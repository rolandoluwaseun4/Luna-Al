require("dotenv").config();
const Groq = require("groq-sdk");
const fetch = require("node-fetch");
const express = require("express");
const cors = require("cors");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const HF_API_KEY = process.env.HF_API_KEY;

const conversations = {};

function getSystemPrompt(userId) {
  return userId === "roland"
    ? "You are Luna, a personal AI assistant created exclusively for Roland. Be friendly, loyal, smart, and fun."
    : "You are Luna, a personal AI assistant built and owned by Roland. Be friendly, helpful, and fun.";
}

const app = express();

app.use(cors({
  origin: ["https://rolandolumaseun4.github.io", "https://rolandolumaseun4.github.io/Luna-AI"]
}));

app.use(express.json());

/* =========================
   CHAT ENDPOINT
========================= */
app.post("/chat", async (req, res) => {
  const { message, userId } = req.body;

  if (!message) {
    return res.status(400).json({ error: "No message provided" });
  }

  const key = `web_${userId || "anon"}`;

  if (!conversations[key]) conversations[key] = [];

  conversations[key].push({ role: "user", content: message });

  if (conversations[key].length > 20) {
    conversations[key] = conversations[key].slice(-20);
  }

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

  } catch (error) {
    console.error("AI Error:", error.message);
    res.status(500).json({ error: "AI failed to respond" });
  }
});

/* =========================
   IMAGE GENERATION
========================= */
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
      return res.status(500).json({ error: `HF failed: ${errText}` });
    }

    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");

    res.json({ image: `data:image/png;base64,${base64}` });

  } catch (error) {
    console.error("Image generation error:", error.message);
    res.status(500).json({ error: "Image generation failed" });
  }
});

/* =========================
   ROOT CHECK
========================= */
app.get("/", (req, res) => {
  res.json({ status: "Luna Web AI is online" });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Luna web server running on port ${PORT}`);
});
