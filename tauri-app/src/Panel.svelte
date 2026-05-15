<script>
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { onMount, onDestroy, tick } from "svelte";
  import Settings from "./Settings.svelte";

  // ── State ─────────────────────────────────────────────────────────────────
  let messages = []; // { role: 'user'|'assistant'|'error'|'tool', text }
  let chatHistory = []; // { role: 'user'|'assistant', content: string } passed to Rust
  let input = "";
  let running = false;
  let showSettings = false;
  let showEmpty = true;
  let chatEl;
  let inputEl;
  let currentStreamingId = null;
  let currentAssistantText = ""; // accumulates streamed chunks for history
  let tasks = [];
  let executingTool = false;  // true while a tool call is in flight
  let errorState = false;     // true for 3s after an agent error (red status bar)

  // ── Listeners (Tauri events from Rust backend) ────────────────────────────
  let unlisteners = [];

  onMount(async () => {
    // Load quick-access tasks (seeded with defaults on first launch)
    try {
      tasks = await invoke("get_tasks_cmd");
    } catch (_) {}

    // Restore chat history across sessions (matches Electron init())
    try {
      const history = await invoke("get_chat_history_cmd");
      if (history && history.length > 0) {
        showEmpty = false;
        chatHistory = history;
        messages = history
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({ role: m.role, text: m.content }));
      }
    } catch (_) {}

    // agent:chunk — streaming text from agent
    unlisteners.push(
      await listen("agent:chunk", ({ payload }) => {
        currentAssistantText += payload.text;
        if (currentStreamingId !== null) {
          messages[currentStreamingId].text += payload.text;
          messages = messages; // trigger reactivity
        } else {
          currentStreamingId = messages.length;
          messages = [...messages, { role: "assistant", text: payload.text }];
        }
        scrollToBottom();
      }),
    );

    // agent:tool — tool execution display
    unlisteners.push(
      await listen("agent:tool", ({ payload }) => {
        currentStreamingId = null;
        executingTool = true;
        const inputStr = payload.input
          ? Object.values(payload.input).join(", ")
          : "";
        const display = inputStr
          ? inputStr.substring(0, 40) + (inputStr.length > 40 ? "..." : "")
          : "";
        messages = [...messages, { role: "tool", name: payload.name, display }];
        scrollToBottom();
      }),
    );

    // agent:done — persist assistant response and reset state (matches Electron)
    unlisteners.push(
      await listen("agent:done", () => {
        if (currentAssistantText) {
          chatHistory = [
            ...chatHistory,
            { role: "assistant", content: currentAssistantText },
          ];
          // Persist assistant response to store
          invoke("append_chat_history_cmd", {
            role: "assistant",
            content: currentAssistantText,
          }).catch(() => {});
          currentAssistantText = "";
        }
        currentStreamingId = null;
        executingTool = false;
        running = false;
      }),
    );

    // agent:error
    unlisteners.push(
      await listen("agent:error", ({ payload }) => {
        currentStreamingId = null;
        executingTool = false;
        errorState = true;
        messages = [...messages, { role: "error", text: payload.message }];
        running = false;
        scrollToBottom();
        // Reset error state after 3s (matches Electron behavior)
        setTimeout(() => { errorState = false; }, 3000);
      }),
    );

    // tasks updated
    unlisteners.push(
      await listen("tasks:updated", ({ payload }) => {
        tasks = payload.tasks || [];
      }),
    );
  });

  onDestroy(() => {
    unlisteners.forEach((u) => u());
  });

  // ── Window controls ───────────────────────────────────────────────────────
  async function hidePanel() {
    try {
      await getCurrentWindow().hide();
    } catch (e) {
      console.error('[Niro] hide failed:', e);
    }
  }

  // ── Send message ──────────────────────────────────────────────────────────
  async function sendMessage() {
    const text = input.trim();
    if (!text || running) return;
    input = "";
    showEmpty = false;
    currentStreamingId = null;
    currentAssistantText = "";
    messages = [...messages, { role: "user", text }];
    // Keep history to last 8 turns to manage token usage
    const historySlice = chatHistory.slice(-8);
    chatHistory = [...historySlice, { role: "user", content: text }];
    running = true;
    scrollToBottom();
    try {
      await invoke("run_agent", { message: text, history: historySlice });
    } catch (err) {
      messages = [...messages, { role: "error", text: err }];
      running = false;
    }
  }

  function stopAgent() {
    invoke("stop_agent").catch(() => {});
    running = false;
  }

  async function scrollToBottom() {
    await tick();
    if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
  }

  function onKeydown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function runTask(instruction) {
    input = instruction;
    sendMessage();
  }

  // ── Voice recording ───────────────────────────────────────────────────────
  let mediaRecorder = null;
  let audioChunks = [];
  let isRecording = false;

  async function toggleMic() {
    if (isRecording) {
      mediaRecorder?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = [];
      mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };
      mediaRecorder.onstop = async () => {
        isRecording = false;
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(audioChunks, { type: "audio/webm" });
        const buf = await blob.arrayBuffer();
        // Show transcribing state
        if (inputEl) { inputEl.placeholder = 'Transcribing...'; inputEl.disabled = true; }
        try {
          const transcript = await invoke("transcribe_audio", {
            audioBytes: Array.from(new Uint8Array(buf)),
          });
          if (transcript?.trim()) {
            input = transcript.trim();
          }
        } catch (err) {
          messages = [
            ...messages,
            { role: "error", text: `Voice error: ${err}` },
          ];
        } finally {
          if (inputEl) { inputEl.placeholder = 'Message Niro...'; inputEl.disabled = false; inputEl.focus(); }
        }
      };
      mediaRecorder.start();
      isRecording = true;
      input = '';
      if (inputEl) inputEl.placeholder = '● Recording... (click mic to stop)';
    } catch (err) {
      messages = [
        ...messages,
        { role: "error", text: `Mic error: ${err.message}` },
      ];
    }
  }
