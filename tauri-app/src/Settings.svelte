<script>
  import { createEventDispatcher, onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';

  const dispatch = createEventDispatcher();

  let saving = false;
  let statusMsg = '';

  // Active tab: 'provider' | 'email' | 'general'
  let activeTab = 'provider';

  // Provider selection
  let provider = 'groq'; // matches Electron default

  // Gemini
  let geminiKey = '';
  let geminiExtraKeys = [];
  let geminiModel = 'gemini-2.5-flash';

  // Groq
  let groqKey = '';
  let groqExtraKeys = [];
  let groqModel = 'llama-3.1-8b-instant'; // matches Electron PROVIDER_DEFAULTS.groq.model

  // Email
  let gmailUser = '';
  let gmailPass = '';

  onMount(async () => {
    try {
      const cfg = await invoke('get_provider_config_cmd');
      provider        = cfg.provider          || 'groq';
      geminiKey       = cfg.gemini_key        || '';
      geminiExtraKeys = cfg.gemini_extra_keys || [];
      geminiModel     = cfg.gemini_model      || geminiModel;
      groqKey         = cfg.groq_key          || '';
      groqExtraKeys   = cfg.groq_extra_keys   || [];
      groqModel       = cfg.groq_model        || groqModel;
      gmailUser       = cfg.gmail_user        || '';
      gmailPass       = cfg.gmail_pass        || '';
    } catch(e) { console.error(e); }
  });

  async function save() {
    saving = true; statusMsg = '';
    try {
      await invoke('set_provider_config_cmd', {
        config: {
          provider,
          gemini_key: geminiKey,
          gemini_extra_keys: geminiExtraKeys,
          gemini_model: geminiModel,
          groq_key: groqKey,
          groq_extra_keys: groqExtraKeys,
          groq_model: groqModel,
          gmail_user: gmailUser,
          gmail_pass: gmailPass,
        }
      });
      statusMsg = `✓ Saved. Using ${provider === 'gemini' ? 'Gemini' : 'Groq'}.`;
    } catch(e) { statusMsg = `✗ ${e}`; }
    saving = false;
  }

  function addGeminiKey() { geminiExtraKeys = [...geminiExtraKeys, '']; }
  function removeGeminiKey(i) { geminiExtraKeys = geminiExtraKeys.filter((_, idx) => idx !== i); }
  function updateGeminiKey(i, val) { geminiExtraKeys = geminiExtraKeys.map((k, idx) => idx === i ? val : k); }

  function addGroqKey() { groqExtraKeys = [...groqExtraKeys, '']; }
  function removeGroqKey(i) { groqExtraKeys = groqExtraKeys.filter((_, idx) => idx !== i); }
  function updateGroqKey(i, val) { groqExtraKeys = groqExtraKeys.map((k, idx) => idx === i ? val : k); }
</script>

<!-- Full-screen settings overlay (matches Electron #settings-overlay + #settings-panel) -->
<div class="settings-overlay">
  <div class="settings-panel">

    <!-- Header -->
    <div class="settings-header">
      <span>⚙️ Settings</span>
      <button class="close-btn" on:click={() => dispatch('close')} title="Close">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>

    <!-- Tabs -->
    <div class="settings-tabs">
      <button class="stab {activeTab === 'provider' ? 'active' : ''}" on:click={() => activeTab = 'provider'}>AI Provider</button>
      <button class="stab {activeTab === 'email'    ? 'active' : ''}" on:click={() => activeTab = 'email'}>Email</button>
      <button class="stab {activeTab === 'general'  ? 'active' : ''}" on:click={() => activeTab = 'general'}>General</button>
    </div>

    <!-- Tab: AI Provider -->
    {#if activeTab === 'provider'}
    <div class="tab-content">

      <!-- Provider selector -->
      <div class="field-row">
        <p class="field-label">Provider</p>
        <div class="provider-btns">
          <button class="provider-tab {provider === 'groq' ? 'active' : ''}" on:click={() => provider = 'groq'}>⚡ Groq</button>
          <button class="provider-tab {provider === 'gemini' ? 'active' : ''}" on:click={() => provider = 'gemini'}>✦ Gemini</button>
        </div>
      </div>

      <!-- Gemini section -->
      {#if provider === 'gemini'}
      <div class="field-row">
        <label for="gemini-key">Gemini API Key <a class="field-link" href="https://aistudio.google.com" target="_blank">aistudio.google.com</a></label>
        <div class="key-input-row">
          <input id="gemini-key" type="password" placeholder="AIza..." bind:value={geminiKey} />
          <button class="btn-add-key" on:click={addGeminiKey} title="Add backup key">+</button>
        </div>
        {#each geminiExtraKeys as key, i}
          <div class="extra-key-item">
            <input type="password" placeholder="Backup key {i + 1}" value={key}
              on:input={e => updateGeminiKey(i, e.target.value)} />
            <button class="key-remove-btn" on:click={() => removeGeminiKey(i)}>✕</button>
          </div>
        {/each}
      </div>
      <div class="field-row">
        <label for="gemini-model">Model</label>
        <select id="gemini-model" bind:value={geminiModel}>
          <option value="gemini-2.5-flash-preview-04-17">Gemini 2.5 Flash</option>
          <option value="gemini-2.5-pro-preview-05-06">Gemini 2.5 Pro</option>
          <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
        </select>
      </div>
      {/if}

      <!-- Groq section -->
      {#if provider === 'groq'}
      <div class="field-row">
        <label for="groq-key">Groq API Key <a class="field-link" href="https://console.groq.com" target="_blank">console.groq.com</a></label>
        <div class="key-input-row">
          <input id="groq-key" type="password" placeholder="gsk_..." bind:value={groqKey} />
          <button class="btn-add-key" on:click={addGroqKey} title="Add backup key">+</button>
        </div>
        {#each groqExtraKeys as key, i}
          <div class="extra-key-item">
            <input type="password" placeholder="Backup key {i + 1}" value={key}
              on:input={e => updateGroqKey(i, e.target.value)} />
            <button class="key-remove-btn" on:click={() => removeGroqKey(i)}>✕</button>
          </div>
        {/each}
      </div>
      <div class="field-row">
        <label for="groq-model">Model</label>
        <select id="groq-model" bind:value={groqModel}>
          <option value="llama-3.1-8b-instant">Llama 3.1 8B Instant (Fast, Recommended)</option>
          <option value="llama-3.3-70b-versatile">Llama 3.3 70B (Powerful, Slower)</option>
          <option value="mixtral-8x7b-32768">Mixtral 8x7B</option>
        </select>
      </div>
      {/if}

      <p class="settings-hint">Keys rotate automatically when daily quota is hit.</p>
    </div>
    {/if}

    <!-- Tab: Email -->
    {#if activeTab === 'email'}
    <div class="tab-content">
      <div class="field-row">
        <label for="gmail-user">Gmail Address</label>
        <input id="gmail-user" type="email" placeholder="you@gmail.com" bind:value={gmailUser} />
      </div>
      <div class="field-row">
        <label for="gmail-pass">App Password <a class="field-link" href="https://myaccount.google.com/apppasswords" target="_blank">get one here</a></label>
        <input id="gmail-pass" type="password" placeholder="xxxx xxxx xxxx xxxx" bind:value={gmailPass} />
      </div>
      <p class="settings-hint">Use an App Password — not your Gmail password.<br>Enable 2FA first, then generate at myaccount.google.com/apppasswords</p>
    </div>
    {/if}

    <!-- Tab: General (placeholder) -->
    {#if activeTab === 'general'}
    <div class="tab-content">
      <p class="settings-hint">More settings coming in a future version.</p>
    </div>
    {/if}

    <!-- Footer -->
    <div class="settings-footer">
      <button class="btn-danger" on:click={() => invoke('quit_app')}>Quit</button>
      {#if statusMsg}<span class="status-msg">{statusMsg}</span>{/if}
      <button class="btn-secondary" on:click={() => dispatch('close')}>Cancel</button>
      <button class="btn-primary" on:click={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>

  </div>
</div>

<style>
  /* Full-screen overlay — matches Electron #settings-overlay */
  .settings-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    pointer-events: all;
  }

  /* Full-panel — matches Electron #settings-panel (position:absolute inset:0) */
  .settings-panel {
    position: absolute;
    inset: 0;
    background: #000000;
    display: flex;
    flex-direction: column;
    animation: settings-in 0.22s cubic-bezier(0.16, 1, 0.3, 1);
    overflow: hidden;
  }

  @keyframes settings-in {
    from { opacity: 0; transform: translateX(16px); }
    to   { opacity: 1; transform: translateX(0); }
  }

  /* Header */
  .settings-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px 10px;
    flex-shrink: 0;
    border-bottom: 1px solid rgba(255,255,255,0.08);
  }
  .settings-header span {
    font-size: 14px;
    font-weight: 700;
    color: #ffffff;
  }
  .close-btn {
    width: 28px; height: 28px;
    border: none; background: transparent;
    color: #b3b3b3; border-radius: 8px;
    cursor: pointer; display: flex;
    align-items: center; justify-content: center;
    transition: all 0.2s ease;
  }
  .close-btn:hover { background: #333; color: #fff; }

  /* Tabs */
  .settings-tabs {
    display: flex;
    gap: 4px;
    padding: 10px 16px 0;
    flex-shrink: 0;
  }
  .stab {
    flex: 1; padding: 6px 8px;
    background: transparent; border: none;
    border-bottom: 2px solid transparent;
    color: #808080;
    font-family: 'Inter', sans-serif;
    font-size: 11px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.5px;
    cursor: pointer; transition: all 0.2s ease;
  }
  .stab:hover { color: #b3b3b3; }
  .stab.active { color: #16EF75; border-bottom-color: #16EF75; }

  /* Tab content */
  .tab-content {
    flex: 1;
    padding: 14px 16px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .tab-content::-webkit-scrollbar { width: 3px; }
  .tab-content::-webkit-scrollbar-track { background: transparent; }
  .tab-content::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }

  /* Provider selector */
  .provider-btns { display: flex; gap: 6px; }
  .provider-tab {
    flex: 1; padding: 7px 10px;
    background: #333; color: #b3b3b3;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 8px;
    font-family: 'Inter', sans-serif;
    font-size: 11px; font-weight: 500;
    cursor: pointer; transition: all 0.2s ease;
    text-align: center;
  }
  .provider-tab:hover { background: #2c2c2c; color: #fff; }
  .provider-tab.active {
    background: rgba(22, 239, 117, 0.12);
    color: #16EF75;
    border-color: rgba(22, 239, 117, 0.3);
    font-weight: 600;
  }

  /* Field rows */
  .field-row {
    display: flex; flex-direction: column; gap: 5px;
  }
  .field-row label,
  .field-label {
    font-size: 10px; font-weight: 600;
    color: #b3b3b3; text-transform: uppercase;
    letter-spacing: 0.5px; margin: 0;
    display: flex; align-items: center; gap: 6px;
  }
  .field-row input[type="password"],
  .field-row input[type="email"],
  .field-row select {
    width: 100%; padding: 8px 12px;
    background: #1c1c1c;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 8px;
    color: #ffffff;
    font-family: 'Inter', sans-serif;
    font-size: 12px; outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
  }
  .field-row input:focus,
  .field-row select:focus {
    border-color: #16EF75;
    box-shadow: 0 0 0 2px rgba(22, 239, 117, 0.15);
  }
  .field-row input::placeholder { color: #808080; }
  .field-row select option { background: #1c1c1c; }

  /* Key input row */
  .key-input-row { display: flex; gap: 6px; align-items: center; }
  .key-input-row input { flex: 1; }
  .btn-add-key {
    width: 34px; height: 34px; flex-shrink: 0;
    background: rgba(22, 239, 117, 0.15);
    border: 1px solid #16EF75;
    color: #16EF75; border-radius: 8px;
    font-size: 20px; font-weight: 300;
    cursor: pointer; display: flex;
    align-items: center; justify-content: center;
    transition: all 0.2s; line-height: 1;
  }
  .btn-add-key:hover { background: #16EF75; color: #000; }

  /* Extra key items */
  .extra-key-item {
    display: flex; align-items: center; gap: 6px;
    background: #2c2c2c;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 8px; padding: 4px 8px;
  }
  .extra-key-item input {
    flex: 1; background: transparent;
    border: none; color: #b3b3b3;
    font-size: 11px; outline: none; padding: 2px 0;
  }
  .key-remove-btn {
    background: none; border: none;
    color: #ef4444; cursor: pointer;
    font-size: 11px; padding: 2px 4px;
    flex-shrink: 0; transition: opacity 0.2s;
  }
  .key-remove-btn:hover { opacity: 0.7; }

  /* Field link */
  .field-link {
    font-size: 9px; color: #16EF75;
    text-decoration: none; font-weight: 500;
    text-transform: none; letter-spacing: 0;
  }
  .field-link:hover { text-decoration: underline; }

  /* Hint */
  .settings-hint {
    font-size: 10px; color: #808080;
    line-height: 1.5; padding: 8px 10px;
    background: rgba(255,255,255,0.03);
    border-radius: 8px;
    border: 1px solid rgba(255,255,255,0.08);
  }

  /* Footer */
  .settings-footer {
    display: flex; align-items: center;
    justify-content: flex-end; gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid rgba(255,255,255,0.08);
    flex-shrink: 0;
  }
  .status-msg {
    font-size: 11px; color: #16EF75;
    margin-right: auto;
  }
  .btn-secondary {
    padding: 7px 14px;
    background: transparent;
    border: 1px solid rgba(255,255,255,0.12);
    color: #b3b3b3; border-radius: 8px;
    font-family: 'Inter', sans-serif;
    font-size: 12px; cursor: pointer;
    transition: all 0.2s;
  }
  .btn-secondary:hover { background: #333; color: #fff; }
  .btn-primary {
    padding: 7px 16px;
    background: #16EF75; color: #000;
    border: none; border-radius: 8px;
    font-family: 'Inter', sans-serif;
    font-size: 12px; font-weight: 600;
    cursor: pointer; transition: all 0.2s;
  }
  .btn-primary:hover { background: #6affa8; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-danger {
    padding: 7px 14px;
    background: rgba(239, 68, 68, 0.12);
    color: #ef4444;
    border: 1px solid rgba(239, 68, 68, 0.2);
    border-radius: 8px;
    font-family: 'Inter', sans-serif;
    font-size: 12px; font-weight: 600;
    cursor: pointer; transition: all 0.2s;
    margin-right: auto;
  }
  .btn-danger:hover { background: rgba(239, 68, 68, 0.22); }
</style>
