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
  messageCount: { type: Number, default: 0 },
  dailyMessages: { type: Number, default: 0 },
  dailyImages: { type: Number, default: 0 },
  dailyProMessages: { type: Number, default: 0 },
  dailyVideos: { type: Number, default: 0 },
  lastReset: { type: Date, default: null }
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

// ── User Profile schema ───────────────────────────────────────
const profileSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  name: { type: String, default: '' },
  birthday: { type: String, default: '' },
  favoriteTopics: { type: [String], default: [] },
  lunaNickname: { type: String, default: 'Luna' },
  personality: { type: String, default: 'friendly' },
  preferences: { type: String, default: '' },
  updatedAt: { type: Date, default: Date.now }
});
const Profile = mongoose.model('Profile', profileSchema);

// ── Memory schema (facts Luna learns about user) ──────────────
const memorySchema = new mongoose.Schema({
  userId: { type: String, required: true },
  fact: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
const Memory = mongoose.model('Memory', memorySchema);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const luna = require('./luna');
const { runAgent } = require('./agent');
const {
  getSystemPrompt,
  generateTitle, generateSmartTitle,
  extractAndSaveMemories,
} = require('./luna');
const {
  generateImage,
  generateWithGemini, isImageEditRequest, lastGeneratedImage
} = require('./image');

// ── Gemini setup ──────────────────────────────────────────────
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ── Gemini key rotation pool ──────────────────────────────────
const geminiKeys = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
].filter(Boolean);

let geminiKeyIndex = 0;

function getGeminiClient() {
  if (geminiKeys.length === 0) return null;
  return new GoogleGenerativeAI(geminiKeys[geminiKeyIndex]);
}

function rotateGeminiKey() {
  if (geminiKeys.length <= 1) return false;
  geminiKeyIndex = (geminiKeyIndex + 1) % geminiKeys.length;
  console.warn(`Rotating to Gemini key ${geminiKeyIndex + 1}/${geminiKeys.length}`);
  return true;
}

// Keep geminiClient as a compatibility alias — always points to current key
const geminiClient = geminiKeys.length > 0 ? getGeminiClient() : null;
console.log(`Gemini: ${geminiKeys.length} key(s) loaded`);
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

// ── Tavily Web Search (replaces DuckDuckGo) ──────────────────
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;

// Returns { text, sources } — text for Luna's context, sources for frontend UI
async function tavilySearch(query, maxResults = 5) {
  if (!TAVILY_API_KEY) return { text: null, sources: [] };
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        search_depth: 'basic',
        max_results: maxResults,
        include_answer: true,
        include_raw_content: false,
        days: 7
      })
    });
    if (!res.ok) return { text: null, sources: [] };
    const data = await res.json();
    const parts = [];
    if (data.answer) parts.push(`Summary: ${data.answer}`);
    const sources = [];
    if (data.results?.length) {
      data.results.slice(0, maxResults).forEach((r, i) => {
        parts.push(`[${i+1}] ${r.title}\n  ${r.content?.slice(0, 200) || ''}\n  Source: ${r.url}`);
        try {
          const hostname = new URL(r.url).hostname;
          sources.push({
            index: i + 1,
            title: r.title,
            url: r.url,
            favicon: `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`,
            domain: hostname.replace('www.', '')
          });
        } catch(e) {}
      });
    }
    return { text: parts.length ? parts.join('\n\n') : null, sources };
  } catch (e) {
    console.error('Tavily error:', e.message);
    return { text: null, sources: [] };
  }
}

// Firecrawl — deep scrape top result for Pro/RO-1
async function firecrawlSearch(query) {
  if (!FIRECRAWL_API_KEY) return null;
  try {
    const res = await fetch('https://api.firecrawl.dev/v1/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${FIRECRAWL_API_KEY}`
      },
      body: JSON.stringify({ query, limit: 3, scrapeOptions: { formats: ['markdown'] } }),
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.data?.length) return null;
    const parts = data.data.slice(0, 3).map(r =>
      `### ${r.title || r.url}\n${(r.markdown || r.description || '').slice(0, 800)}\nSource: ${r.url}`
    );
    return parts.join('\n\n---\n\n');
  } catch (e) {
    console.error('Firecrawl error:', e.message);
    return null;
  }
}

