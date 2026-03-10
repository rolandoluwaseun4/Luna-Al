# Luna-Al

> An AI that actually thinks before it responds. Revolutionary concept, we know.

Luna is a free, personal AI web app with real reasoning, image generation, web search, and memory. No subscription. No paywalls hiding basic features. No "upgrade to continue" after two messages.

Just open it and use it.

**[Try Luna →](https://luna-al.vercel.app)**

---

## What Luna can do

**Chat** — Conversations that don't feel like talking to a customer service bot. Luna reads context, remembers what you said, and responds like something that actually processed your message.

**Deep thinking** — For questions that deserve more than a confident-sounding guess, Luna reasons through the problem and shows you her thought process. Collapsible, so you don't have to read it if you don't want to.

**Web search** — Real-time information from the web, synthesized into an actual answer instead of a list of links you have to open yourself.

**Image generation** — Describe it, get it. Edit the last one, generate a new one, no separate tool required.

**File & PDF reading** — Upload a document, ask questions about it. Luna reads it. You don't have to.

**Memory** — Luna remembers things about you across conversations. Not in a surveillance way. In a "you don't have to re-explain yourself every session" way.

**Multiple models** — Luna Flash for fast responses, Luna Pro for harder problems, RO-1 for when you need serious reasoning power.

---

## Pricing

Free.

Not "free with 10 messages a day and then a popup." Free. Luna Pro features have a daily limit to keep the servers alive, but the core experience costs nothing.

---

## Stack

- **Frontend** — Vanilla HTML/CSS/JS, deployed on Vercel
- **Backend** — Node.js, deployed on Railway
- **Database** — MongoDB
- **Models** — Groq (Llama, Qwen, DeepSeek R1), Google Gemini
- **Image generation** — Pollinations AI
- **Web search** — Tavily, NewsAPI fallback

---

## Running locally

```bash
git clone https://github.com/rolandoluwaseun4/Luna-Al.git
cd Luna-Al
npm install
```

Create a `.env` file with your keys:

```env
GROQ_API_KEY=
GEMINI_API_KEY=
MONGODB_URI=
JWT_SECRET=
TAVILY_API_KEY=
```

Then:

```bash
node telegram.js
```

Open `index.html` in your browser or point it at `localhost:8080`.

---

## Contributing

Found a bug? Open an issue. Have an idea? Open a PR. The codebase is one person's work so it's not perfect, but it works — and it ships.

---

## License

MIT. Use it, learn from it, build on it. Just don't claim you built Luna from scratch.
