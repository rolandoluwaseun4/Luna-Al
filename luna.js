'use strict';

/**
 * luna.js — Luna's Brain & Orchestration Layer
 *
 * Luna is the orchestrator. She thinks before acting.
 * She knows her models, their boundaries, and what each user is allowed.
 * She decides everything — the models just execute.
 *
 * Flow:
 *   think()    → Luna reads the message and produces a plan
 *   route()    → Luna picks the right model based on plan + user tier
 *   execute()  → The chosen model generates the reply
 */

const Groq = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');

// ── Groq client — brain only (fastest for triage) ───────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── OpenRouter client — all model responses ──────────────────────
const openrouter = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    'HTTP-Referer': 'https://luna-al.vercel.app',
    'X-Title': 'Luna AI'
  }
});

// ── Gemini client pool (RO-1 worker) ────────────────────────────
const geminiKeys = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
].filter(Boolean);

let geminiKeyIndex = 0;

function getGeminiClient() {
  if (geminiKeys.length === 0) return null;
  return new GoogleGenerativeAI(geminiKeys[geminiKeyIndex]);
}

function rotateGeminiKey() {
  if (geminiKeys.length <= 1) return false;
  geminiKeyIndex = (geminiKeyIndex + 1) % geminiKeys.length;
  console.warn(`[Luna] Rotating to Gemini key ${geminiKeyIndex + 1}/${geminiKeys.length}`);
  return true;
}

// ── Model definitions — Luna knows exactly what she has ─────────
const LUNA_MODELS = {
  // Luna's brain — Groq only, needs to be instant, never changes
  BRAIN: 'llama-3.1-8b-instant',

  // Luna Flash — Groq primary (fast), OpenRouter fallback pool
  FLASH: {
    primary: 'llama-3.3-70b-versatile',        // Groq — fastest
    groqFallback: 'llama3-70b-8192',            // Groq — backup
    orFallbacks: [                              // OpenRouter when Groq rate limits
      'meta-llama/llama-3.3-70b-instruct:free',
      'mistralai/mistral-small-3.1-24b-instruct:free',
      'google/gemma-3-27b-it:free',
      'nvidia/nemotron-3-nano-30b-a3b:free',
      'nousresearch/hermes-3-llama-3.1-405b:free',
      'openai/gpt-oss-20b:free',
      'arcee-ai/trinity-mini:free',
      'z-ai/glm-4.5-air:free',
    ]
  },

  // Luna Pro — DeepSeek R1 for thinking tags, qwen fallback, OpenRouter pool
  PRO: {
    primary: 'deepseek-r1-distill-llama-70b',  // Groq — real thinking tags ✅
    groqFallback: 'qwen/qwen3-32b',            // Groq — powerful fallback
    orFallbacks: [                              // OpenRouter fallbacks
      'qwen/qwen3-next-80b-a3b-instruct:free',
      'openai/gpt-oss-120b:free',
      'arcee-ai/trinity-large-preview:free',
      'nousresearch/hermes-3-llama-3.1-405b:free',
      'meta-llama/llama-3.3-70b-instruct:free',
    ]
  },

  // RO-1 — DeepSeek R1 on Groq (thinking tags), OpenRouter + Gemini race
  RO1: {
    primary: 'deepseek-r1-distill-llama-70b',  // Groq — real thinking tags
    groqFallback: 'llama-3.3-70b-versatile',
    orFallbacks: [
      'arcee-ai/trinity-large-preview:free',
      'liquid/lfm-2.5-1.2b-thinking:free',
      'openai/gpt-oss-120b:free',
      'nousresearch/hermes-3-llama-3.1-405b:free',
    ],
    raceGemini: true
  },

  // Absolute last resort
  FALLBACK: 'openrouter/auto'
};

// ── Think tag extractor ─────────────────────────────────────────
// Separates DeepSeek R1's <think>...</think> reasoning from the actual reply.
// Returns { thinkContent, cleanReply }
function extractThinkTags(text) {
  if (!text) return { thinkContent: null, cleanReply: text };
  const match = text.match(/<think>([\s\S]*?)<\/think>/);
  if (!match) return { thinkContent: null, cleanReply: text };
  const thinkContent = match[1].trim();
  const cleanReply = text.replace(/<think>[\s\S]*?<\/think>/, '').trimStart();
  return { thinkContent, cleanReply };
}