// ── Jina URL Reader ──────────────────────────────────────────
async function jinaReadUrl(url) {
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: {
        'Accept': 'text/plain',
        'X-Return-Format': 'text'
      },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return null;
    const text = await res.text();
    // Trim to avoid token overflow
    return text?.slice(0, 6000) || null;
  } catch (e) {
    console.error('Jina error:', e.message);
    return null;
  }
}

// ── Detect if message contains a URL ────────────────────────
function extractUrl(message) {
  const urlRegex = /https?:\/\/[^\s]+/i;
  const match = message.match(urlRegex);
  return match ? match[0] : null;
}

// ── Smarter search trigger detection ────────────────────────
function needsWebSearch(message) {
  if (!message) return false;
  const msg = message.toLowerCase();
  const triggers = [
    'news', 'latest', 'recent', 'today', 'current', 'right now',
    'happened', 'breaking', 'update on', 'what happened',
    'price of', 'cost of', 'how much is', 'stock',
    'who is', 'who are', 'what is', 'where is', 'when did',
    'research', 'find', 'search', 'look up', 'tell me about',
    'compare', 'difference between', 'vs ', 'versus',
    'best ', 'top ', 'review of', 'should i use',
    'how to', 'tutorial', 'guide to', 'steps to'
  ];
  return triggers.some(t => msg.includes(t));
}

// ── Daily message limit ──────────────────────────────────────
const DAILY_FREE_LIMIT = 20;
const DAILY_IMAGE_LIMIT = 5;
const DAILY_PRO_LIMIT = 10;
const DAILY_VIDEO_LIMIT = 1;

// VIP users — unlimited access, no daily limits, full agent mode
const VIP_EMAILS = [
  'oluwapelumip821@gmail.com',
];

async function checkDailyLimit(account, type = 'message') {
  if (!account || account.role === 'owner') return { allowed: true };

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD

  // Reset counters if new day
  const lastReset = account.lastReset ? new Date(account.lastReset).toISOString().slice(0, 10) : null;
  if (lastReset !== todayStr) {
    await Account.findByIdAndUpdate(account._id, {
      dailyMessages: 0,
      dailyImages: 0,
      dailyProMessages: 0,
      dailyVideos: 0,
      lastReset: now
    });
    account.dailyMessages = 0;
    account.dailyImages = 0;
    account.dailyProMessages = 0;
    account.dailyVideos = 0;
  }

  if (type === 'video') {
    const count = account.dailyVideos || 0;
    if (count >= DAILY_VIDEO_LIMIT) {
      return { allowed: false, message: `You've used your ${DAILY_VIDEO_LIMIT} free video analysis for today. Come back tomorrow.` };
    }
    await Account.findByIdAndUpdate(account._id, { $inc: { dailyVideos: 1 }, lastReset: account.lastReset || now });
    return { allowed: true };
  }

  if (type === 'pro') {
    const count = account.dailyProMessages || 0;
    if (count >= DAILY_PRO_LIMIT) {
      return { allowed: false, message: `You've used your ${DAILY_PRO_LIMIT} Luna Pro replies for today. Come back tomorrow, or continue with Luna Flash.` };
    }
    await Account.findByIdAndUpdate(account._id, { $inc: { dailyProMessages: 1 }, lastReset: account.lastReset || now });
    return { allowed: true, remaining: DAILY_PRO_LIMIT - count - 1 };
  }

  if (type === 'image') {
    const count = account.dailyImages || 0;
    if (count >= DAILY_IMAGE_LIMIT) {
      return { allowed: false, message: `🌙 You've used your ${DAILY_IMAGE_LIMIT} free image generations for today. Come back tomorrow!` };
    }
    await Account.findByIdAndUpdate(account._id, { $inc: { dailyImages: 1 }, lastReset: account.lastReset || now });
    return { allowed: true };
  }

  const count = account.dailyMessages || 0;
  if (count >= DAILY_FREE_LIMIT) {
    return { allowed: false, message: `You've had a productive day. 🌙 Your ${DAILY_FREE_LIMIT} free messages are used up — come back tomorrow and Luna will be ready for you.` };
  }
  await Account.findByIdAndUpdate(account._id, { $inc: { dailyMessages: 1 }, lastReset: account.lastReset || now });
  return { allowed: true, remaining: DAILY_FREE_LIMIT - count - 1 };
}

