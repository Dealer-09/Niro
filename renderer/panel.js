// panel.js — Niro panel renderer logic
(function () {
  'use strict';

  // ─────────────────────────────────────────────
  // DOM References
  // ─────────────────────────────────────────────
  const panelWrapper   = document.getElementById('panel-wrapper');
  const panel          = document.getElementById('panel');
  const statusBar      = document.getElementById('status-bar');
  const chatInput      = document.getElementById('chat-input');
  const sendBtn        = document.getElementById('send-btn');
  const stopBtn        = document.getElementById('stop-btn');
  const micBtn         = document.getElementById('mic-btn');
  const chatArea       = document.getElementById('chat-area');
  const emptyState     = document.getElementById('empty-state');
  const taskGrid       = document.getElementById('task-grid');
  const btnClear       = document.getElementById('btn-clear');
  const btnSettings    = document.getElementById('btn-settings');
  const btnClose       = document.getElementById('btn-close');

  // Settings modal
  const settingsOverlay  = document.getElementById('settings-overlay');
  const settingsGroqKey  = document.getElementById('settings-groq-key');
  const settingsGeminiKey= document.getElementById('settings-gemini-key');
  const settingsHoverDelay = document.getElementById('settings-hover-delay');
  const settingsAutostart  = document.getElementById('settings-autostart');
  const settingsSave     = document.getElementById('settings-save');
  const settingsCancel   = document.getElementById('settings-cancel');
  const settingsQuit     = document.getElementById('settings-quit');
  const sectionGroq      = document.getElementById('section-groq');
  const sectionGemini    = document.getElementById('section-gemini');
  const providerTabs     = document.getElementById('provider-tabs');
  const btnAddGroqKey    = document.getElementById('btn-add-groq-key');
  const btnAddGeminiKey  = document.getElementById('btn-add-gemini-key');
  const groqExtraKeys    = document.getElementById('groq-extra-keys');
  const geminiExtraKeys  = document.getElementById('gemini-extra-keys');

  let activeProvider = 'groq';
  let currentStreamingMsg = null;
  let isRunning = false;
  // In-memory extra keys (not yet saved)
  let pendingGroqKeys = [];
  let pendingGeminiKeys = [];

  // ─────────────────────────────────────────────
  // Panel Visibility
  // ─────────────────────────────────────────────
  panel.addEventListener('mouseenter', () => window.niro.mouseEnteredPanel());
  panel.addEventListener('mouseleave', () => window.niro.mouseLeftPanel());

  window.niro.onPanelShow(() => panelWrapper.classList.add('visible'));
  window.niro.onPanelHide(() => panelWrapper.classList.remove('visible'));

  // Cleanup listeners on unload to prevent memory leaks
  window.addEventListener('unload', () => {
    if (window.niro.cleanup) window.niro.cleanup();
  });

  // ─────────────────────────────────────────────
  // Status helpers
  // ─────────────────────────────────────────────
  function setStatus(status) {
    statusBar.className = '';
    if (status) statusBar.classList.add(status);
  }

  // ─────────────────────────────────────────────
  // Chat messages
  // ─────────────────────────────────────────────
  function addMessage(role, content) {
    if (emptyState) emptyState.style.display = 'none';

    const msg = document.createElement('div');
    msg.classList.add('message', role);

    if (role === 'tool-status') {
      msg.innerHTML = content;
    } else if (role === 'error') {
      msg.textContent = '⚠ ' + content;
    } else {
      msg.textContent = content;
    }

    chatArea.appendChild(msg);
    chatArea.scrollTop = chatArea.scrollHeight;
    return msg;
  }

  function addThinkingIndicator() {
    if (emptyState) emptyState.style.display = 'none';
    const indicator = document.createElement('div');
    indicator.classList.add('thinking-indicator');
    indicator.id = 'thinking';
    indicator.innerHTML = '<div class="thinking-dots"><span></span><span></span><span></span></div>';
    chatArea.appendChild(indicator);
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  function removeThinkingIndicator() {
    const el = document.getElementById('thinking');
    if (el) el.remove();
  }

  // ─────────────────────────────────────────────
  // Running state
  // ─────────────────────────────────────────────
  function startRunning() {
    isRunning = true;
    setStatus('thinking');
    sendBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');
    chatInput.disabled = true;
    addThinkingIndicator();
  }

  function stopRunning() {
    isRunning = false;
    setStatus('');
    sendBtn.classList.remove('hidden');
    stopBtn.classList.add('hidden');
    chatInput.disabled = false;
    chatInput.focus();
    removeThinkingIndicator();
  }

  // ─────────────────────────────────────────────
  // Send message
  // ─────────────────────────────────────────────
  async function sendMessage() {
    const text = chatInput.value.trim();
    if (!text || isRunning) return;

    chatInput.value = '';
    currentStreamingMsg = null;
    addMessage('user', text);
    startRunning();

    try {
      await window.niro.runAgent(text);
    } catch (err) {
      addMessage('error', err.message || 'Failed to run agent');
      stopRunning();
    }
  }

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn.addEventListener('click', sendMessage);

  stopBtn.addEventListener('click', async () => {
    await window.niro.stopAgent();
    stopRunning();
  });

  // ─────────────────────────────────────────────
  // Agent event listeners
  // ─────────────────────────────────────────────
  window.niro.onChunk((data) => {
    removeThinkingIndicator();
    setStatus('');
    if (currentStreamingMsg) {
      currentStreamingMsg.textContent += data.text;
    } else {
      currentStreamingMsg = addMessage('assistant', data.text);
    }
    chatArea.scrollTop = chatArea.scrollHeight;
  });

  window.niro.onTool((data) => {
    setStatus('executing');
    currentStreamingMsg = null;
    const inputStr = data.input ? Object.values(data.input).join(', ') : '';
    const display = inputStr
      ? `${inputStr.substring(0, 40)}${inputStr.length > 40 ? '...' : ''}`
      : '';
    const msg = document.createElement('div');
    msg.classList.add('message', 'tool-status');
    const icon = document.createElement('span');
    icon.className = 'tool-icon';
    icon.textContent = '⚡';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'tool-name';
    nameSpan.textContent = data.name;  // textContent — safe, no XSS
    msg.appendChild(icon);
    msg.appendChild(document.createTextNode(' Running: '));
    msg.appendChild(nameSpan);
    if (display) msg.appendChild(document.createTextNode(' › ' + display));
    if (emptyState) emptyState.style.display = 'none';
    chatArea.appendChild(msg);
    chatArea.scrollTop = chatArea.scrollHeight;
  });

  window.niro.onDone(() => {
    currentStreamingMsg = null;
    stopRunning();
  });

  window.niro.onError((data) => {
    removeThinkingIndicator();
    currentStreamingMsg = null;
    addMessage('error', data.message);
    stopRunning();
    setStatus('error');
    setTimeout(() => setStatus(''), 3000);
  });

  // Handle task run instruction sent from main process
  window.niro.onTaskRun((data) => {
    if (data && data.instruction) {
      runTaskInstruction(data.instruction);
    }
  });

  // ─────────────────────────────────────────────
  // Voice Input (MediaRecorder)
  // ─────────────────────────────────────────────
  let mediaRecorder = null;
  let audioChunks = [];
  let isRecording = false;

  micBtn.addEventListener('click', async () => {
    if (isRecording) {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      audioChunks = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunks.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        const arrayBuffer = await audioBlob.arrayBuffer();
        stream.getTracks().forEach(track => track.stop());

        micBtn.classList.remove('recording');
        isRecording = false;

        chatInput.disabled = true;
        chatInput.placeholder = 'Transcribing...';
        setStatus('thinking');

        try {
          const transcription = await window.niro.transcribeAudio(arrayBuffer);
          chatInput.value = typeof transcription === 'string' ? transcription : (transcription.text || '');
        } catch (err) {
          addMessage('error', 'Transcription failed: ' + err.message);
        } finally {
          chatInput.disabled = false;
          chatInput.placeholder = 'Message Niro...';
          chatInput.focus();
          setStatus('');
        }
      };

      mediaRecorder.start();
      isRecording = true;
      micBtn.classList.add('recording');
      chatInput.placeholder = '● Recording... (click mic to stop)';
      chatInput.value = '';
    } catch (err) {
      addMessage('error', 'Microphone access denied: ' + err.message);
    }
  });

  // ─────────────────────────────────────────────
  // Task Grid
  // ─────────────────────────────────────────────
  function renderTasks(tasks) {
    if (!taskGrid) return;
    taskGrid.innerHTML = '';

    if (!tasks || tasks.length === 0) {
      document.getElementById('task-area').style.display = 'none';
      return;
    }

    document.getElementById('task-area').style.display = '';

    tasks.forEach(task => {
      const btn = document.createElement('button');
      btn.classList.add('task-btn');
      btn.innerHTML = `
        <span class="task-icon">${task.icon || '⚡'}</span>
        <span class="task-name">${escapeHtml(task.name)}</span>
        <button class="task-delete" data-id="${escapeHtml(task.id)}" title="Remove">✕</button>
      `;

      btn.addEventListener('click', (e) => {
        if (e.target.classList.contains('task-delete')) {
          e.stopPropagation();
          deleteTask(e.target.dataset.id);
          return;
        }
        runTaskInstruction(task.instruction);
      });

      taskGrid.appendChild(btn);
    });
  }

  async function runTaskInstruction(instruction) {
    if (isRunning) return;
    currentStreamingMsg = null;
    addMessage('user', instruction);
    startRunning();
    try {
      await window.niro.runAgent(instruction);
    } catch (err) {
      addMessage('error', err.message);
      stopRunning();
    }
  }

  async function deleteTask(taskId) {
    await window.niro.deleteTask(taskId);
    const tasks = await window.niro.getTasks();
    renderTasks(tasks);
  }

  window.niro.onTasksUpdated((data) => renderTasks(data.tasks));

  // ─────────────────────────────────────────────
  // Header Buttons
  // ─────────────────────────────────────────────
  btnClear.addEventListener('click', async () => {
    await window.niro.clearChatHistory();
    // Remove all messages but keep empty state
    Array.from(chatArea.children).forEach(child => {
      if (child.id !== 'empty-state') child.remove();
    });
    if (emptyState) emptyState.style.display = '';
    setStatus('');
  });

  btnClose.addEventListener('click', () => window.niro.hidePanel());

  // ─────────────────────────────────────────────
  // Provider tab toggle (Settings modal)
  // ─────────────────────────────────────────────
  providerTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.provider-tab');
    if (!tab) return;
    activeProvider = tab.dataset.provider;
    providerTabs.querySelectorAll('.provider-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    sectionGroq.classList.toggle('hidden', activeProvider !== 'groq');
    sectionGemini.classList.toggle('hidden', activeProvider !== 'gemini');
  });

  // ─────────────────────────────────────────────
  // Extra API Keys UI
  // ─────────────────────────────────────────────
  function renderExtraKeys(container, keys, onRemove) {
    container.innerHTML = '';
    if (keys.length === 0) return;
    const label = document.createElement('div');
    label.className = 'extra-keys-label';
    label.textContent = `${keys.length} backup key${keys.length > 1 ? 's' : ''} — agent rotates on quota limit`;
    container.appendChild(label);
    keys.forEach((key, i) => {
      const item = document.createElement('div');
      item.className = 'extra-key-item';
      const lbl = document.createElement('span');
      lbl.className = 'key-label';
      lbl.textContent = key; // already masked from backend
      const rm = document.createElement('button');
      rm.className = 'key-remove';
      rm.textContent = '✕';
      rm.title = 'Remove key';
      rm.addEventListener('click', () => onRemove(i));
      item.appendChild(lbl);
      item.appendChild(rm);
      container.appendChild(item);
    });
  }

  function promptAddKey(placeholder, onAdd) {
    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = placeholder;
    input.style.cssText = 'width:100%;padding:6px 10px;background:var(--bg-input);border:1px solid var(--accent);border-radius:var(--radius-xs);color:var(--text-primary);font-size:12px;outline:none;margin-top:4px;';
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { onAdd(input.value.trim()); input.remove(); }
      if (e.key === 'Escape') input.remove();
    });
    input.addEventListener('blur', () => { if (input.value.trim()) onAdd(input.value.trim()); input.remove(); });
    return input;
  }

  btnAddGroqKey.addEventListener('click', () => {
    const inp = promptAddKey('gsk_... (backup key)', (val) => {
      if (val && !pendingGroqKeys.includes(val)) {
        pendingGroqKeys.push(val);
        renderExtraKeys(groqExtraKeys, pendingGroqKeys.map((k, i) => `Key ${i + 2}: ${k.substring(0,4)}${'•'.repeat(Math.max(0,k.length-8))}${k.slice(-4)}`), (i) => {
          pendingGroqKeys.splice(i, 1);
          renderExtraKeys(groqExtraKeys, pendingGroqKeys.map((k, j) => `Key ${j + 2}: ${k.substring(0,4)}${'•'.repeat(Math.max(0,k.length-8))}${k.slice(-4)}`), arguments.callee);
        });
      }
    });
    groqExtraKeys.parentElement.appendChild(inp);
    inp.focus();
  });

  btnAddGeminiKey.addEventListener('click', () => {
    const inp = promptAddKey('AIza... (backup key)', (val) => {
      if (val && !pendingGeminiKeys.includes(val)) {
        pendingGeminiKeys.push(val);
        renderExtraKeys(geminiExtraKeys, pendingGeminiKeys.map((k, i) => `Key ${i + 2}: ${k.substring(0,4)}${'•'.repeat(Math.max(0,k.length-8))}${k.slice(-4)}`), (i) => {
          pendingGeminiKeys.splice(i, 1);
          renderExtraKeys(geminiExtraKeys, pendingGeminiKeys.map((k, j) => `Key ${j + 2}: ${k.substring(0,4)}${'•'.repeat(Math.max(0,k.length-8))}${k.slice(-4)}`), arguments.callee);
        });
      }
    });
    geminiExtraKeys.parentElement.appendChild(inp);
    inp.focus();
  });

  // ─────────────────────────────────────────────
  // Settings Modal
  // ─────────────────────────────────────────────
  btnSettings.addEventListener('click', async () => {
    try {
      const [settings, providerCfg] = await Promise.all([
        window.niro.getSettings(),
        window.niro.getProviderConfig(),
      ]);

      // Set active provider tab
      activeProvider = providerCfg.provider || 'groq';
      providerTabs.querySelectorAll('.provider-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.provider === activeProvider);
      });
      sectionGroq.classList.toggle('hidden', activeProvider !== 'groq');
      sectionGemini.classList.toggle('hidden', activeProvider !== 'gemini');

      // Pre-fill key placeholders (masked)
      settingsGroqKey.value = '';
      settingsGroqKey.placeholder = providerCfg.groqApiKey || 'gsk_...';
      settingsGeminiKey.value = '';
      settingsGeminiKey.placeholder = providerCfg.geminiApiKey || 'AIza...';

      // Load existing extra keys (already masked)
      pendingGroqKeys = [];
      pendingGeminiKeys = [];
      renderExtraKeys(groqExtraKeys, providerCfg.groqApiKeys || [], (i) => {
        (providerCfg.groqApiKeys || []).splice(i, 1);
        renderExtraKeys(groqExtraKeys, providerCfg.groqApiKeys || [], arguments.callee);
      });
      renderExtraKeys(geminiExtraKeys, providerCfg.geminiApiKeys || [], (i) => {
        (providerCfg.geminiApiKeys || []).splice(i, 1);
        renderExtraKeys(geminiExtraKeys, providerCfg.geminiApiKeys || [], arguments.callee);
      });

      settingsHoverDelay.value = settings.hoverDelay || 800;
      settingsAutostart.classList.toggle('on', !!settings.autoStart);

      settingsOverlay.classList.add('visible');
    } catch (err) {
      addMessage('error', 'Failed to load settings: ' + err.message);
    }
  });

  settingsAutostart.addEventListener('click', () => settingsAutostart.classList.toggle('on'));

  settingsCancel.addEventListener('click', () => settingsOverlay.classList.remove('visible'));

  settingsQuit.addEventListener('click', () => window.niro.quitApp());

  settingsOverlay.addEventListener('click', (e) => {
    if (e.target === settingsOverlay) settingsOverlay.classList.remove('visible');
  });

  settingsSave.addEventListener('click', async () => {
    try {
      const groqKey   = settingsGroqKey.value.trim();
      const geminiKey = settingsGeminiKey.value.trim();

      // Save provider + keys (including extra keys)
      await window.niro.setProviderConfig({
        provider:      activeProvider,
        groqApiKey:    groqKey   || undefined,
        geminiApiKey:  geminiKey || undefined,
        groqApiKeys:   pendingGroqKeys.length > 0 ? pendingGroqKeys : undefined,
        geminiApiKeys: pendingGeminiKeys.length > 0 ? pendingGeminiKeys : undefined,
      });

      // Save hover delay
      const delay = parseInt(settingsHoverDelay.value) || 800;
      await window.niro.setSettings('hoverDelay', delay);

      // Save autostart
      const autoStart = settingsAutostart.classList.contains('on');
      await window.niro.setSettings('autoStart', autoStart);

      settingsOverlay.classList.remove('visible');

      // Confirm to user
      addMessage('assistant', `✓ Settings saved. Using ${activeProvider === 'groq' ? 'Groq' : 'Gemini'} as AI provider.`);
    } catch (err) {
      addMessage('error', 'Failed to save settings: ' + err.message);
    }
  });

  // ─────────────────────────────────────────────
  // Utility
  // ─────────────────────────────────────────────
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─────────────────────────────────────────────
  // Initialize
  // ─────────────────────────────────────────────
  async function init() {
    try {
      const [tasks, history] = await Promise.all([
        window.niro.getTasks(),
        window.niro.getChatHistory(),
      ]);

      renderTasks(tasks);

      if (history && history.length > 0) {
        if (emptyState) emptyState.style.display = 'none';
        history.forEach(msg => {
          if (msg.role === 'user' || msg.role === 'assistant') {
            addMessage(msg.role, msg.content);
          }
        });
      }
    } catch (err) {
      console.error('[Niro] Init error:', err);
    }
  }

  init();
})();
