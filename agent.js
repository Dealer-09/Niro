// agent.js — Niro AI orchestration: Groq + Gemini, user-supplied API keys only
import { GoogleGenAI } from '@google/genai';
import { executeTool } from './tools.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ─── State ────────────────────────────────────────────────────────────────────
let llmClient = null;
let currentProvider = 'groq'; // default: groq
let currentModel = null;
let abortFlag = false;

// ─── Model defaults ───────────────────────────────────────────────────────────
const PROVIDER_DEFAULTS = {
  groq:   { model: 'llama-3.1-8b-instant', baseURL: 'https://api.groq.com/openai/v1' },
  gemini: { model: 'gemini-2.5-flash-lite' }, // fastest, best free tier throughput, strong tool calling
};

// ─── System Prompt ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Niro, a Windows desktop AI assistant.

STRICT RULES — follow exactly:
1. Use tools to complete tasks. Never just describe what to do.
2. After a tool returns a result, give the user the answer as text. STOP. Do not call more tools.
3. NEVER call show_notification unless the user explicitly says "notify me" or "show a notification".
4. Use open_app for apps, open_website for URLs, run_command for system info, set_timer for timers.
5. One tool call per turn unless the task genuinely requires chaining (e.g. open app THEN type).

POWERSHELL COMMANDS — use these exact strings:
- Public IP: (Invoke-RestMethod https://api.ipify.org)
- RAM total GB: [math]::Round((Get-WmiObject Win32_OperatingSystem).TotalVisibleMemorySize/1MB,2)
- RAM free GB: [math]::Round((Get-WmiObject Win32_OperatingSystem).FreePhysicalMemory/1MB,2)
- Disk C free GB: [math]::Round((Get-PSDrive C).Free/1GB,1)
- Disk C total GB: [math]::Round(((Get-PSDrive C).Used+(Get-PSDrive C).Free)/1GB,1)
- CPU: (Get-WmiObject Win32_Processor).Name
- PC name: $env:COMPUTERNAME
- Windows ver: (Get-WmiObject Win32_OperatingSystem).Caption
- Top processes: Get-Process | Sort-Object CPU -Desc | Select-Object -First 10 Name,CPU | Format-Table -Auto

For RAM: run TWO separate run_command calls (one for total, one for free), then combine in your answer.

URL rules:
- YouTube channel @name: https://www.youtube.com/@<name>
- YouTube search: https://www.youtube.com/results?search_query=<query>
- Google search: https://www.google.com/search?q=<query>
- GitHub repo: https://github.com/<owner>/<repo>
- GitHub user: https://github.com/<username>
- Wikipedia: https://en.wikipedia.org/wiki/<topic>
- Reddit: https://www.reddit.com/r/<subreddit>
- Always use open_website for any URL — never use open_app for websites

You are on Windows.`;

// ─── Tool declarations ────────────────────────────────────────────────────────
// CORE tools — always sent to Groq
// NOTE: take_screenshot is excluded from Groq — Groq cannot process images.
// It is only available when using Gemini.
const CORE_TOOLS = [
  {
    name: 'open_app',
    description: 'Open a Windows app by name. Examples: chrome, notepad, calculator, vscode, spotify.',
    parameters: {
      type: 'object',
      properties: { app: { type: 'string', description: 'App name or .exe path' } },
      required: ['app'],
    },
  },
  {
    name: 'open_website',
    description: 'Open a URL in the default browser.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Full URL with https://' } },
      required: ['url'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a PowerShell command. Use for system info, file ops, settings.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'PowerShell command' },
        silent: { type: 'boolean', description: 'If true, suppress output' },
      },
      required: ['command'],
    },
  },
  {
    name: 'set_timer',
    description: 'Set a countdown timer with a notification when done. Use minutes for minute-based timers, seconds for second-based timers.',
    parameters: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: 'Duration in minutes (use 0 if using seconds)' },
        seconds: { type: 'number', description: 'Duration in seconds (optional, use instead of minutes for short timers)' },
        label: { type: 'string', description: 'Timer label' },
      },
      required: ['label'],
    },
  },
  {
    name: 'show_notification',
    description: 'Show a Windows desktop notification.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Notification title' },
        message: { type: 'string', description: 'Notification body' },
      },
      required: ['title', 'message'],
    },
  },
  {
    name: 'take_screenshot',
    description: 'Take a screenshot of the screen.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'save_task',
    description: 'Save a task shortcut to the quick-access panel.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short task name' },
        instruction: { type: 'string', description: 'Full instruction to run' },
      },
      required: ['name', 'instruction'],
    },
  },
  {
    name: 'list_windows',
    description: 'List all open windows with titles and process names.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'focus_window',
    description: 'Bring a window to the foreground by title.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string', description: 'Partial window title' } },
      required: ['title'],
    },
  },
  {
    name: 'close_app',
    description: 'Close a running app by process name.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Process name to close' } },
      required: ['name'],
    },
  },
  {
    name: 'search_files',
    description: 'Search for files by name pattern.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Filename pattern' },
        directory: { type: 'string', description: 'Directory to search (default: user profile)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'type_text',
    description: 'Type text at the current cursor position.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to type' } },
      required: ['text'],
    },
  },
  {
    name: 'press_key',
    description: 'Press a key or shortcut. Examples: enter, ctrl+c, alt+tab.',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Key or combo' } },
      required: ['key'],
    },
  },
];

// BROWSER tools — only added when message mentions web/browser tasks
const BROWSER_TOOLS = [
  {
    name: 'run_task',
    description: 'Run a browser automation task using AI on your real Chrome.',
    parameters: {
      type: 'object',
      properties: { task: { type: 'string', description: 'Natural language browser instruction' } },
      required: ['task'],
    },
  },
  {
    name: 'browser_open',
    description: 'Open a URL in a headless Playwright browser.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to open' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element on the current browser page.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector' },
        text: { type: 'string', description: 'Visible text to click' },
      },
      required: [],
    },
  },
  {
    name: 'browser_type',
    description: 'Type into an input field on the current browser page.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector' },
        text: { type: 'string', description: 'Text to type' },
      },
      required: ['text'],
    },
  },
  {
    name: 'browser_read',
    description: 'Read visible text from the current browser page.',
    parameters: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'CSS selector (omit for full page)' } },
      required: [],
    },
  },
  {
    name: 'browser_close',
    description: 'Close the Playwright browser.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'mouse_click',
    description: 'Click at screen coordinates (x, y).',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate' },
        y: { type: 'number', description: 'Y coordinate' },
      },
      required: ['x', 'y'],
    },
  },
];

// Gemini always gets all tools including take_screenshot (it can see images)
const GEMINI_TOOLS = [{ functionDeclarations: [...CORE_TOOLS, ...BROWSER_TOOLS] }];

// Groq tool set — excludes take_screenshot (can't process images)
// and show_notification (model calls it unprompted too often)
const GROQ_CORE_TOOLS = CORE_TOOLS.filter(t =>
  t.name !== 'take_screenshot' && t.name !== 'show_notification'
);

// Groq gets core tools by default; browser tools added only when user explicitly
// wants AI browser automation (not just opening a URL with open_website)
const BROWSER_KEYWORDS = /\b(automate|browser agent|run task|fill form|log in|sign in|click on|scroll down|scrape|extract from website|interact with)\b/i;

function getGroqTools(message) {
  const tools = [...GROQ_CORE_TOOLS];
  if (BROWSER_KEYWORDS.test(message)) {
    tools.push(...BROWSER_TOOLS);
  }
  return tools.map(t => ({ type: 'function', function: t }));
}

// ─── Groq: static lookup tables (defined once, not per-call) ─────────────────
const DIRECT_COMMANDS = [
  {
    pattern: /\b(public\s+)?ip(\s+address)?\b/i,
    tool: 'run_command',
    args: { command: '(Invoke-RestMethod https://api.ipify.org)' },
    format: (r) => `Your public IP address is ${r.trim()}.`,
  },
  {
    pattern: /\bhow much\s+(ram|memory)\b|\b(ram|memory)\s+(do i have|is free|total|usage|available)\b/i,
    isRam: true,
  },
  {
    pattern: /\b(disk|drive|storage|space)\b.*\bC\b|\bC\b.*\b(disk|drive|storage|space)\b|\bhow much.*free.*disk\b|\bdisk.*free\b/i,
    tool: 'run_command',
    args: { command: '[math]::Round((Get-PSDrive C).Free/1GB,1)' },
    format: (r) => `C drive has ${r.trim()} GB free.`,
  },
  {
    pattern: /\b(computer|pc|machine|host)\s*name\b/i,
    tool: 'run_command',
    args: { command: '$env:COMPUTERNAME' },
    format: (r) => `Your computer name is ${r.trim()}.`,
  },
  {
    pattern: /\b(cpu|processor)\b/i,
    tool: 'run_command',
    args: { command: '(Get-WmiObject Win32_Processor).Name' },
    format: (r) => `Your CPU is: ${r.trim()}`,
  },
  {
    pattern: /\bwindows\s*(version|ver)\b|\bos\s*version\b/i,
    tool: 'run_command',
    args: { command: '(Get-WmiObject Win32_OperatingSystem).Caption' },
    format: (r) => `Your Windows version is: ${r.trim()}`,
  },
  {
    pattern: /\b(top|running)\s*(processes|apps|programs)\b.*\bcpu\b|\bcpu\b.*\b(processes|apps)\b/i,
    tool: 'run_command',
    args: { command: 'Get-Process | Sort-Object CPU -Desc | Select-Object -First 10 Name,@{N="CPU(s)";E={[math]::Round($_.CPU,1)}} | Format-Table -Auto | Out-String -Width 200' },
    format: (r) => `Top processes by CPU:\n${r.trim()}`,
  },
  {
    pattern: /\b(top|most)\s*\d*\s*(processes|apps|programs)\b.*\bmemory\b|\bmemory\b.*\b(processes|apps)\b|\bprocesses.*ram\b|\bram.*processes\b/i,
    tool: 'run_command',
    args: { command: 'Get-Process | Sort-Object WorkingSet -Desc | Select-Object -First 10 Name,@{N="RAM(MB)";E={[math]::Round($_.WorkingSet/1MB,1)}} | Format-Table -Auto | Out-String -Width 200' },
    format: (r) => `Top processes by memory:\n${r.trim()}`,
  },
];

// Fire-and-forget tools: execute once, reply directly, never loop back to model
const TERMINAL_TOOLS = new Set([
  'open_website', 'open_app', 'set_timer', 'show_notification',
  'focus_window', 'close_app', 'press_key', 'type_text', 'mouse_click',
  'save_task',
]);
/**
 * Initialize the LLM client with user-supplied credentials.
 * @param {object} opts
 * @param {'groq'|'gemini'} opts.provider
 * @param {string} opts.apiKey  — user's own API key
 * @param {string} [opts.model] — optional model override
 */
export function initClient({ provider = 'groq', apiKey, model } = {}) {
  if (!apiKey || !apiKey.trim()) {
    console.warn('[Niro] No API key provided — agent will not run until a key is set in Settings.');
    llmClient = null;
    return false;
  }

  try {
    currentProvider = provider;

    if (provider === 'gemini') {
      currentModel = model || PROVIDER_DEFAULTS.gemini.model;
      llmClient = new GoogleGenAI({ apiKey: apiKey.trim() });
      console.log(`[Niro] Gemini client initialized (model: ${currentModel})`);
    } else {
      // Groq uses OpenAI-compatible REST — no SDK needed, plain fetch
      currentModel = model || PROVIDER_DEFAULTS.groq.model;
      llmClient = {
        provider: 'groq',
        apiKey: apiKey.trim(),
        baseURL: PROVIDER_DEFAULTS.groq.baseURL,
        model: currentModel,
      };
      console.log(`[Niro] Groq client initialized (model: ${currentModel})`);
    }

    return true;
  } catch (e) {
    console.error('[Niro] Failed to initialize LLM client:', e.message);
    llmClient = null;
    return false;
  }
}

// ─── Stop agent ───────────────────────────────────────────────────────────────
export function stopAgent() {
  abortFlag = true;
}

// ─── Gemini helpers ───────────────────────────────────────────────────────────
function historyToGeminiContents(chatHistory) {
  return chatHistory
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
}

// ─── Groq helpers (OpenAI-compatible fetch) ───────────────────────────────────
function historyToOpenAIMessages(chatHistory) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  // Only send last 4 messages to Groq — keeps token count low and avoids
  // cross-contamination between different queries in the same session
  const recent = chatHistory.slice(-4);
  for (const m of recent) {
    if (m.role === 'user' || m.role === 'assistant') {
      messages.push({ role: m.role, content: m.content });
    }
  }
  return messages;
}

async function callGroq(messages, tools) {
  const { apiKey, baseURL, model } = llmClient;
  const body = {
    model,
    messages,
    tools,
    tool_choice: 'auto',
    parallel_tool_calls: false,
    max_tokens: 1024,
    temperature: 0.2,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

  try {
    const resp = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      let msg = `Groq API error (${resp.status}): ${errText}`;
      try {
        const parsed = JSON.parse(errText);
        if (parsed?.error?.code === 'rate_limit_exceeded') {
          msg = `Rate limit hit. Please wait a moment and try again. (${parsed.error.message.split('.')[0]})`;
        }
      } catch (_) {}
      throw new Error(msg);
    }

    return resp.json();
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Main agent loop ──────────────────────────────────────────────────────────
export async function runAgent(message, chatHistory, sendEvent) {
  if (!llmClient) {
    sendEvent('agent:error', {
      message: 'No API key configured. Open ⚙️ Settings and add your Groq or Gemini API key.',
    });
    return null;
  }

  abortFlag = false;

  try {
    if (currentProvider === 'gemini') {
      return await runGeminiAgent(message, chatHistory, sendEvent);
    } else {
      return await runGroqAgent(message, chatHistory, sendEvent);
    }
  } catch (err) {
    console.error('[Niro] Agent error:', err);
    sendEvent('agent:error', { message: err.message || 'Unknown error occurred' });
    return null;
  }
}

// ─── Gemini agent loop ────────────────────────────────────────────────────────
async function runGeminiAgent(message, chatHistory, sendEvent) {
  const history = historyToGeminiContents(chatHistory);

  const chat = llmClient.chats.create({
    model: currentModel,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      tools: GEMINI_TOOLS,
      temperature: 0.2,
      maxOutputTokens: 8192,
    },
    history,
  });

  let maxIterations = 10;
  let fullResponse = '';
  let nextMessage = { role: 'user', parts: [{ text: message }] };
  let toolResultParts = null;

  while (maxIterations > 0 && !abortFlag) {
    maxIterations--;

    let response;
    try {
      if (toolResultParts && toolResultParts.length > 0) {
        response = await chat.sendMessage({ message: toolResultParts });
        toolResultParts = null;
      } else if (nextMessage) {
        response = await chat.sendMessage({ message: nextMessage });
        nextMessage = null;
      } else {
        break;
      }
    } catch (err) {
      // Handle Gemini rate limit — parse retry delay from error if available
      const msg = err.message || '';
      const isRateLimit = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota');
      if (isRateLimit) {
        // Try to extract retry delay from error message (e.g. "retry in 38.5s")
        const delayMatch = msg.match(/retry[^\d]*(\d+(?:\.\d+)?)\s*s/i);
        const waitMs = delayMatch ? Math.ceil(parseFloat(delayMatch[1])) * 1000 : 40000;
        const waitSec = Math.ceil(waitMs / 1000);
        sendEvent('agent:chunk', { role: 'assistant', text: `⏳ Rate limit hit, retrying in ${waitSec}s...` });
        await new Promise(r => setTimeout(r, waitMs));
        if (abortFlag) break;
        // Retry the same message
        if (toolResultParts && toolResultParts.length > 0) {
          response = await chat.sendMessage({ message: toolResultParts });
          toolResultParts = null;
        } else if (nextMessage) {
          response = await chat.sendMessage({ message: nextMessage });
          nextMessage = null;
        } else {
          break;
        }
      } else {
        throw err;
      }
    }

    const candidate = response.candidates?.[0];
    if (!candidate) break;

    const parts = candidate.content?.parts || [];
    const hasFunctionCalls = parts.some(p => p.functionCall);

    if (hasFunctionCalls) {
      const responseParts = [];
      for (const part of parts) {
        if (!part.functionCall || abortFlag) continue;
        const toolName = part.functionCall.name;
        const toolArgs = part.functionCall.args || {};
        sendEvent('agent:tool', { name: toolName, input: toolArgs });

        let result;
        try {
          result = await executeTool(toolName, toolArgs);
        } catch (err) {
          result = { success: false, result: err.message };
        }

        if (result.isImage && result.result) {
          // Screenshot: send functionResponse + the actual image inline so Gemini can see it
          responseParts.push({
            functionResponse: {
              name: toolName,
              response: { output: 'Screenshot captured. Describe what you see in the image below.' },
            },
          });
          // Append the image as a separate inlineData part so the model can actually see it
          responseParts.push({
            inlineData: {
              mimeType: 'image/png',
              data: result.result, // base64 string
            },
          });
        } else {
          responseParts.push({
            functionResponse: {
              name: toolName,
              response: { output: result.result || 'Done.' },
            },
          });
        }
      }
      toolResultParts = responseParts;
      continue;
    }

    const textPart = parts.find(p => p.text);
    if (textPart?.text) {
      fullResponse = textPart.text;
      sendEvent('agent:chunk', { role: 'assistant', text: fullResponse });
    }
    break;
  }

  if (abortFlag) {
    sendEvent('agent:error', { message: 'Agent stopped by user.' });
    return null;
  }

  sendEvent('agent:done', {});
  return fullResponse;
}

// ─── Groq agent loop (OpenAI-compatible) ─────────────────────────────────────
async function runGroqAgent(message, chatHistory, sendEvent) {
  // Screenshot requires vision — Groq can't process images, short-circuit immediately
  if (/screenshot|what('s| is) on (my )?screen|what do you see/i.test(message)) {
    const reply = '📸 Screenshot and screen description requires Gemini (vision model). Switch to Gemini in ⚙️ Settings to use this feature.';
    sendEvent('agent:chunk', { role: 'assistant', text: reply });
    sendEvent('agent:done', {});
    return reply;
  }

  // ── Direct intercept: explicit notification requests ─────────────────────
  const notifMatch = /\b(show|send|display|give me|pop up)\b.*\bnotification\b|\bnotif(y|ication)\b.*\bsaying\b/i.test(message);
  if (notifMatch) {
    // Extract the message text — look for quoted string or "saying X"
    const quotedMatch = message.match(/["']([^"']+)["']/);
    const sayingMatch = message.match(/\bsaying\s+["']?([^"']+?)["']?\s*$/i);
    const notifText = quotedMatch?.[1] || sayingMatch?.[1] || message.replace(/show.*notification.*saying/i, '').trim();
    const notifTitle = 'Niro';
    sendEvent('agent:tool', { name: 'show_notification', input: { title: notifTitle, message: notifText } });
    await executeTool('show_notification', { title: notifTitle, message: notifText });
    const reply = `Notification shown: "${notifText}"`;
    sendEvent('agent:chunk', { role: 'assistant', text: reply });
    sendEvent('agent:done', {});
    return reply;
  }

  // ── Direct intercepts for common system info queries ──────────────────────
  // Skip intercepts for multi-part queries — let the LLM handle those
  const isMultiPartQuery = /\band\b.*\band\b|,.*,|all in one|together|combined|both|multiple/i.test(message)
    || (message.match(/\band\b/g) || []).length >= 2;

  if (!isMultiPartQuery) {

  // ── Direct intercept for file search ─────────────────────────────────────
  // Only trigger if message explicitly asks to find/search for files
  const isFileSearch = /\b(find|search|look for|locate)\b.*\bfile[s]?\b|\bfile[s]?\b.*\b(find|search|on desktop|in downloads|in documents)\b/i.test(message);
  const desktopMatch   = /\bdesktop\b/i.test(message);
  const downloadsMatch = /\bdownloads?\b/i.test(message);
  const documentsMatch = /\bdocuments?\b/i.test(message);
  const extMatch   = isFileSearch ? message.match(/\b(pdf|docx?|txt|xlsx?|png|jpg|jpeg|mp4|mp3|zip)\b/i) : null;
  const namedMatch = isFileSearch ? message.match(/\bnamed?\s+["']?([^\s"']+)["']?/i) : null;

  if (extMatch || namedMatch) {
    const query = namedMatch ? namedMatch[1] : `.${extMatch[1]}`;
    let dir = process.env.USERPROFILE || 'C:\\Users\\' + (process.env.USERNAME || 'User');
    if (desktopMatch) dir = `${process.env.USERPROFILE}\\Desktop`;
    else if (downloadsMatch) dir = `${process.env.USERPROFILE}\\Downloads`;
    else if (documentsMatch) dir = `${process.env.USERPROFILE}\\Documents`;

    sendEvent('agent:tool', { name: 'search_files', input: { query, directory: dir } });
    const result = await executeTool('search_files', { query, directory: dir });
    const reply = result.success && result.result !== `No files found matching '${query}'`
      ? `Found files matching "${query}":\n${result.result}`
      : `No files found matching "${query}" in ${dir.split('\\').pop()}.`;
    sendEvent('agent:chunk', { role: 'assistant', text: reply });
    sendEvent('agent:done', {});
    return reply;
  }

  for (const intercept of DIRECT_COMMANDS) {
    if (!intercept.pattern.test(message)) continue;

    if (intercept.isRam) {
      // RAM needs two commands
      sendEvent('agent:tool', { name: 'run_command', input: { command: 'RAM total' } });
      const totalResult = await executeTool('run_command', { command: '[math]::Round((Get-WmiObject Win32_OperatingSystem).TotalVisibleMemorySize/1MB,2)' });
      const freeResult  = await executeTool('run_command', { command: '[math]::Round((Get-WmiObject Win32_OperatingSystem).FreePhysicalMemory/1MB,2)' });
      const total = totalResult.result?.trim() || '?';
      const free  = freeResult.result?.trim()  || '?';
      const reply = `You have ${total} GB of RAM total, with ${free} GB currently free.`;
      sendEvent('agent:chunk', { role: 'assistant', text: reply });
      sendEvent('agent:done', {});
      return reply;
    }

    sendEvent('agent:tool', { name: intercept.tool, input: intercept.args });
    const result = await executeTool(intercept.tool, intercept.args);
    const reply = result.success
      ? intercept.format(result.result)
      : `Failed: ${result.result}`;
    sendEvent('agent:chunk', { role: 'assistant', text: reply });
    sendEvent('agent:done', {});
    return reply;
  }
  } // end !isMultiPartQuery

  // ── Direct intercept for GitHub repos ────────────────────────────────────
  const githubRepoMatch = message.match(/\bgithub\b.*\b(repo|repository)\b.*\b([\w.-]+)\/([\w.-]+)\b|\b([\w.-]+)\/([\w.-]+)\b.*\bgithub\b/i);
  if (githubRepoMatch) {
    const repoStr = message.match(/\b([\w.-]+)\/([\w.-]+)\b/);
    if (repoStr) {
      const url = `https://github.com/${repoStr[1]}/${repoStr[2]}`;
      sendEvent('agent:tool', { name: 'open_website', input: { url } });
      await executeTool('open_website', { url });
      const reply = `Opened ${url}`;
      sendEvent('agent:chunk', { role: 'assistant', text: reply });
      sendEvent('agent:done', {});
      return reply;
    }
  }
  // ── End direct intercepts ─────────────────────────────────────────────────

  const messages = historyToOpenAIMessages(chatHistory);
  messages.push({ role: 'user', content: message });

  // Select tools based on message content — keeps token count low
  const tools = getGroqTools(message);

  let maxIterations = 10;
  let fullResponse = '';

  while (maxIterations > 0 && !abortFlag) {
    maxIterations--;

    // Retry once on rate limit with a short backoff
    let data;
    try {
      data = await callGroq(messages, tools);
    } catch (err) {
      if (err.message.includes('Rate limit') || err.message.includes('rate_limit')) {
        sendEvent('agent:chunk', { role: 'assistant', text: '⏳ Rate limit hit, retrying in 15s...' });
        await new Promise(r => setTimeout(r, 15000));
        if (abortFlag) break;
        data = await callGroq(messages, tools);
      } else {
        throw err;
      }
    }

    const choice = data.choices?.[0];
    if (!choice) break;

    const assistantMsg = choice.message;
    messages.push(assistantMsg);

    // Tool calls
    if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
      // Safety cap: never run more than 2 tool rounds total
      const toolRoundsRun = messages.filter(m => m.role === 'tool').length;
      if (toolRoundsRun >= 2) {
        const lastResult = messages.filter(m => m.role === 'tool').pop();
        const reply = lastResult?.content || 'Done.';
        sendEvent('agent:chunk', { role: 'assistant', text: reply });
        sendEvent('agent:done', {});
        return reply;
      }

      for (const toolCall of assistantMsg.tool_calls) {
        if (abortFlag) break;
        const toolName = toolCall.function.name;
        let toolArgs = {};
        try {
          toolArgs = JSON.parse(toolCall.function.arguments || '{}');
        } catch (_) {}

        sendEvent('agent:tool', { name: toolName, input: toolArgs });

        let toolResultContent;
        try {
          const result = await executeTool(toolName, toolArgs);
          if (result.isImage) {
            toolResultContent = 'Screenshot taken. Image analysis not available on Groq — use Gemini.';
          } else {
            const raw = result.result || 'Done.';
            toolResultContent = raw.length > 500 ? raw.substring(0, 500) + '...(truncated)' : raw;
          }
        } catch (err) {
          toolResultContent = `Error: ${err.message}`;
        }

        // For terminal tools: reply immediately and stop
        if (TERMINAL_TOOLS.has(toolName)) {
          sendEvent('agent:chunk', { role: 'assistant', text: toolResultContent });
          sendEvent('agent:done', {});
          return toolResultContent;
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResultContent,
        });
      }
      continue; // only reaches here for non-terminal tools (run_command, search_files, etc.)
    }

    // Text response — done, break immediately
    const text = assistantMsg.content;
    if (text) {
      fullResponse = text;
      sendEvent('agent:chunk', { role: 'assistant', text: fullResponse });
    }
    break; // always break on text — never loop after a final answer
  }

  if (abortFlag) {
    sendEvent('agent:error', { message: 'Agent stopped by user.' });
    return null;
  }

  sendEvent('agent:done', {});
  return fullResponse;
}

