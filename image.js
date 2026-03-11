'use strict';

/**
 * image.js — Luna's Image Intelligence Module
 *
 * ── GENERATION STACK ─────────────────────────────────────────────────────
 *   1. Gemini 2.5 Flash Image (gemini-2.5-flash-image)
 *      - Called via REST API directly (not SDK — old SDK doesn't support it)
 *      - Free: 500 req/day PER Google Cloud project
 *      - 3 keys from 3 different accounts = up to 1,500/day
 *      - Handles: generation, editing, character consistency, text-in-image
 *
 *   2. Pollinations FLUX
 *      - No API key, unlimited
 *      - What originally worked before Gemini attempts
 *      - Lower quality, last resort
 *
 * ── VISION STACK (reading/understanding images in chat) ──────────────────
 *   1. Gemini Flash via executeGemini() in luna.js (primary)
 *   2. qwen3-vl-30b-thinking via OpenRouter (fallback)
 *   3. llama-3.2-11b-vision via OpenRouter (light fallback)
 *
 * ── DAILY LIMITS ─────────────────────────────────────────────────────────
 *   Gemini gen:  500/day × 3 keys = ~1,500 high quality images
 *   Pollinations: unlimited (lower quality)
 * ─────────────────────────────────────────────────────────────────────────
 */

const OpenAI = require('openai');

// ── Gemini key pool ───────────────────────────────────────────────────────
// Each key should be from a DIFFERENT Google Cloud project for separate quotas
const geminiKeys = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
].filter(Boolean);

let geminiKeyIndex = 0;

function currentGeminiKey() {
  return geminiKeys[geminiKeyIndex];
}

function rotateGeminiKey() {
  if (geminiKeys.length <= 1) return false;
  geminiKeyIndex = (geminiKeyIndex + 1) % geminiKeys.length;
  console.warn(`[Image] Rotated to Gemini key ${geminiKeyIndex + 1}/${geminiKeys.length}`);
  return true;
}

// ── OpenRouter client (vision fallback only) ──────────────────────────────
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

// ── Last generated image store (per user, in-memory) ─────────────────────
const lastGeneratedImage = new Map(); // userId -> { base64, prompt }

// ═════════════════════════════════════════════════════════════════════════
//  DETECTION HELPERS
// ═════════════════════════════════════════════════════════════════════════

function isImageEditRequest(prompt) {
  if (!prompt) return false;
  const p = prompt.toLowerCase();
  return /^(make it|change|edit|update|remove|add|replace|turn it|now make|modify|adjust|fix|make the|make him|make her|make them|darker|lighter|brighter|smaller|bigger|different|instead)/.test(p)
    || p.includes('edit the image') || p.includes('change the image')
    || p.includes('modify the image') || p.includes('update the image')
    || p.startsWith('now ') || p.startsWith('but ');
}

// ═════════════════════════════════════════════════════════════════════════
//  GENERATION — PROVIDER 1: Gemini 2.5 Flash Image
//
//  Uses REST API directly (not @google/generative-ai SDK)
//  because the old SDK doesn't support gemini-2.5-flash-image.
//
//  Model: gemini-2.5-flash-image (stable, free, 500 req/day per project)
//  Endpoint: v1beta/models/gemini-2.5-flash-image:generateContent
// ═════════════════════════════════════════════════════════════════════════
async function generateWithGemini(prompt, existingImageBase64 = null) {
  if (geminiKeys.length === 0) throw new Error('No Gemini keys configured');

  let keysAttempted = 0;
  while (keysAttempted < geminiKeys.length) {
    try {
      const apiKey = currentGeminiKey();
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent`;

      // Build parts — text + optional existing image for edit mode
      const parts = [{ text: prompt }];
      if (existingImageBase64) {
        const base64Data = existingImageBase64.includes(',')
          ? existingImageBase64.split(',')[1]
          : existingImageBase64;
        const mimeType = existingImageBase64.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
        parts.push({ inline_data: { mime_type: mimeType, data: base64Data } });
      }

      const body = {
        contents: [{ role: 'user', parts }],
        generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45000); // 45s timeout

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (res.status === 429 || res.status === 503) {
        // Rate limited — try next key
        const errText = await res.text().catch(() => '');
        console.warn(`[Image] Gemini key ${geminiKeyIndex + 1} rate limited (${res.status})`);
        if (rotateGeminiKey()) { keysAttempted++; continue; }
        throw new Error(`Gemini rate limited: ${errText.slice(0, 100)}`);
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Gemini ${res.status}: ${errText.slice(0, 200)}`);
      }

      const data = await res.json();
      const parts_out = data?.candidates?.[0]?.content?.parts || [];

      for (const part of parts_out) {
        if (part.inlineData || part.inline_data) {
          const inlineData = part.inlineData || part.inline_data;
          console.log(`[Image] Gemini 2.5 Flash Image ✅ (key ${geminiKeyIndex + 1})`);
          return `data:${inlineData.mimeType || inlineData.mime_type};base64,${inlineData.data}`;
        }
      }

      throw new Error('No image in Gemini response — model may have returned text only');

    } catch (err) {
      if (err.name === 'AbortError') {
        console.warn(`[Image] Gemini key ${geminiKeyIndex + 1} timed out`);
        if (rotateGeminiKey()) { keysAttempted++; continue; }
      }
      throw err;
    }
  }
  throw new Error('All Gemini keys exhausted');
}

