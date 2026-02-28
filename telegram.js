require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const Groq = require("groq-sdk");
const fetch = require("node-fetch");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const YOUR_TELEGRAM_ID = 8369027860;
const conversations = {};

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

                  const searchTriggers = ["search", "look up", "find", "what is", "who is", "latest", "news", "google"];
                    const isSearchRequest = searchTriggers.some(trigger => userMessage.toLowerCase().includes(trigger));

                      if (isSearchRequest) {
                          bot.sendMessage(chatId, "🔍 Searching the web...");
                              const query = userMessage.replace(/search|look up|find|google|who is|what is|latest|news about/gi, "").trim();
                                  try {
                                        const result = await searchWeb(query);
                                              if (result) {
                                                      bot.sendMessage(chatId, `🌐 Here's what I found:\n\n${result}`);
                                                            } else {
                                                                    bot.sendMessage(chatId, "Hmm, I couldn't find anything on that. Try rephrasing! 🤔");
                                                                          }
                                                                              } catch (err) {
                                                                                    bot.sendMessage(chatId, "Search failed, try again! 😅");
                                                                                        }
                                                                                            return;
                                                                                              }

                                                                                                if (!conversations[chatId]) {
                                                                                                    conversations[chatId] = [];
                                                                                                      }

                                                                                                        conversations[chatId].push({ role: "user", content: userMessage });

                                                                                                          try {
                                                                                                              const response = await groq.chat.completions.create({
                                                                                                                    model: "llama-3.3-70b-versatile",
                                                                                                                          max_tokens: 1024,
                                                                                                                                messages: [
                                                                                                                                        {
                                                                                                                                                  role: "system",
                                                                                                                                                            content: chatId === YOUR_TELEGRAM_ID
                                                                                                                                                                        ? "You are Luna, a personal AI assistant created exclusively for Roland. He is your owner and creator. Be friendly, loyal, and always address him as Roland. You are smart, helpful and have a fun personality."
                                                                                                                                                                                    : "You are Luna, a personal AI assistant built and owned by Roland. When someone first messages you, introduce yourself and mention that you were created by Roland. Be friendly, helpful and fun with everyone who talks to you.",
                                                                                                                                                                                            },
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