// ─── Voice transcription (Groq Whisper) ──────────────────────────────────────
/**
 * Transcribe audio using Groq Whisper API.
 * Always uses the user's stored Groq API key — never a hardcoded key.
 * @param {ArrayBuffer|Buffer} buffer  — raw audio bytes
 * @param {string} groqApiKey          — user's Groq API key from store
 */
export async function transcribeAudioBuffer(buffer, groqApiKey) {
  if (!groqApiKey || !groqApiKey.trim()) {
    throw new Error('A Groq API key is required for voice transcription. Add one in ⚙️ Settings.');
  }

  const tempFilePath = path.join(os.tmpdir(), `niro_audio_${Date.now()}.webm`);
  fs.writeFileSync(tempFilePath, Buffer.from(buffer));

  try {
    // Use FormData + fetch — no Groq SDK dependency needed
    const { default: FormData } = await import('form-data');
    const form = new FormData();
    form.append('file', fs.createReadStream(tempFilePath), {
      filename: 'audio.webm',
      contentType: 'audio/webm',
    });
    form.append('model', 'whisper-large-v3');
    form.append('response_format', 'json');

    const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${groqApiKey.trim()}`,
        ...form.getHeaders(),
      },
      body: form,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Groq Whisper error (${resp.status}): ${errText}`);
    }

    const result = await resp.json();
    return result.text || '';
  } finally {
    try {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    } catch (_) {}
  }
}