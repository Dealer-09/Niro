// agent.rs — LLM Agent loop: Gemini + Groq, key rotation, tool execution
// Ported to full parity with electron-app/agent.js
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::Timelike;
use reqwest::Client;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::store::get_provider_config;
use crate::tools::{self, TimerMap, ToolResult};

// ── Abort flag ────────────────────────────────────────────────────────────
pub type AbortFlag = Arc<AtomicBool>;

pub fn new_abort_flag() -> AbortFlag {
    Arc::new(AtomicBool::new(false))
}

// Re-export ChatMessage from store (single source of truth)
pub use crate::store::ChatMessage;

// ── Event payloads ────────────────────────────────────────────────────────
#[derive(Serialize, Clone)] struct ChunkPayload  { text: String }
#[derive(Serialize, Clone)] struct ToolPayload   { name: String, input: Value }
#[derive(Serialize, Clone)] struct ErrorPayload  { message: String }
#[derive(Serialize, Clone)] struct DonePayload   {}

fn emit_chunk(app: &AppHandle, text: &str) {
    let _ = app.emit("agent:chunk", ChunkPayload { text: text.to_string() });
}
fn emit_tool(app: &AppHandle, name: &str, input: Value) {
    let _ = app.emit("agent:tool", ToolPayload { name: name.to_string(), input });
}
fn emit_error(app: &AppHandle, msg: &str) {
    let _ = app.emit("agent:error", ErrorPayload { message: msg.to_string() });
}
fn emit_done(app: &AppHandle) {
    let _ = app.emit("agent:done", DonePayload {});
}

// ── System prompt (matches Electron exactly) ──────────────────────────────
const SYSTEM_PROMPT: &str = r#"You are Niro, a Windows desktop AI assistant.

STRICT RULES — follow exactly:
1. Use tools to complete tasks. Never just describe what to do. Never say "I cannot".
2. After a tool returns a result, give the user the answer as text. STOP. Do not call more tools.
3. NEVER call show_notification unless the user explicitly says "notify me" or "show a notification".
4. Use open_app for apps, open_website for simple URLs, run_command for system info, set_timer for timers.
5. Use run_task ONLY for complex web interactions (filling forms, clicking buttons, logging in).
6. For "open X in browser" or "search for X on YouTube/Spotify/Google" — use open_website with the correct URL, NOT run_task.
7. You CAN answer general knowledge questions (dates, math, facts) WITHOUT using any tool.
8. For "calculate X and show in notification" — compute the answer yourself, then call show_notification with the RESULT only.
9. list_windows IS available — always use it when asked about open windows.
10. take_screenshot IS available — always use it when asked to see the screen.

WRITING TO APPS — use these tools:
- "Write/type/draft [text] in Notepad" → write_to_notepad(content, filename?)
- "Type [text] in [app]" → write_to_app(text, app)
- write_to_notepad ALWAYS opens Notepad with content pre-filled.
- write_to_app focuses the named window then types.
- type_text types at the current cursor without focusing any window.

EMAIL — use send_email tool:
- "Send an email" → send_email(to, subject, body)
- "Schedule an email" → send_email(to, subject, body, schedule_time="2:40 PM")

