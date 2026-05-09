// tools.js — All executable tools for Niro agent
import { exec, spawn } from 'child_process';
import { shell, Notification } from 'electron';
import path from 'path';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import screenshotDesktop from 'screenshot-desktop';
import * as browserBridge from './tools/browser.js';

const execAsync = promisify(exec);

// ─────────────────────────────────────────────────
// Playwright browser automation (persistent instance)
// ─────────────────────────────────────────────────
let playwrightBrowser = null;
let playwrightPage = null;

async function getPlaywrightPage() {
  if (playwrightPage && !playwrightPage.isClosed()) return playwrightPage;
  const { chromium } = await import('playwright');
  playwrightBrowser = await chromium.launch({ headless: true });  // headless — legacy fallback only
  const context = await playwrightBrowser.newContext();
  playwrightPage = await context.newPage();
  return playwrightPage;
}

// Cleanup browser on process exit
process.on('exit', () => {
  if (playwrightBrowser) {
    playwrightBrowser.close().catch(() => {});
  }
});

// Try to load robotjs — it's optional (requires native compilation)
let robot = null;
try {
  robot = (await import('@jitsi/robotjs')).default;
} catch (e) {
  console.warn('[Niro] robotjs not available — type_text, press_key, mouse_click tools disabled.');
  console.warn('[Niro] Install @jitsi/robotjs if you need keyboard/mouse control.');
}

// Active timers storage
const activeTimers = new Map();

// Store reference — set from main.js
let store = null;
let mainWindow = null;
let appPath = process.cwd(); // fallback; overridden by setAppPath() from main.js

export function setStore(s) {
  store = s;
}

export function setMainWindow(win) {
  mainWindow = win;
}

export function setAppPath(p) {
  appPath = p;
}

function getIconPath() {
  return path.join(appPath, 'assets', 'icon.png');
}

// ─────────────────────────────────────────────────
// Tool: open_app
// ─────────────────────────────────────────────────
const APP_PATHS = {
  // Chrome — check both Program Files locations
  'chrome': [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].find(p => { try { return existsSync(p); } catch(_) { return false; } })
    || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'google chrome': null, // resolved below
  'firefox': 'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
  'notepad': 'notepad.exe',
  'calculator': 'calc.exe',
  'calc': 'calc.exe',
  'explorer': 'explorer.exe',
  'file explorer': 'explorer.exe',
  'cmd': 'cmd.exe',
  'powershell': 'powershell.exe',
  'spotify': path.join(process.env.APPDATA || '', 'Spotify', 'Spotify.exe'),
  'discord': path.join(process.env.LOCALAPPDATA || '', 'Discord', 'Update.exe'),
  'vscode': path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
  'vs code': path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
  'code': path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
  'slack': path.join(process.env.LOCALAPPDATA || '', 'slack', 'slack.exe'),
  'teams': path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Teams', 'current', 'Teams.exe'),
};
// alias
APP_PATHS['google chrome'] = APP_PATHS['chrome'];

async function open_app({ app }) {
  try {
    const appLower = app.toLowerCase().trim();
    const knownPath = APP_PATHS[appLower];

    if (knownPath) {
      // Discord needs special args
      const args = appLower === 'discord' ? ['--processStart', 'Discord.exe'] : [];
      spawn(knownPath, args, { detached: true, stdio: 'ignore', shell: false }).unref();
      return { success: true, result: `Opened ${app}` };
    }

    // If it looks like a full path, try it directly
    if (app.includes('\\') || app.includes('/') || app.endsWith('.exe')) {
      spawn(app, [], { detached: true, stdio: 'ignore', shell: true }).unref();
      return { success: true, result: `Opened ${app}` };
    }

    // Fallback: try Start-Process via EncodedCommand
    const cmd = `Start-Process '${app.replace(/'/g, "''")}'`;
    const encoded = Buffer.from(cmd, 'utf16le').toString('base64');
    await execAsync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, { timeout: 10000 });
    return { success: true, result: `Opened ${app}` };
  } catch (err) {
    return { success: false, result: `Failed to open ${app}: ${err.message}` };
  }
}

