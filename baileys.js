// baileys.js — Baileys WhatsApp integration for Luna AI
// Free, unlimited, self-hosted. Session stored in MongoDB.
// Auth via pairing code — no QR scan needed on iPhone.

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const fs = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────
const OWNER_NUMBERS = ['2347061298954', '2348153879694'];
const SESSION_DIR = path.join(__dirname, '.baileys_session');
const PHONE_NUMBER = process.env.BAILEYS_PHONE || '2347061298954'; // number to link

let sock = null;
let isConnected = false;
let reconnectAttempts = 0;

// ── Anti-ban: human-like delay ────────────────────────────────
function humanDelay(min = 1000, max = 3000) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(r => setTimeout(r, ms));
}

// ── Strip WhatsApp JID to plain number ────────────────────────
function toNumber(jid) {
  return jid.replace(/[@:].*/g, '').replace(/\D/g, '');
}

// ── Send text with anti-ban delay ────────────────────────────
async function sendBaileys(to, text) {
  if (!sock || !isConnected) {
    console.warn('[Baileys] Not connected — cannot send message');
    return;
  }
  try {
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    await humanDelay(800, 2500);
    await sock.sendMessage(jid, { text });
    console.log('[Baileys] Message sent to', to);
  } catch (e) {
    console.error('[Baileys] Send error:', e.message);
  }
}

// ── Send image ────────────────────────────────────────────────
async function sendBaileysImage(to, imageUrl, caption = '') {
  if (!sock || !isConnected) return;
  try {
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    await humanDelay(1000, 3000);
    await sock.sendMessage(jid, {
      image: { url: imageUrl },
      caption
    });
    console.log('[Baileys] Image sent to', to);
  } catch (e) {
    console.error('[Baileys] Image send error:', e.message);
  }
}

// ── Send typing indicator ─────────────────────────────────────
async function sendBaileysTyping(to, durationMs = 5000) {
  if (!sock || !isConnected) return;
  try {
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise(r => setTimeout(r, Math.min(durationMs, 10000)));
    await sock.sendPresenceUpdate('paused', jid);
  } catch (e) {
    console.warn('[Baileys] Typing indicator error:', e.message);
  }
}