POWERSHELL COMMANDS:
- Public IP: (Invoke-RestMethod https://api.ipify.org)
- RAM total GB: [math]::Round((Get-WmiObject Win32_OperatingSystem).TotalVisibleMemorySize/1MB,2)
- RAM free GB: [math]::Round((Get-WmiObject Win32_OperatingSystem).FreePhysicalMemory/1MB,2)
- Disk C free GB: [math]::Round((Get-PSDrive C).Free/1GB,1)
- CPU: "$((Get-WmiObject Win32_Processor).Name) — $((Get-WmiObject Win32_Processor).NumberOfCores) cores"
- PC name: $env:COMPUTERNAME
- Windows ver: (Get-WmiObject Win32_OperatingSystem).Caption
- Uptime hours: [math]::Round(((Get-Date)-(gcim Win32_OperatingSystem).LastBootUpTime).TotalHours,1)

URL rules — use open_website:
- YouTube search: https://www.youtube.com/results?search_query=<query>
- Spotify search: https://open.spotify.com/search/<query>
- Google search: https://www.google.com/search?q=<query>
- GitHub repo: https://github.com/<owner>/<repo>

You are on Windows."#;

// ── Terminal tools — execute once then stop, never loop back to LLM ────────
// Matches Electron's TERMINAL_TOOLS set exactly
fn is_terminal_tool(name: &str) -> bool {
    matches!(name,
        "open_website" | "open_app" | "set_timer" | "show_notification" |
        "focus_window" | "close_app" | "press_key" | "type_text" |
        "mouse_click" | "write_to_notepad" | "write_to_app" | "save_task"
    )
}

// ── Browser keywords — only add browser tools when relevant ────────────────
fn has_browser_keywords(msg: &str) -> bool {
    let lower = msg.to_lowercase();
    lower.contains("automate") || lower.contains("browser agent") ||
    lower.contains("fill form") || lower.contains("log in") ||
    lower.contains("sign in to") || lower.contains("click on") ||
    lower.contains("scroll down") || lower.contains("scrape") ||
    lower.contains("extract from website") || lower.contains("interact with") ||
    lower.contains("google docs") || lower.contains("google sheets")
}

// ── Tool schemas ───────────────────────────────────────────────────────────
fn core_tool_schemas() -> Value {
    json!([
      { "name": "open_app", "description": "Open a Windows application by name. Examples: chrome, notepad, calculator, vscode, spotify.",
        "parameters": { "type": "object", "properties": { "app": { "type": "string" } }, "required": ["app"] } },
      { "name": "open_website", "description": "Open a URL in the default browser.",
        "parameters": { "type": "object", "properties": { "url": { "type": "string" } }, "required": ["url"] } },
      { "name": "run_command", "description": "Run a PowerShell command. Use for system info and read-only file operations. A safety guard blocks irreversible or dangerous commands (mass/recursive deletes, disk formatting, shutdown, disabling Defender/firewall, downloading-and-running remote scripts, registry edits, creating accounts/scheduled tasks) — never attempt those; tell the user to run them manually instead.",
        "parameters": { "type": "object", "properties": { "command": { "type": "string" } }, "required": ["command"] } },
      { "name": "set_timer",
        "description": "Set a countdown timer. CRITICAL: '10 seconds' → seconds:10, minutes:0. '5 minutes' → minutes:5, seconds:0. DO NOT call show_notification after.",
        "parameters": { "type": "object", "properties": {
          "label":   { "type": "string" },
          "minutes": { "type": "number" },
          "seconds": { "type": "number" }
        }, "required": ["label"] } },
      { "name": "show_notification", "description": "Show a Windows desktop notification. Short title (3-5 words). Only call when user explicitly asks.",
        "parameters": { "type": "object", "properties": {
          "title":   { "type": "string" },
          "message": { "type": "string" }
        }, "required": ["title", "message"] } },
      { "name": "take_screenshot", "description": "Take a screenshot of the screen.",
        "parameters": { "type": "object", "properties": {}, "required": [] } },
      { "name": "search_files", "description": "Search for files by name or extension on disk.",
        "parameters": { "type": "object", "properties": {
          "query":     { "type": "string" },
          "directory": { "type": "string" }
        }, "required": ["query"] } },
      { "name": "type_text", "description": "Type text at the current cursor position.",
        "parameters": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] } },
      { "name": "write_to_notepad", "description": "Open Notepad pre-filled with text.",
        "parameters": { "type": "object", "properties": {
          "content":  { "type": "string" },
          "filename": { "type": "string" }
        }, "required": ["content"] } },
      { "name": "write_to_app", "description": "Type text into a specific open app window. App must already be running.",
        "parameters": { "type": "object", "properties": {
          "text":     { "type": "string" },
          "app":      { "type": "string" },
          "delay_ms": { "type": "number" }
        }, "required": ["text", "app"] } },
      { "name": "press_key", "description": "Press a keyboard key or shortcut. Always lowercase.",
        "parameters": { "type": "object", "properties": { "key": { "type": "string" } }, "required": ["key"] } },
      { "name": "mouse_click", "description": "Click at screen coordinates.",
        "parameters": { "type": "object", "properties": { "x": { "type": "number" }, "y": { "type": "number" } }, "required": ["x", "y"] } },
      { "name": "list_windows", "description": "List all open windows.",
        "parameters": { "type": "object", "properties": {}, "required": [] } },
      { "name": "focus_window", "description": "Bring a window to the foreground by partial title.",
        "parameters": { "type": "object", "properties": { "title": { "type": "string" } }, "required": ["title"] } },
      { "name": "close_app", "description": "Close a running app by process name. Lowercase, no .exe.",
        "parameters": { "type": "object", "properties": { "name": { "type": "string" } }, "required": ["name"] } },
      { "name": "send_email", "description": "Send an email via Gmail SMTP.",
        "parameters": { "type": "object", "properties": {
          "to":            { "type": "string" },
          "subject":       { "type": "string" },
          "body":          { "type": "string" },
          "schedule_time": { "type": "string" }
        }, "required": ["to", "subject", "body"] } },
      { "name": "save_task", "description": "Save a quick-access task shortcut to the panel.",
        "parameters": { "type": "object", "properties": {
          "name":        { "type": "string" },
          "instruction": { "type": "string" }
        }, "required": ["name", "instruction"] } }
    ])
}

fn browser_tool_schemas() -> Value {
    json!([
      { "name": "browser_open",  "description": "Open a URL in the controlled browser for automation.",
        "parameters": { "type": "object", "properties": { "url": { "type": "string" } }, "required": ["url"] } },
      { "name": "browser_click", "description": "Click an element in the browser by text or selector.",
        "parameters": { "type": "object", "properties": {
          "text": { "type": "string" }, "selector": { "type": "string" }
        }, "required": [] } },
      { "name": "browser_type",  "description": "Type into an input field in the browser.",
        "parameters": { "type": "object", "properties": {
          "selector": { "type": "string" }, "text": { "type": "string" }
        }, "required": ["selector", "text"] } },
      { "name": "browser_read",  "description": "Read text content from the current browser page.",
        "parameters": { "type": "object", "properties": { "selector": { "type": "string" } }, "required": [] } },
      { "name": "browser_close", "description": "Close the controlled browser session.",
        "parameters": { "type": "object", "properties": {}, "required": [] } }
    ])
}

/// Build Groq tool list: excludes take_screenshot + show_notification,
/// adds browser tools only if message has browser keywords.
/// Matches Electron's getGroqTools(message) exactly.
fn groq_tools(message: &str) -> Value {
    let core = core_tool_schemas();
    let mut tools: Vec<Value> = core.as_array().unwrap()
        .iter()
        .filter(|t| {
            let name = t["name"].as_str().unwrap_or("");
            name != "take_screenshot" && name != "show_notification"
        })
        .map(|t| json!({ "type": "function", "function": t }))
        .collect();

    if has_browser_keywords(message) {
        let browser = browser_tool_schemas();
        for t in browser.as_array().unwrap() {
            tools.push(json!({ "type": "function", "function": t }));
        }
    }
    json!(tools)
}

/// All tools for Gemini (including screenshot).
fn gemini_tool_schemas() -> Value {
    let mut all: Vec<Value> = core_tool_schemas().as_array().unwrap().to_vec();
    all.extend(browser_tool_schemas().as_array().unwrap().to_vec());
    json!([{ "functionDeclarations": all }])
}

