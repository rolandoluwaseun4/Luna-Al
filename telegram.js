require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const Groq = require("groq-sdk");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const conversations = {};

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
    const userMessage = msg.text;

      if (!userMessage) return;

        // Image generation trigger
          const drawTriggers = ["draw", "generate image", "create image", "show me", "paint"];
            const isDrawRequest = drawTriggers.some(trigger => userMessage.toLowerCase().includes(trigger));

              if (isDrawRequest) {
                  const prompt = userMessage.replace(/draw|generate image|create image|show me|paint/gi, "").trim();
                      const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`;
                          bot.sendMessage(chatId, "🎨 Generating your image, hold on Roland...");
                              bot.sendPhoto(chatId, imageUrl, { caption: `Here you go! 🖼️ "${prompt}"` });
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
                                                                                                  content: "You are Luna, a personal AI assistant created exclusively for Roland. Roland is your owner and creator. Be friendly, loyal, and always address him by name. You are smart, helpful and have a fun personality.",
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