// ═════════════════════════════════════════════════════════════════════════
//  GENERATION — PROVIDER 2: Pollinations FLUX
//
//  No API key required. Unlimited requests. Lower quality.
//  This is what originally worked — keeping as a solid fallback.
// ═════════════════════════════════════════════════════════════════════════
async function generateWithPollinations(prompt) {
  // Pollinations anonymous tier: 1 request every 15s — respect this or get 500s
  const encodedPrompt = encodeURIComponent(prompt);
  const seed = Math.floor(Math.random() * 99999);

  // Two URL variants to try — flux model first, default as backup
  const urls = [
    `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&model=flux&nologo=true&seed=${seed}`,
    `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&nologo=true&seed=${seed}`,
  ];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      if (i > 0) {
        // Wait 16s before second URL attempt — respect 1 req/15s anonymous limit
        console.log('[Image] Pollinations waiting 16s (rate limit)...');
        await new Promise(r => setTimeout(r, 16000));
      }

      console.log(`[Image] Pollinations attempt ${i + 1}...`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 90000); // 90s — their servers are slow
      const response = await fetch(url, { method: 'GET', signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
        console.warn(`[Image] Pollinations ${response.status} — ${i < urls.length - 1 ? 'trying next' : 'giving up'}`);
        continue;
      }

      const buffer = await response.arrayBuffer();
      console.log('[Image] Pollinations ✅');
      return `data:image/png;base64,${Buffer.from(buffer).toString('base64')}`;
    } catch (err) {
      console.warn(`[Image] Pollinations error (attempt ${i + 1}): ${err.message}`);
    }
  }

  throw new Error('Pollinations failed');
}

// ═════════════════════════════════════════════════════════════════════════
//  MAIN GENERATE FUNCTION
//  Gemini (key rotation) → Pollinations
//  Returns { image: base64String, edited: boolean, provider: string }
// ═════════════════════════════════════════════════════════════════════════
async function generateImage(prompt, uid) {
  const lastImg = lastGeneratedImage.get(uid);
  const isEdit = !!(lastImg && isImageEditRequest(prompt));

  // Step 1: Gemini 2.5 Flash Image — best quality, key rotation built in
  try {
    console.log(isEdit ? '[Image] Gemini → edit mode' : '[Image] Gemini → generate');
    const image = await generateWithGemini(prompt, isEdit ? lastImg.base64 : null);
    lastGeneratedImage.set(uid, { base64: image, prompt });
    return { image, edited: isEdit, provider: 'gemini' };
  } catch (err) {
    console.warn('[Image] Gemini failed:', err.message);
  }

  // Step 2: Pollinations — unlimited, no key, what originally worked
  try {
    console.log('[Image] Falling back to Pollinations...');
    const image = await generateWithPollinations(prompt);
    lastGeneratedImage.set(uid, { base64: image, prompt });
    return { image, edited: false, provider: 'pollinations' };
  } catch (err) {
    console.warn('[Image] Pollinations failed:', err.message);
  }

  throw new Error('All image providers failed');
}

// ═════════════════════════════════════════════════════════════════════════
//  VISION FALLBACK — when Gemini Vision fails in luna.js
//
//  Only called when the primary Gemini vision (executeGemini) fails.
//  Models tried in order:
//  1. qwen3-vl-30b-a3b-thinking:free — best free vision, OCR, screenshots, docs
//  2. llama-3.2-11b-vision-instruct:free — lighter, faster fallback
// ═════════════════════════════════════════════════════════════════════════
const VISION_FALLBACK_MODELS = [
  'qwen/qwen3-vl-30b-a3b-thinking:free',
  'meta-llama/llama-3.2-11b-vision-instruct:free',
];

async function analyzeImageWithOpenRouter(systemPrompt, history, imageBase64) {
  if (!openrouter) throw new Error('OpenRouter not configured');

  const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
  const mimeType = imageBase64.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
  const dataUrl = `data:${mimeType};base64,${base64Data}`;

  // Build messages — inject image into the last user message
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