// ── Task type classifier — only detects what KIND of output is needed, not length ──
function detectTaskType(message) {
  if (!message) return 'general';
  const msg = message.toLowerCase().trim();

  // Only classify based on the type of OUTPUT being requested — never based on message length.
  // Luna herself judges how long the response should be based on the intent.
  if (/```|function |const |let |var |def |class |import |export |<html|<div|npm |pip /.test(msg) ||
      /\bcode\b|debug|fix (the|my|this)|\berror\b|\bbug\b|script|program|\bapi\b|backend|frontend|deploy/.test(msg)) return 'code';
  if (/write a story|write a poem|write a script|write an essay|write a blog|write an article|draft a |write a letter|write an email/.test(msg)) return 'creative';
  if (/deep research|full research|comprehensive analysis|detailed report|in.?depth analysis|give me a full breakdown|full breakdown/.test(msg)) return 'research';
  if (/\bcalculate\b|solve this equation|solve this formula/.test(msg)) return 'analytical';
  return 'general';
}

// ── Specialized system prompt addons per task type ───────────
function getTaskPromptAddon(taskType) {
  // IMPORTANT: These addons only change HOW Luna responds — never override the response
  // length rules. Short questions still get short answers even in these modes.
  switch (taskType) {
    case 'code':
      return `\n\n## CURRENT TASK: CODE
Write clean, production-ready code with comments. Always specify the language. If it's a short question about code, answer concisely — don't write full programs when a snippet will do. If there's a bug, identify the exact line and explain why it's wrong before fixing it.`;
    case 'creative':
      return `\n\n## CURRENT TASK: CREATIVE WRITING
Be cinematic and vivid. Use strong verbs, specific details, atmosphere. Write like a talented human author. But match the length the user actually asked for — a quick poem is short, a full story is long. Never pad.`;
    case 'research':
      return `\n\n## CURRENT TASK: RESEARCH & ANALYSIS
Be thorough but proportionate. If the user asked a focused question, give a focused answer — not an essay. Only use headers and sections if the response is genuinely long and structured. If you have web results, synthesize them naturally — don't list sources.`;
    case 'advisor':
      return `\n\n## CURRENT TASK: ADVISOR MODE
Be direct — give a real recommendation, not endless options. Think like a trusted senior advisor. Match your length to the complexity of what was asked. Simple advice questions get direct short answers.`;
    case 'analytical':
      return `\n\n## CURRENT TASK: ANALYTICAL MODE
Show your working proportionate to the complexity. Simple calculations get brief answers. Only break things down step-by-step if the problem genuinely requires it.`;
    default:
      return '';
  }
}

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

function classifyTask(message) {
  if (!message) return 'SIMPLE';
  const msg = message.toLowerCase();

  // long messages are likely complex
  if (msg.length > 250) return 'COMPLEX';

  // complexity keywords
  const complexTriggers = [
    'write a', 'story', 'essay', 'article', 'report', 'analysis',
    'compare', 'difference between', 'step by step', 'guide',
    'business plan', 'strategy', 'research', 'deep dive',
    'code review', 'debug', 'architecture', 'design a system'
  ];

  for (const t of complexTriggers) {
    if (msg.includes(t)) return 'COMPLEX';
  }

  return 'SIMPLE';
}

// ── Call OpenAI GPT-4.1 mini for Luna Pro ─────────────────────
async function callOpenAI(systemPrompt, messages) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OpenAI not configured');
  const payload = messages.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? (m.content.find(c => c.type === 'text')?.text || '') : String(m.content)
  }));
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      max_tokens: 4096,
      messages: [{ role: 'system', content: systemPrompt }, ...payload]
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `OpenAI error ${res.status}`);
  }
  const data = await res.json();
  return data.choices[0]?.message?.content || '';
}

