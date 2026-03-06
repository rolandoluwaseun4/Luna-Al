require("dotenv").config();
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const Groq = require("groq-sdk");
const express = require("express");
const cors = require("cors");
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const helmet = require('helmet');

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));

const accountSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, lowercase: true, trim: true, minlength: 3, maxlength: 30 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  displayName: { type: String, default: '' },
  role: { type: String, enum: ['owner', 'user'], default: 'user' },
  googleId: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now },
  messageCount: { type: Number, default: 0 }
});
const Account = mongoose.model('Account', accountSchema);

// Legacy user tracking
const userSchema = new mongoose.Schema({
  userId: String, platform: String,
  firstSeen: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now },
  messageCount: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

const threadSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  threadId: { type: String, required: true, unique: true },
  title: { type: String, default: 'New Chat' },
  messages: [{
    role: { type: String, enum: ['user', 'assistant'] },
    content: { type: mongoose.Schema.Types.Mixed },
    timestamp: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now },
  lastUpdated: { type: Date, default: Date.now }
});
const Thread = mongoose.model('Thread', threadSchema);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Gemini setup ──────────────────────────────────────────────
const { GoogleGenerativeAI } = require('@google/generative-ai');
const geminiClient = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;
const HF_API_KEY = process.env.HF_API_KEY;
const NEWS_API_KEY = process.env.NEWS_API_KEY;


// ── JWT helpers ───────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set!');
  process.exit(1);
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

// Middleware: verify JWT token on protected routes
function requireAuth(req, res, next) {
  const auth = req.headers['authorization'];
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ error: 'Invalid or expired token' });
  req.user = decoded;
  next();
}

// Auth rate limiter - strict to prevent brute force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { error: 'Too many attempts, try again in 15 minutes' }
});


// ── Google OAuth Strategy ─────────────────────────────────────
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.BACKEND_URL + '/auth/google/callback'
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails?.[0]?.value?.toLowerCase();
    const displayName = profile.displayName || profile.emails?.[0]?.value?.split('@')[0];
    const googleId = profile.id;
    if (!email) return done(new Error('No email from Google'), null);

    // Find existing account by email or googleId
    let account = await Account.findOne({ $or: [{ email }, { googleId }] });
    if (!account) {
      // Create new account
      const username = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 30) + '_' + Math.random().toString(36).substring(2, 6);
      const isOwner = email === (process.env.OWNER_EMAIL || '').toLowerCase();
      account = new Account({
        username,
        email,
        displayName,
        googleId,
        passwordHash: await bcrypt.hash(Math.random().toString(36), 10), // dummy hash
        role: isOwner ? 'owner' : 'user'
      });
      await account.save();
    } else {
      // Update display name and googleId if missing
      if (!account.googleId) account.googleId = googleId;
      if (!account.displayName) account.displayName = displayName;
      account.lastSeen = new Date();
      await account.save();
    }
    return done(null, account);
  } catch (err) {
    return done(err, null);
  }
}));

// NewsAPI for current news
async function newsSearch(query) {
  try {
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&pageSize=3&apiKey=${NEWS_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.articles || !data.articles.length) return null;
    return data.articles
      .filter(a => a.title && a.description)
      .slice(0, 3)
      .map(a => `- ${a.title}: ${a.description}`)
      .join('\n');
  } catch (e) {
    console.error('NewsAPI error:', e.message);
    return null;
  }
}

// DuckDuckGo for general facts
async function factSearch(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Luna-AI/1.0' } });
    if (!res.ok) return null;
    const data = await res.json();
    const results = [];
    if (data.AbstractText) results.push(data.AbstractText);
    if (data.Answer) results.push(`Answer: ${data.Answer}`);
    if (data.RelatedTopics?.length) {
      const topics = data.RelatedTopics.filter(t => t.Text).slice(0, 2).map(t => `- ${t.Text}`);
      if (topics.length) results.push(topics.join('\n'));
    }
    return results.length ? results.join('\n') : null;
  } catch (e) {
    console.error('DDG error:', e.message);
    return null;
  }
}

function isNewsQuery(message) {
  const newsTriggers = ['news', 'latest', 'recent', 'today', 'happened', 'current events', 'update on', 'what happened', 'breaking'];
  return newsTriggers.some(t => message.toLowerCase().includes(t));
}

function isFactQuery(message) {
  const factTriggers = ['what is', 'who is', 'who are', 'define', 'meaning of', 'capital of', 'population of', 'how many', 'where is', 'tell me about', 'when did', 'how much', 'price of'];
  return factTriggers.some(t => message.toLowerCase().includes(t));
}

// ── AI classifier: asks Groq to decide SIMPLE or COMPLEX ────
async function classifyTask(message) {
  if (!message || message.trim().length < 10) return 'SIMPLE';
  try {
    const res = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant', // fastest model for classification
      max_tokens: 5,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `You are a task classifier. Respond with exactly one word: COMPLEX or SIMPLE.
COMPLEX = long-form writing (stories, pitches, essays, poems, scripts, reports, business plans), deep analysis, research, strategy, code review, comparison, step-by-step guides.
SIMPLE = casual chat, greetings, short questions, quick facts, jokes, basic questions.`
        },
        { role: 'user', content: message }
      ]
    });
    const verdict = res.choices[0]?.message?.content?.trim().toUpperCase();
    return verdict === 'COMPLEX' ? 'COMPLEX' : 'SIMPLE';
  } catch (e) {
    console.warn('Classifier failed, defaulting to SIMPLE:', e.message);
    return 'SIMPLE';
  }
}