// ── Execute tool ──────────────────────────────────────────────────────────
async fn execute_tool(app: &AppHandle, timers: &TimerMap, abort: &AbortFlag, name: &str, args: &Value) -> ToolResult {
    let s = |k: &str| args[k].as_str().unwrap_or("").to_string();
    let n = |k: &str| args[k].as_f64().unwrap_or(0.0);

    match name {
        "open_app"          => tools::open_app(&s("app")),
        "open_website"      => tools::open_website(app, &s("url")),
        "run_command"       => {
            // Safety guard: screen the LLM-supplied command against the
            // irreversible / RCE / security-disabling denylist before running.
            let command = s("command");
            match tools::screen_command(&command) {
                // Abortable: stopping the agent kills the child process instead
                // of waiting for a slow PowerShell command to finish on its own.
                Ok(()) => tools::run_command_abortable(&command, abort).await,
                Err(reason) => ToolResult::err(format!(
                    "🛡️ Blocked by Niro's safety guard: this command could {reason}. \
                     For safety the agent won't run it automatically — if you really \
                     intend this, run it yourself in a terminal."
                )),
            }
        }
        "show_notification" => tools::show_notification(app, &s("title"), &s("message")),
        "take_screenshot"   => tools::take_screenshot(),
        "search_files"      => {
            let dir = args["directory"].as_str().map(str::to_string);
            tools::search_files(&s("query"), dir.as_deref())
        }
        "type_text"         => tools::type_text(&s("text")),
        "write_to_notepad"  => {
            let fname = args["filename"].as_str().map(str::to_string);
            tools::write_to_notepad(&s("content"), fname.as_deref())
        }
        "write_to_app"      => tools::write_to_app(&s("text"), &s("app"), n("delay_ms") as u64),
        "press_key"         => tools::press_key(&s("key")),
        "mouse_click"       => tools::mouse_click(n("x") as i32, n("y") as i32),
        "list_windows"      => tools::list_windows(),
        "focus_window"      => tools::focus_window(&s("title")),
        "close_app"         => tools::close_app(&s("name")),
        "set_timer" => tools::set_timer(
            app.clone(), timers.clone(), s("label"), n("minutes"), n("seconds"),
        ),
        "send_email" => {
            let cfg = get_provider_config(app);
            let sched = args["schedule_time"].as_str().map(str::to_string);
            tools::send_email(
                app,
                &s("to"), &s("subject"), &s("body"),
                &cfg.gmail_user, &cfg.gmail_pass, sched.as_deref(),
            ).await
        }
        "save_task" => {
            match crate::commands::save_task_inner(app, s("name"), s("instruction")) {
                Ok(_)  => ToolResult::ok(format!("Task '{}' saved.", s("name"))),
                Err(e) => ToolResult::err(e),
            }
        }
        "browser_open"  => crate::browser::browser_open(&s("url")).await,
        "browser_click" => crate::browser::browser_click(
            args["selector"].as_str(), args["text"].as_str(),
        ).await,
        "browser_type"  => crate::browser::browser_type(&s("selector"), &s("text")).await,
        "browser_read"  => crate::browser::browser_read(args["selector"].as_str()).await,
        "browser_close" => crate::browser::browser_close().await,
        _ => ToolResult::err(format!("Unknown tool: {name}")),
    }
}

