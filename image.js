'use strict';

/**
 * image.js — Luna's Image Intelligence Module
 *
 * ── GENERATION STACK ─────────────────────────────────────────────────────
 *   1. Cloudflare Workers AI  (CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN)
 *      - Model: @cf/black-forest-labs/flux-1-schnell
 *      - Fast, high quality, ~100 free neurons/day on free tier
 *
 *   2. Pixazo Free API        (PIXAZO_API_KEY)
 *      - Fallback when Cloudflare is rate-limited or unavailable
 *      - Returns a hosted image URL directly
 *
 *   3. AI Horde               (anonymous key — no signup needed)
 *      - Community-run, always available, slightly slower
 *      - Uses polling: submit job → check status → fetch result
 *
 * ── VISION STACK (image understanding in chat) ───────────────────────────
 *   1. Gemini Flash via executeGemini() in luna.js (primary)
 *   2. qwen3-vl-30b-thinking via OpenRouter (fallback)
 *   3. llama-3.2-11b-vision via OpenRouter (light fallback)
 *
 * ── ENV VARIABLES REQUIRED ───────────────────────────────────────────────
 *   CLOUDFLARE_ACCOUNT_ID   — Cloudflare account ID (dashboard → right sidebar)
 *   CLOUDFLARE_API_TOKEN    — API token with "Workers AI" permission
 *   PIXAZO_API_KEY          — From your Pixazo dashboard
 *   OPENROUTER_API_KEY      — For vision fallback only (optional)
 * ─────────────────────────────────────────────────────────────────────────
 */

const OpenAI = require('openai');

// ── OpenRouter client (vision fallback only — generation unchanged) ───────
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
// Stores { base64, prompt } so edit requests can reference the previous image
const lastGeneratedImage = new Map();