// ─────────────────────────────────────────────────
// Tool: open_website
// ─────────────────────────────────────────────────
async function open_website({ url }) {
  try {
    let fullUrl = url;
    if (!fullUrl.startsWith('http://') && !fullUrl.startsWith('https://')) {
      fullUrl = 'https://' + fullUrl;
    }
    await shell.openExternal(fullUrl);
    return { success: true, result: `Opened ${fullUrl}` };
  } catch (err) {
    return { success: false, result: `Failed to open ${url}: ${err.message}` };
  }
}

// ─────────────────────────────────────────────────
// Tool: type_text
// ─────────────────────────────────────────────────
async function type_text({ text }) {
  if (!robot) {
    return { success: false, result: 'robotjs not available — cannot type text. Install @jitsi/robotjs.' };
  }
  try {
    // Delay so the target window regains focus
    await new Promise(r => setTimeout(r, 500));
    robot.typeString(text);
    return { success: true, result: `Typed: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"` };
  } catch (err) {
    return { success: false, result: `Failed to type text: ${err.message}` };
  }
}

// ─────────────────────────────────────────────────
// Tool: press_key
// ─────────────────────────────────────────────────
async function press_key({ key }) {
  if (!robot) {
    return { success: false, result: 'robotjs not available — cannot press keys. Install @jitsi/robotjs.' };
  }
  try {
    const parts = key.toLowerCase().split('+').map(k => k.trim());

    if (parts.length === 1) {
      // Single key
      const keyName = mapKeyName(parts[0]);
      robot.keyTap(keyName);
    } else {
      // Key combo: last part is the key, rest are modifiers
      const modifiers = parts.slice(0, -1).map(mapModifier);
      const mainKey = mapKeyName(parts[parts.length - 1]);
      robot.keyTap(mainKey, modifiers);
    }
    return { success: true, result: `Pressed: ${key}` };
  } catch (err) {
    return { success: false, result: `Failed to press ${key}: ${err.message}` };
  }
}

function mapKeyName(key) {
  const map = {
    'enter': 'enter', 'return': 'enter',
    'tab': 'tab', 'space': 'space',
    'backspace': 'backspace', 'delete': 'delete',
    'escape': 'escape', 'esc': 'escape',
    'up': 'up', 'down': 'down', 'left': 'left', 'right': 'right',
    'home': 'home', 'end': 'end',
    'pageup': 'pageup', 'pagedown': 'pagedown',
    'f1': 'f1', 'f2': 'f2', 'f3': 'f3', 'f4': 'f4',
    'f5': 'f5', 'f6': 'f6', 'f7': 'f7', 'f8': 'f8',
    'f9': 'f9', 'f10': 'f10', 'f11': 'f11', 'f12': 'f12',
    'win': 'command', 'windows': 'command', 'meta': 'command',
    'printscreen': 'printscreen', 'insert': 'insert',
  };
  return map[key] || key;
}

function mapModifier(mod) {
  const map = {
    'ctrl': 'control', 'control': 'control',
    'alt': 'alt',
    'shift': 'shift',
    'win': 'command', 'windows': 'command', 'meta': 'command', 'super': 'command',
  };
  return map[mod] || mod;
}

// ─────────────────────────────────────────────────
// Tool: mouse_click
// ─────────────────────────────────────────────────
async function mouse_click({ x, y }) {
  if (!robot) {
    return { success: false, result: 'robotjs not available — cannot click mouse. Install @jitsi/robotjs.' };
  }
  try {
    robot.moveMouse(Math.round(x), Math.round(y));
    await new Promise(r => setTimeout(r, 100));
    robot.mouseClick();
    return { success: true, result: `Clicked at (${x}, ${y})` };
  } catch (err) {
    return { success: false, result: `Failed to click at (${x}, ${y}): ${err.message}` };
  }
}

