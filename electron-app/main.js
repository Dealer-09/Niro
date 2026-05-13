// main.js — Niro main process: windows, IPC, agent orchestration
import { app, BrowserWindow, ipcMain, screen, Tray, nativeImage } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Chromium flags — reduce RAM usage ───────────────────────────────────────
// Must be set before app is ready
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=128');
app.commandLine.appendSwitch('disable-features', 'TranslateUI,AutofillServerCommunication');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-default-apps');
app.commandLine.appendSwitch('disable-extensions');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('metrics-recording-only');
app.commandLine.appendSwitch('no-first-run');
app.commandLine.appendSwitch('safebrowsing-disable-auto-update');
app.commandLine.appendSwitch('disable-component-update');
// Disable GPU cache to avoid permission errors in development
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

// Load .env if present (optional — app works entirely from user-supplied keys in Settings)
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '.env') });

// electron-store is CJS — use createRequire to import it in an ESM context
const require = createRequire(import.meta.url);
const Store = require('electron-store');

import { initClient, runAgent, stopAgent, transcribeAudioBuffer } from './agent.js';
import { setStore, setMainWindow, setAppPath } from './tools.js';
import * as browser from './tools/browser.js';

// ─────────────────────────────────────────────────
// Electron Store — all user data persisted here
// ─────────────────────────────────────────────────
const store = new Store({
  defaults: {
    // Provider config — user sets their own keys, no hardcoded keys
    provider: 'groq',          // 'groq' | 'gemini'
    groqApiKey: '',
    geminiApiKey: '',
    // Extra API keys for fallback when daily quota is hit
    groqApiKeys: [],    // array of additional Groq keys
    geminiApiKeys: [],  // array of additional Gemini keys
    gmailUser: '',
    gmailAppPassword: '',
    tasks: [
      { id: '1', name: 'Chrome',      icon: '🌐', instruction: 'Open Google Chrome' },
      { id: '2', name: 'Notepad',     icon: '📝', instruction: 'Open Notepad' },
      { id: '3', name: '25min Timer', icon: '⏱',  instruction: 'Set a 25 minute focus timer' },
      { id: '4', name: '5min Break',  icon: '☕', instruction: 'Set a 5 minute break timer' },
      { id: '5', name: 'My IP',       icon: '🔌', instruction: 'Show my public IP address' },
      { id: '6', name: 'Screenshot',  icon: '📸', instruction: "Take a screenshot and tell me what's on my screen" },
    ],
    chatHistory: [],
    settings: {
      hoverDelay: 800,
      theme: 'dark',
      autoStart: false,
      sensorHeight: 6,
    },
  },
});

// ─── Migrate legacy single `apiKey` field to per-provider keys ───────────────
const legacyKey = store.get('apiKey');
if (legacyKey && !store.get('groqApiKey') && !store.get('geminiApiKey')) {
  const legacyProvider = store.get('provider') || 'groq';
  if (legacyProvider === 'gemini') {
    store.set('geminiApiKey', legacyKey);
  } else {
    store.set('groqApiKey', legacyKey);
  }
  store.delete('apiKey');
  console.log('[Niro] Migrated legacy apiKey to per-provider storage.');
}

// Give tools access to the store and app path
setStore(store);
setAppPath(__dirname);

// ─────────────────────────────────────────────────
// Initialize API client from stored user credentials
// ─────────────────────────────────────────────────
function initializeApiClients() {
  const provider = store.get('provider') || 'groq';
  const groqKey = store.get('groqApiKey') || '';
  const geminiKey = store.get('geminiApiKey') || '';
  const groqKeys = [groqKey, ...(store.get('groqApiKeys') || [])].filter(Boolean);
  const geminiKeys = [geminiKey, ...(store.get('geminiApiKeys') || [])].filter(Boolean);
  const apiKey = provider === 'gemini' ? geminiKey : groqKey;
  const allKeys = provider === 'gemini' ? geminiKeys : groqKeys;

  if (!apiKey) {
    console.warn('[Niro] No API key set — open Settings to add a Groq or Gemini key.');
    return;
  }

  initClient({ provider, apiKey, allKeys });

  // Always give the browser agent the Gemini key pool
  if (geminiKeys.length > 0) {
    browser.setGeminiApiKey(geminiKeys[0]);
    browser.setGeminiApiKeys(geminiKeys);
  }
}

