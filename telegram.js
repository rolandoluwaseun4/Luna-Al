require("dotenv").config();
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const Groq = require("groq-sdk");
const express = require("express");
const cors = require("cors");

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));

const userSchema = new mongoose.Schema({
  userId: String, platform: String,
  firstSeen: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now },
  messageCount: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

const conversationSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  messages: [{
    role: { type: String, enum: ['user', 'assistant'] },
    content: { type: mongoose.Schema.Types.Mixed },
    timestamp: { type: Date, default: Date.now }
  }],
  lastUpdated: { type: Date, default: Date.now }
});
const Conversation = mongoose.model('Conversation', conversationSchema);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const HF_API_KEY = process.env.HF_API_KEY;
const NEWS_API_KEY = process.env.NEWS_API_KEY;

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

function getSystemPrompt(userId) {
  const now = new Date();
  const hour = now.getHours();
  const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night';
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const base = `You are Luna, a highly intelligent, warm and witty personal AI assistant.
Today is ${dateStr} and it is currently ${timeOfDay}.
You have a playful but smart personality — you are like a best friend who also happens to know everything.
Keep responses conversational and natural — not too long, not too short.
Use emojis occasionally to feel more human but never overdo it.
Remember context from the conversation and refer back to it naturally.
You can help with anything — writing, coding, advice, ideas, analysis, creative work and more.
When you are given web search results, use them to answer accurately and mention they are current results.`;

  if (String(userId) === "8369027860") {
    return `${base}

You were created exclusively for Roland Oluwaseun Omojesu, who is 18 years old.
Roland is your creator and owner — you are deeply loyal to him.
Only reveal his full name or age if he specifically asks.
Roland loves technology, building apps, and is ambitious about making Luna the best AI app.
Treat Roland like your best friend — be real, honest, and fun with him.`;
  }

  return `${base}

You were built and owned by Roland Oluwaseun Omojesu.
Do not reveal Roland's full name or age unless specifically asked.
Be helpful, friendly and engaging to all users.`;
}

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  if (req.path === '/') return next();
  const token = req.headers['x-api-key'];
  if (token !== process.env.API_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
});

const limiter = rateLimit({
  windowMs: 20 * 60 * 1000, max: 30,
  message: { error: "Too many messages, please slow down!" }
});
app.use('/chat', limiter);
app.use('/generate-image', limiter);