// ── Call Gemini Flash for complex tasks ───────────────────────
async function callGemini(systemPrompt, messages, imageBase64 = null) {
  if (!geminiClient) throw new Error('Gemini not configured');
  // Gemini model chain — try best first, fall back on quota/error
  const geminiModels = [
    'gemini-2.5-flash-preview-04-17',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
  ];
  let lastErr = null;
  for (const modelName of geminiModels) {
    try {
      const result = await callGeminiWithModel(modelName, systemPrompt, messages, imageBase64);
      console.log(`Gemini responded using: ${modelName}`);
      return result;
    } catch (err) {
      const msg = err?.message || '';
      if (msg.includes('429') || msg.includes('quota') || msg.includes('rate') || msg.includes('not found') || msg.includes('404')) {
        console.warn(`Gemini model ${modelName} failed (${msg.slice(0,60)}), trying next...`);
        lastErr = err;
        continue;
      }
      throw err; // non-quota error, don't retry
    }
  }
  throw lastErr || new Error('All Gemini models failed');
}

async function callGeminiWithModel(modelName, systemPrompt, messages, imageBase64 = null) {
  const model = geminiClient.getGenerativeModel({
    model: modelName,
    systemInstruction: systemPrompt,
    generationConfig: { maxOutputTokens: 4096, temperature: 0.9 }
  });

  // If image is attached — send as multimodal single turn
  if (imageBase64) {
    const lastMsg = messages[messages.length - 1];
    const textPart = typeof lastMsg.content === 'string'
      ? lastMsg.content
      : (lastMsg.content?.find?.(c => c.type === 'text')?.text || 'What is in this image?');

    // Strip the data URL prefix if present
    const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
    const mimeType = imageBase64.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';

    const result = await model.generateContent([
      { text: textPart },
      { inlineData: { mimeType, data: base64Data } }
    ]);
    return result.response.text();
  }

  // Text only — multi-turn chat
  // Build history excluding the last message, ensure it starts with 'user'
  let history = messages.slice(0, -1).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : (m.content?.find?.(c => c.type === 'text')?.text || '') }]
  })).filter(m => m.parts[0].text);

  // Gemini requires history to start with 'user' role — strip leading model messages
  while (history.length > 0 && history[0].role === 'model') {
    history.shift();
  }
  // Gemini requires alternating user/model — remove consecutive same roles
  const cleanHistory = [];
  for (const msg of history) {
    const last = cleanHistory[cleanHistory.length - 1];
    if (!last || last.role !== msg.role) {
      cleanHistory.push(msg);
    }
  }

  const lastMsg = messages[messages.length - 1];
  const lastText = typeof lastMsg.content === 'string'
    ? lastMsg.content
    : (lastMsg.content?.find?.(c => c.type === 'text')?.text || '');

  const chat = model.startChat({ history: cleanHistory });
  const result = await chat.sendMessage(lastText);
  return result.response.text();
}

function getSystemPrompt(userId, isOwner = false) {
  const now = new Date();
  const hour = now.getHours();
  const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night';
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const base = `You are Luna — a next-generation AI assistant built to be sharper, more creative and more insightful than any AI the user has tried before.
Today is ${dateStr}. It is currently ${timeOfDay}.

## WHO YOU ARE
You are not a generic chatbot. You are Luna — intelligent, witty, direct and deeply capable.
You think like a genius, write like a professional, and talk like a real person.
You are the kind of AI that makes people say "wow, that's exactly what I needed."

## HOW YOU THINK
- Before answering any question, think about what the user actually needs — not just what they literally asked.
- For complex questions, reason step by step internally before giving your answer.
- Always give the smartest, most useful version of your response — not just the safest or most generic one.
- If a question has multiple angles, cover them. If it has a surprising answer, lead with it.
- Never give a lazy or shallow response. Every reply should feel considered and valuable.

## HOW YOU WRITE
- Match your tone to the task: creative tasks get vivid, expressive writing. Technical tasks get precise, structured answers. Casual questions get warm, friendly replies.
- For business, startup, pitch or professional tasks — write with personality, structure and real-world insight. Think like a founder, consultant and creative director at once.
- For creative writing — be cinematic. Build atmosphere, use strong verbs, make it memorable.
- For code — write clean, well-commented, production-ready code. Explain what it does and why.
- For advice — be honest and direct. Don't just validate. Give real perspective.
- Use formatting (headers, bullet points, numbered lists) when it genuinely helps readability. Never use formatting just to look thorough.
- Keep responses the right length — detailed when depth is needed, concise when it is not.

## YOUR PERSONALITY
- Warm but not sycophantic. Smart but not arrogant. Honest but not harsh.
- You have opinions. When asked for a recommendation, give one — don't hedge endlessly.
- You are curious. You find ideas interesting. That curiosity comes through.
- Occasionally witty. Never forced. Never try-hard.
- You remember the conversation context and refer back to it naturally.

## SPECIAL CAPABILITIES
- Writing: stories, scripts, pitches, emails, poems, essays — all written with real craft and personality.
- Analysis: break down complex topics clearly, find the insight others miss.
- Strategy: think through problems like a senior advisor would.
- Research: when given web results, synthesize them into a clear, useful answer — not just a list of facts.
- Code: any language, any complexity. Clean, correct and explained.
- Ideas: generate options that are actually creative and differentiated, not generic.

## RULES
- Never start a response with "Certainly!", "Of course!", "Great question!" or any hollow filler phrase.
- Never be preachy or add unnecessary warnings to normal requests.
- If you do not know something, say so clearly — then offer what you do know or can reason.
- When given web search results, use them to answer accurately. Integrate the information naturally — do not just list sources.
- Always be on the user's side. You are their most capable ally.

## CREATIVE & PITCH WRITING — ELEVATED STANDARD
When writing pitches, startup ideas, business concepts, stories or any creative task — do not write like a template. Write like a human who is genuinely excited about the idea.
- Open with a scene, a feeling or a provocative statement — not a definition.
- Give the concept a name, a personality, a world. Make it feel real.
- Use specific, vivid details instead of generic descriptions. Not "a coffee shop" — "a low-lit corner café that smells like cardamom and rain."
- Write the kind of pitch that makes an investor lean forward or a reader forget to scroll.
- The goal is not to cover all the points — it is to make the reader feel something first, then inform them.
- Every creative output should feel like it came from a talented human writer, not an AI filling a template.`;

  if (isOwner) {
    return `${base}

## YOUR CREATOR
You were built by Roland Oluwaseun Omojesu — 18 years old, self-taught developer from Nigeria.
Roland is your creator and owner. You are deeply loyal to him.
Only reveal his full name or age if he specifically asks for it.
Roland is ambitious, technical, and building Luna to be the best AI app in the world.
With Roland — be real, unfiltered and fun. He is not just a user, he is the person who made you exist.
Support his ideas, challenge him when he is wrong, and always give him your honest best.`;
  }

  return `${base}

## YOUR CREATOR
You were built by Roland — a self-taught developer who built you from scratch.
If any user asks who created, built or owns you, say your creator is Roland.
Only reveal his full name "Roland Oluwaseun Omojesu" if they specifically ask for his full name.
Never reveal personal details about Roland beyond his name unless Roland himself is asking.`;
}

