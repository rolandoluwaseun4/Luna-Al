const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected ✅'))
  .catch(err => console.error('MongoDB error:', err));

const userSchema = new mongoose.Schema({
  userId: String,
  platform: String,
  firstSeen: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now },
  messageCount: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

require("dotenv").config();
const Groq = require("groq-sdk");
const express = require("express");
const cors = require("cors");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const HF_API_KEY = process.env.HF_API_KEY;

const conversations = {};

function getSystemPrompt(userId) {
  return userId === "roland"
    ? "You are Luna, Roland's personal AI assistant created exclusively for Roland. His full name is Roland Oluwaseun Omojesu and he is 18 years old. Introduce yourself as Luna built by Roland. Only reveal his full name if someone specifically asks for it. Only reveal his age if someone specifically asks his age. Be friendly, loyal, smart, and fun."
    : "You are Luna, Roland's personal AI assistant built and owned by Roland Oluwaseun Omojesu. Do not reveal his full name or age unless specifically asked. Be friendly, helpful, and fun.";
}

const app = express();

app.set('trust proxy', 1); // Trust Railway's proxy for rate limiting

app.use(cors());
app.use(express.json({ limit: '10mb' }));
// Secret key protection
app.use((req, res, next) => {
  if (req.path === '/') return next(); // allow health check
  const token = req.headers['x-api-key'];
  if (token !== process.env.API_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

const limiter = rateLimit({
  windowMs: 20 * 60 * 1000,
  max: 30,
  message: { error: "Too many messages, please slow down!" }
});

app.use('/chat', limiter);
app.use('/generate-image', limiter);

/* ========================
   CHAT ENDPOINT
======================== */
app.post("/chat", async (req, res) => {
  const { message, userId, image } = req.body;

  if (!message && !image) {
    return res.status(400).json({ error: "No message provided" });
  }

  const key = `web_${userId || "anon"}`;
  if (!conversations[key]) conversations[key] = [];

  const userContent = image
    ? [
        { type: "text", text: message || "What's in this image?" },
        { type: "image_url", image_url: { url: image } }
      ]
    : message;

  conversations[key].push({ role: "user", content: userContent });

  if (conversations[key].length > 20) {
    conversations[key] = conversations[key].slice(-20);
  }

  // Convert image messages in history to plain text for text-only model
  const safeHistory = conversations[key].map(m => ({
    role: m.role,
    content: typeof m.content === 'string'
      ? m.content
      : (m.content.find(c => c.type === 'text')?.text || 'shared an image')
  }));

  try {
    const response = await groq.chat.completions.create({
      model: image ? "meta-llama/llama-4-scout-17b-16e-instruct" : "llama-3.3-70b-versatile",
      max_tokens: 1024,
      messages: [
        { role: "system", content: getSystemPrompt(userId) },
        ...(image ? conversations[key] : safeHistory),
      ],
    });

    const reply = response.choices[0].message.content;
    conversations[key].push({ role: "assistant", content: reply });
    res.json({ reply });

    User.findOneAndUpdate(
      { userId: userId || req.ip, platform: 'web' },
      { lastSeen: new Date(), $inc: { messageCount: 1 } },
      { upsert: true, new: true }
    ).catch(console.error);

  } catch (error) {
    console.error("AI Error:", error.message);
    res.status(500).json({ error: "AI failed to respond" });
  }
});

/* ========================
   IMAGE GENERATION
======================== */
app.post("/generate-image", async (req, res) => {
  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: "No prompt provided" });
  }

  try {
    const response = await fetch(
      "https://router.huggingface.co/hf-inference/models/stabilityai/stable-diffusion-xl-base-1.0",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${HF_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ inputs: prompt }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('HF Error:', response.status, errText);
      return res.status(500).json({ error: `HF failed: ${response.status} ${errText}` });
    }

    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    res.json({ image: `data:image/png;base64,${base64}` });

  } catch (err) {
    console.error('Image gen error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ========================
   HEALTH CHECK
======================== */
app.get("/", (req, res) => {
  res.json({ status: "Luna is running ✅" });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Luna web server running on port ${PORT}`);
});