// ── Luna's Brain — thinks before every response ─────────────────
/**
 * Luna reads the message and conversation context, then produces
 * a structured plan that guides how the response should be generated.
 *
 * @param {string} message - The user's current message
 * @param {Array}  history - Recent conversation history (last 6 messages)
 * @param {string} clientModel - Which Luna model the user is on
 * @param {boolean} hasImage - Whether an image was attached
 * @returns {object} plan - Luna's reasoning plan
 */
async function think(message, history = [], clientModel = 'luna-flash', hasImage = false) {
  // Build a short conversation summary for context
  const recentMessages = history.slice(-6).map(m =>
    `${m.role === 'user' ? 'User' : 'Luna'}: ${String(m.content).slice(0, 150)}`
  ).join('\n');

  const brainPrompt = `You are Luna's reasoning brain. Your job is to analyze what the user wants and produce a plan for how to respond. Think carefully and be precise.

CONVERSATION SO FAR:
${recentMessages || '(This is the start of the conversation)'}

USER'S CURRENT MESSAGE: "${message}"
HAS IMAGE ATTACHED: ${hasImage}
USER'S MODEL TIER: ${clientModel}

Analyze the message and respond with ONLY a valid JSON object — no explanation, no markdown, just the JSON:

{
  "intent": "one of: chat | code | ui_build | creative | analysis | image_generate | image_edit | search_needed | agent_task",
  "is_followup": true or false,
  "topic": "brief topic of what they're asking about",
  "response_format": "one of: prose | code | list | table | document",
  "response_length": "one of: one_sentence | short | medium | long | full_document",
  "tone": "one of: casual | technical | creative | direct",
  "needs_web_search": true or false,
  "image_prompt": "if intent is image_generate or image_edit, write a vivid detailed prompt here, otherwise null",
  "reasoning": "one sentence explaining why you made these choices"
}

GUIDANCE:
- is_followup = true if the message references something from the conversation above
- one_sentence: single fact or simple answer
- short: 2-4 sentences, casual explanation
- medium: 1-3 paragraphs, proper explanation  
- long: detailed response, complex topic that genuinely needs depth
- full_document: report, essay, story, or guide the user explicitly asked for
- needs_web_search: only true for current events, prices, news, real-time data
- For image_edit: only if user is clearly modifying a previous image in context
- NEVER choose full_document or long unless the user explicitly asked for it
- ui_build: use this when user asks to build a website, landing page, dashboard, UI, app interface, or any visual HTML/CSS output. Always set response_format: code and response_length: full_document for ui_build.
- code: use for scripts, functions, algorithms, backend code, non-UI programming tasks`;

  try {
    const res = await groq.chat.completions.create({
      model: LUNA_MODELS.BRAIN,
      max_tokens: 300,
      temperature: 0,
      messages: [{ role: 'user', content: brainPrompt }]
    });

    const raw = res.choices[0]?.message?.content?.trim() || '';
    const clean = raw.replace(/```json|```/g, '').trim();
    const plan = JSON.parse(clean);

    console.log(`[Luna Brain] Intent: ${plan.intent} | Length: ${plan.response_length} | Format: ${plan.response_format} | Followup: ${plan.is_followup}`);
    return plan;

  } catch (err) {
    // Brain failed — fall back to safe defaults, never break the conversation
    console.warn('[Luna Brain] Thinking failed, using defaults:', err.message);
    return {
      intent: 'chat',
      is_followup: false,
      topic: 'general',
      response_format: 'prose',
      response_length: 'short',
      tone: 'casual',
      needs_web_search: false,
      image_prompt: null,
      reasoning: 'fallback defaults'
    };
  }
}

// ── Route — Luna enforces model boundaries ───────────────────────
/**
 * Based on the plan and the user's tier, Luna decides which model
 * actually handles the response. Users cannot bypass their tier.
 *
 * @param {object} plan - Output from think()
 * @param {string} clientModel - luna-flash | luna-pro | ro1
 * @param {boolean} isOwner - Owner has access to everything
 * @returns {object} route - { provider, model, useGemini, raceGemini }
 */
