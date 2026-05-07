// tools/browser.js — Native JS AI Browser Agent (Gemini Vision + Chrome CDP)
import { chromium } from 'playwright';
import { GoogleGenAI } from '@google/genai';
import { launchChrome, waitForCDP, isChromeCDPReady } from './chrome.js';

let _initialized = false;
let _ready = false;
let _cdpBrowser = null;

// _geminiKey is set from main.js when the user saves their Gemini API key.
// We never read process.env here — all keys come from the user via Settings.
let _geminiKey = null;

const CDP_PORT = process.env.NIRO_CDP_PORT || 9222;
const GEMINI_MODEL = 'gemini-2.5-flash-lite';

// ─── Set Gemini key (called from main.js after user saves settings) ──────────
export function setGeminiApiKey(key) {
  _geminiKey = key || null;
}

// ─── Browser Agent Prompt ────────────────────────────────────────────────────
const BROWSER_AGENT_PROMPT = `
You are an AI Browser Agent. Your goal is to complete a task on a website.
You can "see" the page via a screenshot and a simplified DOM tree.

Available Actions:
1. click(selector): Click an element by CSS selector or text.
2. type(selector, text): Type text into an input field.
3. scroll(direction): 'up' or 'down'.
4. navigate(url): Go to a new URL.
5. wait(ms): Wait for a duration in milliseconds.
6. finish(answer): Task is complete. Provide a summary or answer.
7. fail(reason): Task cannot be completed.

Guidelines:
- Use specific CSS selectors when possible.
- Always explain what you are doing in the "thought" field.
- Respond ONLY in JSON format: { "thought": "...", "action": "...", "params": { ... } }
`;

// ─── Helper: Connect to user's Chrome via CDP ────────────────────────────────
async function getCDPPage() {
  if (!_cdpBrowser) {
    _cdpBrowser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
  }
  const contexts = _cdpBrowser.contexts();
  const context = contexts[0] || (await _cdpBrowser.newContext());
  const pages = context.pages();
  return pages[pages.length - 1] || (await context.newPage());
}

// ─── Core Agent Loop ─────────────────────────────────────────────────────────
export async function runTask(task, onProgress = null) {
  if (!_geminiKey) {
    throw new Error('A Gemini API key is required for browser automation. Add one in ⚙️ Settings.');
  }

  const genAI = new GoogleGenAI({ apiKey: _geminiKey });
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
  const page = await getCDPPage();

  let iterations = 0;
  const maxIterations = 15;

  if (onProgress) onProgress(`Starting task: ${task}`);

  while (iterations < maxIterations) {
    iterations++;

    // 1. Observe — screenshot + DOM snapshot
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 50 });
    const url = page.url();
    const title = await page.title();

    const elements = await page.evaluate(() => {
      const interactives = Array.from(
        document.querySelectorAll('button, a, input, [role="button"], select, textarea')
      );
      return interactives
        .map(el => {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return null;
          return {
            tag: el.tagName.toLowerCase(),
            text: el.innerText?.trim().substring(0, 50),
            placeholder: el.placeholder || undefined,
            id: el.id || undefined,
            selector: el.id ? `#${el.id}` : el.tagName.toLowerCase(),
          };
        })
        .filter(Boolean)
        .slice(0, 50);
    });

    const state = { url, title, task, elements, iteration: iterations };

    // 2. Think
    const promptParts = [
      { text: BROWSER_AGENT_PROMPT },
      { text: `Current State: ${JSON.stringify(state)}` },
      { inlineData: { mimeType: 'image/jpeg', data: screenshot.toString('base64') } },
      { text: `Task: ${task}` },
    ];

    const result = await model.generateContent(promptParts);
    const responseText = result.response.text();

    let plan;
    try {
      const jsonStr = responseText.match(/\{[\s\S]*\}/)?.[0] || responseText;
      plan = JSON.parse(jsonStr);
    } catch (e) {
      console.error('[browser.js] Failed to parse agent response:', responseText);
      throw new Error('Browser agent returned invalid JSON response');
    }

    if (onProgress) onProgress(plan.thought);

    // 3. Act
    const { action, params } = plan;

    if (action === 'finish') return params.answer || 'Task completed.';
    if (action === 'fail') throw new Error(`Browser agent: ${params.reason}`);

    try {
      if (action === 'click') {
        if (params.selector) {
          await page.click(params.selector, { timeout: 5000 });
        } else if (params.text) {
          await page.click(`text="${params.text}"`, { timeout: 5000 });
        }
      } else if (action === 'type') {
        await page.fill(params.selector, params.text, { timeout: 5000 });
      } else if (action === 'navigate') {
        await page.goto(params.url, { waitUntil: 'domcontentloaded' });
      } else if (action === 'scroll') {
        await page.mouse.wheel(0, params.direction === 'down' ? 500 : -500);
      } else if (action === 'wait') {
        await page.waitForTimeout(Math.min(params.ms || 1000, 5000));
      }
      // Brief pause for page stability
      await page.waitForTimeout(800);
    } catch (err) {
      console.warn(`[browser.js] Action "${action}" failed:`, err.message);
      // Continue — let the agent observe the unchanged state and retry
    }
  }

  throw new Error('Browser task timed out: reached maximum iterations (15)');
}

// ─── Direct navigation helper ────────────────────────────────────────────────
export async function navigate(url) {
  const page = await getCDPPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return `Navigated to ${url}`;
}

export async function getCurrentPage() {
  const page = await getCDPPage();
  return { url: page.url(), title: await page.title() };
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────
export function isReady() {
  return _ready;
}

export async function initialize() {
  if (_initialized) return;
  _initialized = true;

  try {
    console.log('[browser.js] Checking Chrome CDP...');
    const ready = await isChromeCDPReady();

    if (!ready) {
      console.log('[browser.js] Launching Chrome with remote debugging...');
      launchChrome();
      await waitForCDP(15000);
    }

    _ready = true;
    console.log('[browser.js] Browser agent ready.');
  } catch (err) {
    console.error('[browser.js] Initialization failed:', err.message);
    _ready = false;
  }
}