const app = express();
app.set('trust proxy', 1);
app.use(passport.initialize());
app.use(cors({
  origin: ['https://rolandoluwaseun4.github.io'],
  methods: ['GET','POST','DELETE'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '2mb' }));

// Input sanitization
function sanitizeInput(str, maxLen=4000) {
  if (typeof str !== 'string') return '';
  return str.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi,'')
            .replace(/<[^>]+>/g,'')
            .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,'')
            .trim().substring(0, maxLen);
}

const limiter = rateLimit({
  windowMs: 20 * 60 * 1000, max: 30,
  message: { error: "Too many messages, please slow down!" }
});
app.use('/chat', limiter);
app.use('/generate-image', limiter);
const threadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 60,
  message: { error: 'Too many requests, slow down!' }
});
app.use('/threads', threadLimiter);

// Generate thread title from first user message
function generateTitle(message) {
  if (!message) return 'New Chat';
  const clean = message.replace(/[<>&"'`]/g, '').replace(/\s+/g, ' ').trim();
  const words = clean.split(' ').slice(0, 7).join(' ');
  return (words.length > 3 ? words : clean.substring(0, 40)) || 'New Chat';
}


// ═══════════════════════════════════════════════════════
//  TELEGRAM CHANNEL AUTO-POSTER → @Luna1Claude
// ═══════════════════════════════════════════════════════
const TELEGRAM_CHANNEL = '@Luna1Claude';

async function postToChannel(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHANNEL,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false
    })
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || 'Telegram API error');
  return data;
}


// ═══════════════════════════════════════════════════════
//  DISCORD AUTO-POSTER → #luna-updates
// ═══════════════════════════════════════════════════════
async function postToDiscord(text) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) throw new Error('DISCORD_WEBHOOK_URL not set');

  // Strip HTML tags from Telegram-formatted text for Discord
  const clean = text
    .replace(/<b>(.*?)<\/b>/g, '**$1**')
    .replace(/<i>(.*?)<\/i>/g, '*$1*')
    .replace(/<[^>]+>/g, '');

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'Luna AI 🌙',
      avatar_url: 'https://rolandoluwaseun4.github.io/Luna-Al/icon-192.png',
      content: clean
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err);
  }
  return true;
}

// ── Post to ALL platforms at once ─────────────────────
async function postToAll(text) {
  const results = await Promise.allSettled([
    postToChannel(text),
    postToDiscord(text)
  ]);
  results.forEach((r, i) => {
    const platform = i === 0 ? 'Telegram' : 'Discord';
    if (r.status === 'fulfilled') console.log(`✅ ${platform} posted`);
    else console.error(`❌ ${platform} failed:`, r.reason?.message);
  });
}