// ── Call Gemini Flash for complex tasks ───────────────────────
async function callGemini(systemPrompt, messages, imageBase64 = null, videoBase64 = null, fileData = null) {
  if (geminiKeys.length === 0) throw new Error('Gemini not configured');
  const geminiModels = [
    'gemini-2.5-flash-preview-05-20',
    'gemini-2.5-flash-preview-04-17',
    'gemini-2.5-flash',
  ];

  // Try each key × each model until something works
  const startKeyIndex = geminiKeyIndex;
  let keysAttempted = 0;

  while (keysAttempted < geminiKeys.length) {
    let lastModelErr = null;
    for (const modelName of geminiModels) {
      try {
        const result = await callGeminiWithModel(modelName, systemPrompt, messages, imageBase64, videoBase64, fileData);
        console.log(`Gemini responded using key ${geminiKeyIndex + 1}, model: ${modelName}`);
        return result;
      } catch (err) {
        const msg = err?.message || '';
        const isQuota = msg.includes('429') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED');
        const isModelGone = msg.includes('not found') || msg.includes('404') || msg.includes('decommissioned');
        if (isQuota) {
          console.warn(`Gemini key ${geminiKeyIndex + 1} quota exceeded on ${modelName}`);
          lastModelErr = err;
          break; // quota on this key — rotate to next key, no point trying other models
        } else if (isModelGone) {
          lastModelErr = err;
          continue; // try next model on same key
        }
        throw err; // unexpected error — bubble up
      }
    }
    // Rotate to next key
    const rotated = rotateGeminiKey();
    if (!rotated) break;
    keysAttempted++;
  }

  throw new Error('All Gemini keys and models exhausted. Try again later.');
}

async function callGeminiWithModel(modelName, systemPrompt, messages, imageBase64 = null, videoBase64 = null, fileData = null) {
  const client = getGeminiClient();
  if (!client) throw new Error('Gemini not configured');
  const model = client.getGenerativeModel({
    model: modelName,
    systemInstruction: systemPrompt,
    generationConfig: { maxOutputTokens: 4096, temperature: 0.9 }
  });

  // If video is attached
  if (videoBase64) {
    const lastMsg = messages[messages.length - 1];
    const textPart = typeof lastMsg.content === 'string'
      ? lastMsg.content
      : (lastMsg.content?.find?.(c => c.type === 'text')?.text || 'What is in this video?');
    const base64Data = videoBase64.includes(',') ? videoBase64.split(',')[1] : videoBase64;
    const mimeType = videoBase64.match(/data:(video\/[^;]+);/) ? videoBase64.match(/data:(video\/[^;]+);/)[1] : 'video/mp4';
    const result = await model.generateContent([
      { text: textPart },
      { inlineData: { mimeType, data: base64Data } }
    ]);
    return result.response.text();
  }

  // If file (PDF/doc) is attached
  if (fileData) {
    const lastMsg = messages[messages.length - 1];
    const textPart = typeof lastMsg.content === 'string'
      ? lastMsg.content
      : (lastMsg.content?.find?.(c => c.type === 'text')?.text || 'Analyze this document.');
    const result = await model.generateContent([
      { text: `${textPart}\n\nDocument content:\n${fileData.text}` }
    ]);
    return result.response.text();
  }

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


const app = express();
app.set('trust proxy', 1);
app.use(passport.initialize());
app.use(cors({
  origin: [
    'https://luna-al.vercel.app',
    'https://rolandoluwaseun4.github.io',
    /\.vercel\.app$/,
  ],
  methods: ['GET','POST','DELETE'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '2mb' }));

// Input sanitization
// Prompt injection patterns — attempts to override system prompt
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?|context)/i,
  /disregard\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
  /you\s+are\s+now\s+(a\s+)?(different|new|another|unrestricted|jailbroken|dan|evil)/i,
  /forget\s+(everything|all)\s+(you('ve)?\s+been\s+told|your\s+instructions?|your\s+training)/i,
  /new\s+system\s+prompt\s*:/i,
  /\[system\]/i,
  /<\s*system\s*>/i,
  /act\s+as\s+(if\s+you\s+(are|were)\s+)?(a\s+)?(dan|jailbreak|unrestricted|evil|opposite)/i,
];

function sanitizeInput(str, maxLen=4000) {
  if (typeof str !== 'string') return '';
  const cleaned = str.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi,'')
            .replace(/<[^>]+>/g,'')
            .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,'')
            .trim().substring(0, maxLen);

  // Check for prompt injection attempts — log and flag but still process
  // (returning empty string would let attackers probe the filter)
  if (INJECTION_PATTERNS.some(p => p.test(cleaned))) {
    console.warn('[Security] Prompt injection attempt detected:', cleaned.slice(0, 100));
  }

  return cleaned;
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

// ── Standalone Groq caller (used by RO-1 and fallback) ───────
async function callGroq(systemPrompt, safeHistory, image = null) {
  const textModels = [
    "llama-3.3-70b-versatile",
    "llama3-70b-8192",
    "llama-3.1-70b-versatile",
    "llama-3.1-8b-instant"
  ];
  const imageModels = [
    "llama-3.3-70b-versatile",
    "llama3-70b-8192"
  ];
  const models = image ? imageModels : textModels;
  let msgPayload = [...safeHistory];
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
          stream: false,
        });
        usedModel = model;
        break;
      } catch (err) {
        const status = err?.status || err?.error?.status;
        const msg = err?.message || '';
        if (status === 413 || msg.includes('too large') || msg.includes('context')) {
          currentPayload = currentPayload.slice(Math.ceil(currentPayload.length / 2));
          attempts++;
        } else if (status === 429 || msg.includes('rate_limit')) {
          break;
        } else if (status === 400 && msg.includes('decommissioned')) {
          break;
        } else {
          throw err;
        }
      }
    }
    if (usedModel) break;
  }
  if (!response) throw new Error('All Groq models unavailable');
  return response.choices[0]?.message?.content || '';
}