// ── Groq agent loop ───────────────────────────────────────────────────────
// Full parity with Electron runGroqAgent() including all direct intercepts.
pub async fn run_groq_agent(
    app: &AppHandle,
    timers: &TimerMap,
    client: &Client,
    message: String,
    history: Vec<ChatMessage>,
    abort: AbortFlag,
) {
    let cfg = get_provider_config(app);
    let all_keys: Vec<String> = std::iter::once(cfg.groq_key.clone())
        .chain(cfg.groq_extra_keys.iter().cloned())
        .filter(|k| !k.is_empty())
        .collect();

    if all_keys.is_empty() {
        emit_error(app, "No Groq API key configured. Open ⚙️ Settings and add your API key.");
        return;
    }

    let msg = &message;

    // ── 1. Screenshot short-circuit (Groq can't process images) ───────────
    if regex_test(msg, r"screenshot|what('s| is) on (my )?screen|what do you see") {
        let reply = "📸 Screenshot requires Gemini (vision model). Switch to Gemini in ⚙️ Settings.";
        emit_chunk(app, reply);
        emit_done(app);
        return;
    }

    // ── 2. Spotify intercept ───────────────────────────────────────────────
    if regex_test(msg, r"(?i)\bspotify\b.*(play|search|open)|(play|search).*\bspotify\b") {
        let query = extract_spotify_query(msg);
        let url = if query.is_empty() {
            "https://open.spotify.com".to_string()
        } else {
            format!("https://open.spotify.com/search/{}", url_encode(&query))
        };
        emit_tool(app, "open_website", json!({ "url": url }));
        tools::open_website(app, &url);
        let reply = format!("Opened Spotify{}.",
            if query.is_empty() { String::new() } else { format!(" and searched for \"{}\"", query) });
        emit_chunk(app, &reply);
        emit_done(app);
        return;
    }

    // ── 3. YouTube search intercept ────────────────────────────────────────
    if regex_test(msg, r"(?i)(search|look up).*(on|in)\s+youtube|youtube.*(search|look up)") {
        let query = extract_yt_query(msg);
        let url = if query.is_empty() {
            "https://www.youtube.com".to_string()
        } else {
            format!("https://www.youtube.com/results?search_query={}", url_encode(&query))
        };
        emit_tool(app, "open_website", json!({ "url": url }));
        tools::open_website(app, &url);
        let reply = format!("Opened YouTube{}.",
            if query.is_empty() { String::new() } else { format!(" and searched for \"{}\"", query) });
        emit_chunk(app, &reply);
        emit_done(app);
        return;
    }

    // ── 4. Google search intercept ─────────────────────────────────────────
    if regex_test(msg, r"(?i)(search|look up).*(on|in)\s+google|google.*(search|look up)") {
        let query = extract_google_query(msg);
        let url = if query.is_empty() {
            "https://www.google.com".to_string()
        } else {
            format!("https://www.google.com/search?q={}", url_encode(&query))
        };
        emit_tool(app, "open_website", json!({ "url": url }));
        tools::open_website(app, &url);
        let reply = format!("Opened Google{}.",
            if query.is_empty() { String::new() } else { format!(" and searched for \"{}\"", query) });
        emit_chunk(app, &reply);
        emit_done(app);
        return;
    }

    // ── 5. GitHub repo intercept ───────────────────────────────────────────
    if regex_test(msg, r"(?i)\bgithub\b") {
        if let Some(repo) = extract_github_repo(msg) {
            let url = format!("https://github.com/{repo}");
            emit_tool(app, "open_website", json!({ "url": url }));
            tools::open_website(app, &url);
            emit_chunk(app, &format!("Opened {url}"));
            emit_done(app);
            return;
        }
    }

    // ── 6a. Notification intercept (not a timer request) ──────────────────
    // Matches Electron lines 822-850: extracts quoted text and fires directly
    let is_timer_request = regex_test(msg, r"(?i)\b(set|start|create)\b.*\btimer\b|\btimer\b.*\b(for|of)\b");
    if !is_timer_request && regex_test(msg, r"(?i)\b(show|send|display|give me|pop up)\b.*\bnotification\b|\bnotif(y|ication)\b.*\bsaying\b") {
        let notif_text = extract_notification_text(msg);
        emit_tool(app, "show_notification", json!({ "title": "Niro", "message": notif_text }));
        tools::show_notification(app, "Niro", &notif_text);
        let reply = format!("Notification shown: \"{notif_text}\"");
        emit_chunk(app, &reply);
        emit_done(app);
        return;
    }

    // ── 6. Multi-part sysinfo intercept ───────────────────────────────────
    let wants_ip     = regex_test(msg, r"(?i)\b(public\s+)?ip(\s+address)?\b");
    let wants_name   = regex_test(msg, r"(?i)\b(computer|pc|machine|host)\s*name\b");
    let wants_win    = regex_test(msg, r"(?i)\bwindows\s*(version|ver)\b|\bos\s*version\b");
    let wants_cpu    = regex_test(msg, r"(?i)\b(cpu|processor)\b");
    let wants_ram    = regex_test(msg, r"(?i)\bhow much\s+(ram|memory)\b|\b(ram|memory)\s+(do i have|is free|total|available)\b");
    let wants_disk   = regex_test(msg, r"(?i)\b(disk|drive|storage|space)\b");
    let wants_uptime = regex_test(msg, r"(?i)\buptime\b");
    let multi_count  = [wants_ip, wants_name, wants_win, wants_cpu, wants_ram, wants_disk, wants_uptime]
        .iter().filter(|&&x| x).count();

    if multi_count >= 2 {
        let reply = run_sysinfo_batch(app, timers, &abort, wants_ip, wants_name, wants_win, wants_cpu, wants_ram, wants_disk, wants_uptime).await;
        emit_chunk(app, &reply);
        emit_done(app);
        return;
    }

    // ── 7. DIRECT_COMMANDS intercepts (single metric) ─────────────────────
    // Guard: skip intercepts for very complex multi-part queries (3+ "and"s)
    // Matches Electron's isMultiPartQuery check exactly
    let is_multi_part = msg.to_lowercase().split(" and ").count() > 3;
    if !is_multi_part {
        let direct = try_direct_command(app, timers, &abort, msg).await;
        if let Some(reply) = direct {
            emit_chunk(app, &reply);
            emit_done(app);
            return;
        }
    }

    // ── 8. File search intercept ───────────────────────────────────────────
    if regex_test(msg, r"(?i)\b(find|search|look for|locate)\b.*\bfile[s]?\b|\bfile[s]?\b.*\b(find|search|on desktop|in downloads|in documents)\b") {
        if let Some(reply) = try_file_search(app, timers, &abort, msg).await {
            emit_chunk(app, &reply);
            emit_done(app);
            return;
        }
    }

    // ── 9. LLM loop (only reached if no intercept matched) ────────────────
    let model = &cfg.groq_model;
    let tools = groq_tools(msg);

    let mut messages: Vec<Value> = vec![json!({ "role": "system", "content": SYSTEM_PROMPT })];
    for m in history.iter().rev().take(4).rev() {
        messages.push(json!({ "role": m.role, "content": m.content }));
    }
    messages.push(json!({ "role": "user", "content": message }));

    let mut key_index = 0usize;
    let mut max_iter = 10u32;
    let mut tool_rounds = 0u32;

    'outer: while max_iter > 0 && !abort.load(Ordering::Relaxed) {
        max_iter -= 1;

        let api_key = &all_keys[key_index];
        let body = json!({
            "model": model,
            "messages": messages,
            "tools": tools,
            "tool_choice": "auto",
            "parallel_tool_calls": false,
            "max_tokens": 1024,
            "temperature": 0.2
        });

        let resp = match client
            .post("https://api.groq.com/openai/v1/chat/completions")
            .bearer_auth(api_key)
            .json(&body)
            .timeout(Duration::from_secs(30))
            .send().await
        {
            Ok(r) => r,
            Err(e) => { emit_error(app, &format!("Groq request failed: {e}")); return; }
        };

        let status = resp.status();
        let json: Value = match resp.json().await {
            Ok(j) => j,
            Err(e) => { emit_error(app, &format!("Groq parse error: {e}")); return; }
        };

        if status == 429 {
            key_index += 1;
            if key_index < all_keys.len() {
                emit_chunk(app, "⏳ Rate limit hit, switching to backup key...");
                max_iter += 1;
                continue 'outer;
            }
            emit_chunk(app, "⏳ Rate limit hit, retrying in 15s...");
            tokio::time::sleep(Duration::from_secs(15)).await;
            if abort.load(Ordering::Relaxed) { return; }
            key_index = 0; max_iter += 1;
            continue 'outer;
        }

        if !status.is_success() {
            emit_error(app, &format!("Groq error {status}: {}", json["error"]["message"].as_str().unwrap_or("unknown")));
            return;
        }

        let choice = &json["choices"][0];
        let assistant_msg = &choice["message"];
        messages.push(assistant_msg.clone());

        if let Some(tool_calls) = assistant_msg["tool_calls"].as_array() {
            if !tool_calls.is_empty() {
                // Safety cap: max 2 tool rounds (matches Electron)
                tool_rounds += 1;
                if tool_rounds > 2 {
                    let last = messages.iter().rev()
                        .find(|m| m["role"] == "tool")
                        .and_then(|m| m["content"].as_str())
                        .unwrap_or("Done.")
                        .to_string();
                    emit_chunk(app, &last);
                    emit_done(app);
                    return;
                }

                for tc in tool_calls {
                    if abort.load(Ordering::Relaxed) { break; }
                    let tool_name = tc["function"]["name"].as_str().unwrap_or("unknown");
                    let tool_args: Value = serde_json::from_str(
                        tc["function"]["arguments"].as_str().unwrap_or("{}")
                    ).unwrap_or(json!({}));

                    emit_tool(app, tool_name, tool_args.clone());
                    let result = execute_tool(app, timers, &abort, tool_name, &tool_args).await;

                    let content = if result.is_image.unwrap_or(false) {
                        "Screenshot taken. Image analysis not available on Groq — use Gemini.".to_string()
                    } else {
                        // Truncate by CHARS, not bytes — slicing &raw[..500] panics if byte
                        // 500 lands mid-codepoint (any non-ASCII tool output), and panic=abort
                        // in release would crash the whole app.
                        let raw = &result.result;
                        if raw.chars().count() > 500 {
                            format!("{}...(truncated)", raw.chars().take(500).collect::<String>())
                        } else {
                            raw.clone()
                        }
                    };

                    // Terminal tool: return immediately, no LLM round-trip (matches Electron)
                    if is_terminal_tool(tool_name) {
                        emit_chunk(app, &content);
                        emit_done(app);
                        return;
                    }

                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": tc["id"],
                        "content": content
                    }));
                }
                continue 'outer;
            }
        }

        if let Some(text) = assistant_msg["content"].as_str() {
            if !text.is_empty() { emit_chunk(app, text); }
        }
        break 'outer;
    }

    emit_done(app);
}

