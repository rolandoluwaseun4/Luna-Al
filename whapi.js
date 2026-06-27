// whapi.js — Whapi.Cloud WhatsApp integration for Luna AI
// Webhook URL: https://luna-al.onrender.com/whatsapp/whapi

const OWNER_NUMBERS = ['2347061298954', '2348153879694'];

// ── Send text message via Whapi ───────────────────────────────
async function sendWhapi(to, text) {
  const token = process.env.WHAPI_TOKEN;
  const apiUrl = process.env.WHAPI_API_URL || 'https://gate.whapi.cloud/';
  try {
    const res = await fetch(`${apiUrl}messages/text`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        to: to.includes('@') ? to : to + '@s.whatsapp.net',
        body: text
      })
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.error('[Whapi] Send failed:', res.status, err.slice(0, 200));
    } else {
      console.log('[Whapi] Message sent to', to);
    }
  } catch (e) {
    console.error('[Whapi] Send error:', e.message);
  }
}

// ── Send image via Whapi ──────────────────────────────────────
async function sendWhapiImage(to, imageUrl, caption = '') {
  const token = process.env.WHAPI_TOKEN;
  const apiUrl = process.env.WHAPI_API_URL || 'https://gate.whapi.cloud/';
  try {
    const res = await fetch(`${apiUrl}messages/image`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        to: to.includes('@') ? to : to + '@s.whatsapp.net',
        media: imageUrl,
        caption
      })
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.error('[Whapi] Image send failed:', res.status, err.slice(0, 200));
    } else {
      console.log('[Whapi] Image sent to', to);
    }
  } catch (e) {
    console.error('[Whapi] Image send error:', e.message);
  }
}