// ── Process incoming message ──────────────────────────────────
async function processMessage(msg, { Thread, getSystemPrompt, groq }) {
  try {
    const isGroup = msg.key.remoteJid?.endsWith('@g.us');
    if (isGroup) return; // ignore group messages for now
    if (isJidBroadcast(msg.key.remoteJid)) return; // ignore broadcasts

    const from = toNumber(msg.key.remoteJid);
    if (!from) return;

    const msgContent = msg.message;
    if (!msgContent) return;

    // Determine message type
    const type = Object.keys(msgContent)[0];
    const supported = ['conversation', 'extendedTextMessage', 'imageMessage', 'documentMessage', 'audioMessage'];
    if (!supported.includes(type)) return;

    const isOwnerWA = OWNER_NUMBERS.includes(from);

    // Extract text body
    let body = msgContent.conversation ||
      msgContent.extendedTextMessage?.text ||
      msgContent.imageMessage?.caption ||
      msgContent.documentMessage?.caption || '';

    // Extract sender name
    const fromName = msg.pushName || null;
    const displayName = isOwnerWA ? 'Roland' : (fromName ? fromName.split(' ')[0] : null);

    console.log(`[Baileys] ${type} from ${from} (${displayName || 'unknown'})${isOwnerWA ? ' (owner)' : ''}: ${body.slice(0, 100)}`);

    // Mark as read
    await sock.readMessages([msg.key]);

    // Load or create thread
    const userId = 'baileys_' + from;
    const threadId = userId + '_wa';
    let thread = await Thread.findOne({ userId, threadId });
    const isNewUser = !thread;

    if (!thread) {
      thread = await Thread.create({
        userId,
        threadId,
        title: displayName || from,
        messages: []
      });
    }

    if (displayName && thread.title !== displayName) {
      thread.title = displayName;
    }

    // Welcome new users
    if (isNewUser) {
      const greeting = displayName ? `Hey ${displayName}! 👋` : `Hey! 👋`;
      const welcome = `${greeting} I'm Luna ✨\n\nYour personal AI — ask me anything!\n\nSave this number as *Luna* so you can find me easily 😊`;
      thread.messages.push({ role: 'assistant', content: welcome });
      thread.lastUpdated = new Date();
      await thread.save();
      await humanDelay(1000, 2000);
      await sendBaileys(from, welcome);
      return;
    }

    // Handle unsupported types (audio etc)
    if (type === 'audioMessage') {
      await sendBaileys(from, "I can't listen to voice notes yet 😅 Type your message and I'll reply!");
      return;
    }

    // Handle image
    if (type === 'imageMessage') {
      try {
        const { analyzeWhatsAppImage } = require('./image');
        const waSystemPrompt = buildSystemPrompt(getSystemPrompt, userId, isOwnerWA, displayName);
        // Download image buffer from Baileys
        const stream = await sock.downloadMediaMessage(msg);
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const buffer = Buffer.concat(chunks);
        const base64 = buffer.toString('base64');
        const mediaUrl = `data:image/jpeg;base64,${base64}`;
        await sendBaileysTyping(from, 5000);
        const imageReply = await analyzeWhatsAppImage(mediaUrl, waSystemPrompt, body || 'What is in this image?');
        thread.messages.push({ role: 'user', content: body || '[image]' });
        thread.messages.push({ role: 'assistant', content: imageReply });
        thread.lastUpdated = new Date();
        await thread.save();
        await sendBaileys(from, imageReply);
        return;
      } catch (e) {
        console.error('[Baileys] Image analysis error:', e.message);
        body = body || 'I sent you an image';
      }
    }

    // Handle PDF
    if (type === 'documentMessage') {
      try {
        const stream = await sock.downloadMediaMessage(msg);
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const buffer = Buffer.concat(chunks);
        const pdfParse = require('pdf-parse');
        const pdfData = await pdfParse(buffer);
        body = (body || 'Summarize this PDF') + `\n\n[PDF content]:\n${pdfData.text.slice(0, 3000)}`;
      } catch (e) {
        console.error('[Baileys] PDF parse error:', e.message);
        body = body || 'I sent you a PDF but it could not be read.';
      }
    }

    if (!body) return;

    // Direct image generation
    const isImgRequest = /^(generate|create|draw|make|give me|show me|design).{0,30}(image|picture|photo|illustration|art|drawing)/i.test(body);
    if (isImgRequest) {
      try {
        await sendBaileysTyping(from, 15000);
        const { generateImageForWhatsApp } = require('./image');
        const imgUrl = await generateImageForWhatsApp(body, userId);
        thread.messages.push({ role: 'user', content: body });
        thread.messages.push({ role: 'assistant', content: '[Generated image]' });
        thread.lastUpdated = new Date();
        await thread.save();
        await sendBaileysImage(from, imgUrl, 'Here you go ✨');
        return;
      } catch (e) {
        console.error('[Baileys] Image gen failed:', e.message);
      }
    }

    // Build AI messages
    const history = thread.messages.slice(-6);
    const waHistory = history.map(m => ({ role: m.role, content: String(m.content) }));
    const waSystemPrompt = buildSystemPrompt(getSystemPrompt, userId, isOwnerWA, displayName);
    const waMessages = [
      { role: 'system', content: waSystemPrompt },
      ...waHistory,
      { role: 'user', content: body }
    ];

    // Show typing
    const typingPromise = sendBaileysTyping(from, 10000);

    // Call AI with fallback chain
    let replyText = 'Something went wrong on my end. Try again?';
    const waModels = [
      { client: 'groq', model: 'llama-3.3-70b-versatile' },
      { client: 'groq', model: 'gpt-oss-120b' },
      { client: 'groq', model: 'gpt-oss-20b' },
      { client: 'groq', model: 'qwen-qwq-32b' },
      { client: 'groq', model: 'llama-3.1-8b-instant' },
      { client: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free' },
      { client: 'openrouter', model: 'meta-llama/llama-4-scout:free' },
      { client: 'openrouter', model: 'qwen/qwen3-235b-a22b:free' },
      { client: 'openrouter', model: 'mistralai/mistral-small-3.2:free' },
    ];

    for (const { client, model } of waModels) {
      try {
        let aiRes;
        if (client === 'groq') {
          aiRes = await Promise.race([
            groq.chat.completions.create({ model, messages: waMessages, max_tokens: 500 }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000))
          ]);
        } else {
          const OpenAI = require('openai');
          const or = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY });
          aiRes = await Promise.race([
            or.chat.completions.create({ model, messages: waMessages, max_tokens: 500 }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))
          ]);
        }
        replyText = aiRes.choices[0]?.message?.content?.trim() || replyText;
        if (replyText) {
          console.log(`[Baileys] Responded with ${model}`);
          break;
        }
      } catch (e) {
        console.log(`[Baileys] ${model} failed: ${e.message}`);
      }
    }

    // Check if Luna wants to generate an image
    const imgMatch = replyText.match(/\[GENERATE_IMAGE:\s*(.+?)\]/i);
    if (imgMatch) {
      try {
        const { generateImageForWhatsApp } = require('./image');
        const imgUrl = await generateImageForWhatsApp(imgMatch[1], userId);
        thread.messages.push({ role: 'user', content: body });
        thread.messages.push({ role: 'assistant', content: '[Generated image]' });
        thread.lastUpdated = new Date();
        await thread.save();
        await sendBaileysImage(from, imgUrl, 'Here you go ✨');
        return;
      } catch (e) {
        console.error('[Baileys] Image gen from reply failed:', e.message);
        replyText = 'Image generation failed. Try again?';
      }
    }

    // Save and send
    thread.messages.push({ role: 'user', content: body });
    thread.messages.push({ role: 'assistant', content: replyText });
    thread.lastUpdated = new Date();
    await thread.save();
    await sendBaileys(from, replyText);

  } catch (err) {
    console.error('[Baileys] processMessage error:', err.message);
  }
}