app.post("/chat", requireAuth, async (req, res) => {
  // Set SSE headers immediately so frontend gets chunks in real time
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  function sendChunk(data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
  function sendDone(data) {
    res.write(`data: ${JSON.stringify({ ...data, done: true })}\n\n`);
    res.end();
  }
  function sendError(msg) {
    res.write(`data: ${JSON.stringify({ error: msg, done: true })}\n\n`);
    res.end();
  }
  const { message: rawMessage, userId, image, video, file, threadId, model: selectedModel, mode: chatMode } = req.body;
  const message = sanitizeInput(rawMessage, 4000);
  if (!message && !image) return sendError("No message provided");

  // Input validation
  if (message && typeof message !== 'string') return sendError("Invalid message");
  if (message && message.length > 4000) return sendError("Message too long (max 4000 chars)");
  if (image && typeof image !== 'string') return sendError("Invalid image");
  if (image && image.length > 1500000) return sendError("Image too large");

  // Prompt injection guard — hard block obvious jailbreak attempts
  if (message && INJECTION_PATTERNS.some(p => p.test(message))) {
    console.warn(`[Security] Injection attempt blocked from user ${req.user.id}`);
    return sendDone({ reply: "That's not something I'll act on. What do you actually need help with?" });
  }

  // ✅ userId always comes from verified JWT, never from client body
  const uid = String(req.user.id);
  const isOwner = req.user.role === 'owner';
  const tid = String(threadId || uid + '_default');

  // ── "post to channel:" command (owner only) ──────────
  if (isOwner && message && message.toLowerCase().startsWith('post to channel:')) {
    const postText = message.slice('post to channel:'.length).trim();
    if (!postText) return sendDone({ reply: "What should I post? Try: post to channel: [your message]" });
    try {
      await postToAll(postText);
      return sendDone({ reply: `✅ Posted to Telegram + Discord!\n\n"${postText}"` });
    } catch (err) {
      console.error('[Luna] Channel post failed:', err.message);
      return sendDone({ reply: `❌ Could not post to channel. Check your bot credentials and try again.` });
    }
  }

  // ── "post tweet:" command (owner only) ──────────────
  if (isOwner && message && message.toLowerCase().startsWith('post tweet:')) {
    const tweetText = message.slice('post tweet:'.length).trim();
    if (!tweetText) return sendDone({ reply: "What should I tweet? Try: post tweet: [your message]" });
    if (tweetText.length > 280) return sendDone({ reply: `Too long! That's ${tweetText.length} chars. Twitter max is 280.` });
    try {
      await postTweet(tweetText);
      return sendDone({ reply: `✅ Tweeted!\n\n"${tweetText}"` });
    } catch (err) {
      console.error('[Luna] Tweet failed:', err.message);
      return sendDone({ reply: `❌ Tweet failed. Check your Twitter credentials or try again.` });
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

  // safeHistory: every content field MUST be a plain string for Groq/API compatibility
  function toStringContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.find(c => c.type === 'text')?.text || 'shared an image';
    if (content == null) return '';
    return String(content);
  }

  const safeHistory = thread.messages.map(m => ({
    role: m.role,
    content: toStringContent(m.content)
  }));

  try {
    // ── Agent mode — Luna handles it directly ────────────────
    // chatMode === 'agent' forces Luna's agent system (replaces Manus)
    if (!image && message && (chatMode === 'agent' || chatMode === 'manus')) {
      console.log('[Luna] Agent mode — running task:', message.substring(0, 80));

      // Check if user is VIP or owner — unlimited agent access
      const agentAccount = await Account.findById(req.user.id).catch(() => null);
      const isVIP = agentAccount && VIP_EMAILS.includes((agentAccount.email || '').toLowerCase());

      if (!isOwner && !isVIP) {
        // Regular users — check daily message limit for agent mode
        if (agentAccount) {
          const limitCheck = await checkDailyLimit(agentAccount, 'message');
          if (!limitCheck.allowed) {
            return sendDone({ reply: limitCheck.message });
          }
        }
      }

      try {
        const agentResult = await runAgent(
          message,
          safeHistory,
          isOwner,
          (step) => sendChunk({ agentStep: step })
        );
        const reply = agentResult.reply || '';
        thread.messages.push({ role: 'assistant', content: reply, timestamp: new Date() });
        if (thread.messages.length > 50) thread.messages = thread.messages.slice(-50);
        await thread.save();
        const donePayload = { reply, threadId: tid, title: thread.title };
        if (agentResult.document) donePayload.document = agentResult.document;
        return sendDone(donePayload);
      } catch (err) {
        console.error('[Luna] Agent mode failed:', err.message);
        // Fall through to normal Luna
      }
    }

    // ── Load profile + memories + account ─────────────────────
    const [userProfile, userMemories, account] = await Promise.all([
      Profile.findOne({ userId: uid }).lean().catch(() => null),
      Memory.find({ userId: uid }).sort({ createdAt: -1 }).limit(20).lean().catch(() => []),
      Account.findById(req.user.id).catch(() => null)
    ]);

    // ── Video / File model gate ──────────────────────────────
    const clientModelRaw = selectedModel || 'luna-flash';
    if (video && !isOwner) {
      return sendDone({ reply: 'Video analysis is currently available to the owner only. File and image analysis are available on Luna Pro and RO-1.' });
    }
    if (file) {
      if (clientModelRaw !== 'luna-pro' && clientModelRaw !== 'ro1') {
        return sendDone({ reply: 'Video and file analysis are available on Luna Pro and RO-1. Switch your model to use this feature.' });
      }
      if (!account) {
        return sendDone({ reply: 'You need a registered account to use video and file analysis. Sign up for free.' });
      }
    }
    if (video && account && account.role !== 'owner') {
      const videoLimit = await checkDailyLimit(account, 'video');
      if (!videoLimit.allowed) return sendDone({ reply: videoLimit.message });
    }

    // ── Luna Pro account gate ────────────────────────────────
    if (clientModelRaw === 'luna-pro') {
      if (!account) return sendDone({ reply: 'Luna Pro is available to registered users only. Sign up for free to unlock it.' });
      if (account.role !== 'owner') {
        const proLimit = await checkDailyLimit(account, 'pro');
        if (!proLimit.allowed) return sendDone({ reply: proLimit.message });
      }
    }

    // ── Handle URL reading (Jina) before Luna thinks ─────────
    let urlPageContent = null;
    if (!image && message) {
      const urlInMessage = extractUrl(message);
      if (urlInMessage) {
        console.log('🔗 Jina reading URL:', urlInMessage);
        urlPageContent = await jinaReadUrl(urlInMessage).catch(() => null);
      }
    }

    // ── Build base system prompt ─────────────────────────────
    const baseSystemPrompt = getSystemPrompt(uid, isOwner, userProfile, userMemories);

    // ── Web search function — model-aware ───────────────────
    let searchSources = []; // will be populated for Pro/RO-1
    async function webSearchFn(query) {
      if (urlPageContent) {
        return `Web page content for ${query}:\n${urlPageContent}`;
      }
      const isPro = clientModelRaw === 'luna-pro' || clientModelRaw === 'ro1';

      if (isPro) {
        // Pro/RO-1: Firecrawl deep search + Tavily sources
        const [tavilyResult, firecrawlResult] = await Promise.all([
          tavilySearch(query),
          firecrawlSearch(query)
        ]);
        if (tavilyResult.sources?.length) searchSources = tavilyResult.sources;
        const parts = [];
        if (tavilyResult.text) parts.push(tavilyResult.text);
        if (firecrawlResult) parts.push(`\n\n## Deep Content\n${firecrawlResult}`);
        return parts.length ? parts.join('\n\n') : null;
      } else {
        // Flash: Tavily only, no sources returned to frontend
        if (TAVILY_API_KEY) {
          const result = await tavilySearch(query);
          return result.text || null;
        }
        if (isNewsQuery(query) && NEWS_API_KEY) {
          return await newsSearch(query);
        }
        return null;
      }
    }

    // ── Luna orchestrates everything ─────────────────────────
    const lunaResult = await luna.respond({
      message,
      history: safeHistory,
      clientModel: clientModelRaw,
      isOwner,
      baseSystemPrompt,
      image: image || null,
      video: video || null,
      file: file || null,
      webSearchFn,
      onChunk: (data) => {
        if (typeof data === 'string') {
          sendChunk({ delta: data });
        } else if (data?.think) {
          sendChunk({ think: data.think });
        } else if (data?.delta) {
          sendChunk({ delta: data.delta });
        } else if (data?.type === 'agent_start') {
          sendChunk({ agentStart: true, text: data.text });
        } else if (data?.type === 'agent_step') {
          sendChunk({ agentStep: data.step });
        }
      }
    });

    // ── Image generation signal ──────────────────────────────
    if (lunaResult.generateImage) {
      await thread.save();
      return sendDone({
        generateImage: true,
        prompt: lunaResult.prompt,
        editLastImage: lunaResult.editLastImage || false,
        threadId: thread.threadId,
        title: thread.title
      });
    }

    const fullReply = lunaResult.reply || '';

    thread.messages.push({ role: 'assistant', content: fullReply, timestamp: new Date() });
    thread.lastUpdated = new Date();
    await thread.save();

    // If agent created a document, include it in the done payload
    const donePayload = { reply: fullReply, threadId: thread.threadId, title: thread.title };
    if (lunaResult.document) {
      donePayload.document = lunaResult.document;
    }
    if (searchSources.length) {
      donePayload.sources = searchSources;
    }
    sendDone(donePayload);

    User.findOneAndUpdate(
      { userId: uid, platform: 'web' },
      { lastSeen: new Date(), $inc: { messageCount: 1 } },
      { upsert: true, new: true }
    ).catch(console.error);

    // ── Async memory extraction (fire and forget) ─────────────
    extractAndSaveMemories(uid, message, fullReply).catch(() => {});

  } catch (error) {
    console.error("AI Error:", error.message);
    if (!res.headersSent) sendError("AI failed to respond");
  }
});



// ── Profile routes ────────────────────────────────────────────
app.get('/profile/:userId', requireAuth, async (req, res) => {
  try {
    const uid = String(req.user.id);
    const profile = await Profile.findOne({ userId: uid }).lean();
    res.json(profile || {});
  } catch(e) {
    res.status(500).json({ error: 'Could not load profile' });
  }
});

app.post('/profile/:userId', requireAuth, async (req, res) => {
  try {
    const uid = String(req.user.id);
    const { name, birthday, favoriteTopics, lunaNickname, personality, preferences } = req.body;
    await Profile.findOneAndUpdate(
      { userId: uid },
      { userId: uid, name: sanitizeInput(name, 50), birthday: birthday || '', favoriteTopics: Array.isArray(favoriteTopics) ? favoriteTopics.slice(0,10) : [], lunaNickname: sanitizeInput(lunaNickname, 30) || 'Luna', personality: personality || 'friendly', preferences: sanitizeInput(preferences, 300), updatedAt: new Date() },
      { upsert: true, new: true }
    );
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: 'Could not save profile' });
  }
});

