'use strict';

/**
 * agent.js — Luna's Agent System
 *
 * Luna as an agent: thinks, uses tools, loops until done.
 *
 * ── FLOW ──────────────────────────────────────────────────────────────────
 *   1. Luna receives task
 *   2. Luna thinks: what tool do I need? what args?
 *   3. Luna executes the tool
 *   4. Luna sees result, thinks again
 *   5. Repeat up to MAX_STEPS
 *   6. Luna synthesizes everything into a final answer
 *
 * ── MODEL ROUTING ─────────────────────────────────────────────────────────
 *   Owner → RO-1  (deepseek-r1-distill-llama-70b — full reasoning)
 *   Users → Pro   (deepseek-r1-distill-llama-70b — same model, shared)
 *   Both get thinking tags stripped before output
 *
 * ── TOOLS ─────────────────────────────────────────────────────────────────
 *   web_search      — Tavily search (existing key)
 *   read_url        — Jina URL reader (existing)
 *   run_code        — Piston API (free, no key, Python + JS + 70 langs)
 *   create_document — Returns markdown/HTML as downloadable base64
 *
 * ── STREAMING ─────────────────────────────────────────────────────────────
 *   onStep({ type, ... }) called at each stage:
 *   { type: 'thinking',  text }
 *   { type: 'tool',      tool, args }
 *   { type: 'result',    tool, summary }
 *   { type: 'done',      reply }
 *   { type: 'error',     message }
 * ─────────────────────────────────────────────────────────────────────────
 */

const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MAX_STEPS = 8;       // Safety cap — prevents infinite loops
const STEP_TIMEOUT = 30000; // 30s per tool call

// ── Model config ─────────────────────────────────────────────────────────
const AGENT_MODELS = {
  owner: 'deepseek-r1-distill-llama-70b', // RO-1
  user:  'deepseek-r1-distill-llama-70b', // Pro (same, different framing)
};

// ═════════════════════════════════════════════════════════════════════════
//  TOOLS
// ═════════════════════════════════════════════════════════════════════════

// ── Tool: Web Search (Tavily) ─────────────────────────────────────────────
async function toolWebSearch(query) {
  if (!process.env.TAVILY_API_KEY) throw new Error('No Tavily key');
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      max_results: 5,
      include_answer: true,
      include_raw_content: false,
    })
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}`);
  const data = await res.json();

  // Return structured summary
  const answer = data.answer ? `Summary: ${data.answer}\n\n` : '';
  const results = (data.results || []).map((r, i) =>
    `[${i+1}] ${r.title}\n${r.url}\n${r.content?.slice(0, 300)}...`
  ).join('\n\n');
  return answer + results;
}

// ── Tool: Read URL (Jina) ─────────────────────────────────────────────────
async function toolReadUrl(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STEP_TIMEOUT);
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { 'Accept': 'text/plain', 'X-Timeout': '20' },
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Jina ${res.status}`);
    const text = await res.text();
    return text.slice(0, 4000); // Cap at 4k chars
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ── Tool: Run Code (Piston API — free, no key needed) ────────────────────
// Supports: python, javascript, typescript, bash, c, cpp, java, rust, go...
const PISTON_LANG_MAP = {
  python: { language: 'python', version: '3.10.0' },
  python3: { language: 'python', version: '3.10.0' },
  javascript: { language: 'javascript', version: '18.15.0' },
  js: { language: 'javascript', version: '18.15.0' },
  typescript: { language: 'typescript', version: '5.0.3' },
  ts: { language: 'typescript', version: '5.0.3' },
  bash: { language: 'bash', version: '5.2.0' },
  sh: { language: 'bash', version: '5.2.0' },
  c: { language: 'c', version: '10.2.0' },
  cpp: { language: 'c++', version: '10.2.0' },
  java: { language: 'java', version: '15.0.2' },
  rust: { language: 'rust', version: '1.50.0' },
  go: { language: 'go', version: '1.16.2' },
};

