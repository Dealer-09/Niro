// tools/browser.js — Native JS AI Browser Agent (Gemini Vision + Chrome CDP)
// Playwright and GoogleGenAI are imported lazily to reduce startup RAM usage.
import { launchChrome, waitForCDP, isChromeCDPReady } from './chrome.js';

let _cdpBrowser = null;
let _geminiKey = null;
let _ready = false;
let _initPromise = null; // prevents duplicate init calls

const CDP_PORT = process.env.NIRO_CDP_PORT || 9222;
const GEMINI_MODEL = 'gemini-2.5-flash-lite';

// ─── Set Gemini key (called from main.js after user saves settings) ──────────
export function setGeminiApiKey(key) {
  _geminiKey = key || null;
}

// ─── Browser Agent Prompt ────────────────────────────────────────────────────
const BROWSER_AGENT_PROMPT = `
You are an AI Browser Agent. Complete a task on a website.
You see the page via a screenshot and a simplified DOM tree.

Actions: click(selector), type(selector, text), scroll(direction: up|down),
navigate(url), wait(ms), finish(answer), fail(reason).

Respond ONLY as JSON: { "thought": "...", "action": "...", "params": { ... } }
`;

// ─── Lazy init: connect to Chrome CDP only when first needed ─────────────────
async function ensureReady() {
  if (_ready && _cdpBrowser) return;

  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const { chromium } = await import('playwright');
    const ready = await isChromeCDPReady();
    if (!ready) {
      launchChrome();
      await waitForCDP(15000);
    }
    _cdpBrowser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
    _ready = true;
    console.log('[browser.js] Connected to Chrome CDP.');
  })();

  return _initPromise;
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
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
  const page = await getCDPPage();

  let iterations = 0;
  const maxIterations = 15;

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

    const promptParts = [
      { text: BROWSER_AGENT_PROMPT },
      { text: `State: ${JSON.stringify(state)}` },
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

  throw new Error('Browser task timed out: reached maximum iterations (15)');
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
