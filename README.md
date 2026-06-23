# Niro AI Agent 🤖

Niro is a high-performance, desktop-native AI companion that lives quietly at the top of your screen and assists with your daily workflow. It combines a sleek, modern panel UI with a powerful Tauri + Rust agent that supports vision, tools, and voice commands.

## ✨ Key Features

- **Dual LLM Support**: Groq (fast, free tier) and Gemini (vision, multi-step reasoning) — user supplies their own API key, no hardcoded keys
- **Smart Guardrails**: Common queries (IP, RAM, disk, file search, notifications) are handled instantly without hitting the LLM — saving tokens and rate limits
- **Vision & Screenshots**: Gemini can take a screenshot and describe exactly what's on your screen
- **Voice Commands**: Integrated Speech-to-Text using **Groq Whisper** (`whisper-large-v3-turbo`)
- **System Automation**: Open apps, run PowerShell commands, set timers, manage windows, search files
- **Writing Automation**: Write content directly into Notepad or any open app — no additional dependencies required
- **AI Browser Automation**: Connects to your real Chrome browser via CDP — uses your actual logins and cookies
- **Invisible Sensor UI**: Hover at the top of your screen to trigger the panel — stays out of your way
- **Quick Tasks**: One-click preset task buttons for your most common actions
- **Modern Aesthetics**: Dark-mode design with glassmorphism and smooth micro-animations

## 🛠️ Tech Stack

### Desktop Agent (`tauri-app/`) — current
- **Framework**: Tauri v2 (Rust backend + Svelte frontend, Vite)
- **AI Providers**: Google Gemini (REST `generateContent`) · Groq (OpenAI-compatible REST), via `reqwest`
- **Speech-to-Text**: Groq Whisper via multipart upload
- **Browser Automation**: Chrome DevTools Protocol over WebSocket (Brave → Edge → Chrome, real browser)
- **System Automation**: PowerShell via `-EncodedCommand` (no quoting issues)
- **Writing Automation**: Windows `System.Windows.Forms.SendKeys` + temp-file Notepad approach; key/mouse input via `enigo`
- **Secrets**: API keys + Gmail App Password stored in the OS keychain (Windows Credential Manager), not on disk
- **State Management**: `tauri-plugin-store` (non-secret settings + chat history)

> The original Electron implementation lives in `electron-app/` and is kept for reference only — the Tauri app is a 1:1 port and the active codebase.

### Web Landing Page (`web/`)
- **Framework**: React 19 + Vite + TypeScript
- **Styling**: Tailwind CSS v4
- **Routing**: React Router v7

## 📁 Repository Structure

```
CICADA3301_PS02/
├── tauri-app/          ← Desktop AI agent (Tauri v2) — current
│   ├── src/            (Svelte UI: Panel.svelte, Settings.svelte)
│   ├── public/         (sensor.html — invisible hover strip)
│   └── src-tauri/
│       ├── src/
│       │   ├── main.rs      (entry point, tray, windows, plugins)
│       │   ├── commands.rs  (IPC command handlers)
│       │   ├── agent.rs     (LLM orchestration, Groq + Gemini)
│       │   ├── tools.rs     (all tool implementations)
│       │   ├── browser.rs   (CDP browser automation)
│       │   └── store.rs     (settings + keychain + chat history)
│       └── tauri.conf.json
│
├── electron-app/       ← Legacy Electron implementation (reference only)
│
└── web/                ← Landing page (React + Vite)
    ├── src/
    │   ├── Onboarding.tsx
    │   └── components/
    └── package.json
```

## 🚀 Getting Started

### Prerequisites
- **Bun**: v1.3+ ([bun.sh](https://bun.sh)) — the workspace package manager/runtime
- **Rust**: stable toolchain via [rustup](https://rustup.rs) + [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) (WebView2, MSVC build tools)
- **Windows**: Required (PowerShell automation is Windows-only)
- **API Key**: Groq (free at [console.groq.com](https://console.groq.com)) or Gemini (free at [aistudio.google.com](https://aistudio.google.com))

### Installation

1. **Clone the repo**:
   ```bash
   git clone https://github.com/Dealer-09/Niro.git
   cd Niro
   ```

2. **Run the Desktop Agent** (requires the [Rust toolchain](https://rustup.rs) + [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)):
   ```bash
   cd tauri-app
   bun install
   bun run tauri dev
   ```

3. **Run the Web Landing Page** (optional):
   ```bash
   cd web
   bun install
   bun run dev
   ```

4. **First launch**: Hover at the top-center of your screen → click ⚙️ Settings → add your API key

## 📦 Building for Production

```bash
cd tauri-app
bun run tauri build
```

The NSIS installer and `.exe` are emitted under `tauri-app/src-tauri/target/release/bundle/`.

## 🔑 API Keys

Niro uses **your own API keys** — no keys are bundled with the app. Keys and the Gmail App Password are stored in the **OS keychain** (Windows Credential Manager), not in any plaintext file.

| Provider | Where to get | Used for |
|---|---|---|
| **Groq** | [console.groq.com](https://console.groq.com) | Chat (Groq mode) + Voice transcription |
| **Gemini** | [aistudio.google.com](https://aistudio.google.com) | Chat (Gemini mode) + Screenshot vision + Browser automation |

Both have generous free tiers. Groq is faster for simple tasks; Gemini is better for vision and multi-step reasoning.

## 🧠 How It Works

```
User message
    │
    ├─ Guardrail match? (IP, RAM, disk, files, notifications, GitHub URLs...)
    │   └─ Execute directly — no LLM call, instant response
    │
    └─ No match → LLM (Groq or Gemini) with tool declarations
        └─ Model selects tools → agent executes → result returned
```

### Available Tools (22+)

| Category | Tools |
|---|---|
| **Apps** | `open_app`, `close_app`, `focus_window`, `list_windows` |
| **Web** | `open_website`, `run_task` (AI browser), `browser_open/click/type/read/close` |
| **System** | `run_command` (PowerShell), `search_files`, `take_screenshot` |
| **Writing** | `write_to_notepad`, `write_to_app`, `type_text`, `press_key`, `mouse_click` |
| **Utilities** | `set_timer`, `show_notification`, `save_task`, `send_email` |

> **Writing Tools**: `write_to_notepad` and `write_to_app` work out of the box using Windows built-in `SendKeys` — no native compilation needed. `type_text`, `press_key`, and `mouse_click` optionally use `@jitsi/robotjs` for faster input, with automatic fallback if it's not installed.


## 📄 License
This project is part of the CICADA3301 series. All rights reserved.