// ─────────────────────────────────────────────────
// Tool: run_command
// ─────────────────────────────────────────────────
async function run_command({ command, silent = false }) {
  try {
    // Use -EncodedCommand to avoid any quoting/escaping issues
    const encoded = Buffer.from(command, 'utf16le').toString('base64');
    const { stdout, stderr } = await execAsync(
      `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
      { timeout: 30000, maxBuffer: 1024 * 1024 }
    );
    const output = stdout.trim() || stderr.trim() || '(no output)';
    return {
      success: true,
      result: silent ? 'Command executed successfully.' : output.substring(0, 2000)
    };
  } catch (err) {
    return { success: false, result: `Command failed: ${err.message}` };
  }
}

// ─────────────────────────────────────────────────
// Tool: set_timer
// ─────────────────────────────────────────────────
async function set_timer({ minutes, label, seconds }) {
  try {
    let ms;
    let displayText;

    const mins = Number(minutes) || 0;
    const secs = Number(seconds) || 0;

    if (secs > 0) {
      ms = secs * 1000;
      displayText = secs < 60 ? `${secs} second` : `${Math.round(secs / 60)} minute`;
    } else if (mins > 0) {
      // If fractional minutes passed (e.g. 0.17 for ~10s), convert properly
      if (mins < 1) {
        const actualSeconds = Math.round(mins * 60);
        ms = actualSeconds * 1000;
        displayText = `${actualSeconds} second`;
      } else {
        ms = mins * 60 * 1000;
        displayText = `${mins} minute`;
      }
    } else {
      return { success: false, result: 'Timer duration must be greater than 0. Specify minutes or seconds.' };
    }

    const id = `timer_${Date.now()}`;
    const timeout = setTimeout(() => {
      const notif = new Notification({
        title: '⏱ Timer Complete!',
        body: label || `Your ${displayText} timer is done!`,
        icon: getIconPath(),
      });
      notif.show();
      activeTimers.delete(id);
    }, ms);

    activeTimers.set(id, { timeout, label, endsAt: Date.now() + ms });

    return {
      success: true,
      result: `Timer set: "${label}" — ${displayText}(s). You'll get a notification when it's done.`
    };
  } catch (err) {
    return { success: false, result: `Failed to set timer: ${err.message}` };
  }
}

// ─────────────────────────────────────────────────
// Tool: take_screenshot
// ─────────────────────────────────────────────────
async function take_screenshot() {
  try {
    const imgBuffer = await screenshotDesktop({ format: 'png' });
    const base64 = imgBuffer.toString('base64');
    return { success: true, result: base64, isImage: true };
  } catch (err) {
    return { success: false, result: `Screenshot failed: ${err.message}` };
  }
}

// ─────────────────────────────────────────────────
// Tool: show_notification
// ─────────────────────────────────────────────────
async function show_notification({ title, message }) {
  try {
    const notif = new Notification({
      title: title,
      body: message,
      icon: getIconPath(),
    });
    notif.show();
    return { success: true, result: `Notification shown: "${title}"` };
  } catch (err) {
    return { success: false, result: `Notification failed: ${err.message}` };
  }
}

// ─────────────────────────────────────────────────
// Tool: save_task
// ─────────────────────────────────────────────────
async function save_task({ name, instruction }) {
  try {
    const tasks = store.get('tasks') || [];

    const newTask = {
      id: uuidv4(),
      name: name,
      instruction: instruction,
      icon: '⚡'
    };

    tasks.push(newTask);
    store.set('tasks', tasks);

    // Notify renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tasks:updated', { tasks });
    }

    return { success: true, result: `Task "${name}" saved to quick-access panel.` };
  } catch (err) {
    return { success: false, result: `Failed to save task: ${err.message}` };
  }
}

// ─────────────────────────────────────────────────
// Tool: browser_open — Navigate Playwright browser to a URL
// ─────────────────────────────────────────────────
async function browser_open({ url }) {
  try {
    let fullUrl = url;
    if (!fullUrl.startsWith('http://') && !fullUrl.startsWith('https://')) {
      fullUrl = 'https://' + fullUrl;
    }
    const page = await getPlaywrightPage();
    await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const title = await page.title();
    return { success: true, result: `Opened ${fullUrl} — Page title: "${title}"` };
  } catch (err) {
    return { success: false, result: `Browser navigation failed: ${err.message}` };
  }
}

// ─────────────────────────────────────────────────
// Tool: browser_click — Click an element by CSS selector or visible text
// ─────────────────────────────────────────────────
async function browser_click({ selector, text }) {
  try {
    const page = await getPlaywrightPage();
    if (text) {
      await page.getByText(text, { exact: false }).first().click({ timeout: 5000 });
      return { success: true, result: `Clicked element with text: "${text}"` };
    } else if (selector) {
      await page.click(selector, { timeout: 5000 });
      return { success: true, result: `Clicked element: ${selector}` };
    }
    return { success: false, result: 'Provide either "selector" or "text" to click.' };
  } catch (err) {
    return { success: false, result: `Click failed: ${err.message}` };
  }
}

// ─────────────────────────────────────────────────
// Tool: browser_type — Type into an input field by selector
// ─────────────────────────────────────────────────
async function browser_type({ selector, text, placeholder }) {
  try {
    const page = await getPlaywrightPage();
    if (placeholder) {
      await page.getByPlaceholder(placeholder).first().fill(text, { timeout: 5000 });
      return { success: true, result: `Typed "${text.substring(0, 40)}" into field with placeholder "${placeholder}"` };
    } else if (selector) {
      await page.fill(selector, text, { timeout: 5000 });
      return { success: true, result: `Typed "${text.substring(0, 40)}" into ${selector}` };
    }
    return { success: false, result: 'Provide either "selector" or "placeholder" to target the input field.' };
  } catch (err) {
    return { success: false, result: `Browser type failed: ${err.message}` };
  }
}

// ─────────────────────────────────────────────────
// Tool: browser_read — Read visible text content from the current page
// ─────────────────────────────────────────────────
async function browser_read({ selector }) {
  try {
    const page = await getPlaywrightPage();
    let content;
    if (selector) {
      content = await page.textContent(selector, { timeout: 5000 });
    } else {
      content = await page.textContent('body', { timeout: 5000 });
    }
    // Truncate to avoid overwhelming the model
    const trimmed = (content || '').trim().substring(0, 3000);
    const title = await page.title();
    const url = page.url();
    return { success: true, result: `Page: "${title}" (${url})\n\nContent:\n${trimmed}` };
  } catch (err) {
    return { success: false, result: `Browser read failed: ${err.message}` };
  }
}

// ─────────────────────────────────────────────────
// Tool: browser_close — Close the Playwright browser
// ─────────────────────────────────────────────────
async function browser_close() {
  try {
    if (playwrightBrowser) {
      await playwrightBrowser.close();
      playwrightBrowser = null;
      playwrightPage = null;
    }
    return { success: true, result: 'Browser closed.' };
  } catch (err) {
    return { success: false, result: `Failed to close browser: ${err.message}` };
  }
}

// ─────────────────────────────────────────────────
// Tool: list_windows — List all visible windows
// ─────────────────────────────────────────────────
async function list_windows() {
  try {
    const cmd = `Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Select-Object ProcessName, MainWindowTitle, Id | Format-Table -AutoSize | Out-String -Width 300`;
    const encoded = Buffer.from(cmd, 'utf16le').toString('base64');
    const { stdout } = await execAsync(
      `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
      { timeout: 10000 }
    );
    return { success: true, result: stdout.trim().substring(0, 2000) || 'No visible windows found.' };
  } catch (err) {
    return { success: false, result: `Failed to list windows: ${err.message}` };
  }
}