</script>

<!-- ── Panel Shell ─────────────────────────────────────────────────────── -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<div class="panel"
  on:mouseenter={() => invoke('panel_mouse_enter').catch(() => {})}
  on:mouseleave={() => invoke('panel_mouse_leave').catch(() => {})}
>
  <!-- Status Bar -->
  <div class="status-bar" class:thinking={running && !executingTool} class:executing={executingTool} class:error={errorState}></div>

  <!-- Header -->
  <header class="header">
    <div class="logo">
      <span class="logo-dot"></span>
      <span class="logo-name">Niro</span>
    </div>
    <div class="header-actions">
      <button class="header-btn" title="Clear chat" on:click={async () => {
        // Stop any running agent first
        if (running) { invoke('stop_agent').catch(() => {}); running = false; executingTool = false; }
        // Clear persisted history in store (matches Electron chat:clear)
        await invoke('clear_chat_history_cmd').catch(() => {});
        messages = []; chatHistory = []; showEmpty = true;
      }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="m19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
      <button class="header-btn" title="Settings" on:click={() => (showSettings = true)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </button>
      <button class="header-btn" title="Close" on:click={hidePanel}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  </header>

  <!-- Chat Area -->
  <div class="chat" bind:this={chatEl}>
    {#if showEmpty && messages.length === 0}
      <div class="empty">
        <div class="empty-icon">🐦</div>
        <p class="empty-sub">Hey! I'm <strong>Niro</strong>, your desktop AI agent.<br>I can open apps, run commands, set timers, and more.</p>
      </div>
    {/if}

    {#each messages as msg, i (i)}
      {#if msg.role === "user"}
        <div class="msg msg-user fade-up">{msg.text}</div>
      {:else if msg.role === "assistant"}
        <div class="msg msg-assistant fade-up">{msg.text}</div>
      {:else if msg.role === "tool"}
        <div class="msg msg-tool fade-up">
          <span class="tool-icon">⚡</span>
          <span
            >Running: <strong>{msg.name}</strong>{msg.display
              ? ` › ${msg.display}`
              : ""}</span
          >
        </div>
      {:else if msg.role === "error"}
        <div class="msg msg-error fade-up">{msg.text}</div>
      {/if}
    {/each}

    {#if running && !["assistant", "tool"].includes(messages[messages.length - 1]?.role)}
      <div class="thinking fade-up">
        <div class="pulse-dot"></div>
        <div class="pulse-dot"></div>
        <div class="pulse-dot"></div>
      </div>
    {/if}
  </div>

  <!-- Quick Tasks (3-column grid, below chat — matches Electron #task-area) -->
  {#if tasks.length > 0}
    <div class="task-area">
      <div class="task-grid">
        {#each tasks as task (task.id)}
          <button
            class="task-btn"
            on:click={() => runTask(task.instruction)}
            title={task.instruction}
          >
            <span class="task-icon">{task.icon || "⚡"}</span>
            <span class="task-name">{task.name}</span>
            <button
              class="task-delete"
              title="Remove"
              on:click|stopPropagation={async () => {
                await invoke('delete_task_cmd', { taskId: task.id }).catch(() => {});
                tasks = tasks.filter(t => t.id !== task.id);
              }}
            >✕</button>
          </button>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Input Bar (matches Electron #input-area) -->
  <div class="input-area">
    <div class="input-container" class:focused={false}>
      <button class="mic-btn {isRecording ? 'recording' : ''}" on:click={toggleMic} title="Voice input">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>
      </button>
      <input
        type="text"
        class="chat-input"
        placeholder="Message Niro..."
        bind:value={input}
        bind:this={inputEl}
        on:keydown={onKeydown}
        disabled={running}
        autocomplete="off"
        spellcheck="false"
      />
      {#if running}
        <button class="stop-btn" on:click={stopAgent} title="Stop">■</button>
      {:else}
        <button class="send-btn" on:click={sendMessage} disabled={!input.trim()} title="Send">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
        </button>
      {/if}
    </div>
  </div>
</div>

<!-- Settings Modal -->
{#if showSettings}
  <Settings on:close={() => (showSettings = false)} />
{/if}

<style>
  .panel {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--bg);
    border: 1px solid rgba(255,255,255,0.08);
    border-top: none;
    border-radius: 0 0 16px 16px;
    overflow: hidden;
    box-shadow: 0 8px 32px rgba(0,0,0,0.7);
  }

  /* Status bar */
  .status-bar {
    width: 100%; height: 3px;
    background: var(--accent);
    transition: background 0.4s ease;
    flex-shrink: 0;
  }
  .status-bar.thinking {
    background: #f59e0b;
    animation: pulse-amber 1.2s ease-in-out infinite;
  }
  .status-bar.executing {
    background: #10b981;
    animation: pulse-green 0.8s ease-in-out infinite;
  }
  @keyframes pulse-green {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }
  .status-bar.error {
    background: #ef4444;
  }
  @keyframes pulse-amber {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  /* Header */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px 8px;
    flex-shrink: 0;
  }
  .header-btn {
    width: 30px; height: 30px;
    display: flex; align-items: center; justify-content: center;
    border: none; background: transparent;
    color: var(--text-dim); border-radius: 8px;
    cursor: pointer; font-size: 14px;
    transition: all 0.2s ease;
  }
  .header-btn:hover { background: var(--surface2); color: var(--text); }
  .header-btn:active { transform: scale(0.92); }
  .logo {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .logo-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 8px var(--accent-dim);
    animation: glow-pulse 2s ease-in-out infinite;
  }
  @keyframes glow-pulse {
    0%,
    100% {
      box-shadow: 0 0 6px var(--accent-dim);
    }
    50% {
      box-shadow: 0 0 14px var(--accent);
    }
  }
  .logo-name {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: -0.3px;
    background: linear-gradient(135deg, var(--accent-light), var(--accent));
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .header-actions {
    display: flex;
    gap: 4px;
  }

  /* Task grid (matches Electron #task-area / #task-grid) */
  .task-area {
    padding: 4px 12px 10px;
    flex-shrink: 0;
    max-height: 160px;
    overflow-y: auto;
  }
  .task-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
  }
  .task-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 10px 6px;
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 10px;
    color: var(--text-dim);
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    transition: all 0.15s;
    min-height: 56px;
  }
  .task-btn:hover {
    background: var(--accent-dim);
    border-color: var(--accent-border);
    color: var(--text);
    transform: translateY(-1px);
  }
  .task-btn:active { transform: scale(0.97); }
  .task-icon { font-size: 18px; line-height: 1; }
  .task-name { font-size: 11px; font-weight: 500; text-align: center; line-height: 1.2; }
  .task-delete {
    position: absolute; top: 3px; right: 3px;
    width: 14px; height: 14px; border: none; background: transparent;
    color: var(--text-faint); font-size: 9px; cursor: pointer;
    border-radius: 3px; display: flex; align-items: center; justify-content: center;
    opacity: 0; transition: opacity 0.15s, background 0.15s;
    padding: 0; line-height: 1;
  }
  .task-btn { position: relative; }
  .task-btn:hover .task-delete { opacity: 1; }
  .task-delete:hover { background: rgba(239,68,68,0.15); color: #ef4444; }

  /* Chat */
  .chat {
    flex: 1;
    overflow-y: auto;
    padding: 4px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    scroll-behavior: smooth;
  }
  /* Custom scrollbar (matches Electron) */
  .chat::-webkit-scrollbar { width: 4px; }
  .chat::-webkit-scrollbar-track { background: transparent; }
  .chat::-webkit-scrollbar-thumb { background: var(--surface2); border-radius: 4px; }
  .chat::-webkit-scrollbar-thumb:hover { background: var(--text-faint); }

  /* Empty state */
  .empty {
    margin: auto;
    text-align: center;
    padding: 32px 24px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
  }
  .empty-icon {
    font-size: 32px;
    opacity: 0.6;
  }
  .empty-sub {
    font-size: 13px;
    color: var(--text-dim);
    line-height: 1.6;
    max-width: 260px;
  }

  /* Messages */
  .msg {
    max-width: 88%;
    padding: 10px 14px;
    border-radius: 16px;
    font-size: 13px;
    line-height: 1.55;
    word-break: break-word;
    animation: msg-in 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  }
  @keyframes msg-in {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .msg-user {
    align-self: flex-end;
    background: var(--accent);
    color: #000000;
    font-weight: 500;
    border-bottom-right-radius: 4px;
  }
  .msg-assistant {
    align-self: flex-start;
    background: var(--surface);
    color: var(--text);
    white-space: pre-wrap;
    border-bottom-left-radius: 4px;
  }
  .msg-tool {
    align-self: flex-start;
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--tool-bg);
    border: 1px solid var(--accent-border);
    border-radius: var(--radius-sm);
    color: var(--accent);
    font-size: 12px;
    padding: 6px 12px;
  }
  .msg-error {
    align-self: flex-start;
    background: rgba(248, 113, 113, 0.08);
    border: 1px solid rgba(248, 113, 113, 0.2);
    border-radius: var(--radius-sm);
    color: var(--error);
    padding: 8px 12px;
    font-size: 12px;
  }
  .tool-icon {
    font-size: 11px;
  }

  /* Thinking */
  .thinking {
    align-self: flex-start;
    display: flex;
    gap: 5px;
    padding: 8px 0;
  }

  /* Input area (matches Electron #input-area, #input-container) */
  .input-area {
    padding: 0 12px 10px;
    flex-shrink: 0;
  }
  .input-container {
    display: flex;
    align-items: center;
    gap: 8px;
    background: #1c1c1c;
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 6px;
    transition: border-color 0.2s, box-shadow 0.2s;
  }
  .input-container:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-dim);
  }
  .chat-input {
    flex: 1;
    border: none;
    background: transparent;
    color: var(--text);
    font-family: 'Inter', sans-serif;
    font-size: 14px;
    font-weight: 400;
    outline: none;
    min-height: 38px;
    line-height: 38px;
  }
  .chat-input::placeholder { color: var(--text-faint); }
  .mic-btn {
    width: 36px; height: 36px;
    border: none; background: transparent;
    color: var(--text-dim);
    border-radius: 10px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.2s; flex-shrink: 0;
  }
  .mic-btn:hover { background: var(--surface2); color: var(--text); }
  .mic-btn.recording {
    background: rgba(255, 68, 68, 0.15);
    color: #ff4444;
    animation: pulse-recording 1.5s infinite;
    box-shadow: 0 0 12px rgba(255, 68, 68, 0.4);
  }
  @keyframes pulse-recording {
    0% { transform: scale(1); box-shadow: 0 0 8px rgba(255, 68, 68, 0.3); }
    50% { transform: scale(1.1); box-shadow: 0 0 20px rgba(255, 68, 68, 0.7); }
    100% { transform: scale(1); box-shadow: 0 0 8px rgba(255, 68, 68, 0.3); }
  }
  .send-btn {
    width: 36px; height: 36px;
    border: none; background: var(--accent);
    color: #000; border-radius: 10px;
    cursor: pointer; display: flex;
    align-items: center; justify-content: center;
    transition: all 0.2s; flex-shrink: 0;
  }
  .send-btn:hover { background: var(--accent-light); transform: scale(1.05); }
  .send-btn:active { transform: scale(0.95); }
  .send-btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }
  .stop-btn {
    width: 32px; height: 32px;
    border: none; background: var(--error);
    color: white; border-radius: 10px;
    cursor: pointer; display: flex;
    align-items: center; justify-content: center;
    font-size: 12px; transition: all 0.2s; flex-shrink: 0;
  }
  .stop-btn:hover { opacity: 0.85; }
</style>
