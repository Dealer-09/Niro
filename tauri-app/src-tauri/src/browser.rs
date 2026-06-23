// browser.rs — Lightweight CDP browser automation (no bundled binary)
// Detects Brave → Edge → Chrome in that order. Uses the OS remote-debug port.
use std::path::PathBuf;
use std::time::Duration;
use serde_json::{json, Value};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use crate::tools::ToolResult;

const CDP_PORT: u16 = 9222;

// ── Browser detection ──────────────────────────────────────────────────────
fn detect_chromium_browser() -> Option<PathBuf> {
    let candidates = [
        r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
        r"C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ];
    candidates.iter().map(PathBuf::from).find(|p| p.exists())
}

// ── Ensure CDP is available, launching browser if needed ───────────────────
async fn ensure_cdp() -> Result<(), String> {
    if get_page_ws_url().await.is_ok() {
        return Ok(()); // already running
    }

    let browser = detect_chromium_browser()
        .ok_or("No Chromium browser found. Install Brave, Chrome, or Edge.")?;

    std::process::Command::new(&browser)
        .args([
            &format!("--remote-debugging-port={CDP_PORT}"),
            "--no-first-run",
            "--no-default-browser-check",
        ])
        .spawn()
        .map_err(|e| format!("Failed to launch browser: {e}"))?;

    // Wait up to 5s for CDP to become available
    for _ in 0..10 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if get_page_ws_url().await.is_ok() {
            return Ok(());
        }
    }
    Err("Browser launched but CDP didn't respond in 5s".into())
}

// ── Get WebSocket URL for first page tab ───────────────────────────────────
async fn get_page_ws_url() -> Result<String, String> {
    let url = format!("http://127.0.0.1:{CDP_PORT}/json");
    let targets: Vec<Value> = reqwest::Client::new()
        .get(&url)
        .timeout(Duration::from_secs(2))
        .send().await.map_err(|_| "CDP not available".to_string())?
        .json().await.map_err(|e| e.to_string())?;

    targets.iter()
        .find(|t| t["type"].as_str() == Some("page"))
        .and_then(|t| t["webSocketDebuggerUrl"].as_str())
        .map(str::to_string)
        .ok_or("No page target found".into())
}

// ── Send one CDP command, return result ────────────────────────────────────
async fn cdp(method: &str, params: Value) -> Result<Value, String> {
    let ws_url = get_page_ws_url().await?;
    let url = ws_url.parse::<tokio_tungstenite::tungstenite::http::Uri>()
        .map_err(|e| e.to_string())?;

    let (mut ws, _) = connect_async(url).await
        .map_err(|e| format!("WS connect failed: {e}"))?;

    let cmd = json!({"id": 1, "method": method, "params": params}).to_string();
    ws.send(Message::Text(cmd)).await
        .map_err(|e| format!("WS send failed: {e}"))?;

    while let Some(Ok(Message::Text(txt))) = ws.next().await {
        let v: Value = serde_json::from_str(&txt).unwrap_or_default();
        if v["id"].as_u64() == Some(1) {
            return if let Some(err) = v.get("error") {
                Err(format!("CDP error: {err}"))
            } else {
                Ok(v["result"].clone())
            };
        }
    }
    Err("CDP: no response".into())
}

// ── Execute JavaScript and return string result ────────────────────────────
async fn eval_js(js: &str) -> Result<String, String> {
    let result = cdp("Runtime.evaluate", json!({
        "expression": js,
        "returnByValue": true,
        "awaitPromise": true,
    })).await?;
    Ok(result["result"]["value"].as_str().unwrap_or("").to_string())
}

// ── JS string literal helper ───────────────────────────────────────────────
// Produce a valid JS string literal (with quotes) from arbitrary Rust &str.
// Uses serde_json to get correct Unicode escaping — Rust's {:?} Debug format
// emits Rust-style escapes (\n as literal backslash-n etc.) which break JS.
fn js_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"")))
}

// ── Public browser tools ───────────────────────────────────────────────────

pub async fn browser_open(url: &str) -> ToolResult {
    let full = if url.starts_with("http") { url.into() } else { format!("https://{url}") };
    if let Err(e) = ensure_cdp().await { return ToolResult::err(e); }
    match cdp("Page.navigate", json!({ "url": full })).await {
        Ok(_) => {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            ToolResult::ok(format!("Navigated to {full}"))
        }
        Err(e) => ToolResult::err(e),
    }
}

pub async fn browser_click(selector: Option<&str>, text: Option<&str>) -> ToolResult {
    if let Err(e) = ensure_cdp().await { return ToolResult::err(e); }

    let js = match (selector, text) {
        (_, Some(txt)) => {
            let v = js_str(txt);
            format!(
                r#"(()=>{{const tags='a,button,[role="button"],input[type="submit"],input[type="button"]';
                const el=[...document.querySelectorAll(tags)].find(e=>e.innerText?.trim().toLowerCase().includes({v}.toLowerCase())||e.value?.toLowerCase().includes({v}.toLowerCase()));
                if(el){{el.click();return'Clicked: '+(el.innerText||el.value||{v})}}return'Not found: '+{v}}})()"#,
                v = v)
        }
        (Some(sel), _) => {
            let v = js_str(sel);
            format!(
                r#"(()=>{{const el=document.querySelector({v});if(el){{el.click();return'Clicked: '+{v}}}return'Not found: '+{v}}})()"#,
                v = v)
        }
        _ => return ToolResult::err("Provide selector or text"),
    };

    match eval_js(&js).await {
        Ok(r) => ToolResult::ok(r),
        Err(e) => ToolResult::err(e),
    }
}

pub async fn browser_type(selector: &str, text: &str) -> ToolResult {
    if let Err(e) = ensure_cdp().await { return ToolResult::err(e); }

    let sel_js = js_str(selector);
    let text_js = js_str(text);
    let js = format!(
        r#"(()=>{{
        const el=document.querySelector({sel})||[...document.querySelectorAll('input,textarea,*[contenteditable]')]
            .find(e=>e.placeholder?.toLowerCase().includes({sel}.toLowerCase())||e.name?.includes({sel}));
        if(!el)return'Input not found: '+{sel};
        el.focus();el.value={text};
        el.dispatchEvent(new Event('input',{{bubbles:true}}));
        el.dispatchEvent(new Event('change',{{bubbles:true}}));
        return'Typed into '+{sel}}})()"#,
        sel = sel_js, text = text_js);

    match eval_js(&js).await {
        Ok(r) => ToolResult::ok(r),
        Err(e) => ToolResult::err(e),
    }
}

pub async fn browser_read(selector: Option<&str>) -> ToolResult {
    if let Err(e) = ensure_cdp().await { return ToolResult::err(e); }

    let js = match selector {
        Some(sel) => {
            let v = js_str(sel);
            format!(
                r#"(()=>{{const el=document.querySelector({v});return el?el.innerText||el.value||el.textContent:'Not found: '+{v}}})()"#,
                v = v)
        }
        None => "document.title+'\\n---\\n'+document.body.innerText.slice(0,2000)".into(),
    };

    match eval_js(&js).await {
        Ok(r) => ToolResult::ok(r),
        Err(e) => ToolResult::err(e),
    }
}

pub async fn browser_close() -> ToolResult {
    if get_page_ws_url().await.is_err() {
        return ToolResult::ok("No browser session active.");
    }
    match cdp("Browser.close", json!({})).await {
        Ok(_) | Err(_) => ToolResult::ok("Browser closed."),
    }
}
