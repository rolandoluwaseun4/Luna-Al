const fs = require('fs');
let code = fs.readFileSync('telegram.js', 'utf8');

const imageFunc = `
async function generateImage(prompt) {
  const url = \`https://image.pollinations.ai/prompt/\${encodeURIComponent(prompt)}?width=512&height=512&nologo=true\`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const buffer = await res.buffer();
    return buffer;
  } catch(e) {
    clearTimeout(timeout);
    return null;
  }
}
`;

const imageTrigger = `
  const imageTriggers = ["generate", "draw", "create image", "imagine"];
  const isImageRequest = imageTriggers.some(t => userMessage.toLowerCase().includes(t));
  if (isImageRequest) {
    bot.sendMessage(chatId, "🎨 Generating your image, give me a moment...");
    const prompt = userMessage.replace(/generate|draw|create image|imagine/gi, "").trim() || userMessage;
    const imageBuffer = await generateImage(prompt);
    if (imageBuffer) {
      await bot.sendPhoto(chatId, imageBuffer, { caption: \`🖼️ \${prompt}\` });
    } else {
      bot.sendMessage(chatId, "Sorry, image generation timed out. Try a simpler prompt! 😅");
    }
    return;
  }
`;

code = code.replace('bot.on("message"', imageFunc + '\nbot.on("message"');
code = code.replace('  if (!conversations[chatId])', imageTrigger + '\n  if (!conversations[chatId])');
fs.writeFileSync('telegram.js', code);
console.log("Patch applied!");