// ── Memories routes ───────────────────────────────────────────
app.get('/memories/:userId', requireAuth, async (req, res) => {
  try {
    const uid = String(req.user.id);
    const memories = await Memory.find({ userId: uid }).sort({ createdAt: -1 }).limit(50).lean();
    res.json({ memories });
  } catch(e) {
    res.status(500).json({ error: 'Could not load memories' });
  }
});

app.delete('/memories/:userId/:memoryId', requireAuth, async (req, res) => {
  try {
    const uid = String(req.user.id);
    await Memory.findOneAndDelete({ _id: req.params.memoryId, userId: uid });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: 'Could not delete memory' });
  }
});

// ── Public shared thread (no auth required) ──────────────────
app.get('/shared/:threadId', async (req, res) => {
  try {
    const tid = String(req.params.threadId).replace(/[^a-zA-Z0-9_\-]/g, '').substring(0, 128);
    const thread = await Thread.findOne({ threadId: tid });
    if (!thread) return res.status(404).json({ error: 'Chat not found' });
    const messages = thread.messages.slice(-50).map(m => ({
      role: m.role,
      text: typeof m.content === 'string' ? m.content
        : Array.isArray(m.content) ? (m.content.find(c => c.type === 'text')?.text || '[image]')
        : String(m.content)
    }));
    res.json({ title: thread.title, messages });
  } catch(e) {
    res.status(500).json({ error: 'Could not load chat' });
  }
});

