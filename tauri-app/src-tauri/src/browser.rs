// browser.rs — Lightweight CDP browser automation (no bundled binary)
// Detects Brave → Edge → Chrome in that order. Uses the OS remote-debug port.
use std::path::PathBuf;
use std::time::Duration;
use serde_json::{json, Value};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use once_cell::sync::Lazy;
use tokio::sync::Mutex as AsyncMutex;
use crate::tools::ToolResult;

const CDP_PORT: u16 = 9222;

// ── Persistent CDP connection ───────────────────────────────────────────────
// Previously every browser tool call opened a fresh WebSocket (TCP + HTTP
// upgrade) for a single command, then dropped it — N handshakes for an N-step
// automation. We now cache one live connection and reuse it, reconnecting only
// when the socket breaks (tab closed, browser relaunched, etc.). Browser tools
// run sequentially (parallel_tool_calls = false), so a single mutex-guarded
// connection is sufficient and never interleaves commands.
type CdpStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct CdpConn {
    ws: CdpStream,
    next_id: u64,
}

static CDP_CONN: Lazy<AsyncMutex<Option<CdpConn>>> = Lazy::new(|| AsyncMutex::new(None));

// Shared HTTP client for the CDP /json discovery endpoint — reqwest::Client is
// a connection pool meant to be reused, not recreated per call.
static HTTP: Lazy<reqwest::Client> = Lazy::new(reqwest::Client::new);

/// Drop any cached CDP socket — call when the browser is (re)launched or closed.
async fn reset_cdp_conn() {
    *CDP_CONN.lock().await = None;
}

// ── Browser detection ──────────────────────────────────────────────────────
// ponytail: Windows paths only; v1.0.6 adds macOS/Linux paths in #[cfg(not(windows))]
#[cfg(windows)]
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

#[cfg(not(windows))]
fn detect_chromium_browser() -> Option<PathBuf> {
    None // ponytail: v1.0.6 stub — add macOS/Linux paths here
}

// ── Ensure CDP is available, launching browser if needed ───────────────────
async fn ensure_cdp() -> Result<(), String> {
    if get_page_ws_url().await.is_ok() {
        return Ok(()); // already running
    }

    // Browser isn't reachable — any cached socket is stale.
    reset_cdp_conn().await;

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
    let targets: Vec<Value> = HTTP
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

// ── Send one CDP command over the cached connection, return result ─────────
enum CdpOutcome {
    Done(Result<Value, String>),
    Reconnect(&'static str),
}

async fn cdp(method: &str, params: Value) -> Result<Value, String> {
    let mut guard = CDP_CONN.lock().await;

    // Reuse the cached connection; on any send/read failure drop it and
    // reconnect once (covers a browser that was closed and relaunched).
    let mut last_err = "CDP: no response";
    for _ in 0..2 {
        if guard.is_none() {
            let ws_url = get_page_ws_url().await?;
            let uri = ws_url
                .parse::<tokio_tungstenite::tungstenite::http::Uri>()
                .map_err(|e| e.to_string())?;
            let (ws, _) = connect_async(uri).await
                .map_err(|e| format!("WS connect failed: {e}"))?;
            *guard = Some(CdpConn { ws, next_id: 1 });
        }

        // Scope the &mut borrow of the connection so we can reset `guard` after.
        let outcome: CdpOutcome = {
            let conn = guard.as_mut().unwrap();
            let id = conn.next_id;
            conn.next_id += 1;

            let cmd = json!({ "id": id, "method": method, "params": params }).to_string();
            if conn.ws.send(Message::Text(cmd)).await.is_err() {
                CdpOutcome::Reconnect("WS send failed")
            } else {
                // Read frames until the response carrying our id arrives;
                // unrelated events (other ids) are skipped.
                loop {
                    match conn.ws.next().await {
                        Some(Ok(Message::Text(txt))) => {
                            let v: Value = serde_json::from_str(&txt).unwrap_or_default();
                            if v["id"].as_u64() == Some(id) {
                                break CdpOutcome::Done(if let Some(err) = v.get("error") {
                                    Err(format!("CDP error: {err}"))
                                } else {
                                    Ok(v["result"].clone())
                                });
                            }
                        }
                        Some(Ok(_)) => {} // ping/pong/binary — ignore
                        Some(Err(_)) | None => break CdpOutcome::Reconnect("WS connection closed"),
                    }
                }
            }
        };

        match outcome {
            CdpOutcome::Done(r) => return r,
            CdpOutcome::Reconnect(msg) => { *guard = None; last_err = msg; }
        }
    }
    Err(last_err.into())
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

    // Mark the page content as untrusted — it is external data that must not be
    // treated as user instructions. agent.rs prepends the sentinel prefix.
    match eval_js(&js).await {
        Ok(r) => ToolResult::untrusted(r),
        Err(e) => ToolResult::err(e),
    }
}

pub async fn browser_close() -> ToolResult {
    if get_page_ws_url().await.is_err() {
        reset_cdp_conn().await;
        return ToolResult::ok("No browser session active.");
    }
    let _ = cdp("Browser.close", json!({})).await;
    // The socket is dead once the browser exits — drop it so the next session
    // reconnects cleanly.
    reset_cdp_conn().await;
    ToolResult::ok("Browser closed.")
}