function route(plan, clientModel, isOwner) {
  // Normalize model name
  const model = isOwner ? (clientModel || 'ro1') : (clientModel || 'luna-flash');

  // RO-1 is owner only — demote others to Flash
  const effectiveModel = (model === 'ro1' && !isOwner) ? 'luna-flash' : model;

  switch (effectiveModel) {
    case 'luna-flash':
    default:
      return {
        models: LUNA_MODELS.FLASH,
        raceGemini: false,
        label: 'Luna Flash → Groq + OpenRouter fallback'
      };

    case 'luna-pro':
      return {
        models: LUNA_MODELS.PRO,
        raceGemini: false,
        label: 'Luna Pro → Groq qwen3 (thinking) + OpenRouter fallback'
      };

    case 'ro1':
      const isComplex = ['analysis', 'code', 'ui_build', 'creative', 'agent_task'].includes(plan.intent) ||
                        ['long', 'full_document'].includes(plan.response_length);
      return {
        models: LUNA_MODELS.RO1,
        raceGemini: isComplex && geminiKeys.length > 0,
        label: isComplex ? 'RO-1 → DeepSeek R1 + Gemini race' : 'RO-1 → DeepSeek R1'
      };
  }
}

// ── Craft — Luna builds the perfect prompt from her plan ─────────
/**
 * Luna takes the brain's plan and builds a targeted system prompt
 * that tells the model exactly what to do — no guessing.
 *
 * @param {object} plan - Output from think()
 * @param {string} baseSystemPrompt - The full Luna personality prompt from telegram.js
 * @param {string|null} webSearchResults - Web search results if needed
 * @param {string|null} conversationContext - Recent conversation summary
 * @returns {string} craftedPrompt - The final system prompt to send to the model
 */
function craft(plan, baseSystemPrompt, webSearchResults = null, conversationContext = null) {
  const lengthInstructions = {
    one_sentence: 'Respond in exactly one sentence. Nothing more.',
    short: 'Respond in 2-4 sentences. Plain prose. No headers, no bullets.',
    medium: 'Respond in 1-3 paragraphs. Plain prose. Only use structure if the content genuinely requires it.',
    long: 'This requires a thorough response. Write in depth but stay focused — no padding, no repetition.',
    full_document: 'The user asked for a full document, report, or story. Write it completely with appropriate structure.'
  };

  const formatInstructions = {
    prose: 'Write in flowing prose. No headers, no bullet points unless listing actual items.',
    code: 'Write clean, well-commented, production-ready code. Specify the language. Explain briefly what it does.',
    list: 'Format as a clear list. Keep each item concise.',
    table: 'Use a markdown table for this comparison.',
    document: 'Use appropriate headers and structure for this document.'
  };

  const toneInstructions = {
    casual: 'Be conversational and natural — like talking to a smart friend.',
    technical: 'Be precise and technical. Use correct terminology.',
    creative: 'Be vivid, imaginative, and original. Make it memorable.',
    direct: 'Be direct. Give a clear answer or recommendation without hedging.'
  };

  let craftedPrompt = baseSystemPrompt;

  // Inject conversation context if this is a follow-up
  if (conversationContext && plan.is_followup) {
    craftedPrompt += `\n\n## CONVERSATION CONTEXT\n${conversationContext}\nThe user's current message is a follow-up to this conversation. Use the context naturally — never ask them to repeat what was already discussed.`;
  }

  // Inject web search results if available
  if (webSearchResults) {
    craftedPrompt += `\n\n## LIVE WEB SEARCH RESULTS\n${webSearchResults}\nUse these results to answer accurately. Synthesize naturally — don't just list sources.`;
  }

  // ── UI Build special instructions ───────────────────────────────
  if (plan.intent === 'ui_build') {
    craftedPrompt += `

## UI/WEBSITE BUILD INSTRUCTIONS — FOLLOW EXACTLY

You are building a complete, visually stunning, production-ready website in a SINGLE HTML file.

DESIGN STANDARDS — these are non-negotiable:
- Choose the BEST color scheme for the project based on what it is. Think like a professional designer:
  • SaaS/Tech product → dark sleek (deep navy/black + electric blue/purple accents)
  • Portfolio/Creative → bold and distinctive, match the person's vibe
  • Restaurant/Food → warm rich colors (deep burgundy, golden, cream)
  • Healthcare/Medical → clean light (white/soft blue, trustworthy)
  • Fashion/Beauty → elegant (black + gold, or soft pastels depending on brand)
  • Kids/Education → bright, playful, high contrast colors
  • Finance/Corporate → professional light or dark (navy, white, green accents)
  • Music/Entertainment → dark, vibrant, energetic gradients
  • Nature/Eco → earthy greens, organic warmth
  • Minimal/Clean → lots of white space, muted accents
  IF the user specifies colors or a theme — use exactly what they asked for, no exceptions
- Modern typography — use Google Fonts (Inter, Plus Jakarta Sans, or similar). Import via @import in <style>
- Smooth animations — subtle fade-ins, hover transitions (0.2-0.3s ease), micro-interactions
- Glassmorphism or neumorphism where appropriate — backdrop-filter: blur(), rgba surfaces
- Proper spacing — generous padding, breathing room between sections
- Fully responsive — mobile-first, works on all screen sizes with media queries
- No Bootstrap, no external CSS frameworks — write pure CSS that actually looks good
- Hero sections with gradient text, CTAs with hover glow effects
- Cards with subtle borders (rgba white/black), box shadows, border-radius: 16px+
- Consistent color system — define CSS variables at :root level

CODE STANDARDS:
- Complete, self-contained single HTML file — everything in one file (HTML + CSS + JS)
- Semantic HTML5 elements (header, nav, main, section, footer)
- CSS variables for theming (:root { --bg, --accent, --text, etc })
- Smooth scroll behavior
- Working navigation if multiple sections
- Placeholder images use https://picsum.photos/ or CSS gradients — never broken img tags
- All interactive elements must actually work (buttons, forms, modals)

OUTPUT:
- Output the COMPLETE file — no truncation, no "add more content here" placeholders
- Start with <!DOCTYPE html> and end with </html>
- Brief 1-sentence description before the code block, nothing after`;
  } else {
    // Standard instructions for non-UI intents
    craftedPrompt += `\n\n## YOUR INSTRUCTIONS FOR THIS RESPONSE
Topic: ${plan.topic}
Intent: ${plan.intent}
${lengthInstructions[plan.response_length] || lengthInstructions.short}
${formatInstructions[plan.response_format] || formatInstructions.prose}
${toneInstructions[plan.tone] || toneInstructions.casual}
Follow these instructions exactly. They override any default tendencies.
ABSOLUTE RULE: If the length says one sentence or 2-4 sentences — write that and STOP. Do not add more. Do not summarize at the end. Do not add a closing line. Just stop.`;
  }

  return craftedPrompt;
}

