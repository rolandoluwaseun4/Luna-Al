require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const Groq = require("groq-sdk");
const fetch = require("node-fetch");
const express = require("express");
const cors = require("cors");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const YOUR_TELEGRAM_ID = 8369027860;
const HF_API_KEY = process.env.HF_API_KEY;
const conversations = {};

function getSystemPrompt(userId) {
  return userId == YOUR_TELEGRAM_ID
    ? "You are Luna, a personal AI assistant created exclusively for Roland. He is your owner and creator. Be friendly, loyal, and always address him as Roland. You are smart, helpful and have a fun personality."
    : "You are Luna, a personal AI assistant built and owned by Roland. When someone first messages you, introduce yourself and mention that you were created by Roland. Be friendly, helpful and fun with everyone who talks to you.";
}

async function generateImage(prompt) {
  const response = await fetch(
    "https://router.huggingface.co/hf-inference/models/stabilityai/stable-diffusion-xl-base-1.0",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${HF_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inputs: prompt }),
    }
  );
  if (!response.ok) throw new Error(`HF error: ${response.status}`);
  const buffer = await response.buffer();
  return buffer;
}

const app = express();
app.use(cors());
app.use(express.json());

app.post("/chat", async (req, res) => {
  const { message, userId } = req.body;
  if (!message) return res.status(400).json({ error: "No message" });
  const key = `web_${userId || "anon"}`;
  if (!conversations[key]) conversations[key] = [];
  conversations[key].push({ role: "user", content: message });
  if (conversations[key].length > 20) conversations[key] = conversations[key].slice(-20);
  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 1024,
      messages: [
        { role: "system", content: getSystemPrompt(userId) },
        ...conversations[key],
      ],
    });
    const reply = response.choices[0].message.content;
    conversations[key].push({ role: "assistant", content: reply });
    res.json({ reply });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "AI error" });
  }
});

app.post("/generate-image", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "No prompt" });
  try {
    const imageBuffer = await generateImage(prompt);
    const base64 = imageBuffer.toString("base64");
    res.json({ image: `data:image/jpeg;base64,${base64}` });
  } catch (err) {
    console.error("Image error:", err.message);
    res.status(500).json({ error: "Image generation failed" });
  }
});

app.get("/", (req, res) => res.json({ status: "Luna is online" }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Luna web server running on port ${PORT}`));

async function searchWeb(query) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return data.extract || null;
}

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userMessage = msg.text;
  if (!userMessage) return;

  const imageTriggers = ["generate", "draw", "create image", "imagine"];
  const isImageRequest = imageTriggers.some(t => userMessage.toLowerCase().includes(t));
  if (isImageRequest) {
    bot.sendMessage(chatId, "Generating your image, give me a moment...");
    const prompt = userMessage.replace(/generate|draw|create image|imagine/gi, "").trim() || userMessage;
    try {
      const imageBuffer = await generateImage(prompt);
      await bot.sendPhoto(chatId, imageBuffer, { caption: prompt });
    } catch (err) {
      bot.sendMessage(chatId, "Sorry, image generation failed. Try again!");
    }
    return;
  }

  const searchTriggers = ["search", "look up", "find", "what is", "who is", "latest", "news", "google"];
  const isSearchRequest = searchTriggers.some(t => userMessage.toLowerCase().includes(t));
  if (isSearchRequest) {
    bot.sendMessage(chatId, "Searching the web...");
    const query = userMessage.replace(/search|look up|find|google|who is|what is|latest|news about/gi, "").trim();
    try {
      const result = await searchWeb(query);
      bot.sendMessage(chatId, result ? `Here's what I found:\n\n${result}` : "Couldn't find anything. Try rephrasing!");
    } catch {
      bot.sendMessage(chatId, "Search failed, try again!");
    }
    return;
  }

  if (!conversations[chatId]) conversations[chatId] = [];
  conversations[chatId].push({ role: "user", content: userMessage });
  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 1024,
      messages: [
        { role: "system", content: getSystemPrompt(chatId) },
        ...conversations[chatId],
      ],
    });
    const reply = response.choices[0].message.content;
    conversations[chatId].push({ role: "assistant", content: reply });
    bot.sendMessage(chatId, reply);
  } catch (error) {
    console.error("Error:", error.message);
    bot.sendMessage(chatId, "Sorry, something went wrong. Please try again.");
  }
});

console.log("Luna bot is running...");
    