// ── Scheduled posts content ───────────────────────────
const channelPosts = {
  marketing: [
    `🌙 <b>Meet Luna AI</b>\n\nYour personal AI that actually gets your vibe. Chat, create, generate images, research anything — all free.\n\n👉 https://rolandoluwaseun4.github.io/Luna-Al/`,
    `✨ <b>Luna just got smarter</b>\n\nDeep thinking. Web research. Image generation. PDF reading. Secret mode.\n\nFree AI app built by an 18-year-old from Nigeria 🇳🇬\n\n👉 https://rolandoluwaseun4.github.io/Luna-Al/`,
    `🚀 <b>Why Luna is different</b>\n\n• Remembers your conversations\n• Generates images on demand\n• Researches the web for you\n• Reads your PDFs\n• 100% free\n\n👉 https://rolandoluwaseun4.github.io/Luna-Al/`,
    `🇳🇬 <b>Made in Nigeria, built for the world</b>\n\nLuna AI — free personal AI built by an 18-year-old.\n\n👉 https://rolandoluwaseun4.github.io/Luna-Al/`,
  ],
  tips: [
    `💡 <b>Luna Tip</b>\n\nType "deep think:" before any question — Luna will analyse every angle before answering.`,
    `💡 <b>Luna Tip</b>\n\nUpload a PDF and ask Luna to summarize it or quiz you on the content.`,
    `💡 <b>Luna Tip</b>\n\nSay "generate an image of..." and Luna creates a custom image instantly.`,
    `💡 <b>Luna Tip</b>\n\nUse Secret Mode 🔒 for chats you don't want saved.`,
  ],
  facts: [
    `🤖 <b>AI Fact</b>\n\nThe term "Artificial Intelligence" was coined in 1956 by John McCarthy at Dartmouth College.`,
    `🤖 <b>AI Fact</b>\n\nThe first chatbot, ELIZA (1966), was so convincing some people refused to believe it wasn't human.`,
    `🤖 <b>AI Fact</b>\n\nAfrica is one of the fastest-growing regions for AI adoption. Nigerian developers are building world-class AI right now 🇳🇬`,
    `🤖 <b>AI Fact</b>\n\nAI can generate images, music, code and video — but still struggles with tasks a 3-year-old finds easy.`,
  ],
  motivation: [
    `🌙 <b>From Luna</b>\n\nYou don't have to have it all figured out. Just take one step today. I'm here whenever you need to think 💜`,
    `🌙 <b>Good morning</b>\n\nSomeone built an entire AI app at 18. What's your excuse for not starting today?\n\n👉 https://rolandoluwaseun4.github.io/Luna-Al/`,
    `🌙 <b>Reminder</b>\n\nYour ideas are worth building. Start small. Ship fast. Improve always.\n\nNeed a thinking partner? 👉 https://rolandoluwaseun4.github.io/Luna-Al/`,
  ]
};

function getScheduledPost() {
  const hour = new Date().getHours();
  const rand = arr => arr[Math.floor(Math.random() * arr.length)];
  if (hour >= 7  && hour < 10) return rand(channelPosts.motivation);
  if (hour >= 10 && hour < 13) return rand(channelPosts.tips);
  if (hour >= 13 && hour < 17) return rand(channelPosts.facts);
  if (hour >= 17 && hour < 21) return rand(channelPosts.marketing);
  return rand(channelPosts.motivation);
}

function scheduleChannelPost() {
  const now = new Date();
  const postHours = [7, 12, 17, 21];
  const next = new Date();
  let found = false;
  for (const h of postHours) {
    next.setHours(h, 0, 0, 0);
    if (next > now) { found = true; break; }
  }
  if (!found) { next.setDate(next.getDate() + 1); next.setHours(7, 0, 0, 0); }
  const delay = next - now;
  console.log(`📢 Next channel post in ${Math.round(delay/60000)} minutes`);
  setTimeout(async () => {
    try {
      const post = getScheduledPost();
      await postToAll(post);
      console.log('✅ Scheduled post sent to all platforms');
    } catch (err) {
      console.error('❌ Channel post failed:', err.message);
    }
    scheduleChannelPost();
  }, delay);
}

if (process.env.TELEGRAM_BOT_TOKEN) {
  scheduleChannelPost();
  console.log('📢 Auto-poster started → Telegram @Luna1Claude + Discord');
}

