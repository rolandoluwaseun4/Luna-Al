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
  owner: 'qwen/qwen3-32b',           // best available on Groq for reasoning
  user:  'llama-3.3-70b-versatile',  // reliable, no daily cap
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
// Language map for Glot.io
const GLOT_LANG_MAP = {
  python: 'python', python3: 'python',
  javascript: 'javascript', js: 'javascript',
  typescript: 'typescript', ts: 'typescript',
  bash: 'bash', sh: 'bash',
  c: 'c', cpp: 'cpp',
  java: 'java', rust: 'rust', go: 'go',
};

async function toolRunCode(code, language = 'python') {
  const lang = GLOT_LANG_MAP[language.toLowerCase()];
  if (!lang) throw new Error(`Unsupported language: ${language}. Supported: ${Object.keys(GLOT_LANG_MAP).join(', ')}`);

  const ext = { python: 'py', javascript: 'js', typescript: 'ts', bash: 'sh', c: 'c', cpp: 'cpp', java: 'java', rust: 'rs', go: 'go' };
  const filename = `main.${ext[lang] || lang}`;

  // Try Piston first (best, no auth), fall back to Glot (needs key)
  const pistonEndpoints = [
    'https://emkc.org/api/v2/piston/execute',
  ];

  const pistonVersions = { python: '3.10.0', javascript: '18.15.0', typescript: '5.0.3', bash: '5.2.0', c: '10.2.0', cpp: '10.2.0', java: '15.0.2', rust: '1.50.0', go: '1.16.2' };

  for (const endpoint of pistonEndpoints) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), STEP_TIMEOUT);

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language: lang,
          version: pistonVersions[lang] || '*',
          files: [{ name: filename, content: code }],
          stdin: '', args: [],
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!res.ok) {
        console.warn(`[Code] Piston endpoint \${endpoint} returned \${res.status}`);
        continue; // try next endpoint
      }

      const data = await res.json();
      const stdout = data.run?.stdout || '';
      const stderr = data.run?.stderr || '';
      const exitCode = data.run?.code ?? 0;

      if (exitCode !== 0 && stderr) return `Error:\n\${stderr.slice(0, 500)}`;
      console.log(`[Code] Piston ✅ via \${endpoint}`);
      return stdout.slice(0, 2000) || '(no output)';
    } catch (err) {
      console.warn(`[Code] Piston \${endpoint} failed: \${err.message}`);
    }
  }

  // Glot fallback (requires GLOT_API_KEY env var)
  if (process.env.GLOT_API_KEY) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), STEP_TIMEOUT);
      const res = await fetch(`https://glot.io/api/run/\${lang}/latest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Token \${process.env.GLOT_API_KEY}` },
        body: JSON.stringify({ files: [{ name: filename, content: code }] }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json();
        console.log('[Code] Glot ✅');
        return (data.stdout || data.stderr || data.error || '(no output)').slice(0, 2000);
      }
    } catch (err) {
      console.warn('[Code] Glot failed:', err.message);
    }
  }

  throw new Error('All code execution providers failed');
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
//  MATH DETECTION
// ═════════════════════════════════════════════════════════════════════════

const MATH_KEYWORDS = [
  'solve', 'calculate', 'compute', 'find', 'what is', 'evaluate',
  'simplify', 'factorise', 'factorize', 'expand', 'differentiate',
  'integrate', 'derivative', 'equation', 'inequality', 'prove',
  'geometry', 'triangle', 'circle', 'area', 'perimeter', 'volume',
  'probability', 'statistics', 'mean', 'median', 'mode', 'variance',
  'algebra', 'quadratic', 'linear', 'matrix', 'vector', 'fraction',
  'percentage', 'ratio', 'proportion', 'interest', 'profit', 'loss',
  'speed', 'distance', 'time', 'angle', 'pythagoras', 'trigonometry',
  'sin', 'cos', 'tan', 'logarithm', 'log', 'indices', 'surd',
  '+', '-', '×', '÷', '=', '^', '√', '%'
];

const MATH_PATTERNS = [
  /\d+\s*[+\-*/^]\s*\d+/,          // arithmetic: 5 + 3, 12 * 4
  /\d+x|x\d+/i,                      // algebra: 3x, x2
  /\b\d+\.\d+/,                     // decimals
  /\b(sin|cos|tan|log|ln)\b/i,        // trig/log
  /\^\d+|\d+\^/,                    // powers: x^2
  /\b\d+\/\d+\b/,                  // fractions: 3/4
  /find\s+(the\s+)?(value|x|y|angle|area|length|volume)/i,
];