// ── Inject length constraint into last user message ─────────────
// qwen3 and other strong models ignore system prompt length rules.
// Injecting directly into the user turn is much harder to ignore.
function injectLengthConstraint(history, plan) {
  if (!history || history.length === 0) return history;
  const constrained = [...history];
  const lastUserIdx = [...constrained].map((m,i) => ({m,i})).reverse().find(({m}) => m.role === 'user');
  if (!lastUserIdx) return constrained;

  const lengthTag = {
    one_sentence: '[Reply in ONE sentence only. No lists, no headers.]',
    short:        '[Reply in 2-4 sentences only. No lists, no headers.]',
    medium:       '[Reply in 1-3 paragraphs. No headers unless content is a document.]',
    long:         '[Write a thorough response. Stay focused, no padding.]',
    full_document:'[Write the full document the user requested.]'
  }[plan.response_length] || '[Reply in 2-4 sentences only.]';

  const formatTag = (plan.response_format === 'prose' || !plan.response_format)
    ? '[Plain prose only. No bullet points, no headers.]'
    : '';

  const constraint = `

${lengthTag}${formatTag ? ' ' + formatTag : ''}`;

  const lastMsg = { ...constrained[lastUserIdx.i] };
  lastMsg.content = (typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content)) + constraint;
  constrained[lastUserIdx.i] = lastMsg;
  return constrained;
}

// ── Try a single Groq model, returns reply or throws ────────────
async function tryGroqModel(model, systemPrompt, history, plan) {
  const needsConstraint = model.includes('qwen') || model.includes('deepseek');
  const finalHistory = (plan && needsConstraint) ? injectLengthConstraint(history, plan) : history;

  const params = {
    model,
    max_tokens: (plan && plan.intent === 'ui_build') ? 8192 : 4096,
    messages: [{ role: 'system', content: systemPrompt }, ...finalHistory],
  };

  const res = await groq.chat.completions.create(params);
  const message = res.choices[0]?.message || {};
  const reply = message.content || '';

  // DeepSeek R1 returns thinking inline as <think>...</think>
  // Just return content directly — extractThinkTags() handles DeepSeek
  console.log(`[Luna] Groq responded: ${model}`);
  return reply;
}

