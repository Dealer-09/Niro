// store.rs — Settings persistence via tauri-plugin-store
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "niro_settings.json";

// ── Secret storage (OS keychain via `keyring`) ─────────────────────────────
// API keys and the Gmail App Password live in the OS credential vault (Windows
// Credential Manager), never in the plaintext settings JSON.
const KEYRING_SERVICE: &str = "com.dealer09.niro";

fn secret_get(account: &str) -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, account)
        .ok()?
        .get_password()
        .ok()
        .filter(|s| !s.is_empty())
}

/// Store or clear one secret. Returns true on success (including deletes), so
/// the caller can decide whether it's safe to blank the on-disk copy. A false
/// return means the keychain was unavailable — keep the plaintext fallback.
fn write_secret(account: &str, value: &str) -> bool {
    if value.is_empty() {
        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, account) {
            let _ = entry.delete_credential();
        }
        return true;
    }
    match keyring::Entry::new(KEYRING_SERVICE, account) {
        Ok(entry) => {
            if entry.set_password(value).is_err() {
                return false;
            }
            // Read-back verification: confirm the keychain durably stored the
            // value before the caller blanks the on-disk copy. A flaky/locked
            // vault that reports write-success but isn't readable would
            // otherwise destroy the user's key forever.
            match entry.get_password() {
                Ok(readback) if readback == value => true,
                _ => false,
            }
        }
        Err(_) => false,
    }
}

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

// A scheduled email persisted to disk so it survives an app restart. `send_at`
// is a unix-epoch timestamp (seconds); the queue is re-armed on startup.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduledEmail {
    pub id: String,
    pub to: String,
    pub subject: String,
    pub body: String,
    pub send_at: i64,
}

// A general scheduled task — persisted so it survives a restart. `send_at` is
// a unix-epoch timestamp (seconds). The task fires as a bounded agent invocation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduledTask {
    pub id: String,
    pub prompt: String,  // instruction replayed to the agent when it fires
    pub run_at: i64,     // unix epoch seconds
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

    // Pull secrets from the OS keychain; fall back to any legacy plaintext still
    // in the store (pre-migration installs). migrate_secrets_to_keyring() moves
    // those into the keychain and blanks them from disk on startup.
    let gemini_key = secret_get("gemini_key").unwrap_or(cfg.gemini_key);
    // Parse extra_keys JSON carefully — a parse failure must fall back to the
    // on-disk value, never silently drop the user's backup keys.
    let gemini_extra_keys = match secret_get("gemini_extra_keys") {
        Some(j) => serde_json::from_str::<Vec<String>>(&j)
            .unwrap_or_else(|_| {
                eprintln!("[Niro] WARNING: gemini_extra_keys JSON parse failed, using on-disk fallback");
                cfg.gemini_extra_keys.clone()
            }),
        None => cfg.gemini_extra_keys,
    };
    let groq_key = secret_get("groq_key").unwrap_or(cfg.groq_key);
    let groq_extra_keys = match secret_get("groq_extra_keys") {
        Some(j) => serde_json::from_str::<Vec<String>>(&j)
            .unwrap_or_else(|_| {
                eprintln!("[Niro] WARNING: groq_extra_keys JSON parse failed, using on-disk fallback");
                cfg.groq_extra_keys.clone()
            }),
        None => cfg.groq_extra_keys,
    };
    let gmail_pass = secret_get("gmail_pass").unwrap_or(cfg.gmail_pass);

    // Apply defaults — default provider is 'groq' to match Electron
    ProviderConfig {
        provider:      if cfg.provider.is_empty() { "groq".into() } else { cfg.provider },
        // Rewrite empty or decommissioned models to a live default.
        // gemini-2.0-flash / 2.0-flash-lite were shut down 2026-06-01; the old
        // "preview" snapshots are gone too — all would 404 if sent.
        gemini_model:  if cfg.gemini_model.is_empty()
                          || cfg.gemini_model.contains("preview")
                          || cfg.gemini_model == "gemini-2.0-flash"
                          || cfg.gemini_model == "gemini-2.0-flash-lite"
                            { "gemini-2.5-flash".into() } else { cfg.gemini_model },
        groq_model:    if cfg.groq_model.is_empty() { "llama-3.1-8b-instant".into() } else { cfg.groq_model },
        gemini_key,
        gemini_extra_keys,
        groq_key,
        groq_extra_keys,
        gmail_user: cfg.gmail_user,
        gmail_pass,
    }
}

pub fn set_provider_config(app: &AppHandle, config: ProviderConfig) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;

    // Write secrets to the OS keychain. On any failure (keychain unavailable),
    // keep that field in the store so the value isn't lost — this degrades to
    // the previous plaintext behavior rather than dropping the user's key.
    let mut sanitized = config.clone();
    if write_secret("gemini_key", &config.gemini_key) {
        sanitized.gemini_key = String::new();
    }
    let gem_extra = serde_json::to_string(&config.gemini_extra_keys).unwrap_or_else(|_| "[]".into());
    if write_secret("gemini_extra_keys", &gem_extra) {
        sanitized.gemini_extra_keys = Vec::new();
    }
    if write_secret("groq_key", &config.groq_key) {
        sanitized.groq_key = String::new();
    }
    let groq_extra = serde_json::to_string(&config.groq_extra_keys).unwrap_or_else(|_| "[]".into());
    if write_secret("groq_extra_keys", &groq_extra) {
        sanitized.groq_extra_keys = Vec::new();
    }
    if write_secret("gmail_pass", &config.gmail_pass) {
        sanitized.gmail_pass = String::new();
    }

    store.set("providerConfig", serde_json::to_value(&sanitized).unwrap());
    store.save().map_err(|e| e.to_string())
}