async function toolRunCode(code, language = 'python') {
  const lang = PISTON_LANG_MAP[language.toLowerCase()];
  if (!lang) throw new Error(`Unsupported language: ${language}. Supported: ${Object.keys(PISTON_LANG_MAP).join(', ')}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STEP_TIMEOUT);

  try {
    const res = await fetch('https://emkc.org/api/v2/piston/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        language: lang.language,
        version: lang.version,
        files: [{ content: code }],
        stdin: '',
        args: [],
        compile_timeout: 10000,
        run_timeout: 10000,
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`Piston ${res.status}`);
    const data = await res.json();

    const stdout = data.run?.stdout || '';
    const stderr = data.run?.stderr || '';
    const exitCode = data.run?.code ?? 0;

    if (exitCode !== 0 && stderr) {
      return `Error (exit ${exitCode}):\n${stderr.slice(0, 1000)}`;
    }
    return stdout.slice(0, 2000) || '(no output)';
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ── Tool: Create Document ─────────────────────────────────────────────────
// Returns { filename, content, mimeType } for frontend to offer as download
function toolCreateDocument(content, filename = 'luna-output') {
  // Auto-detect format from content
  const isHtml = content.trim().startsWith('<!DOCTYPE') || content.trim().startsWith('<html');
  const isMarkdown = content.includes('##') || content.includes('**') || content.includes('- ');

  let ext, mimeType;
  if (isHtml) {
    ext = 'html';
    mimeType = 'text/html';
  } else if (isMarkdown) {
    ext = 'md';
    mimeType = 'text/markdown';
  } else {
    ext = 'txt';
    mimeType = 'text/plain';
  }

  const finalFilename = filename.endsWith(`.${ext}`) ? filename : `${filename}.${ext}`;
  const base64 = Buffer.from(content, 'utf8').toString('base64');

  return {
    filename: finalFilename,
    base64,
    mimeType,
    size: content.length,
  };
}

// ── Tool dispatcher ───────────────────────────────────────────────────────
async function executeTool(toolName, args) {
  switch (toolName) {
    case 'web_search':
      return await toolWebSearch(args.query);
    case 'read_url':
      return await toolReadUrl(args.url);
    case 'run_code':
      return await toolRunCode(args.code, args.language || 'python');
    case 'create_document':
      return toolCreateDocument(args.content, args.filename);
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  AGENT BRAIN — Think step (decides what to do next)
// ═════════════════════════════════════════════════════════════════════════

const AGENT_SYSTEM_PROMPT = `You are Luna's agent brain. You execute multi-step tasks using tools.

AVAILABLE TOOLS:
- web_search(query: string) — search the web for current info
- read_url(url: string) — read the full content of a webpage
- run_code(code: string, language: string) — execute code and get output
- create_document(content: string, filename: string) — create a downloadable file

RULES:
1. Respond ONLY with valid JSON — no markdown, no explanation outside the JSON
2. Each step, decide: should I use a tool, or am I done?
3. When done, set "done": true and write the full final answer in "reply"
4. Keep tool calls focused — one clear goal per step
5. After web_search, read the most relevant URL for deeper info
6. When asked to create a file, use create_document as your LAST step
7. Never loop more than needed — be efficient

RESPONSE FORMAT (always valid JSON):
{
  "thinking": "brief reasoning about what to do next",
  "done": false,
  "tool": "web_search",
  "args": { "query": "..." }
}

OR when finished:
{
  "thinking": "I have all the info I need",
  "done": true,
  "reply": "Full final answer to the user..."
}`;

async function thinkStep(task, stepHistory, model) {
  // Build context from all previous steps
  const stepContext = stepHistory.map((s, i) =>
    `Step ${i+1}: Used ${s.tool}\nArgs: ${JSON.stringify(s.args)}\nResult: ${String(s.result).slice(0, 800)}`
  ).join('\n\n---\n\n');

  const userMessage = stepHistory.length === 0
    ? `Task: ${task}\n\nWhat is your first step?`
    : `Task: ${task}\n\nSteps completed so far:\n${stepContext}\n\nWhat is your next step? If you have enough info, set done: true and write the reply.`;

  const res = await groq.chat.completions.create({
    model,
    max_tokens: 1500,
    temperature: 0.3,
    messages: [
      { role: 'system', content: AGENT_SYSTEM_PROMPT },
      { role: 'user', content: userMessage }
    ]
  });

  let raw = res.choices[0]?.message?.content?.trim() || '{}';

  // Strip <think> tags if DeepSeek includes them
  raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // Strip markdown code fences if present
  raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();

  try {
    return JSON.parse(raw);
  } catch (e) {
    // Try to extract JSON from response
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[0]); } catch {}
    }
    throw new Error(`Agent returned invalid JSON: ${raw.slice(0, 200)}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  MAIN AGENT RUNNER
// ═════════════════════════════════════════════════════════════════════════

/**
 * runAgent — executes a multi-step task using tools
 *
 * @param {string} task — the user's request
 * @param {Array}  history — conversation history (for context)
 * @param {boolean} isOwner — true = RO-1 model, false = Pro model
 * @param {Function} onStep — callback for streaming progress to user
 * @returns {Promise<{ reply: string, document?: object }>}
 */
async function runAgent(task, history = [], isOwner = false, onStep = null) {
  const model = isOwner ? AGENT_MODELS.owner : AGENT_MODELS.user;
  const stepHistory = [];
  let finalDocument = null;

  const emit = (data) => { if (onStep) onStep(data); };

  console.log(`[Agent] Starting — model: ${model}, task: "${task.slice(0, 80)}"`);
  emit({ type: 'thinking', text: 'Planning your task...' });

  for (let step = 0; step < MAX_STEPS; step++) {
    try {
      // ── Think: decide what to do ────────────────────────────────────────
      console.log(`[Agent] Step ${step + 1}/${MAX_STEPS} — thinking...`);
      const decision = await thinkStep(task, stepHistory, model);

      if (decision.thinking) {
        console.log(`[Agent] Thinking: ${decision.thinking.slice(0, 100)}`);
      }

      // ── Done: synthesize final answer ────────────────────────────────────
      if (decision.done || step === MAX_STEPS - 1) {
        const reply = decision.reply || 'Task complete.';
        console.log(`[Agent] Done after ${step + 1} steps`);
        emit({ type: 'done', reply });
        return { reply, document: finalDocument };
      }

      // ── Execute tool ─────────────────────────────────────────────────────
      const toolName = decision.tool;
      const toolArgs = decision.args || {};

      if (!toolName) {
        // No tool specified but not done — ask again
        stepHistory.push({ tool: 'think', args: {}, result: 'No tool selected' });
        continue;
      }

      emit({ type: 'tool', tool: toolName, args: toolArgs });
      console.log(`[Agent] Executing: ${toolName}(${JSON.stringify(toolArgs).slice(0, 100)})`);

      let result;
      try {
        result = await executeTool(toolName, toolArgs);
      } catch (toolErr) {
        result = `Tool error: ${toolErr.message}`;
        console.warn(`[Agent] Tool ${toolName} failed: ${toolErr.message}`);
      }

      // Handle create_document specially — store for return value
      if (toolName === 'create_document' && result?.base64) {
        finalDocument = result;
        result = `Document created: ${result.filename} (${result.size} chars)`;
      }

      // Summarise result for the emit (don't send raw 4000-char web content)
      const resultSummary = typeof result === 'string'
        ? result.slice(0, 200) + (result.length > 200 ? '...' : '')
        : JSON.stringify(result).slice(0, 200);

      emit({ type: 'result', tool: toolName, summary: resultSummary });
      console.log(`[Agent] ${toolName} result: ${resultSummary}`);

      stepHistory.push({ tool: toolName, args: toolArgs, result });

    } catch (err) {
      console.error(`[Agent] Step ${step + 1} error:`, err.message);
      emit({ type: 'error', message: err.message });

      // Give Luna one more chance to wrap up with what it has
      if (stepHistory.length > 0) {
        const fallbackReply = `I ran into an issue at step ${step + 1}: ${err.message}. Here's what I found so far:\n\n${
          stepHistory.map(s => `**${s.tool}:** ${String(s.result).slice(0, 400)}`).join('\n\n')
        }`;
        return { reply: fallbackReply, document: finalDocument };
      }

      throw err;
    }
  }

  // Exceeded max steps — synthesize what we have
  console.warn('[Agent] Max steps reached — synthesizing');
  const fallbackReply = `I've completed ${MAX_STEPS} research steps. Here's what I found:\n\n${
    stepHistory.map(s => `**${s.tool}:** ${String(s.result).slice(0, 400)}`).join('\n\n')
  }`;
  return { reply: fallbackReply, document: finalDocument };
}

module.exports = { runAgent };