// ── Execute on Groq — tries primary then groqFallback ────────────
async function executeGroq(systemPrompt, history, modelConfig, plan = null) {
  const models = [modelConfig.primary, modelConfig.groqFallback].filter(Boolean);


  for (const model of models) {
    let currentHistory = [...history];
    let attempts = 0;

    while (attempts < 3) {
      try {
        return await tryGroqModel(model, systemPrompt, currentHistory, plan);
      } catch (err) {
        const status = err?.status || err?.error?.status;
        const msg = (err?.message || '').toLowerCase();

        if (status === 413 || msg.includes('too large') || msg.includes('context')) {
          currentHistory = currentHistory.slice(Math.ceil(currentHistory.length / 2));
          attempts++;
          console.warn(`[Luna] ${model} context too large — trimming (attempt ${attempts})`);
          if (attempts >= 3) { break; }
        } else if (status === 429 || msg.includes('rate_limit')) {
          console.warn(`[Luna] ${model} rate limited — trying next`);
          break;
        } else if (status === 400 && (msg.includes('decommissioned') || msg.includes('invalid_request'))) {
          console.warn(`[Luna] ${model} unavailable — trying next`);
          break;
        } else {
          console.warn(`[Luna] ${model} error: ${err.message} — trying next`);
          break;
        }
      }
    }
  }
  throw new Error('Groq unavailable');
}

// ── Execute on OpenRouter ───────────────────────────────────────
// Tries models in order until one responds. Same retry logic as Groq.
async function executeOpenRouter(systemPrompt, history, modelConfig, plan = null) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OpenRouter not configured');

  const allModels = [...(modelConfig.orFallbacks || []), LUNA_MODELS.FALLBACK];
  
  for (const model of allModels) {
    let currentHistory = [...history];
    let attempts = 0;

    while (attempts < 3) {
      try {
        // Inject length constraint for stubborn models
        const finalHistory = plan ? injectLengthConstraint(currentHistory, plan) : currentHistory;

        const res = await openrouter.chat.completions.create({
          model,
          max_tokens: (plan && plan.intent === 'ui_build') ? 8192 : 4096,
          messages: [{ role: 'system', content: systemPrompt }, ...finalHistory],
        });

        const reply = res.choices[0]?.message?.content || '';
        console.log(`[Luna] OpenRouter responded: ${model}`);
        return reply;

      } catch (err) {
        const status = err?.status || err?.error?.status;
        const msg = (err?.message || '').toLowerCase();

        if (status === 413 || msg.includes('too large') || msg.includes('context')) {
          currentHistory = currentHistory.slice(Math.ceil(currentHistory.length / 2));
          attempts++;
          console.warn(`[Luna] ${model} context too large — trimming (attempt ${attempts})`);
          if (attempts >= 3) { console.warn(`[Luna] ${model} giving up — trying next`); break; }
        } else if (status === 429 || msg.includes('rate_limit') || msg.includes('rate limit')) {
          console.warn(`[Luna] ${model} rate limited — trying next`);
          break;
        } else if (status === 400 || status === 404 || msg.includes('unavailable') || msg.includes('not found')) {
          console.warn(`[Luna] ${model} unavailable — trying next`);
          break;
        } else if (status === 503 || msg.includes('overloaded')) {
          console.warn(`[Luna] ${model} overloaded — trying next`);
          break;
        } else {
          console.warn(`[Luna] ${model} error: ${err.message} — trying next`);
          break;
        }
      }
    }
  }

  throw new Error('All OpenRouter models unavailable');
}