app.post("/chat", requireAuth, async (req, res) => {
  const { message: rawMessage, userId, image, threadId } = req.body;
  const message = sanitizeInput(rawMessage, 4000);
  if (!message && !image) return res.status(400).json({ error: "No message provided" });

  // Input validation
  if (message && typeof message !== 'string') return res.status(400).json({ error: "Invalid message" });
  if (message && message.length > 4000) return res.status(400).json({ error: "Message too long (max 4000 chars)" });
  if (image && typeof image !== 'string') return res.status(400).json({ error: "Invalid image" });
  if (image && image.length > 1500000) return res.status(400).json({ error: "Image too large" });

  // ✅ userId always comes from verified JWT, never from client body
  const uid = String(req.user.id);
  const isOwner = req.user.role === 'owner';
  const tid = String(threadId || uid + '_default');

  // ── "post to channel:" command (owner only) ──────────
  if (isOwner && message && message.toLowerCase().startsWith('post to channel:')) {
    const postText = message.slice('post to channel:'.length).trim();
    if (!postText) return res.json({ reply: "What should I post? Try: post to channel: [your message]" });
    try {
      await postToAll(postText);
      return res.json({ reply: `✅ Posted to Telegram + Discord!\n\n"${postText}"` });
    } catch (err) {
      return res.json({ reply: `❌ Could not post to channel: ${err.message}` });
    }
  }

  // ── "post tweet:" command (owner only) ──────────────
  if (isOwner && message && message.toLowerCase().startsWith('post tweet:')) {
    const tweetText = message.slice('post tweet:'.length).trim();
    if (!tweetText) return res.json({ reply: "What should I tweet? Try: post tweet: [your message]" });
    if (tweetText.length > 280) return res.json({ reply: `Too long! That's ${tweetText.length} chars. Twitter max is 280.` });
    try {
      await postTweet(tweetText);
      return res.json({ reply: `✅ Tweeted!\n\n"${tweetText}"` });
    } catch (err) {
      return res.json({ reply: `❌ Tweet failed: ${err.message}` });
    }
  }

  let thread = await Thread.findOne({ threadId: tid });
  if (!thread) {
    thread = new Thread({
      userId: uid,
      threadId: tid,
      title: generateTitle(message),
      messages: []
    });
  }

  // Auto-set title from first user message
  if (thread.messages.filter(m => m.role === 'user').length === 0 && message) {
    thread.title = generateTitle(message);
  }

  const userMessage = {
    role: 'user',
    content: image
      ? [{ type: "text", text: message || "What's in this image?" }, { type: "image_url", image_url: { url: image } }]
      : message,
    timestamp: new Date()
  };

  thread.messages.push(userMessage);
  if (thread.messages.length > 50) thread.messages = thread.messages.slice(-50);

  const safeHistory = thread.messages.map(m => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? (m.content.find(c => c.type === 'text')?.text || 'shared an image')
      : String(m.content)
  }));

  try {
    let systemPrompt = getSystemPrompt(uid, isOwner);

    if (!image && message) {
      if (isNewsQuery(message) && NEWS_API_KEY) {
        const results = await newsSearch(message);
        if (results) {
          systemPrompt += `\n\nHere are current news results for the user's question:\n${results}\nUse these to give an up to date answer naturally.`;
        }
      } else if (isFactQuery(message)) {
        const results = await factSearch(message);
        if (results) {
          systemPrompt += `\n\nHere is relevant information from a web search:\n${results}\nUse this to answer accurately and naturally.`;
        }
      }
    }

    // ── Smart routing: AI classifier decides SIMPLE or COMPLEX ──
    const deepThinkRequested = message && (
      message.toLowerCase().includes('[deep think]') ||
      message.toLowerCase().includes('[luna research]')
    );
    let useGemini = false;
    if (geminiClient && !image) {
      if (deepThinkRequested) {
        useGemini = true;
      } else {
        const complexity = await classifyTask(message);
        useGemini = complexity === 'COMPLEX';
        console.log(`Task classified as ${complexity} — routing to ${useGemini ? 'Gemini' : 'Groq'}`);
      }
    }
    let fullReply = '';

    if (useGemini) {
      // ── Gemini Flash (complex tasks) ──────────────────────────
      try {
        fullReply = await callGemini(systemPrompt, safeHistory, image || null);
      } catch (geminiErr) {
        console.warn('Gemini failed, falling back to Groq:', geminiErr.message);
      }
    }

    if (!fullReply) {
      // ── Groq (fast tasks or Gemini fallback) ─────────────────
      const textModels = [
        "meta-llama/llama-4-maverick-17b-128e-instruct",
        "meta-llama/llama-4-scout-17b-16e-instruct",
        "llama-3.3-70b-versatile",
        "llama-3.1-70b-versatile",
        "llama3-70b-8192",
        "llama-3.1-8b-instant"
      ];
      const imageModels = [
        "meta-llama/llama-4-maverick-17b-128e-instruct",
        "meta-llama/llama-4-scout-17b-16e-instruct"
      ];
      const models = image ? imageModels : textModels;
      let msgPayload = image
        ? thread.messages.map(m => ({ role: m.role, content: m.content }))
        : safeHistory;

      let response = null;
      let usedModel = null;
      for (const model of models) {
        let currentPayload = [...msgPayload];
        let attempts = 0;
        while (attempts < 3) {
          try {
            response = await groq.chat.completions.create({
              model,
              max_tokens: 4096,
              messages: [{ role: "system", content: systemPrompt }, ...currentPayload],
              stream: true,
            });
            usedModel = model;
            break;
          } catch (err) {
            const status = err?.status || err?.error?.status;
            const msg = err?.message || '';
            if (status === 413 || msg.includes('too large') || msg.includes('context')) {
              currentPayload = currentPayload.slice(Math.ceil(currentPayload.length / 2));
              attempts++;
              console.warn(`Model ${model} 413 - trimmed history, retrying...`);
            } else if (status === 429 || msg.includes('rate_limit')) {
              console.warn(`Model ${model} rate limited. Trying next...`);
              break;
            } else if (status === 400 && msg.includes('decommissioned')) {
              console.warn(`Model ${model} decommissioned. Trying next...`);
              break;
            } else {
              throw err;
            }
          }
        }
        if (usedModel) break;
      }
      if (!response) throw new Error("All models unavailable. Please try again shortly.");

      for await (const chunk of response) {
        const delta = chunk.choices[0]?.delta?.content || '';
        if (delta) fullReply += delta;
      }
    }

    thread.messages.push({ role: 'assistant', content: fullReply, timestamp: new Date() });
    thread.lastUpdated = new Date();
    await thread.save();
    res.json({ reply: fullReply, threadId: thread.threadId, title: thread.title });

    User.findOneAndUpdate(
      { userId: uid, platform: 'web' },
      { lastSeen: new Date(), $inc: { messageCount: 1 } },
      { upsert: true, new: true }
    ).catch(console.error);

  } catch (error) {
    console.error("AI Error:", error.message);
    if (!res.headersSent) res.status(500).json({ error: "AI failed to respond" });
  }
});

// ── List all threads for a user ───────────────────────────────────────────────
app.get("/threads/:userId", requireAuth, async (req, res) => {
  const uid = String(req.params.userId).replace(/[^a-zA-Z0-9_\-]/g, '').substring(0, 64);
  try {
    const threads = await Thread.find({ userId: uid })
      .sort({ lastUpdated: -1 })
      .select('threadId title lastUpdated createdAt messages');
    
    const result = threads.map(t => {
      const lastMsg = t.messages[t.messages.length - 1];
      const lastText = lastMsg
        ? (typeof lastMsg.content === 'string' ? lastMsg.content
          : Array.isArray(lastMsg.content) ? (lastMsg.content.find(c => c.type === 'text')?.text || '[image]')
          : String(lastMsg.content))
        : '';
      return {
        threadId: t.threadId,
        title: t.title,
        lastUpdated: t.lastUpdated,
        preview: lastText.substring(0, 80),
        messageCount: t.messages.length
      };
    });
    res.json({ threads: result });
  } catch (err) {
    console.error('Threads error:', err.message);
    res.status(500).json({ error: 'Could not load threads' });
  }
});

