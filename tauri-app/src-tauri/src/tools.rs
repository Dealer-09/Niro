// tools.rs — All Niro tool implementations in Rust
use std::process::Command;
use std::time::Duration;
use enigo::{Enigo, Key, Keyboard, Settings as EnigoSettings};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tokio::time::sleep;
use uuid::Uuid;
use std::collections::HashMap;
use std::sync::Arc;
use parking_lot::Mutex;

// ── Active timers registry ─────────────────────────────────────────────────
pub type TimerMap = Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>;

pub fn new_timer_map() -> TimerMap {
    Arc::new(Mutex::new(HashMap::new()))
}

// ── Tool result type ───────────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub success: bool,
    pub result: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_image: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,   // base64 PNG when is_image = Some(true)
}

impl ToolResult {
    pub fn ok(result: impl Into<String>) -> Self {
        Self { success: true, result: result.into(), is_image: None, image: None }
    }
    pub fn err(result: impl Into<String>) -> Self {
        Self { success: false, result: result.into(), is_image: None, image: None }
    }
    pub fn image(b64: String) -> Self {
        Self { success: true, result: String::new(), is_image: Some(true), image: Some(b64) }
    }
}

// ── run_command ────────────────────────────────────────────────────────────
pub fn run_command(command: &str) -> ToolResult {
    let encoded: String = {
        let utf16: Vec<u16> = command.encode_utf16().collect();
        let bytes: Vec<u8> = utf16.iter().flat_map(|c| c.to_le_bytes()).collect();
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes)
    };

    #[cfg(windows)]
    use std::os::windows::process::CommandExt;

    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded]);

    // Hide the PowerShell window — prevents terminal from flashing on screen
    // CREATE_NO_WINDOW = 0x08000000
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);

    match cmd.output()
    {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if !stderr.is_empty() && out.status.code() != Some(0) {
                ToolResult::err(stderr)
            } else {
                ToolResult::ok(if stdout.is_empty() { "Done.".into() } else { stdout })
            }
        }
        Err(e) => ToolResult::err(format!("PowerShell failed: {e}")),
    }
}

// ── open_app ───────────────────────────────────────────────────────────────
// Matches Electron APP_PATHS table exactly: APPDATA-aware paths for Spotify,
// Discord (with special --processStart args), VS Code, Slack, Teams.
fn spawn_detached(path: &str, args: &[&str]) -> ToolResult {
    let mut cmd = Command::new(path);
    for a in args { cmd.arg(a); }
    match cmd.spawn() {
        Ok(_)  => ToolResult::ok(format!("Opened {}", path.split('\\').last().unwrap_or(path))),
        Err(_) => {
            let safe = path.replace('\'', "''");
            run_command(&format!("Start-Process '{safe}'"))
        }
    }
}

pub fn open_app(app_name: &str) -> ToolResult {
    let lower = app_name.to_lowercase();
    let appdata  = std::env::var("APPDATA").unwrap_or_default();
    let localapp = std::env::var("LOCALAPPDATA").unwrap_or_default();

    match lower.as_str() {
        "chrome" | "google chrome" => {
            let candidates = [
                format!("{localapp}\\Google\\Chrome\\Application\\chrome.exe"),
                "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe".to_string(),
                "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe".to_string(),
            ];
            for p in &candidates {
                if std::path::Path::new(p).exists() {
                    return spawn_detached(p, &[]);
                }
            }
            spawn_detached(&candidates[1], &[])
        }
        "firefox"             => spawn_detached("C:\\Program Files\\Mozilla Firefox\\firefox.exe", &[]),
        "notepad"             => spawn_detached("notepad.exe", &[]),
        "calculator" | "calc" => spawn_detached("calc.exe", &[]),
        "explorer" | "file explorer" => spawn_detached("explorer.exe", &[]),
        "cmd"                 => spawn_detached("cmd.exe", &[]),
        "powershell"          => spawn_detached("powershell.exe", &[]),
        "spotify"             => spawn_detached(&format!("{appdata}\\Spotify\\Spotify.exe"), &[]),
        // Discord needs --processStart args (matches Electron exactly)
        "discord"             => spawn_detached(
            &format!("{localapp}\\Discord\\Update.exe"),
            &["--processStart", "Discord.exe"],
        ),
        "vscode" | "vs code" | "code" => spawn_detached(
            &format!("{localapp}\\Programs\\Microsoft VS Code\\Code.exe"), &[],
        ),
        "slack"               => spawn_detached(&format!("{localapp}\\slack\\slack.exe"), &[]),
        "teams"               => spawn_detached(
            &format!("{localapp}\\Microsoft\\Teams\\current\\Teams.exe"), &[],
        ),
        _ => {
            if app_name.contains('\\') || app_name.contains('/') || app_name.ends_with(".exe") {
                return spawn_detached(app_name, &[]);
            }
            let safe = app_name.replace('\'', "''");
            run_command(&format!("Start-Process '{safe}'"))
        }
    }
}