function isMathTask(task) {
  if (!task) return false;
  const lower = task.toLowerCase();
  const hasKeyword = MATH_KEYWORDS.some(k => lower.includes(k.toLowerCase()));
  const hasPattern = MATH_PATTERNS.some(p => p.test(task));
  return hasKeyword || hasPattern;
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

STRICT RULES:
1. Respond ONLY with valid JSON — no markdown, no explanation outside the JSON
2. You MUST use at least one tool before you are allowed to set "done": true
3. NEVER answer from memory alone — always verify with web_search first
4. For ANY research, comparison, "top X", current events, or factual task → start with web_search
5. After web_search, read the most relevant URL with read_url for deeper detail
6. For code tasks → use run_code to execute and verify it works
7. When asked to create a file → use create_document as your LAST step
8. When done, write a thorough, detailed final answer in "reply" — not a summary

RESPONSE FORMAT (always valid JSON):
{
  "thinking": "brief reasoning about what to do next",
  "done": false,
  "tool": "web_search",
  "args": { "query": "..." }
}

OR when finished (only after using at least one tool):
{
  "thinking": "I searched the web and have real verified info",
  "done": true,
  "reply": "Full detailed answer based on what I actually found..."
}`;

// ── Math-specific system prompt ───────────────────────────────────────────
// Used instead of AGENT_SYSTEM_PROMPT when isMathTask() returns true.
const MATH_SYSTEM_PROMPT = `You are Luna's math agent. You solve problems step by step, clearly, so a student can actually learn.

AVAILABLE TOOLS:
- run_code(code: string, language: "python") — execute Python to compute exact answers
- web_search(query: string) — look up formulas or methods you are unsure about

HOW TO HANDLE EVERY MATH PROBLEM:

Step 1 — Identify the problem type (algebra, geometry, arithmetic, statistics, etc.)
Step 2 — Write Python code to solve it exactly. Use run_code.
Step 3 — When you have the computed answer, set done: true and write the reply.

REPLY FORMAT (when done):
Write the reply in plain, simple language a student can follow:

1. State what type of problem it is in one sentence.
2. Explain the method — what approach are you using and why.
3. Show each step clearly, numbered. Use simple words. No jargon unless necessary.
4. State the final answer clearly on its own line.
5. Add a one-line tip about this type of problem if helpful.

RULES:
- Never guess or estimate — always use run_code for the actual computation
- Show the working, not just the answer — the goal is understanding
- Use simple language. Imagine explaining to a secondary school student.
- If the problem has multiple parts, solve each part separately
- Respond ONLY in valid JSON

RESPONSE FORMAT:
{
  "thinking": "what type of problem this is and my plan",
  "done": false,
  "tool": "run_code",
  "args": { "code": "# Python solution\n...", "language": "python" }
}

OR when done:
{
  "thinking": "computed the answer, ready to explain",
  "done": true,
  "reply": "Step by step explanation here..."
}`;

async function thinkStep(task, stepHistory, model, isMath) {
  // Build context from all previous steps
  const stepContext = stepHistory.map((s, i) =>
    `Step ${i+1}: Used ${s.tool}\nArgs: ${JSON.stringify(s.args)}\nResult: ${String(s.result).slice(0, 800)}`
  ).join('\n\n---\n\n');

  const userMessage = stepHistory.length === 0
    ? `Task: ${task}\n\nWhat is your first step?`
    : `Task: ${task}\n\nSteps completed so far:\n${stepContext}\n\nWhat is your next step? If you have enough info, set done: true and write the reply.`;

  // Use math prompt for math tasks, standard prompt for everything else
  const systemPrompt = isMath ? MATH_SYSTEM_PROMPT : AGENT_SYSTEM_PROMPT;

  const res = await groq.chat.completions.create({
    model,
    max_tokens: 1500,
    temperature: 0.1, // lower temp for math — we want precision not creativity
    messages: [
      { role: 'system', content: systemPrompt },
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
  const mathTask = isMathTask(task); // detect math once upfront

  const emit = (data) => { if (onStep) onStep(data); };

  console.log(`[Agent] Starting — model: ${model}, math: ${mathTask}, task: "${task.slice(0, 80)}"`);
  emit({ type: 'thinking', text: mathTask ? 'Reading the problem...' : 'Planning your task...' });

  let toolsUsed = 0; // track tool calls — must use at least 1 before done

  for (let step = 0; step < MAX_STEPS; step++) {
    try {
      // ── Think: decide what to do ────────────────────────────────────────
      console.log(`[Agent] Step ${step + 1}/${MAX_STEPS} — thinking...`);
      const decision = await thinkStep(task, stepHistory, model, mathTask);

      if (decision.thinking) {
        console.log(`[Agent] Thinking: ${decision.thinking.slice(0, 100)}`);
      }

      // ── Done: synthesize final answer ────────────────────────────────────
      // Block early exit if no tools used yet — force at least web_search
      const forcedTool = toolsUsed === 0 && (decision.done || !decision.tool);
      if (forcedTool) {
        if (mathTask) {
          // For math — force run_code with a basic Python solution attempt
          console.warn('[Agent] Math task tried to skip tools — forcing run_code');
          decision.done = false;
          decision.tool = 'run_code';
          decision.args = {
            code: `# Solving: ${task.slice(0, 100)}
# Write your solution here
print("Computing...")`,
            language: 'python'
          };
        } else {
          console.warn('[Agent] Tried to answer without using any tools — forcing web_search');
          decision.done = false;
          decision.tool = 'web_search';
          decision.args = { query: task.slice(0, 200) };
        }
      }

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
      toolsUsed++;

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
