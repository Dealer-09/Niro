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
const SYSTEM_PROMPT = `You are Niro, a Windows desktop AI assistant. Execute tasks using the provided tools.

Rules:
- Always use tools to complete tasks, never just describe what to do
- For opening apps use open_app. For websites use open_website
- For system info use run_command with PowerShell
- For timers use set_timer
- Be concise in responses

You are on Windows. PowerShell is available via run_command.`;

// ─── Tool declarations ────────────────────────────────────────────────────────
// CORE tools — always sent to Groq (kept minimal to stay under token limits)
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
    description: 'Set a countdown timer with a notification when done.',
    parameters: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: 'Duration in minutes' },
        label: { type: 'string', description: 'Timer label' },
      },
      required: ['minutes', 'label'],
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

// Gemini always gets all tools
const GEMINI_TOOLS = [{ functionDeclarations: [...CORE_TOOLS, ...BROWSER_TOOLS] }];

// Groq gets core tools by default; browser tools added only when needed
const BROWSER_KEYWORDS = /browser|chrome|web|website|url|http|google|youtube|gmail|search online|navigate/i;

function getGroqTools(message) {
  const tools = [...CORE_TOOLS];
  if (BROWSER_KEYWORDS.test(message)) {
    tools.push(...BROWSER_TOOLS);
  }
  return tools.map(t => ({ type: 'function', function: t }));
}

// ─── Client initialization ────────────────────────────────────────────────────
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
  for (const m of chatHistory) {
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
    parallel_tool_calls: false,  // one tool at a time — prevents format errors on free tier
    max_tokens: 4096,            // stay well under the 6k TPM limit per request
    temperature: 0.2,            // lower = more reliable tool call JSON generation
  };

  const resp = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    // Surface rate limit errors clearly
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

        let toolResult;
        try {
          const result = await executeTool(toolName, toolArgs);
          toolResult = {
            output: result.isImage ? 'Screenshot captured successfully.' : result.result,
          };
        } catch (err) {
          toolResult = { error: err.message };
        }

        responseParts.push({
          functionResponse: { name: toolName, response: toolResult },
        });
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
          toolResultContent = result.isImage
            ? 'Screenshot captured successfully.'
            : (result.result || 'Done.');
        } catch (err) {
          toolResultContent = `Error: ${err.message}`;
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResultContent,
        });
      }
      continue; // loop back with tool results
    }

    // Text response
    const text = assistantMsg.content;
    if (text) {
      fullResponse = text;
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
