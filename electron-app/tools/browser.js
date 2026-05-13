// tools/browser.js — Native JS AI Browser Agent (Gemini Vision + Chrome CDP)
// Playwright and GoogleGenAI are imported lazily to reduce startup RAM usage.
import { launchChrome, waitForCDP, isChromeCDPReady } from './chrome.js';

let _cdpBrowser = null;
let _geminiKey = null;
let _ready = false;
let _initPromise = null; // prevents duplicate init calls

const CDP_PORT = process.env.NIRO_CDP_PORT || 9222;
const GEMINI_MODEL = 'gemini-2.5-flash-lite';

// ─── Set Gemini key(s) — called from main.js after user saves settings ───────
export function setGeminiApiKey(key) {
  _geminiKey = key || null;
}

export function setGeminiApiKeys(keys) {
  // no-op for now — browser agent uses primary key only
  // key rotation for browser agent can be added later if needed
}

// ─── Browser Agent Prompt ────────────────────────────────────────────────────
const BROWSER_AGENT_PROMPT = `
You are an AI Browser Agent. Complete a task on a website.
You see the page via a screenshot and a simplified DOM tree.

Actions: click(selector), type(selector, text), scroll(direction: up|down),
navigate(url), wait(ms), finish(answer), fail(reason).

Guidelines:
- For Gmail: navigate to https://mail.google.com first if not already there
- To compose: click the "Compose" button (look for text "Compose" or pencil icon)
- To schedule send in Gmail: click the arrow next to Send button, select "Schedule send"
- Use wait(2000) after clicking buttons to let Gmail's UI load
- If a selector fails, try clicking by text instead
- Respond ONLY as JSON: { "thought": "...", "action": "...", "params": { ... } }
`;

// ─── Lazy init: connect to Chrome CDP only when first needed ─────────────────
async function ensureReady() {
  if (_ready && _cdpBrowser) return;

  // If a previous init failed, reset so we can retry
  if (_initPromise) {
    try { await _initPromise; return; } catch (_) { _initPromise = null; }
  }

  _initPromise = (async () => {
    const { chromium } = await import('playwright');
    const ready = await isChromeCDPReady();
    if (!ready) {
      launchChrome();
      await waitForCDP(30000); // 30s — Chrome can be slow to start
    }
    _cdpBrowser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
    _ready = true;
    console.log('[browser.js] Connected to Chrome CDP.');
  })();

  try {
    await _initPromise;
  } catch (err) {
    _initPromise = null; // reset so next call can retry
    _ready = false;
    throw err;
  }
}

// ─── Helper: get active page ─────────────────────────────────────────────────
async function getCDPPage() {
  await ensureReady();
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

  // Lazy-import GoogleGenAI only when browser automation is actually used
  const { GoogleGenAI } = await import('@google/genai');
  const genAI = new GoogleGenAI({ apiKey: _geminiKey });
  const page = await getCDPPage();

  let iterations = 0;
  const maxIterations = 25; // increased for complex multi-step tasks like Gmail compose+schedule

  if (onProgress) onProgress(`Starting task: ${task}`);

  while (iterations < maxIterations) {
    iterations++;

    const screenshot = await page.screenshot({ type: 'jpeg', quality: 50 });
    const url = page.url();
    const title = await page.title();

    const elements = await page.evaluate(() => {
      return Array.from(
        document.querySelectorAll('button, a, input, [role="button"], select, textarea')
      )
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

    const result = await genAI.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            { text: BROWSER_AGENT_PROMPT },
            { text: `State: ${JSON.stringify(state)}` },
            { inlineData: { mimeType: 'image/jpeg', data: screenshot.toString('base64') } },
            { text: `Task: ${task}` },
          ],
        },
      ],
    });
    const responseText = result.candidates?.[0]?.content?.parts?.[0]?.text || '';

    let plan;
    try {
      const jsonStr = responseText.match(/\{[\s\S]*\}/)?.[0] || responseText;
      plan = JSON.parse(jsonStr);
    } catch (e) {
      throw new Error('Browser agent returned invalid JSON response');
    }

    if (onProgress) onProgress(plan.thought);

    const { action, params } = plan;
    if (action === 'finish') return params.answer || 'Task completed.';
    if (action === 'fail') throw new Error(`Browser agent: ${params.reason}`);

    try {
      if (action === 'click') {
        if (params.selector) await page.click(params.selector, { timeout: 5000 });
        else if (params.text) await page.click(`text="${params.text}"`, { timeout: 5000 });
      } else if (action === 'type') {
        await page.fill(params.selector, params.text, { timeout: 5000 });
      } else if (action === 'navigate') {
        await page.goto(params.url, { waitUntil: 'domcontentloaded' });
      } else if (action === 'scroll') {
        await page.mouse.wheel(0, params.direction === 'down' ? 500 : -500);
      } else if (action === 'wait') {
        await page.waitForTimeout(Math.min(params.ms || 1000, 5000));
      }
      await page.waitForTimeout(800);
    } catch (err) {
      console.warn(`[browser.js] Action "${action}" failed:`, err.message);
    }
  }

  throw new Error(`Browser task timed out: reached maximum iterations (${maxIterations})`);
}

// ─── Direct helpers ───────────────────────────────────────────────────────────
export async function navigate(url) {
  const page = await getCDPPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return `Navigated to ${url}`;
}

export async function getCurrentPage() {
  const page = await getCDPPage();
  return { url: page.url(), title: await page.title() };
}

export function isReady() {
  return _ready;
}

// ─── Lifecycle: called from main.js on startup ───────────────────────────────
// Only checks if Chrome is already running — does NOT launch or connect.
// Full init happens lazily on first run_task call.
export async function initialize() {
  try {
    const ready = await isChromeCDPReady();
    if (ready) {
      // Chrome already running — pre-connect in background (non-blocking)
      ensureReady().catch(() => {});
    }
    // If Chrome not running, we skip — it'll launch on first run_task call
  } catch (_) {}
}