/// One-time migration: move any plaintext secrets left in the settings JSON
/// (pre-keychain installs) into the OS keychain, then blank them on disk.
/// Safe to call on every startup — it no-ops once the store is clean.
pub fn migrate_secrets_to_keyring(app: &AppHandle) {
    let store = match app.store(STORE_FILE) {
        Ok(s) => s,
        Err(_) => return,
    };
    let cfg: ProviderConfig = match store
        .get("providerConfig")
        .and_then(|v| serde_json::from_value(v).ok())
    {
        Some(c) => c,
        None => return,
    };
    let has_plaintext = !cfg.gemini_key.is_empty()
        || !cfg.groq_key.is_empty()
        || !cfg.gmail_pass.is_empty()
        || !cfg.gemini_extra_keys.is_empty()
        || !cfg.groq_extra_keys.is_empty();
    if has_plaintext {
        // set_provider_config writes secrets to the keychain and rewrites the
        // store with them blanked.
        let _ = set_provider_config(app, cfg);
    }
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

// ── Scheduled-email queue (persisted so it survives a restart) ─────────────
const SCHEDULED_EMAILS_KEY: &str = "scheduledEmails";

pub fn get_scheduled_emails(app: &AppHandle) -> Vec<ScheduledEmail> {
    let store = match app.store(STORE_FILE) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    store
        .get(SCHEDULED_EMAILS_KEY)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

pub fn add_scheduled_email(app: &AppHandle, email: &ScheduledEmail) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let mut list = get_scheduled_emails(app);
    list.push(email.clone());
    store.set(SCHEDULED_EMAILS_KEY, serde_json::to_value(&list).unwrap());
    store.save().map_err(|e| e.to_string())
}

pub fn remove_scheduled_email(app: &AppHandle, id: &str) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let mut list = get_scheduled_emails(app);
    list.retain(|e| e.id != id);
    store.set(SCHEDULED_EMAILS_KEY, serde_json::to_value(&list).unwrap());
    store.save().map_err(|e| e.to_string())
}

// ── Scheduled task queue ────────────────────────────────────────────────────
const SCHEDULED_TASKS_KEY: &str = "scheduledTasks";

pub fn get_scheduled_tasks(app: &AppHandle) -> Vec<ScheduledTask> {
    let store = match app.store(STORE_FILE) { Ok(s) => s, Err(_) => return Vec::new() };
    store.get(SCHEDULED_TASKS_KEY).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}

pub fn add_scheduled_task(app: &AppHandle, task: &ScheduledTask) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let mut list = get_scheduled_tasks(app);
    list.push(task.clone());
    store.set(SCHEDULED_TASKS_KEY, serde_json::to_value(&list).unwrap());
    store.save().map_err(|e| e.to_string())
}

pub fn remove_scheduled_task(app: &AppHandle, id: &str) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let mut list = get_scheduled_tasks(app);
    list.retain(|t| t.id != id);
    store.set(SCHEDULED_TASKS_KEY, serde_json::to_value(&list).unwrap());
    store.save().map_err(|e| e.to_string())
}

// ── Persistent long-term memory ─────────────────────────────────────────────
const MEMORY_KEY: &str = "memory";
const MAX_MEMORY: usize = 50;

pub fn get_memory(app: &AppHandle) -> Vec<String> {
    let store = match app.store(STORE_FILE) { Ok(s) => s, Err(_) => return Vec::new() };
    store.get(MEMORY_KEY).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}

pub fn add_memory_fact(app: &AppHandle, fact: &str) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let mut facts = get_memory(app);
    // Truncate to 200 chars; skip exact duplicates (case-insensitive)
    let fact = fact.chars().take(200).collect::<String>();
    if !facts.iter().any(|f| f.to_lowercase() == fact.to_lowercase()) {
        facts.push(fact);
    }
    if facts.len() > MAX_MEMORY { facts.drain(0..facts.len() - MAX_MEMORY); }
    store.set(MEMORY_KEY, serde_json::to_value(&facts).unwrap());
    store.save().map_err(|e| e.to_string())
}

pub fn forget_fact(app: &AppHandle, query: &str) -> Result<usize, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let mut facts = get_memory(app);
    let before = facts.len();
    let q = query.to_lowercase();
    facts.retain(|f| !f.to_lowercase().contains(&q));
    let removed = before - facts.len();
    store.set(MEMORY_KEY, serde_json::to_value(&facts).unwrap());
    store.save().map_err(|e| e.to_string())?;
    Ok(removed)
}

/// Returns a formatted memory block for injection into the system prompt,
/// or None if memory is empty.
pub fn memory_prompt_block(app: &AppHandle) -> Option<String> {
    let facts = get_memory(app);
    if facts.is_empty() { return None; }
    Some(format!(
        "USER MEMORY (persistent context about the user — use naturally):\n{}",
        facts.iter().map(|f| format!("• {f}")).collect::<Vec<_>>().join("\n")
    ))
}

// ── Reset / clean uninstall ─────────────────────────────────────────────────
/// Purge all Niro data: OS keychain entries, store keys, memory, tasks.
/// Called from the Settings "Reset all data" action and wired to NSIS uninstaller.
pub fn reset_all_data(app: &AppHandle) -> Result<(), String> {
    // 1. Delete all keychain entries (best-effort — ignore individual failures)
    for account in &["gemini_key", "gemini_extra_keys", "groq_key", "groq_extra_keys", "gmail_pass"] {
        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, account) {
            let _ = entry.delete_credential();
        }
    }
    // 2. Clear the store file
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    for key in &["providerConfig", "tasks", "chatHistory",
                 SCHEDULED_EMAILS_KEY, SCHEDULED_TASKS_KEY, MEMORY_KEY] {
        store.delete(key);
    }
    store.save().map_err(|e| e.to_string())
}
