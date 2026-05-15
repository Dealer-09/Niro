// store.rs — Settings persistence via tauri-plugin-store
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "niro_settings.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderConfig {
    pub provider: String,
    pub gemini_key: String,
    pub gemini_extra_keys: Vec<String>,
    pub gemini_model: String,
    pub groq_key: String,
    pub groq_extra_keys: Vec<String>,
    pub groq_model: String,
    pub gmail_user: String,
    pub gmail_pass: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub name: String,
    pub instruction: String,
    pub icon: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

// ── Default tasks (matches Electron store.defaults.tasks) ─────────────────
fn default_tasks() -> Vec<Task> {
    vec![
        Task { id: "1".into(), name: "Chrome".into(),      icon: "🌐".into(), instruction: "Open Google Chrome".into() },
        Task { id: "2".into(), name: "Notepad".into(),     icon: "📝".into(), instruction: "Open Notepad".into() },
        Task { id: "3".into(), name: "25min Timer".into(), icon: "⏱".into(),  instruction: "Set a 25 minute focus timer".into() },
        Task { id: "4".into(), name: "5min Break".into(),  icon: "☕".into(), instruction: "Set a 5 minute break timer".into() },
        Task { id: "5".into(), name: "My IP".into(),       icon: "🔌".into(), instruction: "Show my public IP address".into() },
        Task { id: "6".into(), name: "Screenshot".into(),  icon: "📸".into(), instruction: "Take a screenshot and tell me what's on my screen".into() },
    ]
}

pub fn get_provider_config(app: &AppHandle) -> ProviderConfig {
    let store = match app.store(STORE_FILE) {
        Ok(s) => s,
        Err(_) => return ProviderConfig::default(),
    };
    let cfg: ProviderConfig = store
        .get("providerConfig")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    // Apply defaults — default provider is 'groq' to match Electron
    ProviderConfig {
        provider:      if cfg.provider.is_empty()      { "groq".into() }                              else { cfg.provider },
        gemini_model:  if cfg.gemini_model.is_empty() || cfg.gemini_model.contains("preview-04-17")
                            { "gemini-2.5-flash".into() } else { cfg.gemini_model },
        groq_model:    if cfg.groq_model.is_empty()    { "llama-3.1-8b-instant".into() }           else { cfg.groq_model },
        ..cfg
    }
}

pub fn set_provider_config(app: &AppHandle, config: ProviderConfig) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set("providerConfig", serde_json::to_value(&config).unwrap());
    store.save().map_err(|e| e.to_string())
}

pub fn get_tasks(app: &AppHandle) -> Vec<Task> {
    let store = match app.store(STORE_FILE) {
        Ok(s) => s,
        Err(_) => return default_tasks(),
    };
    match store.get("tasks").and_then(|v| serde_json::from_value(v).ok()) {
        Some(tasks) => tasks,
        None => {
            // First launch — seed defaults exactly like Electron
            let defaults = default_tasks();
            store.set("tasks", serde_json::to_value(&defaults).unwrap());
            let _ = store.save();
            defaults
        }
    }
}

pub fn set_tasks(app: &AppHandle, tasks: &[Task]) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set("tasks", serde_json::to_value(tasks).unwrap());
    store.save().map_err(|e| e.to_string())
}

pub fn delete_task(app: &AppHandle, task_id: &str) -> Result<Vec<Task>, String> {
    let mut tasks = get_tasks(app);
    tasks.retain(|t| t.id != task_id);
    set_tasks(app, &tasks)?;
    Ok(tasks)
}

// ── Chat history persistence (matches Electron chat:getHistory / chat:clear) ─
pub fn get_chat_history(app: &AppHandle) -> Vec<ChatMessage> {
    let store = match app.store(STORE_FILE) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    store
        .get("chatHistory")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

pub fn append_chat_history(app: &AppHandle, role: &str, content: &str) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let mut history = get_chat_history(app);
    history.push(ChatMessage { role: role.into(), content: content.into() });
    // Keep last 50 messages like Electron
    if history.len() > 50 { history.drain(0..history.len() - 50); }
    store.set("chatHistory", serde_json::to_value(&history).unwrap());
    store.save().map_err(|e| e.to_string())
}

pub fn clear_chat_history(app: &AppHandle) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set("chatHistory", serde_json::json!([]));
    store.save().map_err(|e| e.to_string())
}