// ── Build system prompt safely ────────────────────────────────
function buildSystemPrompt(getSystemPrompt, userId, isOwnerWA, displayName) {
  let base = '';
  try { base = getSystemPrompt(userId, isOwnerWA, null, []); }
  catch(e) {
    try { base = getSystemPrompt({ isOwner: isOwnerWA, profile: null, memories: [] }); }
    catch(e2) { base = ''; }
  }
  const nameCtx = displayName ? `\n\nThe user's name is ${displayName}. Use their name naturally and sparingly.` : '';
  return base +
    nameCtx +
    '\n\nIMPORTANT: This is WhatsApp. Keep replies short and conversational — max 3 sentences unless the user asks for more.' +
    '\n\nIMAGE GENERATION: If asked to generate/create/draw an image, reply with ONLY: [GENERATE_IMAGE: detailed prompt here]';
}

// ── Start Baileys connection ──────────────────────────────────
async function startBaileys(deps) {
  // Create session directory
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }

  const { version } = await fetchLatestBaileysVersion();
  console.log('[Baileys] Using WA version:', version.join('.'));

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false, // we use pairing code
    browser: ['Luna AI', 'Chrome', '120.0.0'],
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    getMessage: async () => ({ conversation: '' }),
  });

  // ── Pairing code auth (no QR needed) ─────────────────────
  if (!sock.authState.creds.registered) {
    const cleanNumber = PHONE_NUMBER.replace(/\D/g, '');
    console.log('[Baileys] Requesting pairing code for', cleanNumber);
    await new Promise(r => setTimeout(r, 3000));
    const code = await sock.requestPairingCode(cleanNumber);
    console.log('');
    console.log('╔════════════════════════════════╗');
    console.log('║  WHATSAPP PAIRING CODE:        ║');
    console.log(`║  ${code}                  ║`);
    console.log('╚════════════════════════════════╝');
    console.log('');
    console.log('Go to WhatsApp → Linked Devices → Link a Device → Enter code above');
    console.log('');
  }

  // ── Connection updates ────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (connection === 'open') {
      isConnected = true;
      reconnectAttempts = 0;
      console.log('[Baileys] ✅ Connected to WhatsApp!');
    }

    if (connection === 'close') {
      isConnected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;

      console.log('[Baileys] Connection closed. Code:', code, '| Reconnect:', shouldReconnect);

      if (shouldReconnect) {
        reconnectAttempts++;
        const delay = Math.min(5000 * reconnectAttempts, 60000); // max 1 min
        console.log(`[Baileys] Reconnecting in ${delay/1000}s (attempt ${reconnectAttempts})...`);
        setTimeout(() => startBaileys(deps), delay);
      } else {
        console.log('[Baileys] Logged out. Delete session folder and restart to re-link.');
      }
    }
  });

  // ── Save credentials on update ────────────────────────────
  sock.ev.on('creds.update', saveCreds);

  // ── Handle incoming messages ──────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue; // skip outgoing
      if (!msg.message) continue;
      await processMessage(msg, deps);
    }
  });

  return sock;
}

// ── Health check ──────────────────────────────────────────────
function isBaileysConnected() {
  return isConnected;
}

module.exports = { startBaileys, sendBaileys, sendBaileysImage, sendBaileysTyping, isBaileysConnected };