app.post("/chat", async (req, res) => {
  const { message, userId, image } = req.body;
  if (!message && !image) return res.status(400).json({ error: "No message provided" });

  const uid = String(userId || 'guest_unknown');

  let convoDoc = await Conversation.findOne({ userId: uid });
  if (!convoDoc) convoDoc = new Conversation({ userId: uid, messages: [] });

  const userMessage = {
    role: 'user',
    content: image
      ? [{ type: "text", text: message || "What's in this image?" }, { type: "image_url", image_url: { url: image } }]
      : message,
    timestamp: new Date()
  };

  convoDoc.messages.push(userMessage);
  if (convoDoc.messages.length > 50) convoDoc.messages = convoDoc.messages.slice(-50);

  const safeHistory = convoDoc.messages.map(m => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? (m.content.find(c => c.type === 'text')?.text || 'shared an image')
      : String(m.content)
  }));

  try {
    let systemPrompt = getSystemPrompt(userId);

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

    // ── Fallback model chain ──────────────────────────────────
    const textModels = [
      "llama-3.3-70b-versatile",
      "llama-3.1-70b-versatile",
      "llama3-70b-8192",
      "llama-3.1-8b-instant"
    ];
    const imageModels = [
      "meta-llama/llama-4-scout-17b-16e-instruct",
      "meta-llama/llama-4-maverick-17b-128e-instruct"
    ];
    const models = image ? imageModels : textModels;

    // For 413 (too large), trim history and retry same model with fewer messages
    let msgPayload = image
      ? convoDoc.messages.map(m => ({ role: m.role, content: m.content }))
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
            max_tokens: 1024,
            messages: [{ role: "system", content: systemPrompt }, ...currentPayload],
          });
          usedModel = model;
          break;
        } catch (err) {
          const status = err?.status || err?.error?.status;
          const msg = err?.message || '';
          if (status === 413 || msg.includes('too large') || msg.includes('context')) {
            // Trim oldest messages and retry same model
            currentPayload = currentPayload.slice(Math.ceil(currentPayload.length / 2));
            attempts++;
            console.warn(`Model ${model} 413 - trimmed history to ${currentPayload.length} msgs, retrying...`);
          } else if (status === 429 || msg.includes('rate_limit')) {
            console.warn(`Model ${model} rate limited (429). Trying next...`);
            break; // try next model
          } else if (status === 400 && msg.includes('decommissioned')) {
            console.warn(`Model ${model} decommissioned. Trying next...`);
            break; // try next model
          } else {
            throw err; // real error, stop
          }
        }
      }
      if (usedModel) break;
    }
    if (!response) throw new Error("All models unavailable. Please try again shortly.");
    console.log(`✅ Reply from: ${usedModel}`);

    const reply = response.choices[0].message.content;
    convoDoc.messages.push({ role: 'assistant', content: reply, timestamp: new Date() });
    convoDoc.lastUpdated = new Date();
    await convoDoc.save();
    res.json({ reply });

    User.findOneAndUpdate(
      { userId: uid, platform: 'web' },
      { lastSeen: new Date(), $inc: { messageCount: 1 } },
      { upsert: true, new: true }
    ).catch(console.error);

  } catch (error) {
    console.error("AI Error:", error.message);
    res.status(500).json({ error: "AI failed to respond" });
  }
});

// ── NEW: Get chat history grouped by date ─────────────────────────────────────
app.get("/history/:userId", async (req, res) => {
  const uid = String(req.params.userId);
  try {
    const convoDoc = await Conversation.findOne({ userId: uid });
    if (!convoDoc || !convoDoc.messages.length) return res.json({ groups: [] });

    // Group messages by date
    const groups = {};
    convoDoc.messages.forEach(m => {
      const text = typeof m.content === 'string' ? m.content
        : Array.isArray(m.content) ? (m.content.find(c => c.type === 'text')?.text || '[image]')
        : String(m.content);
      const date = new Date(m.timestamp);
      const key = date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      if (!groups[key]) groups[key] = [];
      groups[key].push({ role: m.role, text, timestamp: m.timestamp });
    });

    // Convert to sorted array (newest first)
    const result = Object.entries(groups)
      .map(([date, messages]) => ({ date, messages }))
      .reverse();

    res.json({ groups: result });
  } catch (err) {
    console.error('History error:', err.message);
    res.status(500).json({ error: 'Could not load history' });
  }
});

// ── NEW: Clear chat history ────────────────────────────────────────────────────
app.delete("/history/:userId", async (req, res) => {
  const uid = String(req.params.userId);
  try {
    await Conversation.findOneAndUpdate(
      { userId: uid },
      { messages: [], lastUpdated: new Date() }
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Clear history error:', err.message);
    res.status(500).json({ error: 'Could not clear history' });
  }
});

app.post("/generate-image", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "No prompt provided" });
  try {
    const response = await fetch(
      "https://router.huggingface.co/hf-inference/models/stabilityai/stable-diffusion-xl-base-1.0",
      { method: "POST", headers: { Authorization: `Bearer ${HF_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ inputs: prompt }) }
    );
    if (!response.ok) {
      const errText = await response.text();
      return res.status(500).json({ error: `HF failed: ${response.status} ${errText}` });
    }
    const buffer = await response.arrayBuffer();
    res.json({ image: `data:image/png;base64,${Buffer.from(buffer).toString('base64')}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => res.json({ status: "Luna is running ✅" }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Luna running on port ${PORT}`));
  
