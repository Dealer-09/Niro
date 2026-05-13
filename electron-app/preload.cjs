// preload.cjs — Secure contextBridge for Niro
const { contextBridge, ipcRenderer } = require('electron');

// Track registered listeners so we can clean them up
const _listeners = [];

function _on(channel, callback) {
  const wrapped = (_e, data) => callback(data);
  ipcRenderer.on(channel, wrapped);
  _listeners.push({ channel, wrapped });
}

contextBridge.exposeInMainWorld('niro', {
  // ── Agent ──────────────────────────────────────────────────────────────────
  runAgent:  (message) => ipcRenderer.invoke('agent:run', message),
  stopAgent: ()        => ipcRenderer.invoke('agent:stop'),

  // ── Tasks ──────────────────────────────────────────────────────────────────
  getTasks:   ()       => ipcRenderer.invoke('tasks:get'),
  runTask:    (taskId) => ipcRenderer.invoke('tasks:run', taskId),
  deleteTask: (taskId) => ipcRenderer.invoke('tasks:delete', taskId),

  // ── Settings ───────────────────────────────────────────────────────────────
  getSettings:       ()           => ipcRenderer.invoke('settings:get'),
  setSettings:       (key, value) => ipcRenderer.invoke('settings:set', { key, value }),

  // Provider config — Groq / Gemini keys stored per-provider
  getProviderConfig: ()     => ipcRenderer.invoke('settings:getProviderConfig'),
  setProviderConfig: (args) => ipcRenderer.invoke('settings:setProviderConfig', args),

  // Legacy single-key helpers (kept for backward compat)
  getApiKey: ()      => ipcRenderer.invoke('settings:getApiKey'),
  setApiKey: (args)  => ipcRenderer.invoke('settings:setApiKey', args),

  // ── Browser Use ────────────────────────────────────────────────────────────
  browserRunTask: (task) => ipcRenderer.invoke('browser:run', task),
  browserNavigate: (url) => ipcRenderer.invoke('browser:navigate', url),
  currentPage:    ()     => ipcRenderer.invoke('browser:page'),
  browserReady:   ()     => ipcRenderer.invoke('browser:ready'),

  // ── Chat history & Audio ───────────────────────────────────────────────────
  getChatHistory:  () => ipcRenderer.invoke('chat:getHistory'),
  clearChatHistory:() => ipcRenderer.invoke('chat:clear'),
  transcribeAudio: (buffer) => ipcRenderer.invoke('audio:transcribe', buffer),

  // ── Panel visibility ───────────────────────────────────────────────────────
  showPanel:        () => ipcRenderer.send('panel:show'),
  hidePanel:        () => ipcRenderer.send('panel:hide'),
  mouseEnteredPanel:() => ipcRenderer.send('panel:mouseEnter'),
  mouseLeftPanel:   () => ipcRenderer.send('panel:mouseLeave'),

  // ── App lifecycle ──────────────────────────────────────────────────────────
  quitApp: () => ipcRenderer.send('app:quit'),

  // ── Sensor ─────────────────────────────────────────────────────────────────
  sensorHover: () => ipcRenderer.send('sensor:hover'),

  // ── Events: main → renderer ────────────────────────────────────────────────
  onChunk:        (cb) => _on('agent:chunk',       cb),
  onTool:         (cb) => _on('agent:tool',        cb),
  onDone:         (cb) => _on('agent:done',        cb),
  onError:        (cb) => _on('agent:error',       cb),
  onTasksUpdated: (cb) => _on('tasks:updated',     cb),
  onPanelShow:    (cb) => _on('panel:doShow',      cb),
  onPanelHide:    (cb) => _on('panel:doHide',      cb),
  onTaskRun:      (cb) => _on('tasks:runInstruction', cb),

  // ── Gmail credentials ──────────────────────────────────────────────────────
  getGmail:    ()     => ipcRenderer.invoke('settings:getGmail'),
  setGmail:    (args) => ipcRenderer.invoke('settings:setGmail', args),

  // ── Cleanup ────────────────────────────────────────────────────────────────
  cleanup: () => {
    for (const { channel, wrapped } of _listeners) {
      ipcRenderer.removeListener(channel, wrapped);
    }
    _listeners.length = 0;
  },
});