// â”€â”€ open_website â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
pub fn open_website(app: &AppHandle, url: &str) -> ToolResult {
    let full = if url.starts_with("http") { url.to_string() } else { format!("https://{url}") };
    match app.opener().open_url(&full, None::<String>) {
        Ok(_)  => ToolResult::ok(format!("Opened {full}")),
        Err(e) => ToolResult::err(format!("Failed to open {full}: {e}")),
    }
}

// â”€â”€ show_notification â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
pub fn show_notification(app: &AppHandle, title: &str, message: &str) -> ToolResult {
    match app.notification()
        .builder()
        .title(title)
        .body(message)
        .show()
    {
        Ok(_)  => ToolResult::ok(format!("Notification shown: \"{title}\"")),
        Err(e) => ToolResult::err(format!("Notification failed: {e}")),
    }
}

// â”€â”€ set_timer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
pub fn set_timer(
    app: AppHandle,
    timers: TimerMap,
    label: String,
    minutes: f64,
    seconds: f64,
) -> ToolResult {
    let ms = if seconds > 0.0 {
        (seconds * 1000.0) as u64
    } else if minutes > 0.0 {
        (minutes * 60.0 * 1000.0) as u64
    } else {
        return ToolResult::err("Timer duration must be > 0.");
    };

    let display = if seconds > 0.0 {
        format!("{} second", seconds as u64)
    } else {
        format!("{} minute", minutes as u64)
    };

    let id = Uuid::new_v4().to_string();
    let label_clone = label.clone();
    let display_clone = display.clone();

    let handle = tokio::spawn(async move {
        sleep(Duration::from_millis(ms)).await;
        let title = "â± Timer Complete!";
        let body = format!("{label_clone} â€” {display_clone}(s) timer done!");
        if let Err(e) = app.notification()
            .builder()
            .title(title)
            .body(&body)
            .show()
        {
            eprintln!("[Niro] Timer notification failed: {e}");
        }
    });

    timers.lock().insert(id, handle);

    ToolResult::ok(format!(
        "Timer set: \"{label}\" â€” {display}(s). You'll get a notification when it's done."
    ))
}

// â”€â”€ take_screenshot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
pub fn take_screenshot() -> ToolResult {
    match screenshots::Screen::all() {
        Ok(screens) => {
            if let Some(screen) = screens.first() {
                match screen.capture() {
                    Ok(img) => {
                        // Encode ImageBuffer to PNG bytes using image crate encoder
                        let mut png_bytes: Vec<u8> = Vec::new();
                        {
                            use image::ImageEncoder;
                            let enc = image::codecs::png::PngEncoder::new(&mut png_bytes);
                            let _ = enc.write_image(
                                img.as_raw(),
                                img.width(),
                                img.height(),
                                image::ColorType::Rgba8.into(),
                            );
                        }
                        let b64 = base64::Engine::encode(
                            &base64::engine::general_purpose::STANDARD, &png_bytes
                        );
                        ToolResult::image(b64)
                    }
                    Err(e) => ToolResult::err(format!("Capture failed: {e}")),
                }
            } else {
                ToolResult::err("No screens found.")
            }
        }
        Err(e) => ToolResult::err(format!("Screenshot error: {e}")),
    }
}

