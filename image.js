'use strict';

/**
 * image.js — Luna's Image Intelligence Module
 *
 * Handles ALL image work: generation, editing, and vision understanding.
 *
 * ── GENERATION STACK ────────────────────────────────────────────────────
 *   1. gemini-2.5-flash-image  (primary — 500 req/day × 3 keys = 1,500/day)
 *      └─ Key rotation: if one key rate-limits, switch to next
 *   2. Pollinations FLUX       (fallback — unlimited, lower quality)
 *
 * ── VISION STACK (reading/understanding images) ─────────────────────────
 *   1. Gemini Flash            (primary — in luna.js executeGemini)
 *   2. qwen3-vl-30b-thinking   (OpenRouter fallback — OCR, screenshots, docs)
 *   3. llama-3.2-11b-vision    (OpenRouter light fallback)
 *
 * ── DAILY LIMITS (free, no top-up) ──────────────────────────────────────
 *   Generation:  ~1,500/day (Gemini) + unlimited (Pollinations)
 *   Vision:      ~1,500/day (Gemini) + ~50/day OpenRouter (shared with chat)
 * ────────────────────────────────────────────────────────────────────────
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');

// ── Gemini key pool ──────────────────────────────────────────────────────
const geminiKeys = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
].filter(Boolean);

let geminiKeyIndex = 0;

function getGeminiClient() {
  return new GoogleGenerativeAI(geminiKeys[geminiKeyIndex]);
}

function rotateGeminiKey() {
  if (geminiKeys.length <= 1) return false;
  geminiKeyIndex = (geminiKeyIndex + 1) % geminiKeys.length;
  console.warn(`[Image] Rotated to Gemini key ${geminiKeyIndex + 1}/${geminiKeys.length}`);
  return true;
}

// ── OpenRouter client (for vision fallback only) ─────────────────────────
const openrouter = process.env.OPENROUTER_API_KEY
  ? new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: process.env.OPENROUTER_API_KEY,
      defaultHeaders: {
        'HTTP-Referer': 'https://luna-al.vercel.app',
        'X-Title': 'Luna AI'
      }
    })
  : null;

// ── Last generated image store (per user, in-memory) ────────────────────
const lastGeneratedImage = new Map(); // userId -> { base64, prompt }

// ════════════════════════════════════════════════════════════════════════
//  DETECTION HELPERS
// ════════════════════════════════════════════════════════════════════════

function isImageEditRequest(prompt) {
  if (!prompt) return false;
  const p = prompt.toLowerCase();
  return /^(make it|change|edit|update|remove|add|replace|turn it|now make|modify|adjust|fix|make the|make him|make her|make them|darker|lighter|brighter|smaller|bigger|different|instead)/.test(p)
    || p.includes('edit the image') || p.includes('change the image')
    || p.includes('modify the image') || p.includes('update the image')
    || p.startsWith('now ') || p.startsWith('but ');
}

// ════════════════════════════════════════════════════════════════════════
//  GENERATION — PROVIDER 1: Gemini 2.5 Flash Image
//  Best quality: edits, text-in-image, multi-image fusion,
//  character consistency. 500 req/day per key, 3 keys = ~1,500/day
// ════════════════════════════════════════════════════════════════════════
async function generateWithGemini(prompt, existingImageBase64 = null) {
  if (geminiKeys.length === 0) throw new Error('No Gemini keys configured');

  let keysAttempted = 0;
  while (keysAttempted < geminiKeys.length) {
    try {
      const client = getGeminiClient();
      // gemini-2.5-flash-image is the stable successor to deprecated gemini-2.0-flash-exp
      const model = client.getGenerativeModel({ model: 'gemini-2.5-flash-image' });

      let parts;
      if (existingImageBase64) {
        const base64Data = existingImageBase64.includes(',')
          ? existingImageBase64.split(',')[1]
          : existingImageBase64;
        const mimeType = existingImageBase64.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
        parts = [
          { text: prompt },
          { inlineData: { mimeType, data: base64Data } }
        ];
      } else {
        parts = [{ text: prompt }];
      }

      const result = await model.generateContent({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
      });

      for (const part of result.response.candidates[0].content.parts) {
        if (part.inlineData) {
          console.log(`[Image] Gemini 2.5 Flash Image ✅ (key ${geminiKeyIndex + 1})`);
          return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        }
      }
      throw new Error('No image in Gemini response');

    } catch (err) {
      const isRateLimit = err.message?.includes('429')
        || err.message?.includes('quota')
        || err.message?.includes('RESOURCE_EXHAUSTED');

      if (isRateLimit && rotateGeminiKey()) {
        keysAttempted++;
        continue;
      }

      // If new model not available yet, try old one
      if (err.message?.includes('not found') || err.message?.includes('404')) {
        console.warn('[Image] gemini-2.5-flash-image not found, trying gemini-2.0-flash-exp...');
        try {
          const client = getGeminiClient();
          const fallbackModel = client.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
          const parts = existingImageBase64
            ? [
                { text: prompt },
                {
                  inlineData: {
                    mimeType: existingImageBase64.startsWith('data:image/png') ? 'image/png' : 'image/jpeg',
                    data: existingImageBase64.includes(',') ? existingImageBase64.split(',')[1] : existingImageBase64
                  }
                }
              ]
            : [{ text: prompt }];

          const result = await fallbackModel.generateContent({
            contents: [{ role: 'user', parts }],
            generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
          });
          for (const part of result.response.candidates[0].content.parts) {
            if (part.inlineData) {
              console.log('[Image] Gemini 2.0 Flash fallback ✅');
              return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
            }
          }
        } catch (e2) {
          throw e2;
        }
      }

      throw err;
    }
  }
  throw new Error('All Gemini keys exhausted');
}

// ════════════════════════════════════════════════════════════════════════
//  GENERATION — PROVIDER 2: Pollinations FLUX
//  No API key. Unlimited. Lower quality. Last resort only.
// ════════════════════════════════════════════════════════════════════════
async function generateWithPollinations(prompt) {
  const enhancedPrompt = `${prompt}, highly detailed, sharp focus, vivid colors, 4k, masterpiece`;
  const encodedPrompt = encodeURIComponent(enhancedPrompt);
  const seed = Math.floor(Math.random() * 99999);

  const urls = [
    `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&model=flux&nologo=true&seed=${seed}`,
    `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&nologo=true&seed=${seed}`,
  ];

  for (const url of urls) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`[Image] Pollinations attempt ${attempt}...`);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        const response = await fetch(url, { method: 'GET', signal: controller.signal });
        clearTimeout(timeout);

        if (!response.ok) {
          console.warn(`[Image] Pollinations ${response.status}`);
          break;
        }

        const buffer = await response.arrayBuffer();
        console.log('[Image] Pollinations ✅');
        return `data:image/png;base64,${Buffer.from(buffer).toString('base64')}`;
      } catch (err) {
        console.warn(`[Image] Pollinations error (${attempt}): ${err.message}`);
        if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
  throw new Error('Pollinations failed');
}

// ════════════════════════════════════════════════════════════════════════
//  MAIN GENERATE FUNCTION
//  Gemini (key rotation) → Pollinations
//  Returns { image, edited, provider }
// ════════════════════════════════════════════════════════════════════════
async function generateImage(prompt, uid) {
  const lastImg = lastGeneratedImage.get(uid);
  const isEdit = !!(lastImg && isImageEditRequest(prompt));

  // Step 1: Gemini — best quality, key rotation built in
  try {
    console.log(isEdit ? '[Image] Gemini → edit mode' : '[Image] Gemini → generate');
    const image = await generateWithGemini(prompt, isEdit ? lastImg.base64 : null);
    lastGeneratedImage.set(uid, { base64: image, prompt });
    return { image, edited: isEdit, provider: 'gemini' };
  } catch (err) {
    console.warn('[Image] Gemini failed:', err.message);
  }

  // Step 2: Pollinations — unlimited fallback
  try {
    const image = await generateWithPollinations(prompt);
    lastGeneratedImage.set(uid, { base64: image, prompt });
    return { image, edited: false, provider: 'pollinations' };
  } catch (err) {
    console.warn('[Image] Pollinations failed:', err.message);
  }

  throw new Error('All image providers failed');
}

// ════════════════════════════════════════════════════════════════════════
//  VISION FALLBACK — for when Gemini Vision fails in luna.js
//
//  Models tried in order:
//  1. qwen3-vl-30b-a3b-thinking:free — best free vision, has thinking,
//     excellent at OCR, screenshots, logs, charts, documents
//  2. llama-3.2-11b-vision-instruct:free — lighter, faster fallback
// ════════════════════════════════════════════════════════════════════════
const VISION_FALLBACK_MODELS = [
  'qwen/qwen3-vl-30b-a3b-thinking:free',
  'meta-llama/llama-3.2-11b-vision-instruct:free',
];

async function analyzeImageWithOpenRouter(systemPrompt, history, imageBase64) {
  if (!openrouter) throw new Error('OpenRouter not configured');

  const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
  const mimeType = imageBase64.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
  const dataUrl = `data:${mimeType};base64,${base64Data}`;

  // Build message array — inject image into the last user message
  const safeHistory = history.slice(-10);
  const messages = [{ role: 'system', content: systemPrompt }];

  safeHistory.forEach((msg, i) => {
    const isLast = i === safeHistory.length - 1;
    if (isLast && msg.role === 'user') {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: typeof msg.content === 'string' ? msg.content : 'What is in this image?' },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      });
    } else {
      messages.push({ role: msg.role, content: msg.content });
    }
  });

  for (const model of VISION_FALLBACK_MODELS) {
    try {
      console.log(`[Vision] Trying ${model}`);
      const res = await openrouter.chat.completions.create({
        model,
        messages,
        max_tokens: 1500,
        temperature: 0.7,
      });
      const reply = res.choices[0]?.message?.content?.trim();
      if (reply) {
        console.log(`[Vision] ${model} ✅`);
        return reply;
      }
    } catch (err) {
      console.warn(`[Vision] ${model} failed: ${err.message}`);
    }
  }

  throw new Error('All vision fallback models failed');
}

module.exports = {
  generateImage,
  generateWithGemini,
  generateWithPollinations,
  analyzeImageWithOpenRouter,
  isImageEditRequest,
  lastGeneratedImage,
};