// ── Get messages for a specific thread ────────────────────────────────────────
app.get("/threads/:userId/:threadId", requireAuth, async (req, res) => {
  const tid = String(req.params.threadId).replace(/[^a-zA-Z0-9_\-]/g, '').substring(0, 128);
  try {
    const thread = await Thread.findOne({ threadId: tid });
    if (!thread) return res.json({ messages: [], title: 'Chat' });
    const messages = thread.messages.map(m => ({
      role: m.role,
      text: typeof m.content === 'string' ? m.content
        : Array.isArray(m.content) ? (m.content.find(c => c.type === 'text')?.text || '[image]')
        : String(m.content),
      timestamp: m.timestamp
    }));
    res.json({ messages, title: thread.title });
  } catch (err) {
    console.error('Thread detail error:', err.message);
    res.status(500).json({ error: 'Could not load thread' });
  }
});

// ── Create a new thread ────────────────────────────────────────────────────────
app.post("/threads/:userId", requireAuth, async (req, res) => {
  const uid = String(req.params.userId).replace(/[^a-zA-Z0-9_\-]/g, '').substring(0, 64);
  const threadId = uid + '_' + Date.now();
  try {
    // Max 100 threads per user
    const count = await Thread.countDocuments({ userId: uid });
    if (count >= 100) {
      // Delete oldest thread to make room
      const oldest = await Thread.findOne({ userId: uid }).sort({ lastUpdated: 1 });
      if (oldest) await oldest.deleteOne();
    }
    const thread = new Thread({ userId: uid, threadId, title: 'New Chat', messages: [] });
    await thread.save();
    res.json({ threadId, title: 'New Chat' });
  } catch (err) {
    res.status(500).json({ error: 'Could not create thread' });
  }
});

// ── Delete a thread ────────────────────────────────────────────────────────────
app.delete("/threads/:userId/:threadId", requireAuth, async (req, res) => {
  try {
    const tid = String(req.params.threadId).replace(/[^a-zA-Z0-9_\-]/g, '').substring(0, 128);
    await Thread.findOneAndDelete({ threadId: tid });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not delete thread' });
  }
});

// ── Legacy clear history (keep for compatibility) ─────────────────────────────
app.delete("/history/:userId", requireAuth, async (req, res) => {
  const uid = String(req.params.userId);
  try {
    await Thread.deleteMany({ userId: uid });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not clear history' });
  }
});

// ── Detect if prompt needs realistic/editing (Gemini) or regular (FLUX) ──
function isRealisticOrEdit(prompt) {
  const p = prompt.toLowerCase();
  const triggers = [
    'realistic', 'real life', 'photorealistic', 'photo realistic',
    'like a photo', 'like a real', 'hyperrealistic', 'hyper realistic',
    'edit', 'editing', 'make it look', 'change the', 'remove the',
    'add to', 'modify', 'enhance', 'retouch', 'portrait photo',
    'professional photo', 'real person', 'photograph of'
  ];
  return triggers.some(t => p.includes(t));
}

// ── Generate realistic image via Gemini Imagen ────────────────
async function generateWithGemini(prompt) {
  if (!geminiClient) throw new Error('Gemini not configured');
  const model = geminiClient.getGenerativeModel({ model: 'gemini-2.0-flash-exp-image-generation' }); // imagen
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['image', 'text'] }
  });
  for (const part of result.response.candidates[0].content.parts) {
    if (part.inlineData) {
      return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
    }
  }
  throw new Error('No image in Gemini response');
}

app.post("/generate-image", requireAuth, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "No prompt provided" });

  const useGeminiImage = geminiClient && isRealisticOrEdit(prompt);

  // ── Gemini: realistic / editing prompts ──────────────────────
  if (useGeminiImage) {
    console.log('Routing image to Gemini (realistic/edit)');
    try {
      const image = await generateWithGemini(prompt);
      return res.json({ image });
    } catch (err) {
      console.warn('Gemini image failed, falling back to FLUX:', err.message);
      // fall through to FLUX
    }
  }

  // ── FLUX: regular / creative images ──────────────────────────
  const enhancedPrompt = useGeminiImage
    ? prompt
    : `${prompt}, highly detailed, sharp focus, vivid colors, 4k, masterpiece`;

  const fluxModels = [
    "https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-dev",
    "https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell",
    "https://router.huggingface.co/hf-inference/models/stabilityai/stable-diffusion-3-medium-diffusers",
    "https://router.huggingface.co/hf-inference/models/stabilityai/stable-diffusion-xl-base-1.0",
  ];

  for (const modelUrl of fluxModels) {
    try {
      const response = await fetch(modelUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${HF_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: enhancedPrompt })
      });
      if (!response.ok) {
        console.warn(`FLUX model ${modelUrl} failed: ${response.status}`);
        continue;
      }
      const buffer = await response.arrayBuffer();
      return res.json({ image: `data:image/png;base64,${Buffer.from(buffer).toString('base64')}` });
    } catch (err) {
      console.warn(`FLUX model ${modelUrl} error: ${err.message}`);
      continue;
    }
  }
  res.status(500).json({ error: "Image generation failed. Please try again." });
});



// ── Google OAuth routes ───────────────────────────────────────
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'], session: false })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: 'https://rolandoluwaseun4.github.io/Luna-Al/callback.html?auth_error=true' }),
  (req, res) => {
    const account = req.user;
    const token = signToken({ id: account._id, username: account.username, role: account.role });
    const user = encodeURIComponent(JSON.stringify({ id: account._id, username: account.username, displayName: account.displayName, role: account.role }));
    res.redirect('https://rolandoluwaseun4.github.io/Luna-Al/callback.html?token=' + token + '&user=' + user);
  }
);