// â”€â”€ search_files â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
pub fn search_files(query: &str, directory: Option<&str>) -> ToolResult {
    let userprofile = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\Users".into());
    let dir = directory.unwrap_or(userprofile.as_str());
    let safe_dir = dir.replace('\'', "''");
    let safe_query = query.replace('\'', "''");
    let cmd = format!(
        "Get-ChildItem -Path '{safe_dir}' -Recurse -Filter '*{safe_query}*' \
        -ErrorAction SilentlyContinue -Depth 4 | \
        Select-Object -First 15 FullName, Length, LastWriteTime | \
        Format-Table -AutoSize | Out-String -Width 300"
    );
    let mut result = run_command(&cmd);
    if result.success && result.result.trim().is_empty() {
        result.result = format!("No files found matching '{query}'");
    }
    result
}

// â”€â”€ type_text â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
pub fn type_text(text: &str) -> ToolResult {
    let safe = text.replace('\'', "''");
    // Escape SendKeys special chars
    let escaped = safe
        .chars()
        .map(|c| match c {
            '+' | '^' | '%' | '~' | '(' | ')' | '{' | '}' | '[' | ']' => format!("{{{c}}}"),
            '\n' => "{ENTER}".to_string(),
            '\t' => "{TAB}".to_string(),
            _ => c.to_string(),
        })
        .collect::<String>();

    let ps = format!(
        "Add-Type -AssemblyName System.Windows.Forms; \
        Start-Sleep -Milliseconds 600; \
        [System.Windows.Forms.SendKeys]::SendWait('{escaped}')"
    );
    run_command(&ps)
}

// â”€â”€ write_to_notepad â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
pub fn write_to_notepad(content: &str, filename: Option<&str>) -> ToolResult {
    let safe_name = filename
        .unwrap_or("niro_note")
        .chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) { '_' } else { c })
        .collect::<String>();

    let tmp_dir = std::env::temp_dir();
    let path = tmp_dir.join(format!("{safe_name}.txt"));

    match std::fs::write(&path, content) {
        Ok(_) => match Command::new("notepad.exe").arg(&path).spawn() {
            Ok(_)  => ToolResult::ok(format!("Opened Notepad with your content ({safe_name}.txt)")),
            Err(e) => ToolResult::err(format!("Failed to open Notepad: {e}")),
        },
        Err(e) => ToolResult::err(format!("Failed to write file: {e}")),
    }
}

// â”€â”€ write_to_app â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
pub fn write_to_app(text: &str, app_title: &str, delay_ms: u64) -> ToolResult {
    // Focus window then type
    let focus_result = focus_window(app_title);
    if !focus_result.success {
        return focus_result;
    }
    let actual_delay = if delay_ms == 0 { 800 } else { delay_ms.min(2000) };
    std::thread::sleep(Duration::from_millis(actual_delay));
    type_text(text)
}