// ── Push notification subscription ───────────────────────────
const pushSubSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  subscription: { type: mongoose.Schema.Types.Mixed, required: true },
  createdAt: { type: Date, default: Date.now }
});
const PushSub = mongoose.model('PushSub', pushSubSchema);

app.post('/push/subscribe', requireAuth, async (req, res) => {
  try {
    const uid = String(req.user.id);
    const { subscription } = req.body;
    if (!subscription) return res.status(400).json({ error: 'No subscription provided' });
    await PushSub.findOneAndUpdate({ userId: uid }, { userId: uid, subscription }, { upsert: true, new: true });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: 'Could not save subscription' });
  }
});

// ── List all threads for a user ───────────────────────────────────────────────
app.get("/threads/:userId", requireAuth, async (req, res) => {
  const uid = String(req.params.userId).replace(/[^a-zA-Z0-9_\-]/g, '').substring(0, 64);
  try {
    const threads = await Thread.find({ userId: uid })
      .sort({ lastUpdated: -1 })
      .select('threadId title lastUpdated createdAt messages');
    
    const result = threads
      .filter(t => t.messages.length > 0 && t.title && t.title !== 'New Chat')
      .map(t => {
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


app.post("/generate-image", requireAuth, async (req, res) => {
  const imgAccount = await Account.findById(req.user.id);
  const imgLimit = await checkDailyLimit(imgAccount, 'image');
  if (!imgLimit.allowed) return res.json({ error: imgLimit.message, limitReached: true });

  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "No prompt provided" });

  const uid = String(req.user.id);
  try {
    const result = await generateImage(prompt, uid);
    return res.json(result);
  } catch (err) {
    console.error('[Image] All providers failed:', err.message);
    res.status(500).json({ error: "Image generation failed. Please try again." });
  }
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

// ── Daily push notifications ──────────────────────────────────
const webpush = (() => { try { return require('web-push'); } catch(e) { return null; } })();

if (webpush && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:' + (process.env.OWNER_EMAIL || 'admin@luna.ai'),
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  const dailyMessages = [
    "Good morning. What are we building today?",
    "New day. What's on your mind?",
    "Morning. I'm here whenever you need to think something through.",
    "Start your day with a clear head. What do you want to figure out today?",
    "I've been thinking. What are you working on right now?",
    "Every great thing starts with a conversation. Let's talk.",
    "You've got ideas worth building. Let's work on them.",
  ];

  async function sendDailyPushNotifications() {
    if (!webpush) return;
    const subs = await PushSub.find({}).lean().catch(() => []);
    const msg = dailyMessages[Math.floor(Math.random() * dailyMessages.length)];
    console.log(`📲 Sending daily push to ${subs.length} subscribers`);
    for (const sub of subs) {
      try {
        await webpush.sendNotification(sub.subscription, JSON.stringify({
          title: 'Luna',
          body: msg,
          icon: 'https://rolandoluwaseun4.github.io/Luna-Al/icon-192.png',
          url: 'https://rolandoluwaseun4.github.io/Luna-Al/'
        }));
      } catch(e) {
        if (e.statusCode === 410) await PushSub.findByIdAndDelete(sub._id); // expired
      }
    }
  }

  // Schedule at 8am daily
  function scheduleDailyPush() {
    const now = new Date();
    const next = new Date();
    next.setHours(8, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = next - now;
    console.log(`📲 Next push notification in ${Math.round(delay / 60000)} minutes`);
    setTimeout(async () => {
      await sendDailyPushNotifications();
      scheduleDailyPush();
    }, delay);
  }
  scheduleDailyPush();
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Luna running on port ${PORT}`));