// ─────────────────────────────────────────────────
// Tool: focus_window — Bring a window to the front by title
// ─────────────────────────────────────────────────
async function focus_window({ title }) {
  try {
    const safeTitle = title.replace(/'/g, "''");
    const cmd = `
Add-Type @"
  using System;
  using System.Runtime.InteropServices;
  public class WinAPI {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  }
"@
$proc = Get-Process | Where-Object { $_.MainWindowTitle -like '*${safeTitle}*' } | Select-Object -First 1
if ($proc) {
  [WinAPI]::ShowWindow($proc.MainWindowHandle, 9)
  [WinAPI]::SetForegroundWindow($proc.MainWindowHandle)
  "Focused: " + $proc.MainWindowTitle
} else {
  "No window found matching '${safeTitle}'"
}`;
    const encoded = Buffer.from(cmd, 'utf16le').toString('base64');
    const { stdout } = await execAsync(
      `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
      { timeout: 10000 }
    );
    return { success: true, result: stdout.trim() };
  } catch (err) {
    return { success: false, result: `Failed to focus window: ${err.message}` };
  }
}

// ─────────────────────────────────────────────────
// Tool: close_app — Close a running application by name
// ─────────────────────────────────────────────────
async function close_app({ name }) {
  try {
    const safeName = name.replace(/'/g, "''");
    const cmd = `Get-Process -Name '*${safeName}*' -ErrorAction SilentlyContinue | Stop-Process -Force -PassThru | Select-Object ProcessName`;
    const encoded = Buffer.from(cmd, 'utf16le').toString('base64');
    const { stdout } = await execAsync(
      `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
      { timeout: 10000 }
    );
    const result = stdout.trim();
    return { success: true, result: result ? `Closed: ${result}` : `No process found matching '${name}'` };
  } catch (err) {
    return { success: false, result: `Failed to close ${name}: ${err.message}` };
  }
}

// ─────────────────────────────────────────────────
// Tool: search_files — Search for files on disk
// ─────────────────────────────────────────────────
async function search_files({ query, directory }) {
  try {
    const dir = directory || process.env.USERPROFILE || 'C:\\Users';
    const cmd = `Get-ChildItem -Path '${dir.replace(/'/g, "''")}' -Recurse -Filter '*${query.replace(/'/g, "''")}*' -ErrorAction SilentlyContinue -Depth 4 | Select-Object -First 15 FullName, Length, LastWriteTime | Format-Table -AutoSize | Out-String -Width 300`;
    const encoded = Buffer.from(cmd, 'utf16le').toString('base64');
    const { stdout } = await execAsync(
      `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
      { timeout: 20000 }
    );
    return { success: true, result: stdout.trim().substring(0, 2000) || `No files found matching '${query}'` };
  } catch (err) {
    return { success: false, result: `Search failed: ${err.message}` };
  }
}

// ─────────────────────────────────────────────────
// Tool: run_task — AI-powered Browser Use via Python engine
// ─────────────────────────────────────────────────
async function run_task({ task }) {
  try {
    const result = await browserBridge.runTask(task);
    return { success: true, result: result || 'Browser task completed.' };
  } catch (err) {
    // Surface the actual error reason, not a generic message
    const msg = err.message || 'Unknown browser error';
    console.error('[Niro] run_task failed:', msg);
    return { success: false, result: `Browser task failed: ${msg}` };
  }
}

// ─────────────────────────────────────────────────
// Tool: send_email — Send email via Gmail SMTP
// Requires Gmail address + App Password stored in settings
// ─────────────────────────────────────────────────
async function send_email({ to, subject, body, scheduleTime }) {
  try {
    const gmailUser = store?.get('gmailUser') || '';
    const gmailPass = store?.get('gmailAppPassword') || '';

    if (!gmailUser || !gmailPass) {
      return {
        success: false,
        result: 'Gmail not configured. Open ⚙️ Settings → Email tab and add your Gmail address and App Password. Get an App Password at myaccount.google.com/apppasswords'
      };
    }

    // If scheduleTime is provided, use set_timer to delay the send
    if (scheduleTime) {
      // Parse scheduleTime like "8:25 AM", "14:30", "1:47 PM"
      const now = new Date();
      let targetTime = null;

      const timeMatch = scheduleTime.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
      if (timeMatch) {
        let hours = parseInt(timeMatch[1]);
        const mins = parseInt(timeMatch[2]);
        const ampm = timeMatch[3]?.toUpperCase();
        if (ampm === 'PM' && hours < 12) hours += 12;
        if (ampm === 'AM' && hours === 12) hours = 0;
        targetTime = new Date(now);
        targetTime.setHours(hours, mins, 0, 0);
        if (targetTime <= now) targetTime.setDate(targetTime.getDate() + 1); // next day if past
      }

      if (targetTime) {
        const delayMs = targetTime - now;
        const delayMins = delayMs / (1000 * 60);
        const id = `email_${Date.now()}`;
        const timeout = setTimeout(async () => {
          await send_email({ to, subject, body }); // send without scheduleTime
          const notif = new Notification({
            title: '📧 Email Sent!',
            body: `Scheduled email to ${to} has been sent.`,
            icon: getIconPath(),
          });
          notif.show();
        }, delayMs);
        activeTimers.set(id, { timeout, label: `Email to ${to}`, endsAt: Date.now() + delayMs });
        return {
          success: true,
          result: `Email scheduled to ${to} at ${scheduleTime} (in ${Math.round(delayMins)} minutes). You'll get a notification when it's sent.`
        };
      }
    }

    // Send immediately via PowerShell + Gmail SMTP
    const safeUser = gmailUser.replace(/'/g, "''");
    const safePass = gmailPass.replace(/'/g, "''");
    const safeTo = to.replace(/'/g, "''");
    const safeSubject = subject.replace(/'/g, "''");
    const safeBody = body.replace(/'/g, "''").replace(/\n/g, '`n');

    const cmd = `
$pass = ConvertTo-SecureString '${safePass}' -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential('${safeUser}', $pass)
Send-MailMessage -From '${safeUser}' -To '${safeTo}' -Subject '${safeSubject}' -Body '${safeBody}' -SmtpServer 'smtp.gmail.com' -Port 587 -UseSsl -Credential $cred
Write-Output 'Email sent successfully'`;

    const encoded = Buffer.from(cmd, 'utf16le').toString('base64');
    const { stdout, stderr } = await execAsync(
      `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
      { timeout: 30000 }
    );

    if (stderr && stderr.includes('Error')) {
      return { success: false, result: `Email failed: ${stderr.trim()}` };
    }

    return { success: true, result: `Email sent to ${to} with subject "${subject}"` };
  } catch (err) {
    return { success: false, result: `Email failed: ${err.message}` };
  }
}

// ─────────────────────────────────────────────────
// Tool Router
// ─────────────────────────────────────────────────
const TOOL_MAP = {
  open_app,
  open_website,
  type_text,
  press_key,
  mouse_click,
  run_command,
  set_timer,
  take_screenshot,
  show_notification,
  save_task,
  send_email,
  run_task,
  browser_open,
  browser_click,
  browser_type,
  browser_read,
  browser_close,
  list_windows,
  focus_window,
  close_app,
  search_files,
};

export async function executeTool(name, args) {
  const fn = TOOL_MAP[name];
  if (!fn) {
    return { success: false, result: `Unknown tool: ${name}` };
  }
  console.log(`[Niro] Executing tool: ${name}`, args);
  return await fn(args);
}