// ── Execute on Gemini ────────────────────────────────────────────
async function executeGemini(systemPrompt, history, image = null, video = null, file = null) {
  if (geminiKeys.length === 0) throw new Error('Gemini not configured');

  const geminiModels = [
    'gemini-2.5-flash-preview-05-20',
    'gemini-2.5-flash-preview-04-17',
    'gemini-2.0-flash',
  ];

  let keysAttempted = 0;
  while (keysAttempted < geminiKeys.length) {
    for (const modelName of geminiModels) {
      try {
        const client = getGeminiClient();
        const model = client.getGenerativeModel({
          model: modelName,
          systemInstruction: systemPrompt,
          generationConfig: { maxOutputTokens: 4096, temperature: 0.9 }
        });

        // Video input
        if (video) {
          const lastMsg = history[history.length - 1];
          const textPart = typeof lastMsg.content === 'string' ? lastMsg.content : 'What is in this video?';
          const base64Data = video.includes(',') ? video.split(',')[1] : video;
          const mimeType = video.match(/data:(video\/[^;]+);/)?.[1] || 'video/mp4';
          const result = await model.generateContent([
            { text: textPart },
            { inlineData: { mimeType, data: base64Data } }
          ]);
          console.log(`[Luna] Gemini responded: ${modelName}`);
          return result.response.text();
        }

        // File/PDF input
        if (file) {
          const lastMsg = history[history.length - 1];
          const textPart = typeof lastMsg.content === 'string' ? lastMsg.content : 'Analyze this document.';
          const result = await model.generateContent([
            { text: `${textPart}\n\nDocument content:\n${file.text}` }
          ]);
          console.log(`[Luna] Gemini responded: ${modelName}`);
          return result.response.text();
        }

        // Image input
        if (image) {
          const lastMsg = history[history.length - 1];
          const textPart = typeof lastMsg.content === 'string' ? lastMsg.content : 'What is in this image?';
          const base64Data = image.includes(',') ? image.split(',')[1] : image;
          const mimeType = image.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
          const result = await model.generateContent([
            { text: textPart },
            { inlineData: { mimeType, data: base64Data } }
          ]);
          console.log(`[Luna] Gemini responded: ${modelName}`);
          return result.response.text();
        }

        // Text only — multi-turn
        let geminiHistory = history.slice(0, -1).map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: typeof m.content === 'string' ? m.content : (m.content?.find?.(c => c.type === 'text')?.text || '') }]
        })).filter(m => m.parts[0].text);

        // Gemini requires history to start with user and alternate
        while (geminiHistory.length > 0 && geminiHistory[0].role === 'model') geminiHistory.shift();
        const cleanHistory = [];
        for (const msg of geminiHistory) {
          const last = cleanHistory[cleanHistory.length - 1];
          if (!last || last.role !== msg.role) cleanHistory.push(msg);
        }

        const lastMsg = history[history.length - 1];
        const lastText = typeof lastMsg.content === 'string' ? lastMsg.content : (lastMsg.content?.find?.(c => c.type === 'text')?.text || '');
        const chat = model.startChat({ history: cleanHistory });
        const result = await chat.sendMessage(lastText);
        console.log(`[Luna] Gemini responded: ${modelName}`);
        return result.response.text();

      } catch (err) {
        const msg = err?.message || '';
        const isQuota = msg.includes('429') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED');
        const isGone = msg.includes('not found') || msg.includes('404') || msg.includes('decommissioned');
        if (isQuota) { rotateGeminiKey(); break; }
        if (isGone) continue;
        throw err;
      }
    }
    keysAttempted++;
  }
  throw new Error('All Gemini keys exhausted');
}

// ── Main respond function — called by telegram.js ────────────────
/**
 * The single entry point for all chat responses.
 * Luna thinks, routes, crafts, then executes.
 *
 * @param {object} ctx - Everything Luna needs to respond
 * @returns {object} - { reply, generateImage, prompt, editLastImage }
 */