// ── Main webhook handler ──────────────────────────────────────
async function handleWhapiWebhook(req, res, { Thread, getSystemPrompt, groq }) {
  try {
    const data = req.body;
    console.log('[Whapi] Webhook received:', JSON.stringify(data).slice(0, 300));

    const messages = data?.messages;
    if (!messages || !messages.length) {
      return res.status(200).json({ status: 'ignored' });
    }

    for (const msg of messages) {
      // Skip outgoing
      if (msg.from_me) continue;

      const type = msg.type;
      if (!['text', 'image', 'document'].includes(type)) continue;

      // Extract sender number
      const from = (msg.chat_id || msg.from || '')
        .replace('@s.whatsapp.net', '')
        .replace('@c.us', '')
        .replace(/\D/g, '');

      if (!from) continue;

      const isOwnerWA = OWNER_NUMBERS.includes(from);
      let body = msg.text?.body || msg.caption || '';

      console.log(`[Whapi] ${type} from ${from}${isOwnerWA ? ' (owner)' : ''}: ${body.slice(0, 100)}`);

      // Load or create thread
      const userId = 'whapi_' + from;
      const threadId = userId + '_wa';
      let thread = await Thread.findOne({ userId, threadId });
      const isNewUser = !thread;

      if (!thread) {
        thread = await Thread.create({
          userId,
          threadId,
          title: 'WhatsApp',
          messages: []
        });
      }

      // Welcome new users
      if (isNewUser) {
        const welcome = `Hey ${isOwnerWA ? 'Roland' : ''} 👋 I'm Luna ✨\n\nWhat's on your mind?`;
        thread.messages.push({ role: 'assistant', content: welcome });
        thread.lastUpdated = new Date();
        await thread.save();
        await sendWhapi(from, welcome);
        continue;
      }

      // ── Handle image ──────────────────────────────────────────
      if (type === 'image') {
        try {
          const { analyzeWhatsAppImage } = require('./image');
          const waSystemPrompt = getSystemPrompt({ isOwner: isOwnerWA, profile: null, memories: [] });
          const mediaUrl = msg.image?.link || msg.image?.url || '';
          if (mediaUrl) {
            const imageReply = await analyzeWhatsAppImage(mediaUrl, waSystemPrompt, body || 'What is in this image?');
            thread.messages.push({ role: 'user', content: body || '[image]' });
            thread.messages.push({ role: 'assistant', content: imageReply });
            thread.lastUpdated = new Date();
            await thread.save();
            await sendWhapi(from, imageReply);
            continue;
          }
        } catch (e) {
          console.error('[Whapi] Image analysis error:', e.message);
          body = body || 'I sent you an image';
        }
      }

      // ── Handle PDF ────────────────────────────────────────────
      if (type === 'document') {
        try {
          const docUrl = msg.document?.link || msg.document?.url || '';
          if (docUrl) {
            const token = process.env.WHAPI_TOKEN;
            const pdfRes = await fetch(docUrl, {
              headers: { 'Authorization': `Bearer ${token}` }
            });
            const pdfBuffer = await pdfRes.arrayBuffer();
            const pdfParse = require('pdf-parse');
            const pdfData = await pdfParse(Buffer.from(pdfBuffer));
            body = (body || 'Summarize this PDF') + `\n\n[PDF content]:\n${pdfData.text.slice(0, 3000)}`;
          }
        } catch (e) {
          console.error('[Whapi] PDF parse error:', e.message);
          body = body || 'I sent you a PDF but it could not be read.';
        }
      }

      if (!body) continue;

      // ── Direct image generation request ───────────────────────
      const isImgRequest = /^(generate|create|draw|make|give me|show me|design).{0,30}(image|picture|photo|illustration|art|drawing)/i.test(body);
      if (isImgRequest) {
        try {
          const { generateImageForWhatsApp } = require('./image');
          const imgUrl = await generateImageForWhatsApp(body, userId);
          thread.messages.push({ role: 'user', content: body });
          thread.messages.push({ role: 'assistant', content: '[Generated image]' });
          thread.lastUpdated = new Date();
          await thread.save();
          await sendWhapiImage(from, imgUrl, 'Here you go ✨');
          continue;
        } catch (e) {
          console.error('[Whapi] Direct image gen failed:', e.message);
          // Fall through to normal AI
        }
      }

      // ── Build AI messages ─────────────────────────────────────
      const history = thread.messages.slice(-6);
      const waHistory = history.map(m => ({ role: m.role, content: String(m.content) }));
      const waSystemPrompt = getSystemPrompt({ isOwner: isOwnerWA, profile: null, memories: [] }) +
        '\n\nIMPORTANT: This is WhatsApp. Keep replies short and conversational — max 3 sentences unless the user asks for more.' +
        '\n\nIMAGE GENERATION: If asked to generate/create/draw an image, reply with ONLY: [GENERATE_IMAGE: detailed prompt here]';

      const waMessages = [
        { role: 'system', content: waSystemPrompt },
        ...waHistory,
        { role: 'user', content: body }
      ];

      // ── Call AI with fallback ─────────────────────────────────
      let replyText = 'Something went wrong on my end. Try again?';
      const waModels = [
        { client: 'groq', model: 'llama-3.3-70b-versatile' },          // smart + fast, primary
        { client: 'groq', model: 'gpt-oss-120b' },                      // smartest on Groq
        { client: 'groq', model: 'gpt-oss-20b' },                       // fastest on Groq
        { client: 'groq', model: 'qwen-qwq-32b' },                      // strong reasoning
        { client: 'groq', model: 'llama-3.1-8b-instant' },              // lightweight backup
        { client: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free' },
        { client: 'openrouter', model: 'meta-llama/llama-4-scout:free' },
        { client: 'openrouter', model: 'qwen/qwen3-235b-a22b:free' },
        { client: 'openrouter', model: 'mistralai/mistral-small-3.2:free' },
        { client: 'openrouter', model: 'openrouter/auto' },             // last resort
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
            const or = new OpenAI({
              baseURL: 'https://openrouter.ai/api/v1',
              apiKey: process.env.OPENROUTER_API_KEY
            });
            aiRes = await Promise.race([
              or.chat.completions.create({ model, messages: waMessages, max_tokens: 500 }),
              new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))
            ]);
          }
          replyText = aiRes.choices[0]?.message?.content?.trim() || replyText;
          if (replyText) {
            console.log(`[Whapi] Responded with ${model}`);
            break;
          }
        } catch (e) {
          console.log(`[Whapi] ${model} failed: ${e.message}`);
        }
      }

      // ── Image generation from AI reply ────────────────────────
      const imgMatch = replyText.match(/\[GENERATE_IMAGE:\s*(.+?)\]/i);
      if (imgMatch) {
        try {
          const { generateImageForWhatsApp } = require('./image');
          const imgUrl = await generateImageForWhatsApp(imgMatch[1], userId);
          thread.messages.push({ role: 'user', content: body });
          thread.messages.push({ role: 'assistant', content: '[Generated image]' });
          thread.lastUpdated = new Date();
          await thread.save();
          await sendWhapiImage(from, imgUrl, 'Here you go ✨');
          continue;
        } catch (e) {
          console.error('[Whapi] Image gen failed:', e.message);
          replyText = 'Image generation failed. Try again?';
        }
      }

      // ── Save and send ─────────────────────────────────────────
      thread.messages.push({ role: 'user', content: body });
      thread.messages.push({ role: 'assistant', content: replyText });
      thread.lastUpdated = new Date();
      await thread.save();
      await sendWhapi(from, replyText);
    }

    return res.status(200).json({ status: 'ok' });

  } catch (err) {
    console.error('[Whapi] Error:', err.message);
    res.status(200).json({ status: 'error', message: err.message });
  }
}

module.exports = { handleWhapiWebhook, sendWhapi, sendWhapiImage };
