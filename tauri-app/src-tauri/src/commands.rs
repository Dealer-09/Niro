// commands.rs — All Tauri command handlers (IPC bridge between Svelte and Rust)
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::agent::{new_abort_flag, run_gemini_agent, run_groq_agent, AbortFlag, ChatMessage};
use crate::store::{
    get_provider_config, get_tasks, set_provider_config as store_set_config, set_tasks,
    delete_task as store_delete_task,
    get_chat_history as store_get_chat_history,
    append_chat_history, clear_chat_history as store_clear_chat_history,
    ProviderConfig, Task,
};
use crate::tools::{new_timer_map, TimerMap};

// ── Managed app state ──────────────────────────────────────────────────────
pub struct AppState {
    pub abort: Mutex<AbortFlag>,
    pub timers: TimerMap,
    pub http: reqwest::Client,
    pub hide_cancelled: Arc<AtomicBool>,  // cancellation flag for sensor hide delay
}

impl AppState {
    pub fn new() -> Self {
        Self {
            abort: Mutex::new(new_abort_flag()),
            timers: new_timer_map(),
            http: reqwest::Client::new(),
            hide_cancelled: Arc::new(AtomicBool::new(false)),
        }
    }
}

// ── run_agent ──────────────────────────────────────────────────────────────
#[tauri::command]
pub async fn run_agent(
    app: AppHandle,
    state: State<'_, AppState>,
    message: String,
    history: Vec<ChatMessage>,
) -> Result<(), String> {
    // Create a fresh abort flag for this run
    let abort = new_abort_flag();
    *state.abort.lock() = abort.clone();

    let timers = state.timers.clone();
    let cfg = get_provider_config(&app);

    // Spawn agent in background — it streams events back via app.emit()
    let msg_for_history = message.clone(); // only clone needed: for append_chat_history
    let http = state.http.clone(); // cheap Arc clone
    tokio::spawn(async move {
        if cfg.provider == "groq" {
            run_groq_agent(&app, &timers, &http, message, history, abort).await;
        } else {
            run_gemini_agent(&app, &timers, &http, message, history, abort).await;
        }
        let _ = append_chat_history(&app, "user", &msg_for_history);
    });

    Ok(())
}

// ── stop_agent ─────────────────────────────────────────────────────────────
#[tauri::command]
pub fn stop_agent(state: State<'_, AppState>) {
    state.abort.lock().store(true, Ordering::Relaxed);
}

// ── get_provider_config ────────────────────────────────────────────────────
#[tauri::command]
pub fn get_provider_config_cmd(app: AppHandle) -> ProviderConfig {
    get_provider_config(&app)
}

// ── set_provider_config ────────────────────────────────────────────────────
#[tauri::command]
pub fn set_provider_config_cmd(app: AppHandle, config: ProviderConfig) -> Result<(), String> {
    store_set_config(&app, config)
}

// ── get_tasks ──────────────────────────────────────────────────────────────
#[tauri::command]
pub fn get_tasks_cmd(app: AppHandle) -> Vec<Task> {
    get_tasks(&app)
}

// ── save_task (callable from Svelte and from agent tool) ───────────────────
#[tauri::command]
pub fn save_task_cmd(app: AppHandle, name: String, instruction: String) -> Result<(), String> {
    save_task_inner(&app, name, instruction)
}

// ── delete_task ────────────────────────────────────────────────────────────
#[tauri::command]
pub fn delete_task_cmd(app: AppHandle, task_id: String) -> Result<Vec<Task>, String> {
    let tasks = store_delete_task(&app, &task_id)?;
    let _ = app.emit("tasks:updated", serde_json::json!({ "tasks": tasks }));
    Ok(tasks)
}

// ── get_chat_history ───────────────────────────────────────────────────────
#[tauri::command]
pub fn get_chat_history_cmd(app: AppHandle) -> Vec<serde_json::Value> {
    store_get_chat_history(&app)
        .into_iter()
        .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
        .collect()
}

// ── clear_chat_history ─────────────────────────────────────────────────────
#[tauri::command]
pub fn clear_chat_history_cmd(app: AppHandle) -> Result<(), String> {
    store_clear_chat_history(&app)
}

// ── append_chat_history — called by frontend to persist assistant responses ─
#[tauri::command]
pub fn append_chat_history_cmd(app: AppHandle, role: String, content: String) -> Result<(), String> {
    append_chat_history(&app, &role, &content)
}

/// Internal helper — called by both the Tauri command and the agent's save_task tool
pub fn save_task_inner(app: &AppHandle, name: String, instruction: String) -> Result<(), String> {
    let mut tasks = get_tasks(app);
    tasks.push(Task {
        id: Uuid::new_v4().to_string(),
        name,
        instruction,
        icon: "⚡".to_string(),
    });
    set_tasks(app, &tasks)?;
    // Push update to frontend
    let _ = app.emit("tasks:updated", serde_json::json!({ "tasks": tasks }));
    Ok(())
}

// ── transcribe_audio ───────────────────────────────────────────────────────
#[tauri::command]
pub async fn transcribe_audio(
    app: AppHandle,
    state: State<'_, AppState>,
    audio_bytes: Vec<u8>,
) -> Result<String, String> {
    let cfg = get_provider_config(&app);
    if cfg.groq_key.is_empty() {
        return Err(
            "A Groq API key is required for voice transcription. Add one in ⚙️ Settings.".into(),
        );
    }

    // Build multipart form for Groq Whisper
    let form = reqwest::multipart::Form::new()
        .text("model", "whisper-large-v3-turbo")
        .text("response_format", "text")
        .part(
            "file",
            reqwest::multipart::Part::bytes(audio_bytes)
                .file_name("audio.webm")
                .mime_str("audio/webm")
                .map_err(|e| e.to_string())?,
        );

    let resp = state.http
        .post("https://api.groq.com/openai/v1/audio/transcriptions")
        .bearer_auth(&cfg.groq_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("Whisper API error: {txt}"));
    }

    resp.text().await.map_err(|e| e.to_string())
}

// ── quit_app ───────────────────────────────────────────────────────────────
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

// ── sensor_hover — called when mouse enters the invisible sensor zone ──────
#[tauri::command]
pub fn sensor_hover(app: AppHandle) {
    if let Some(panel) = app.get_webview_window("panel") {
        let _ = panel.show();
        let _ = panel.set_focus();
    }
}

// ── panel_mouse_leave — schedule hide after delay (matches Electron) ───────
#[tauri::command]
pub fn panel_mouse_leave(app: AppHandle, state: State<'_, AppState>) {
    // Reset cancel flag — new leave event starts fresh
    state.hide_cancelled.store(false, Ordering::Relaxed);
    let cancel_flag = state.hide_cancelled.clone();

    // Use tokio instead of std::thread (cheaper, non-blocking)
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        // Check if hide was cancelled (user re-entered panel)
        if !cancel_flag.load(Ordering::Relaxed) {
            if let Some(panel) = app.get_webview_window("panel") {
                if !panel.is_focused().unwrap_or(true) {
                    let _ = panel.hide();
                }
            }
        }
    });
}

// ── panel_mouse_enter — cancel any pending hide ────────────────────────────
#[tauri::command]
pub fn panel_mouse_enter(state: State<'_, AppState>) {
    state.hide_cancelled.store(true, Ordering::Relaxed);
}