// ─────────────────────────────────────────────────
// Window references
// ─────────────────────────────────────────────────
let tray = null;
let sensorWindow = null;
let panelWindow = null;
let hideTimeout = null;
let mouseInPanel = false;
let mouseInSensor = false;

const PANEL_WIDTH = 380;
const PANEL_HEIGHT = 620;

// ─────────────────────────────────────────────────
// Sensor Zone Window (invisible, top of screen)
// ─────────────────────────────────────────────────
function createSensorWindow() {
  const { width } = screen.getPrimaryDisplay().bounds;
  const sensorHeight = store.get('settings.sensorHeight') || 6;
  const panelX = Math.round((width - PANEL_WIDTH) / 2);

  sensorWindow = new BrowserWindow({
    width: PANEL_WIDTH,
    height: sensorHeight,
    x: panelX,
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    hasShadow: false,
    type: 'toolbar',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
      enableWebSQL: false,
      v8CacheOptions: 'none',
    },
  });

  sensorWindow.loadFile(path.join(__dirname, 'renderer', 'sensor.html'));
  sensorWindow.setIgnoreMouseEvents(false);
  sensorWindow.show();

  sensorWindow.on('focus', () => sensorWindow.blur());
}

// ─────────────────────────────────────────────────
// Panel Window (main UI)
// ─────────────────────────────────────────────────
function createPanelWindow() {
  const { width } = screen.getPrimaryDisplay().bounds;
  const panelX = Math.round((width - PANEL_WIDTH) / 2);

  panelWindow = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    x: panelX,
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    resizable: false,
    hasShadow: false,
    show: false,
    type: 'toolbar',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,   // throttle when hidden — saves CPU/RAM
      spellcheck: false,
      enableWebSQL: false,
    },
  });

  panelWindow.loadFile(path.join(__dirname, 'renderer', 'panel.html'));
  setMainWindow(panelWindow);

  // Free renderer memory when panel is hidden
  panelWindow.on('hide', () => {
    if (panelWindow && !panelWindow.isDestroyed()) {
      panelWindow.webContents.setBackgroundThrottling(true);
    }
  });

  panelWindow.on('show', () => {
    if (panelWindow && !panelWindow.isDestroyed()) {
      panelWindow.webContents.setBackgroundThrottling(false);
    }
  });
}

// ─────────────────────────────────────────────────
// Show / Hide panel
// ─────────────────────────────────────────────────
function showPanel() {
  if (!panelWindow || panelWindow.isDestroyed()) return;
  clearHideTimeout();
  panelWindow.showInactive();
  panelWindow.webContents.send('panel:doShow');
}

function hidePanel() {
  if (!panelWindow || panelWindow.isDestroyed()) return;
  panelWindow.webContents.send('panel:doHide');
  setTimeout(() => {
    if (panelWindow && !panelWindow.isDestroyed()) panelWindow.hide();
  }, 350);
}

function scheduleHide() {
  clearHideTimeout();
  const delay = store.get('settings.hoverDelay') || 800;
  hideTimeout = setTimeout(() => {
    if (!mouseInPanel && !mouseInSensor) hidePanel();
  }, delay);
}

function clearHideTimeout() {
  if (hideTimeout) {
    clearTimeout(hideTimeout);
    hideTimeout = null;
  }
}

// ─────────────────────────────────────────────────
// Tray Icon
// ─────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('Niro — Desktop AI Agent');
  tray.on('click', () => showPanel());
}