// â”€â”€ press_key â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
pub fn press_key(key: &str) -> ToolResult {
    let lower = key.to_lowercase();
    let parts: Vec<&str> = lower.split('+').map(str::trim).collect();
    
    let map_key = |k: &str| -> Option<Key> {
        match k {
            "enter" | "return" => Some(Key::Return),
            "escape" | "esc"   => Some(Key::Escape),
            "tab"              => Some(Key::Tab),
            "space"            => Some(Key::Space),
            "backspace"        => Some(Key::Backspace),
            "delete" | "del"   => Some(Key::Delete),
            "up"               => Some(Key::UpArrow),
            "down"             => Some(Key::DownArrow),
            "left"             => Some(Key::LeftArrow),
            "right"            => Some(Key::RightArrow),
            "f1"               => Some(Key::F1),
            "f2"               => Some(Key::F2),
            "f3"               => Some(Key::F3),
            "f4"               => Some(Key::F4),
            "f5"               => Some(Key::F5),
            _ if k.len() == 1  => Some(Key::Unicode(k.chars().next().unwrap())),
            _                  => None,
        }
    };

    let map_modifier = |k: &str| -> Option<Key> {
        match k {
            "ctrl" | "control" => Some(Key::Control),
            "alt"              => Some(Key::Alt),
            "shift"            => Some(Key::Shift),
            "win" | "super"    => Some(Key::Meta),
            _                  => None,
        }
    };

    let Ok(mut enigo) = Enigo::new(&EnigoSettings::default()) else {
        return ToolResult::err("Failed to initialize keyboard control.");
    };

    if parts.len() == 1 {
        if let Some(k) = map_key(parts[0]) {
            let _ = enigo.key(k, enigo::Direction::Click);
            return ToolResult::ok(format!("Pressed {key}"));
        }
    } else {
        // Combo: hold modifiers, tap key, release modifiers
        let mods: Vec<Key> = parts[..parts.len()-1].iter().filter_map(|m| map_modifier(m)).collect();
        let main_key = map_key(parts[parts.len()-1]);
        if let Some(k) = main_key {
            for m in &mods { let _ = enigo.key(*m, enigo::Direction::Press); }
            let _ = enigo.key(k, enigo::Direction::Click);
            for m in mods.iter().rev() { let _ = enigo.key(*m, enigo::Direction::Release); }
            return ToolResult::ok(format!("Pressed {key}"));
        }
    }

    ToolResult::err(format!("Unknown key: {key}"))
}

// â”€â”€ mouse_click â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
pub fn mouse_click(x: i32, y: i32) -> ToolResult {
    let Ok(mut enigo) = Enigo::new(&EnigoSettings::default()) else {
        return ToolResult::err("Failed to initialize mouse control.");
    };
    use enigo::{Mouse, Coordinate};
    let _ = enigo.move_mouse(x, y, Coordinate::Abs);
    let _ = enigo.button(enigo::Button::Left, enigo::Direction::Click);
    ToolResult::ok(format!("Clicked at ({x}, {y})"))
}

// â”€â”€ list_windows â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
pub fn list_windows() -> ToolResult {
    run_command(
        "Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | \
        Select-Object ProcessName, MainWindowTitle, Id | \
        Format-Table -AutoSize | Out-String -Width 300"
    )
}