// ═════════════════════════════════════════════════════════════════════════
//  DETECTION HELPER — is this an edit request or a fresh generation?
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
//  PROVIDER 1 — Cloudflare Workers AI
//
//  Endpoint: POST /accounts/{id}/ai/run/@cf/black-forest-labs/flux-1-schnell
//  Auth:     Bearer token via CLOUDFLARE_API_TOKEN
//  Returns:  Raw image bytes (arrayBuffer → base64 data URL)
//  Docs:     https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/
// ═════════════════════════════════════════════════════════════════════════
async function generateWithCloudflare(prompt) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken  = process.env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !apiToken) {
    throw new Error('Cloudflare: CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN not set in .env');
  }

  const model    = '@cf/black-forest-labs/flux-1-schnell';
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;

  console.log('[Image] Cloudflare Workers AI → generating...');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000); // 60s timeout

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      num_steps: 4,   // schnell is optimised for 1–4 steps
    }),
    signal: controller.signal,
  });
  clearTimeout(timeout);

  if (res.status === 429) {
    throw new Error(`Cloudflare: rate limited (429) — daily free neurons exhausted`);
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Cloudflare: HTTP ${res.status} — ${errText.slice(0, 200)}`);
  }

  // Cloudflare returns raw binary image bytes for this model
  const buffer    = await res.arrayBuffer();
  const base64    = Buffer.from(buffer).toString('base64');
  const mimeType  = res.headers.get('content-type') || 'image/png';

  console.log('[Image] Cloudflare Workers AI ✅');
  return `data:${mimeType};base64,${base64}`;
}

// ═════════════════════════════════════════════════════════════════════════
//  PROVIDER 2 — Pixazo Free API
//
//  Endpoint: POST https://api.pixazo.io/v1/generate  (verify in your dashboard)
//  Auth:     API key via PIXAZO_API_KEY
//  Returns:  JSON { image_url: "https://..." } — fetched and converted to base64
//  Docs:     https://docs.pixazo.io  (check for latest endpoint/field names)
// ═════════════════════════════════════════════════════════════════════════
async function generateWithPixazo(prompt) {
  const apiKey = process.env.PIXAZO_API_KEY;

  if (!apiKey) {
    throw new Error('Pixazo: PIXAZO_API_KEY not set in .env');
  }

  // ── NOTE: Verify this endpoint + request/response shape in your Pixazo dashboard ──
  const endpoint = 'https://api.pixazo.io/v1/generate';

  console.log('[Image] Pixazo → generating...');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      width: 1024,
      height: 1024,
    }),
    signal: controller.signal,
  });
  clearTimeout(timeout);

  if (res.status === 401) throw new Error('Pixazo: invalid API key (401)');
  if (res.status === 429) throw new Error('Pixazo: rate limited (429)');
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Pixazo: HTTP ${res.status} — ${errText.slice(0, 200)}`);
  }

  const json = await res.json();

  // ── Adapt field name if Pixazo uses something other than image_url ────────
  const imageUrl = json?.image_url || json?.url || json?.data?.url;
  if (!imageUrl) {
    throw new Error(`Pixazo: no image URL in response — ${JSON.stringify(json).slice(0, 200)}`);
  }

  // Download the hosted image and convert to base64 data URL
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Pixazo: failed to fetch image (${imgRes.status})`);

  const buffer   = await imgRes.arrayBuffer();
  const mimeType = imgRes.headers.get('content-type') || 'image/jpeg';

  console.log('[Image] Pixazo ✅');
  return `data:${mimeType};base64,${Buffer.from(buffer).toString('base64')}`;
}

// ═════════════════════════════════════════════════════════════════════════
//  PROVIDER 3 — AI Horde  (anonymous, no signup)
//
//  Anonymous key: "0000000000"  — slower queue priority, still works fine
//  Flow:
//    1. POST /generate/async    → returns { id }
//    2. Poll GET /generate/check/{id} until done === true
//    3. GET /generate/status/{id} → returns { generations: [{ img }] }
//  Docs: https://stablehorde.net/api/
// ═════════════════════════════════════════════════════════════════════════

// Anonymous API key — no account needed
const AI_HORDE_ANON_KEY = '0000000000';

// How often to poll for completion (ms) and max wait time
const HORDE_POLL_INTERVAL = 4_000;   // 4 seconds between status checks
const HORDE_MAX_WAIT      = 180_000; // 3 minutes max

async function generateWithAIHorde(prompt) {
  const BASE = 'https://stablehorde.net/api/v2';

  const commonHeaders = {
    'Content-Type': 'application/json',
    'apikey': AI_HORDE_ANON_KEY,
    'Client-Agent': 'LunaAI:1.0:contact@luna.ai',
  };

  // ── Step 1: Submit generation job ────────────────────────────────────────
  console.log('[Image] AI Horde → submitting job (anonymous key)...');

  const submitRes = await fetch(`${BASE}/generate/async`, {
    method: 'POST',
    headers: commonHeaders,
    body: JSON.stringify({
      prompt,
      params: {
        width: 512,          // anonymous tier: keep size moderate for faster queue
        height: 512,
        steps: 20,
        cfg_scale: 7,
        sampler_name: 'k_euler_a',
        n: 1,                // one image
      },
      models: ['stable_diffusion'],  // widely available on horde workers
      nsfw: false,
      censor_nsfw: true,
      r2: true,              // use R2 storage → faster image delivery
    }),
  });

  if (!submitRes.ok) {
    const err = await submitRes.text().catch(() => '');
    throw new Error(`AI Horde submit failed (${submitRes.status}): ${err.slice(0, 200)}`);
  }

  const { id: jobId } = await submitRes.json();
  if (!jobId) throw new Error('AI Horde: no job ID returned');
  console.log(`[Image] AI Horde job ID: ${jobId} — polling...`);

  // ── Step 2: Poll until done ───────────────────────────────────────────────
  const deadline = Date.now() + HORDE_MAX_WAIT;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, HORDE_POLL_INTERVAL));

    const checkRes = await fetch(`${BASE}/generate/check/${jobId}`, {
      headers: commonHeaders,
    });

    if (!checkRes.ok) {
      console.warn(`[Image] AI Horde check error (${checkRes.status}) — retrying`);
      continue;
    }

    const status = await checkRes.json();
    const waitSec = Math.round((status.wait_time || 0));
    console.log(`[Image] AI Horde → done: ${status.done}, queue pos: ${status.queue_position ?? '?'}, ~${waitSec}s`);

    if (!status.done) continue;

    // ── Step 3: Retrieve the result ─────────────────────────────────────────
    const resultRes = await fetch(`${BASE}/generate/status/${jobId}`, {
      headers: commonHeaders,
    });

    if (!resultRes.ok) {
      throw new Error(`AI Horde status fetch failed (${resultRes.status})`);
    }

    const result = await resultRes.json();
    const generation = result?.generations?.[0];

    if (!generation) {
      throw new Error('AI Horde: no generation in result');
    }

    // Result is either a base64 string or a URL (depends on r2 flag)
    if (generation.img) {
      // If it starts with http it's a URL; otherwise it's raw base64
      if (generation.img.startsWith('http')) {
        const imgRes = await fetch(generation.img);
        if (!imgRes.ok) throw new Error(`AI Horde: image download failed (${imgRes.status})`);
        const buffer = await imgRes.arrayBuffer();
        console.log('[Image] AI Horde ✅ (URL)');
        return `data:image/webp;base64,${Buffer.from(buffer).toString('base64')}`;
      } else {
        // Raw base64 (without data: prefix)
        console.log('[Image] AI Horde ✅ (base64)');
        return `data:image/webp;base64,${generation.img}`;
      }
    }

    throw new Error('AI Horde: generation has no img field');
  }

  throw new Error('AI Horde: timed out after 3 minutes');
}

// ═════════════════════════════════════════════════════════════════════════
//  MAIN EXPORT — generateImage(prompt, uid?)
//
//  Fallback order:
//    1. Cloudflare Workers AI  (fastest, highest quality)
//    2. Pixazo                 (fallback if Cloudflare fails/rate-limited)
//    3. AI Horde               (always available, slower — last resort)
//
//  Returns: { image: <base64 data URL>, provider: string, edited: boolean }
//  Throws:  only if ALL three providers fail
// ═════════════════════════════════════════════════════════════════════════
async function generateImage(prompt, uid = 'anonymous') {
  if (!prompt || !prompt.trim()) {
    throw new Error('generateImage: prompt is required');
  }

  // Note: image editing (passing a previous image as reference) requires
  // a provider that supports img2img. For now, edit requests are treated
  // as fresh generations with the edit description as the new prompt.
  const lastImg = lastGeneratedImage.get(uid);
  const isEdit  = !!(lastImg && isImageEditRequest(prompt));

  if (isEdit) {
    console.log('[Image] Edit request detected — generating fresh with new prompt (no img2img in current stack)');
  }

  // ── Provider 1: Cloudflare Workers AI ────────────────────────────────────
  try {
    const image = await generateWithCloudflare(prompt);
    lastGeneratedImage.set(uid, { base64: image, prompt });
    return { image, edited: isEdit, provider: 'cloudflare' };
  } catch (err) {
    console.warn('[Image] ⚠ Cloudflare failed:', err.message, '→ trying Pixazo...');
  }

  // ── Provider 2: Pixazo ───────────────────────────────────────────────────
  try {
    const image = await generateWithPixazo(prompt);
    lastGeneratedImage.set(uid, { base64: image, prompt });
    return { image, edited: isEdit, provider: 'pixazo' };
  } catch (err) {
    console.warn('[Image] ⚠ Pixazo failed:', err.message, '→ trying AI Horde...');
  }

  // ── Provider 3: AI Horde (anonymous, always available) ───────────────────
  try {
    const image = await generateWithAIHorde(prompt);
    lastGeneratedImage.set(uid, { base64: image, prompt });
    return { image, edited: isEdit, provider: 'ai-horde' };
  } catch (err) {
    console.warn('[Image] ⚠ AI Horde failed:', err.message);
  }

  // All three failed — surface a clear error
  throw new Error(
    'All image providers failed (Cloudflare → Pixazo → AI Horde). ' +
    'Check your .env keys and network connectivity.'
  );
}

// ═════════════════════════════════════════════════════════════════════════
//  VISION FALLBACK — called from luna.js when primary Gemini Vision fails
//
//  Models tried in order:
//    1. qwen3-vl-30b-a3b-thinking:free — best free vision (OCR, screenshots)
//    2. llama-3.2-11b-vision-instruct:free — lighter, faster fallback
// ═════════════════════════════════════════════════════════════════════════
const VISION_FALLBACK_MODELS = [
  'qwen/qwen3-vl-30b-a3b-thinking:free',
  'meta-llama/llama-3.2-11b-vision-instruct:free',
];

async function analyzeImageWithOpenRouter(systemPrompt, history, imageBase64) {
  if (!openrouter) throw new Error('OpenRouter not configured — OPENROUTER_API_KEY missing');

  const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
  const mimeType   = imageBase64.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
  const dataUrl    = `data:${mimeType};base64,${base64Data}`;

  // Build messages — inject image into the last user message
  const safeHistory = history.slice(-10);
  const messages    = [{ role: 'system', content: systemPrompt }];

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

// ═════════════════════════════════════════════════════════════════════════
//  EXPORTS
//
//  Primary:
//    generateImage(prompt, uid?)   — the only function you need to call
//
//  Individual providers (for testing or direct use):
//    generateWithCloudflare(prompt)
//    generateWithPixazo(prompt)
//    generateWithAIHorde(prompt)
//
//  Vision:
//    analyzeImageWithOpenRouter(systemPrompt, history, imageBase64)
//
//  Utilities:
//    isImageEditRequest(prompt)    — detect if user wants to edit prev image
//    lastGeneratedImage            — Map<uid, {base64, prompt}>
// ═════════════════════════════════════════════════════════════════════════
module.exports = {
  generateImage,
  generateWithCloudflare,
  generateWithPixazo,
  generateWithAIHorde,
  analyzeImageWithOpenRouter,
  isImageEditRequest,
  lastGeneratedImage,
};