// ─────────────────────────────────────────────────
// App Lifecycle
// ─────────────────────────────────────────────────
app.whenReady().then(async () => {
  createSensorWindow();
  createPanelWindow();
  createTray();

  const autoStart = store.get('settings.autoStart');
  if (autoStart) {
    app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
  }

  initializeApiClients();

  // Initialize Browser Agent (Chrome CDP) — non-fatal, deferred 3s to not block startup
  setTimeout(() => {
    browser.initialize().catch(err => {
      console.warn('[main.js] Browser engine init warning:', err.message);
    });
  }, 3000);

  // Periodic memory cleanup — run GC every 5 minutes when panel is hidden
  setInterval(() => {
    if (panelWindow && !panelWindow.isDestroyed() && !panelWindow.isVisible()) {
      if (global.gc) global.gc();
    }
  }, 5 * 60 * 1000);
});

app.on('window-all-closed', () => {
  // Don't quit — Niro lives in the tray
});

ipcMain.on('app:quit', () => app.quit());

// ─────────────────────────────────────────────────
// IPC: Panel Visibility
// ─────────────────────────────────────────────────
ipcMain.on('sensor:hover', () => {
  mouseInSensor = true;
  showPanel();
});

ipcMain.on('panel:mouseEnter', () => {
  mouseInPanel = true;
  clearHideTimeout();
});

ipcMain.on('panel:mouseLeave', () => {
  mouseInPanel = false;
  mouseInSensor = false;
  scheduleHide();
});

ipcMain.on('panel:show', () => showPanel());
ipcMain.on('panel:hide', () => {
  mouseInPanel = false;
  mouseInSensor = false;
  hidePanel();
});

// ─────────────────────────────────────────────────
// IPC: Agent
// ─────────────────────────────────────────────────
let agentRunning = false;

ipcMain.handle('agent:run', async (event, message) => {
  if (agentRunning) {
    event.sender.send('agent:error', { message: 'Agent is already running. Please wait.' });
    return;
  }
  agentRunning = true;

  const chatHistory = store.get('chatHistory') || [];
  chatHistory.push({ role: 'user', content: message, timestamp: Date.now() });

  const sendEvent = (channel, data) => {
    if (panelWindow && !panelWindow.isDestroyed()) {
      panelWindow.webContents.send(channel, data);
    }
  };

  try {
    const response = await runAgent(message, chatHistory, sendEvent);
    if (response) {
      chatHistory.push({ role: 'assistant', content: response, timestamp: Date.now() });
    }
    // Keep last 50 messages
    while (chatHistory.length > 50) chatHistory.shift();
    store.set('chatHistory', chatHistory);
  } catch (err) {
    sendEvent('agent:error', { message: err.message });
  } finally {
    agentRunning = false; // always reset, even on unexpected throws
  }
});

ipcMain.handle('agent:stop', () => {
  stopAgent();
  agentRunning = false;
});

// ─────────────────────────────────────────────────
// IPC: Tasks
// ─────────────────────────────────────────────────
ipcMain.handle('tasks:get', () => store.get('tasks') || []);

// tasks:run — sends instruction back to renderer to run via agent
ipcMain.handle('tasks:run', async (event, taskId) => {
  const tasks = store.get('tasks') || [];
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send('tasks:runInstruction', { instruction: task.instruction });
  }
});

ipcMain.handle('tasks:delete', (event, taskId) => {
  const tasks = store.get('tasks') || [];
  const filtered = tasks.filter(t => t.id !== taskId);
  store.set('tasks', filtered);
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send('tasks:updated', { tasks: filtered });
  }
  return filtered;
});

// ─────────────────────────────────────────────────
// IPC: Settings
// ─────────────────────────────────────────────────
ipcMain.handle('settings:get', () => store.get('settings'));

ipcMain.handle('settings:set', (event, { key, value }) => {
  store.set(`settings.${key}`, value);
  if (key === 'autoStart') {
    app.setLoginItemSettings({ openAtLogin: value, path: process.execPath });
  }
  return store.get('settings');
});

// ─── Provider config (Groq / Gemini) ─────────────────────────────────────────
ipcMain.handle('settings:getProviderConfig', () => {
  return {
    provider: store.get('provider') || 'groq',
    groqApiKey: _maskKey(store.get('groqApiKey') || ''),
    geminiApiKey: _maskKey(store.get('geminiApiKey') || ''),
    groqApiKeys: (store.get('groqApiKeys') || []).map(_maskKey),
    geminiApiKeys: (store.get('geminiApiKeys') || []).map(_maskKey),
  };
});