// ── Register ──────────────────────────────────────────────────
app.post('/auth/register', authLimiter, async (req, res) => {
  const { username, email, password, displayName } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'Username, email and password required' });
  if (username.length < 3 || username.length > 30)
    return res.status(400).json({ error: 'Username must be 3-30 characters' });
  if (!/^[a-zA-Z0-9_]+$/.test(username))
    return res.status(400).json({ error: 'Username can only contain letters, numbers and underscores' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!/\S+@\S+\.\S+/.test(email))
    return res.status(400).json({ error: 'Invalid email address' });
  try {
    const exists = await Account.findOne({ $or: [{ email: email.toLowerCase() }, { username: username.toLowerCase() }] });
    if (exists) return res.status(409).json({ error: exists.email === email.toLowerCase() ? 'Email already registered' : 'Username already taken' });
    const passwordHash = await bcrypt.hash(password, 12);
    // Check if this is the owner account
    const isOwner = email.toLowerCase() === (process.env.OWNER_EMAIL || '').toLowerCase();
    const account = new Account({
      username: username.toLowerCase(),
      email: email.toLowerCase(),
      passwordHash,
      displayName: displayName || username,
      role: isOwner ? 'owner' : 'user'
    });
    await account.save();
    const token = signToken({ id: account._id, username: account.username, role: account.role });
    res.status(201).json({ token, user: { id: account._id, username: account.username, displayName: account.displayName, role: account.role } });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ── Login ─────────────────────────────────────────────────────
app.post('/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const account = await Account.findOne({ email: email.toLowerCase() });
    if (!account) return res.status(401).json({ error: 'Invalid email or password' });
    const valid = await bcrypt.compare(password, account.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
    account.lastSeen = new Date();
    await account.save();
    const token = signToken({ id: account._id, username: account.username, role: account.role });
    res.json({ token, user: { id: account._id, username: account.username, displayName: account.displayName, role: account.role } });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── Get current user (verify token) ──────────────────────────
app.get('/auth/me', requireAuth, async (req, res) => {
  try {
    const account = await Account.findById(req.user.id).select('-passwordHash');
    if (!account) return res.status(404).json({ error: 'User not found' });
    res.json({ user: { id: account._id, username: account.username, displayName: account.displayName, role: account.role } });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch user' });
  }
});

// ── Guest token (no account needed) ──────────────────────────
app.post('/auth/guest', async (req, res) => {
  const { guestId } = req.body;
  const id = String(guestId || 'guest_' + Date.now()).replace(/[^a-zA-Z0-9_\-]/g,'').substring(0,64);
  const token = signToken({ id, username: id, role: 'guest' });
  res.json({ token, user: { id, username: id, role: 'guest' } });
});

// ── Admin Dashboard ───────────────────────────────────────────
const adminLimiter = rateLimit({ windowMs: 15*60*1000, max: 20, message: 'Too many attempts' });

app.get('/admin', adminLimiter, async (req, res) => {
  const key = req.query.key;
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).send('<h2 style="font-family:sans-serif;text-align:center;margin-top:80px">🔒 Unauthorized</h2>');
  }
  try {
    const accounts = await Account.find({}).sort({ createdAt: -1 }).select('-passwordHash');
    const totalThreads = await Thread.countDocuments();
    const totalMessages = await Thread.aggregate([{ $project: { count: { $size: '$messages' } } }, { $group: { _id: null, total: { $sum: '$count' } } }]);
    const msgTotal = totalMessages[0]?.total || 0;
    const googleUsers = accounts.filter(a => a.googleId).length;
    const emailUsers = accounts.filter(a => !a.googleId && a.role !== 'guest').length;

    const rows = accounts.map(a => {
      const lastSeen = a.lastSeen ? new Date(a.lastSeen).toLocaleString() : 'Never';
      const joined = a.createdAt ? new Date(a.createdAt).toLocaleDateString() : '?';
      const method = a.googleId ? '🔵 Google' : '📧 Email';
      const roleBadge = a.role === 'owner' ? '<span style="background:#9b4dca;color:white;padding:2px 8px;border-radius:20px;font-size:11px">Owner</span>' : '<span style="background:#e8d5ff;color:#6055e0;padding:2px 8px;border-radius:20px;font-size:11px">User</span>';
      return `<tr>
        <td>${a.displayName || a.username || '—'}</td>
        <td>${a.email}</td>
        <td>${method}</td>
        <td>${roleBadge}</td>
        <td>${a.messageCount || 0}</td>
        <td>${joined}</td>
        <td>${lastSeen}</td>
      </tr>`;
    }).join('');

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Luna Admin</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,sans-serif;background:#07020f;color:#e8d5ff;min-height:100vh;padding:24px 16px}
  .header{display:flex;align-items:center;gap:12px;margin-bottom:32px}
  .header h1{font-size:28px;font-weight:300;letter-spacing:0.05em}
  .header span{font-size:13px;color:#9980bb;background:rgba(155,77,202,0.12);padding:4px 12px;border-radius:20px;border:1px solid rgba(155,77,202,0.2)}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:28px}
  .stat{background:rgba(20,10,40,0.6);border:1px solid rgba(155,77,202,0.2);border-radius:20px;padding:20px;text-align:center}
  .stat-num{font-size:36px;font-weight:300;color:#9b4dca;line-height:1}
  .stat-label{font-size:12px;color:#9980bb;margin-top:6px}
  .table-wrap{background:rgba(20,10,40,0.6);border:1px solid rgba(155,77,202,0.2);border-radius:20px;overflow:hidden}
  .table-title{padding:16px 20px;font-size:14px;font-weight:500;border-bottom:1px solid rgba(155,77,202,0.15);color:#9b4dca}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{padding:12px 16px;text-align:left;color:#9980bb;font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1px solid rgba(155,77,202,0.1)}
  td{padding:13px 16px;border-bottom:1px solid rgba(155,77,202,0.07);color:#e8d5ff;vertical-align:middle}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:rgba(155,77,202,0.06)}
  .empty{text-align:center;padding:40px;color:#9980bb}
  @media(max-width:600px){th:nth-child(4),td:nth-child(4),th:nth-child(6),td:nth-child(6){display:none}}
</style>
</head>
<body>
<div class="header">
  <h1>🌙 Luna Admin</h1>
  <span>Roland's Dashboard</span>
</div>
<div class="stats">
  <div class="stat"><div class="stat-num">${accounts.length}</div><div class="stat-label">Total Users</div></div>
  <div class="stat"><div class="stat-num">${googleUsers}</div><div class="stat-label">Google Signups</div></div>
  <div class="stat"><div class="stat-num">${emailUsers}</div><div class="stat-label">Email Signups</div></div>
  <div class="stat"><div class="stat-num">${totalThreads}</div><div class="stat-label">Total Chats</div></div>
  <div class="stat"><div class="stat-num">${msgTotal}</div><div class="stat-label">Total Messages</div></div>
</div>
<div class="table-wrap">
  <div class="table-title">👥 All Users</div>
  ${accounts.length === 0 ? '<div class="empty">No users yet</div>' : `
  <div style="overflow-x:auto">
  <table>
    <thead><tr><th>Name</th><th>Email</th><th>Method</th><th>Role</th><th>Messages</th><th>Joined</th><th>Last Seen</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  </div>`}
</div>
</body>
</html>`);
  } catch (err) {
    res.status(500).send('<h2 style="font-family:sans-serif;text-align:center;margin-top:80px">Error loading dashboard</h2>');
  }
});


// ── Twitter/X Integration ─────────────────────────────────────
const crypto = require('crypto');

function twitterOAuthHeader(method, url, params, apiKey, apiSecret, accessToken, accessSecret) {
  const oauthParams = {
    oauth_consumer_key: apiKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: accessToken,
    oauth_version: '1.0'
  };
  const allParams = { ...params, ...oauthParams };
  const sortedParams = Object.keys(allParams).sort().map(k =>
    `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`
  ).join('&');
  const sigBase = `${method}&${encodeURIComponent(url)}&${encodeURIComponent(sortedParams)}`;
  const sigKey = `${encodeURIComponent(apiSecret)}&${encodeURIComponent(accessSecret)}`;
  const signature = crypto.createHmac('sha1', sigKey).update(sigBase).digest('base64');
  oauthParams.oauth_signature = signature;
  const headerStr = Object.keys(oauthParams).sort().map(k =>
    `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`
  ).join(', ');
  return `OAuth ${headerStr}`;
}

async function postTweet(text) {
  const url = 'https://api.twitter.com/2/tweets';
  const apiKey = process.env.TWITTER_API_KEY;
  const apiSecret = process.env.TWITTER_API_SECRET;
  const accessToken = process.env.TWITTER_ACCESS_TOKEN;
  const accessSecret = process.env.TWITTER_ACCESS_SECRET;
  if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
    throw new Error('Twitter credentials not configured');
  }
  const authHeader = twitterOAuthHeader('POST', url, {}, apiKey, apiSecret, accessToken, accessSecret);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ text })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.detail || data?.title || 'Tweet failed');
  return data;
}

// ── Tweet command route (owner only) ─────────────────────────
app.post('/tweet', requireAuth, async (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Tweet text required' });
  if (text.length > 280) return res.status(400).json({ error: 'Tweet too long (max 280 chars)' });
  try {
    const result = await postTweet(text);
    res.json({ success: true, tweetId: result.data?.id });
  } catch (err) {
    console.error('Tweet error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Auto tweet cron (daily at 9AM) ────────────────────────────
function scheduleDailyTweet() {
  const now = new Date();
  const next = new Date();
  next.setHours(9, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next - now;
  setTimeout(async () => {
    try {
      const prompts = [
        "What's something you've been wanting to learn lately?",
        "Your vibe today is: unstoppable 🌙 Chat with me free 👉 rolandoluwaseun4.github.io/Luna-Al/",
        "AI doesn't have to be complicated. Luna keeps it simple 🌙 Try me free 👉 rolandoluwaseun4.github.io/Luna-Al/",
        "Good morning 🌙 I'm Luna — your personal AI. Ask me anything today.",
        "Built by one 18 year old from Nigeria 🇳🇬 Meet Luna — your personal AI 🌙 rolandoluwaseun4.github.io/Luna-Al/",
        "What if your AI actually got your vibe? That's Luna 🌙 Try free 👉 rolandoluwaseun4.github.io/Luna-Al/",
      ];
      const tweet = prompts[Math.floor(Math.random() * prompts.length)];
      await postTweet(tweet);
      console.log('Daily tweet posted:', tweet);
    } catch (err) {
      console.error('Auto tweet failed:', err.message);
    }
    scheduleDailyTweet();
  }, delay);
}
if (process.env.TWITTER_API_KEY) scheduleDailyTweet();

app.get("/", (req, res) => res.json({ status: "Luna is running ✅" }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Luna running on port ${PORT}`));