// â”€â”€ focus_window â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
pub fn focus_window(title: &str) -> ToolResult {
    let safe = title.replace('\'', "''");
    let cmd = format!(r#"
Add-Type @"
  using System;
  using System.Runtime.InteropServices;
  public class WinAPI {{
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  }}
"@
$proc = Get-Process | Where-Object {{ $_.MainWindowTitle -like '*{safe}*' }} | Select-Object -First 1
if ($proc) {{
  [WinAPI]::ShowWindow($proc.MainWindowHandle, 9)
  [WinAPI]::SetForegroundWindow($proc.MainWindowHandle)
  "Focused: " + $proc.MainWindowTitle
}} else {{
  "No window found matching '{safe}'"
}}"#);
    run_command(&cmd)
}

// â”€â”€ close_app â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
pub fn close_app(name: &str) -> ToolResult {
    let safe = name.replace('\'', "''");
    let cmd = format!(
        "Get-Process -Name '*{safe}*' -ErrorAction SilentlyContinue | Stop-Process -Force -PassThru | Select-Object ProcessName"
    );
    let result = run_command(&cmd);
    if result.success && result.result.trim().is_empty() {
        ToolResult::ok(format!("No process found matching '{name}'"))
    } else {
        result
    }
}

// â”€â”€ send_email â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
fn parse_schedule_duration(time_str: &str) -> Option<std::time::Duration> {
    use chrono::{Local, NaiveTime, Timelike};
    // Accepts "6:05 PM", "18:05", "6:05pm"
    let s = time_str.trim().to_uppercase();
    let fmt_12 = "%I:%M %p";
    let fmt_24 = "%H:%M";
    let target = NaiveTime::parse_from_str(&s, fmt_12)
        .or_else(|_| NaiveTime::parse_from_str(time_str.trim(), fmt_24))
        .ok()?;

    let now = Local::now();
    let now_t = now.time();
    let secs_target = target.num_seconds_from_midnight() as i64;
    let secs_now    = now_t.num_seconds_from_midnight() as i64;
    let mut diff = secs_target - secs_now;
    if diff < 0 { diff += 86_400; } // next day
    Some(std::time::Duration::from_secs(diff as u64))
}

pub async fn send_email(
    app: &AppHandle,
    to: &str,
    subject: &str,
    body: &str,
    gmail_user: &str,
    gmail_pass: &str,
    schedule_time: Option<&str>,
) -> ToolResult {

    // Schedule: wait until the specified wall-clock time
    if let Some(t) = schedule_time.filter(|s| !s.is_empty()) {
        match parse_schedule_duration(t) {
            Some(wait) if wait.as_secs() > 0 => {
                let mins = wait.as_secs() / 60;
                let secs = wait.as_secs() % 60;
                let eta = if mins > 0 { format!("{mins}m {secs}s") } else { format!("{secs}s") };
                let to = to.to_string(); let subject = subject.to_string();
                let body = body.to_string();
                let gmail_user = gmail_user.to_string();
                let gmail_pass = gmail_pass.to_string();
                let t_str = t.to_string();
                let app_clone = app.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(wait).await;
                    let result = send_email_now(&to, &subject, &body, &gmail_user, &gmail_pass).await;
                    // Notify user when scheduled email fires — matches Electron behavior
                    let notif_body = if result.success {
                        format!("Scheduled email to {} has been sent.", to)
                    } else {
                        format!("Scheduled email failed: {}", result.result)
                    };
                    let _ = app_clone.notification()
                        .builder()
                        .title("📧 Email Sent!")
                        .body(&notif_body)
                        .show();
                });
                return ToolResult::ok(format!("Email scheduled to send in {eta} at {t_str}."));
            }
            _ => {} // parse failed or 0s â†’ send now
        }
    }

    send_email_now(to, subject, body, gmail_user, gmail_pass).await
}

async fn send_email_now(to: &str, subject: &str, body: &str, gmail_user: &str, gmail_pass: &str) -> ToolResult {
    use lettre::{
        message::header::ContentType,
        transport::smtp::authentication::Credentials,
        AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
    };

    if gmail_user.is_empty() || gmail_pass.is_empty() {
        return ToolResult::err("Gmail not configured. Add your Gmail address and App Password in âš™ï¸ Settings â†’ Email.");
    }

    let from_addr = match gmail_user.parse() {
        Ok(a) => a,
        Err(e) => return ToolResult::err(format!("Invalid sender email '{}': {}", gmail_user, e)),
    };
    let to_addr = match to.parse() {
        Ok(a) => a,
        Err(e) => return ToolResult::err(format!("Invalid recipient email '{}': {}", to, e)),
    };

    let email = match Message::builder()
        .from(from_addr)
        .to(to_addr)
        .subject(subject)
        .header(ContentType::TEXT_PLAIN)
        .body(body.to_string())
    {
        Ok(e) => e,
        Err(e) => return ToolResult::err(format!("Email build error: {e}")),
    };
    let creds = Credentials::new(gmail_user.to_string(), gmail_pass.to_string());
    let mailer = match AsyncSmtpTransport::<Tokio1Executor>::starttls_relay("smtp.gmail.com") {
        Ok(m) => m.credentials(creds).build(),
        Err(e) => return ToolResult::err(format!("SMTP setup failed: {e}")),
    };
    match mailer.send(email).await {
        Ok(_)  => ToolResult::ok(format!("Email sent to {to} âœ“")),
        Err(e) => ToolResult::err(format!("Email failed: {e}")),
    }
}