ipcMain.handle('settings:setProviderConfig', (event, { provider, groqApiKey, geminiApiKey, groqApiKeys, geminiApiKeys }) => {
  if (provider) store.set('provider', provider);
  if (groqApiKey && groqApiKey.trim()) store.set('groqApiKey', groqApiKey.trim());
  if (geminiApiKey && geminiApiKey.trim()) store.set('geminiApiKey', geminiApiKey.trim());
  if (Array.isArray(groqApiKeys)) store.set('groqApiKeys', groqApiKeys.filter(k => k && k.trim()).map(k => k.trim()));
  if (Array.isArray(geminiApiKeys)) store.set('geminiApiKeys', geminiApiKeys.filter(k => k && k.trim()).map(k => k.trim()));
  initializeApiClients();
  return true;
});

// Legacy single-key handlers (kept for backward compat)
ipcMain.handle('settings:getApiKey', () => {
  const provider = store.get('provider') || 'groq';
  const key = provider === 'gemini'
    ? store.get('geminiApiKey') || ''
    : store.get('groqApiKey') || '';
  return _maskKey(key);
});

ipcMain.handle('settings:setApiKey', (event, { key, provider: p }) => {
  const provider = p || store.get('provider') || 'groq';
  if (provider === 'gemini') {
    store.set('geminiApiKey', key.trim());
  } else {
    store.set('groqApiKey', key.trim());
  }
  initializeApiClients();
  return true;
});

function _maskKey(key) {
  if (!key || key.length <= 8) return key ? '••••••••' : '';
  return key.substring(0, 4) + '•'.repeat(key.length - 8) + key.substring(key.length - 4);
}

// ─────────────────────────────────────────────────
// IPC: Browser Agent
// ─────────────────────────────────────────────────
ipcMain.handle('browser:run', async (event, task) => {
  const sendEvent = (channel, data) => {
    if (panelWindow && !panelWindow.isDestroyed()) panelWindow.webContents.send(channel, data);
  };
  return browser.runTask(task, (text) => {
    sendEvent('agent:chunk', { role: 'assistant', text: `[Browser] ${text}` });
  });
});

ipcMain.handle('browser:navigate', async (event, url) => browser.navigate(url));
ipcMain.handle('browser:page', async () => browser.getCurrentPage());
ipcMain.handle('browser:ready', () => browser.isReady());

// ─────────────────────────────────────────────────
// IPC: Chat History
// ─────────────────────────────────────────────────
ipcMain.handle('chat:getHistory', () => store.get('chatHistory') || []);

ipcMain.handle('chat:clear', () => {
  store.set('chatHistory', []);
  return [];
});

// ─────────────────────────────────────────────────
// IPC: Gmail Credentials
// ─────────────────────────────────────────────────
ipcMain.handle('settings:getGmail', () => {
  return {
    gmailUser: store.get('gmailUser') || '',
    gmailAppPassword: _maskKey(store.get('gmailAppPassword') || ''),
  };
});

ipcMain.handle('settings:setGmail', (event, { gmailUser, gmailAppPassword }) => {
  if (gmailUser !== undefined) store.set('gmailUser', gmailUser.trim());
  if (gmailAppPassword && gmailAppPassword.trim()) store.set('gmailAppPassword', gmailAppPassword.trim());
  return true;
});

// ─────────────────────────────────────────────────
// IPC: Audio Transcription (Groq Whisper)
// ─────────────────────────────────────────────────
ipcMain.handle('audio:transcribe', async (event, buffer) => {
  try {
    const groqKey = store.get('groqApiKey') || '';
    if (!groqKey) {
      throw new Error('A Groq API key is required for voice transcription. Add one in ⚙️ Settings.');
    }
    const text = await transcribeAudioBuffer(buffer, groqKey);
    return text;
  } catch (error) {
    console.error('[Niro] Transcription error:', error.message);
    throw error;
  }
});