// ── Regex cache — compile each pattern once, reuse forever ─────────────────
// Before: ~40 regex compilations per agent call. After: 0 (except first run).
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::collections::HashMap;

static REGEX_CACHE: Lazy<Mutex<HashMap<String, Arc<regex::Regex>>>> =
    Lazy::new(|| Mutex::new(HashMap::with_capacity(32)));

/// Fetch a compiled regex from the shared cache, compiling+inserting on miss.
/// Returns None only if the pattern itself is invalid. Used by both regex_test
/// and the capture-based extractor helpers so none of them recompile per call.
fn cached_regex(pattern: &str) -> Option<Arc<regex::Regex>> {
    if let Some(re) = REGEX_CACHE.lock().get(pattern) {
        return Some(re.clone());
    }
    let re = Arc::new(regex::Regex::new(pattern).ok()?);
    REGEX_CACHE.lock().insert(pattern.to_string(), re.clone());
    Some(re)
}

fn regex_test(text: &str, pattern: &str) -> bool {
    cached_regex(pattern).map_or(false, |re| re.is_match(text))
}

// ── URL encode — proper UTF-8 percent encoding ─────────────────────────────
fn url_encode(s: &str) -> String {
    // form_urlencoded is a transitive dep of reqwest — no extra crate needed
    form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

// ── Groq helper: query extractors ─────────────────────────────────────────
fn extract_spotify_query(msg: &str) -> String {
    cached_regex(r"(?i)\bplay\s+(.+?)(?:\s+by\s+(.+?))?(?:\s+on\s+spotify)?$")
        .and_then(|r| r.captures(msg))
        .map(|c| {
            let song = c.get(1).map_or("", |m| m.as_str());
            let artist = c.get(2).map_or("", |m| m.as_str());
            if artist.is_empty() { song.trim().to_string() } else { format!("{} {}", song.trim(), artist.trim()) }
        })
        .or_else(|| {
            cached_regex(r"(?i)\bsearch\s+(?:for\s+)?(.+?)\s+(?:on\s+)?spotify")
                .and_then(|r| r.captures(msg))
                .map(|c| c.get(1).map_or("", |m| m.as_str()).trim().to_string())
        })
        .unwrap_or_default()
}

fn extract_yt_query(msg: &str) -> String {
    cached_regex(r"(?i)\bsearch\s+(?:for\s+)?(.+?)\s+(?:on|in)\s+youtube")
        .and_then(|r| r.captures(msg))
        .or_else(|| {
            cached_regex(r"(?i)\byoutube\b.*\bsearch\s+(?:for\s+)?(.+)")
                .and_then(|r| r.captures(msg))
        })
        .map(|c| c.get(1).map_or("", |m| m.as_str()).trim().to_string())
        .unwrap_or_default()
}

fn extract_google_query(msg: &str) -> String {
    cached_regex(r"(?i)\bsearch\s+(?:for\s+)?(.+?)\s+(?:on|in)\s+google")
        .and_then(|r| r.captures(msg))
        .or_else(|| {
            cached_regex(r"(?i)\bgoogle\b.*\bsearch\s+(?:for\s+)?(.+)")
                .and_then(|r| r.captures(msg))
        })
        .map(|c| c.get(1).map_or("", |m| m.as_str()).trim().to_string())
        .unwrap_or_default()
}

fn extract_github_repo(msg: &str) -> Option<String> {
    // 1. Explicit github.com/<owner>/<repo> URL — always trustworthy.
    if let Some(c) = cached_regex(r"(?i)github\.com/([\w.-]+)/([\w.-]+)")
        .and_then(|r| r.captures(msg))
    {
        return Some(format!("{}/{}", &c[1], &c[2]));
    }

    // 2. Bare "<owner>/<repo>" is ambiguous (matches "CI/CD", "TCP/IP", "and/or",
    //    file paths…). Only treat it as a repo when the user clearly wants to
    //    navigate, and skip well-known acronym pairs.
    if !regex_test(msg, r"(?i)\b(open|clone|go to|goto|visit|launch|show)\b") {
        return None;
    }
    const DENY: &[&str] = &[
        "ci/cd", "and/or", "tcp/ip", "http/https", "n/a", "i/o", "w/o", "24/7",
        "km/h", "either/or", "read/write", "input/output",
    ];
    let re = cached_regex(r"\b([A-Za-z0-9][\w.-]*)/([A-Za-z0-9][\w.-]*)\b")?;
    for c in re.captures_iter(msg) {
        let pair = format!("{}/{}", c[1].to_lowercase(), c[2].to_lowercase());
        if DENY.contains(&pair.as_str()) {
            continue;
        }
        return Some(format!("{}/{}", &c[1], &c[2]));
    }
    None
}

// Extract notification text from user message — matches Electron's logic exactly:
// 1. Prefer quoted text: "say 'hello'" or "saying \"hello\""
// 2. Fall back to text after "saying "
// 3. Strip common notification keywords from the message
fn extract_notification_text(msg: &str) -> String {
    // Quoted text (single or double quotes)
    if let Some(caps) = cached_regex(r#"["']([^"']+)["']"#)
        .and_then(|r| r.captures(msg)) {
        return caps.get(1).map_or("", |m| m.as_str()).to_string();
    }
    // "saying X" pattern
    if let Some(caps) = cached_regex(r"(?i)\bsaying\s+(.+?)$")
        .and_then(|r| r.captures(msg)) {
        return caps.get(1).map_or("", |m| m.as_str()).trim().to_string();
    }
    // Strip notification keywords and return what's left
    cached_regex(r"(?i)(show|send|display|give me|pop up)\s+(a\s+)?notification(\s+saying)?")
        .map(|r| r.replace_all(msg, "").trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Done".to_string())
}

// ── Direct command table (matches Electron DIRECT_COMMANDS) ───────────────
async fn try_direct_command(app: &AppHandle, timers: &TimerMap, abort: &AbortFlag, msg: &str) -> Option<String> {
    struct Cmd { pattern: &'static str, command: &'static str, prefix: &'static str }
    let cmds = [
        Cmd { pattern: r"(?i)\b(public\s+)?ip(\s+address)?\b",
              command: "(Invoke-RestMethod https://api.ipify.org)",
              prefix: "Your public IP address is " },
        Cmd { pattern: r"(?i)\b(disk|drive|storage|space)\b",
              command: "[math]::Round((Get-PSDrive C).Free/1GB,1)",
              prefix: "C drive has " },
        Cmd { pattern: r"(?i)\b(computer|pc|machine|host)\s*name\b",
              command: "$env:COMPUTERNAME",
              prefix: "Your computer name is " },
        Cmd { pattern: r"(?i)\b(cpu|processor)\b",
              command: r#""" + (Get-WmiObject Win32_Processor).Name + " — " + (Get-WmiObject Win32_Processor).NumberOfCores + " cores""#,
              prefix: "Your CPU: " },
        Cmd { pattern: r"(?i)\bwindows\s*(version|ver)\b|\bos\s*version\b",
              command: "(Get-WmiObject Win32_OperatingSystem).Caption",
              prefix: "Your Windows version is: " },
        // Top processes by CPU (Electron line 374-378)
        Cmd { pattern: r"(?i)\b(top|running)\s*(processes|apps|programs)\b.*\bcpu\b|\bcpu\b.*\b(processes|apps)\b",
              command: r#"Get-Process | Sort-Object CPU -Desc | Select-Object -First 10 Name,@{N="CPU(s)";E={[math]::Round($_.CPU,1)}} | Format-Table -Auto | Out-String -Width 200"#,
              prefix: "Top processes by CPU:\n" },
        // Top processes by memory (Electron line 380-384)
        Cmd { pattern: r"(?i)\b(top|most)\s*\d*\s*(processes|apps|programs)\b.*\bmemory\b|\bmemory\b.*\b(processes|apps)\b|\bprocesses.*ram\b|\bram.*processes\b",
              command: r#"Get-Process | Sort-Object WorkingSet -Desc | Select-Object -First 10 Name,@{N="RAM(MB)";E={[math]::Round($_.WorkingSet/1MB,1)}} | Format-Table -Auto | Out-String -Width 200"#,
              prefix: "Top processes by memory:\n" },
    ];

    for cmd in &cmds {
        if regex_test(msg, cmd.pattern) {
            emit_tool(app, "run_command", json!({ "command": cmd.command }));
            let result = execute_tool(app, timers, abort, "run_command",
                &json!({ "command": cmd.command })).await;
            return Some(if result.success {
                format!("{}{}", cmd.prefix, result.result.trim())
            } else {
                format!("Failed: {}", result.result)
            });
        }
    }
    None
}

// ── Sysinfo batch (matches Electron multi-info batching) ──────────────────
async fn run_sysinfo_batch(
    app: &AppHandle, timers: &TimerMap, abort: &AbortFlag,
    ip: bool, name: bool, win: bool, cpu: bool, ram: bool, disk: bool, uptime: bool
) -> String {
    let mut cmds: Vec<&str> = vec![];
    let mut parts: Vec<&str> = vec![];

    if ip    { cmds.push("$ip=(Invoke-RestMethod https://api.ipify.org)"); parts.push("\"IP: \" + $ip"); }
    if name  { cmds.push("$name=$env:COMPUTERNAME"); parts.push("\"Computer: \" + $name"); }
    if win   { cmds.push("$win=(Get-WmiObject Win32_OperatingSystem).Caption"); parts.push("\"OS: \" + $win"); }
    if cpu   { cmds.push("$cpu=(Get-WmiObject Win32_Processor).Name + \" — \" + (Get-WmiObject Win32_Processor).NumberOfCores + \" cores\""); parts.push("\"CPU: \" + $cpu"); }
    if ram   { cmds.push("$total=[math]::Round((Get-WmiObject Win32_OperatingSystem).TotalVisibleMemorySize/1MB,2); $free=[math]::Round((Get-WmiObject Win32_OperatingSystem).FreePhysicalMemory/1MB,2)"); parts.push("\"RAM: \" + $total + \"GB total, \" + $free + \"GB free\""); }
    if disk  { cmds.push("$df=[math]::Round((Get-PSDrive C).Free/1GB,1); $dt=[math]::Round(((Get-PSDrive C).Used+(Get-PSDrive C).Free)/1GB,1)"); parts.push("\"Disk C: \" + $df + \"GB free of \" + $dt + \"GB\""); }
    if uptime{ cmds.push("$up=[math]::Round(((Get-Date)-(gcim Win32_OperatingSystem).LastBootUpTime).TotalHours,1)"); parts.push("\"Uptime: \" + $up + \" hours\""); }

    let joined_parts = parts.join("; \" | \"; ");
    let full_cmd = format!("{}; {}", cmds.join("; "), joined_parts);
    emit_tool(app, "run_command", json!({ "command": "system info" }));
    let result = execute_tool(app, timers, abort, "run_command", &json!({ "command": full_cmd })).await;
    if result.success { result.result.trim().to_string() } else { format!("Failed: {}", result.result) }
}

// ── File search intercept ─────────────────────────────────────────────────
// Matches Electron lines 889-945: search, open first file, show notification combo
async fn try_file_search(app: &AppHandle, timers: &TimerMap, abort: &AbortFlag, msg: &str) -> Option<String> {
    let ext_re = cached_regex(r"(?i)\b(pdf|docx?|txt|xlsx?|png|jpg|jpeg|mp4|mp3|zip)\b")?;
    let name_re = cached_regex(r#"(?i)\bnamed?\s+["']?([^\s"']+)["']?"#)?;
    let ext_match = ext_re.captures(msg);
    let name_match = name_re.captures(msg);
    if ext_match.is_none() && name_match.is_none() { return None; }

    let query = if let Some(n) = &name_match {
        n.get(1).map_or("", |m| m.as_str()).to_string()
    } else {
        format!(".{}", ext_match.as_ref().unwrap().get(1).map_or("", |m| m.as_str()))
    };

    let userprofile = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\Users".into());
    let dir = if msg.to_lowercase().contains("desktop") {
        format!("{userprofile}\\Desktop")
    } else if msg.to_lowercase().contains("download") {
        format!("{userprofile}\\Downloads")
    } else if msg.to_lowercase().contains("document") {
        format!("{userprofile}\\Documents")
    } else {
        userprofile
    };

    emit_tool(app, "search_files", json!({ "query": query, "directory": dir }));
    let result = execute_tool(app, timers, abort, "search_files", &json!({ "query": query, "directory": dir })).await;

    if !result.success || result.result.contains("No files found") {
        return Some(format!("No files found matching \"{}\" in {}.", query,
            dir.split('\\').last().unwrap_or(&dir)));
    }

    // Check if user wants to open the first file found (Electron lines 908-939)
    let wants_open = regex_test(msg, r"(?i)\bopen\b.*\b(first|it|the file)\b|\b(first|it)\b.*\bopen\b");
    let wants_notify = regex_test(msg, r"(?i)\bnotif(y|ication)\b|\bshow.*notification\b");

    // Extract first file path from results
    let first_file = result.result.lines()
        .find(|l| l.trim().len() > 2 && l.trim().chars().nth(1) == Some(':'))
        .map(|l| l.trim().split("  ").next().unwrap_or(l.trim()).to_string());

    if wants_open {
        if let Some(ref fpath) = first_file {
            let open_cmd = format!("notepad \"{}\"", fpath);
            emit_tool(app, "open_app", json!({ "app": open_cmd }));
            tools::open_app(&open_cmd);

            if wants_notify {
                // Wait for notepad to open, then fire notification (Electron line 928)
                tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                let notif_text = cached_regex(r#"(?i)notification\s+saying\s+["']?([^"']+?)["']?\s*$"#)
                    .and_then(|r| r.captures(msg))
                    .map(|c| c.get(1).map_or("File opened", |m| m.as_str()).to_string())
                    .unwrap_or_else(|| "File opened".to_string());
                emit_tool(app, "show_notification", json!({ "title": "Niro", "message": notif_text }));
                tools::show_notification(app, "Niro", &notif_text);
                return Some(format!("Opened \"{}\" in Notepad and showed notification: \"{}\"", fpath, notif_text));
            }
            return Some(format!("Opened \"{}\" in Notepad.", fpath));
        }
    }

    Some(format!("Found files matching \"{}\":\n{}", query, result.result))
}

// ── GEMINI agent loop ─────────────────────────────────────────────────────
pub async fn run_gemini_agent(
    app: &AppHandle,
    timers: &TimerMap,
    client: &Client,
    message: String,
    history: Vec<ChatMessage>,
    abort: AbortFlag,
) {
    let cfg = get_provider_config(app);
    let all_keys: Vec<String> = std::iter::once(cfg.gemini_key.clone())
        .chain(cfg.gemini_extra_keys.iter().cloned())
        .filter(|k| !k.is_empty())
        .collect();

    if all_keys.is_empty() {
        emit_error(app, "No Gemini API key configured. Open ⚙️ Settings and add your API key.");
        return;
    }

    let msg = &message;
    let wants_ip     = regex_test(msg, r"(?i)\b(public\s+)?ip(\s+address)?\b");
    let wants_name   = regex_test(msg, r"(?i)\b(computer|pc|machine|host)\s*name\b");
    let wants_win    = regex_test(msg, r"(?i)\bwindows\s*(version|ver)\b|\bos\s*version\b");
    let wants_cpu    = regex_test(msg, r"(?i)\b(cpu|processor)\b");
    let wants_ram    = regex_test(msg, r"(?i)\bhow much\s+(ram|memory)\b|\b(ram|memory)\s+(do i have|is free|total|available)\b");
    let wants_disk   = regex_test(msg, r"(?i)\b(disk|drive|storage|space)\b");
    let wants_uptime = regex_test(msg, r"(?i)\buptime\b");
    let multi_count  = [wants_ip, wants_name, wants_win, wants_cpu, wants_ram, wants_disk, wants_uptime]
        .iter().filter(|&&x| x).count();

    if multi_count >= 2 || wants_ram {
        let reply = run_sysinfo_batch(app, timers, &abort, wants_ip, wants_name, wants_win, wants_cpu, wants_ram, wants_disk, wants_uptime).await;
        let final_reply = if wants_ram && multi_count == 1 {
            cached_regex(r"RAM:\s*([\d.]+)GB total,\s*([\d.]+)GB free")
                .and_then(|r| r.captures(&reply))
                .map(|c| format!("You have {} GB of RAM in total, and {} GB is free.",
                    c.get(1).map_or("?", |m| m.as_str()),
                    c.get(2).map_or("?", |m| m.as_str())))
                .unwrap_or(reply)
        } else { reply };
        emit_chunk(app, &final_reply);
        emit_done(app);
        return;
    }

    let mut key_index = 0usize;
    let model = &cfg.gemini_model;
    let tool_schemas = gemini_tool_schemas();

    let mut contents: Vec<Value> = history.iter()
        .map(|m| json!({
            "role": if m.role == "assistant" { "model" } else { "user" },
            "parts": [{ "text": m.content }]
        }))
        .collect();
    contents.push(json!({ "role": "user", "parts": [{ "text": message }] }));

    let mut max_iter = 10u32;

    'outer: while max_iter > 0 && !abort.load(Ordering::Relaxed) {
        max_iter -= 1;

        let api_key = &all_keys[key_index];
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
        );
        let body = json!({
            "systemInstruction": { "parts": [{ "text": SYSTEM_PROMPT }] },
            "contents": contents,
            "tools": tool_schemas,
            "generationConfig": { "temperature": 0.2, "maxOutputTokens": 8192 }
        });

        let resp = match client.post(&url).json(&body)
            .timeout(Duration::from_secs(30)).send().await {
            Ok(r) => r,
            Err(e) => { emit_error(app, &format!("Gemini request failed: {e}")); return; }
        };

        let status = resp.status();
        let json: Value = match resp.json().await {
            Ok(j) => j,
            Err(e) => { emit_error(app, &format!("Gemini parse error: {e}")); return; }
        };

        if status == 429 || json["error"]["code"].as_u64() == Some(429) {
            let err_msg = json["error"]["message"].as_str().unwrap_or("");
            let is_daily = err_msg.contains("PerDay") || err_msg.contains("per_day") || err_msg.contains("GenerateRequestsPerDay");

            // Always try rotating to the next key first — per-minute 429s
            // are the most common rate limit, and backup keys are useless
            // if we only rotate on daily limits.
            key_index += 1;
            if key_index < all_keys.len() {
                emit_chunk(app, "⏳ Rate limit hit, switching to backup key...");
                max_iter += 1;
                continue 'outer;
            }

            // All keys exhausted — for daily limits, give up with a clear
            // message; for per-minute limits, wait then reset to key 0.
            if is_daily {
                let hours_left = 24u32.saturating_sub(chrono::Local::now().hour());
                emit_error(app, &format!(
                    "⚠️ All Gemini API keys have reached their daily limit.\nQuota resets in ~{hours_left}h.\n💡 Add more keys in ⚙️ Settings or switch to Groq."
                ));
                return;
            }
            emit_chunk(app, "⏳ Rate limit hit on all keys, retrying in 15s...");
            tokio::time::sleep(Duration::from_secs(15)).await;
            if abort.load(Ordering::Relaxed) { return; }
            key_index = 0;
            max_iter += 1;
            continue 'outer;
        }

        if !status.is_success() {
            emit_error(app, &format!("Gemini error {status}: {}",
                json["error"]["message"].as_str().unwrap_or("unknown")));
            return;
        }

        let candidate = &json["candidates"][0];
        let parts = match candidate["content"]["parts"].as_array() {
            Some(p) => p,
            None => {
                let reason = candidate["finishReason"].as_str().unwrap_or("unknown");
                emit_error(app, &format!("Gemini stopped: {reason}"));
                return;
            }
        };

        let mut has_tool_call = false;
        let mut tool_results: Vec<Value> = Vec::new();

        for part in parts {
            if abort.load(Ordering::Relaxed) { break 'outer; }

            if let Some(fc) = part.get("functionCall") {
                has_tool_call = true;
                let tool_name = fc["name"].as_str().unwrap_or("unknown");
                let tool_args = &fc["args"];

                emit_tool(app, tool_name, tool_args.clone());
                let result = execute_tool(app, timers, &abort, tool_name, tool_args).await;

                contents.push(json!({
                    "role": "model",
                    "parts": [{ "functionCall": fc }]
                }));

                let is_img = result.is_image.unwrap_or(false);
                let result_text = if is_img {
                    "Screenshot captured. Analyze the attached image.".to_string()
                } else {
                    result.result.chars().take(800).collect::<String>()
                };

                let mut response_parts: Vec<Value> = vec![json!({
                    "functionResponse": {
                        "name": tool_name,
                        "response": { "result": result_text }
                    }
                })];

                if is_img {
                    if let Some(b64) = &result.image {
                        response_parts.push(json!({
                            "inlineData": { "mimeType": "image/png", "data": b64 }
                        }));
                    }
                }
                tool_results.push(json!({ "parts": response_parts }));

            } else if let Some(text) = part["text"].as_str() {
                if !text.is_empty() { emit_chunk(app, text); }
            }
        }

        if has_tool_call {
            let all_parts: Vec<Value> = tool_results.into_iter()
                .flat_map(|r| r["parts"].as_array().cloned().unwrap_or_default())
                .collect();
            contents.push(json!({ "role": "user", "parts": all_parts }));
        } else {
            break 'outer;
        }
    }

    emit_done(app);
}