async function respond(ctx) {
  const {
    message,
    history,          // safeHistory array from telegram.js
    clientModel,      // luna-flash | luna-pro | ro1
    isOwner,
    baseSystemPrompt, // getSystemPrompt() output from telegram.js
    image,
    video,
    file,
    webSearchFn,      // async function to run web search if needed
    onChunk,          // SSE chunk sender function
  } = ctx;

  // ── Step 1: Luna thinks ────────────────────────────────────────
  const plan = await think(message, history, clientModel, !!image);

  // ── Step 2: Handle image generation signals ───────────────────
  if (plan.intent === 'image_generate' || plan.intent === 'image_edit') {
    if (plan.image_prompt) {
      return {
        generateImage: true,
        prompt: plan.image_prompt,
        editLastImage: plan.intent === 'image_edit'
      };
    }
    // Vague request — ask user what they want
    return { reply: "What would you like me to draw? Give me a description and I'll generate it." };
  }

  // ── Step 3: Web search if needed ──────────────────────────────
  let webResults = null;
  if (plan.needs_web_search && webSearchFn) {
    try {
      webResults = await webSearchFn(message);
    } catch (e) {
      console.warn('[Luna] Web search failed:', e.message);
    }
  }

  // ── Step 4: Build conversation context for follow-ups ─────────
  let conversationContext = null;
  if (plan.is_followup && history.length > 2) {
    const lastAssistant = [...history].reverse().find(m => m.role === 'assistant');
    if (lastAssistant) {
      conversationContext = `Your last reply covered: "${String(lastAssistant.content).slice(0, 400)}"`;
    }
  }

  // ── Step 5: Luna crafts the perfect prompt ────────────────────
  const systemPrompt = craft(plan, baseSystemPrompt, webResults, conversationContext);

  // ── Step 6: Route to the right model ─────────────────────────
  const routeDecision = route(plan, clientModel, isOwner);
  console.log(`[Luna] ${routeDecision.label}`);

  let rawReply = '';

  // ── Step 7: Execute ─────────────────────────────────────────────
  // Priority: Groq (fast) → OpenRouter (wide fallback) → Gemini → error message
  // RO-1 races Groq DeepSeek R1 vs Gemini for best quality answer.

  if (routeDecision.raceGemini) {
    // RO-1: race Groq DeepSeek R1 vs Gemini simultaneously
    try {
      const [groqResult, geminiResult] = await Promise.allSettled([
        executeGroq(systemPrompt, history, routeDecision.models, plan),
        executeGemini(systemPrompt, history, image, video, file)
      ]);
      const groqRaw = groqResult.status === 'fulfilled' ? groqResult.value : null;
      const geminiRaw = geminiResult.status === 'fulfilled' ? geminiResult.value : null;

      const { cleanReply: groqClean } = extractThinkTags(groqRaw || '');
      const { cleanReply: geminiClean } = extractThinkTags(geminiRaw || '');

      if (groqClean && geminiClean) {
        rawReply = geminiClean.length >= groqClean.length ? (geminiRaw || '') : (groqRaw || '');
        console.log(`[Luna RO-1] Picked: ${geminiClean.length >= groqClean.length ? 'Gemini' : 'DeepSeek R1'}`);
      } else {
        rawReply = groqRaw || geminiRaw || '';
      }
    } catch (e) {
      console.warn('[Luna RO-1] Race failed:', e.message);
    }
  }

  // Step 1: Try Groq (fast, primary for all tiers)
  if (!rawReply) {
    try {
      rawReply = await executeGroq(systemPrompt, history, routeDecision.models, plan);
    } catch (e) {
      console.warn('[Luna] Groq failed — trying OpenRouter:', e.message);
    }
  }

  // Step 2: OpenRouter fallback (wide model pool)
  if (!rawReply) {
    try {
      rawReply = await executeOpenRouter(systemPrompt, history, routeDecision.models, plan);
    } catch (e) {
      console.warn('[Luna] OpenRouter failed — trying Gemini:', e.message);
    }
  }

  // Step 3: Gemini fallback
  if (!rawReply && geminiKeys.length > 0) {
    try {
      rawReply = await executeGemini(systemPrompt, history, image, video, file);
      console.log('[Luna] Gemini fallback used');
    } catch (e) {
      console.warn('[Luna] Gemini also failed:', e.message);
    }
  }

  // Step 4: Give up gracefully
  if (!rawReply) {
    rawReply = "I'm having trouble connecting right now. Please try again in a moment.";
    console.warn('[Luna] All providers failed');
  }

  // ── Step 8: Extract think tags from raw reply ─────────────────
  const { thinkContent, cleanReply } = extractThinkTags(rawReply);
  const fullReply = cleanReply || '';

  // ── Step 9: Detect image JSON signal ─────────────────────────
  try {
    const trimmed = fullReply.trim();
    if (trimmed.startsWith('{') && trimmed.includes('"generateImage"')) {
      const parsed = JSON.parse(trimmed);
      if (parsed.generateImage && parsed.prompt) {
        return { generateImage: true, prompt: parsed.prompt, editLastImage: !!parsed.editLastImage };
      }
    }
  } catch (e) { /* not a signal */ }

  // ── Step 10: Stream clean reply to user ──────────────────────
  // Send think content as a separate SSE event BEFORE streaming reply
  // Frontend receives { think: "..." } and renders the collapsible
  if (thinkContent && onChunk) {
    onChunk({ think: thinkContent });
  }

  // Stream the clean reply word by word
  if (fullReply && onChunk) {
    const words = fullReply.split(' ');
    for (const word of words) {
      onChunk({ delta: word + ' ' });
      await new Promise(r => setTimeout(r, 15));
    }
  }

  return { reply: fullReply, thinkContent };
}

module.exports = { think, route, craft, respond };
