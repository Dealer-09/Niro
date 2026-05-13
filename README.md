# Niro AI Agent 🤖

Niro is a high-performance, desktop-native AI companion that lives quietly at the top of your screen and assists with your daily workflow. It combines a sleek, modern panel UI with a powerful Electron-based agent that supports vision, tools, and voice commands.

## ✨ Key Features

- **Dual LLM Support**: Groq (fast, free tier) and Gemini (vision, multi-step reasoning) — user supplies their own API key, no hardcoded keys
- **Smart Guardrails**: Common queries (IP, RAM, disk, file search, notifications) are handled instantly without hitting the LLM — saving tokens and rate limits
- **Vision & Screenshots**: Gemini can take a screenshot and describe exactly what's on your screen
- **Voice Commands**: Integrated Speech-to-Text using **Groq Whisper** (`whisper-large-v3`)
- **System Automation**: Open apps, run PowerShell commands, set timers, manage windows, search files
- **Writing Automation**: Write content directly into Notepad or any open app — no additional dependencies required
- **AI Browser Automation**: Connects to your real Chrome browser via CDP — uses your actual logins and cookies
- **Invisible Sensor UI**: Hover at the top of your screen to trigger the panel — stays out of your way
- **Quick Tasks**: One-click preset task buttons for your most common actions
- **Modern Aesthetics**: Dark-mode design with glassmorphism and smooth micro-animations

## 🛠️ Tech Stack

### Desktop Agent (`electron-app/`)
- **Framework**: Electron (Node.js, ESM)
- **AI Providers**: Google Gemini (`@google/genai`) · Groq (OpenAI-compatible REST)
- **Speech-to-Text**: Groq Whisper via multipart fetch
- **Browser Automation**: Playwright (headless fallback) + Chrome CDP (real browser)
- **System Automation**: PowerShell via `-EncodedCommand` (no quoting issues)
- **Writing Automation**: Windows `System.Windows.Forms.SendKeys` (built-in, zero deps) + temp-file Notepad approach
- **State Management**: `electron-store`

### Web Landing Page (`web/`)
- **Framework**: React 19 + Vite + TypeScript
- **Styling**: Tailwind CSS v4
- **Routing**: React Router v7

## 📁 Repository Structure

```
CICADA3301_PS02/
├── electron-app/       ← Desktop AI agent (Electron)
│   ├── main.js         (Electron entry point, IPC, windows)
│   ├── agent.js        (LLM orchestration, Groq + Gemini)
│   ├── tools.js        (All tool implementations)
│   ├── preload.cjs     (Secure contextBridge)
│   ├── tools/          (browser.js, chrome.js — CDP automation)
│   ├── renderer/       (Panel UI: HTML, CSS, JS)
│   ├── assets/         (App icon)
│   ├── build_assets/   (NSIS installer config)
│   └── package.json
│
└── web/                ← Landing page (React + Vite)
    ├── src/
    │   ├── Onboarding.tsx
    │   └── components/
    └── package.json
```

## 🚀 Getting Started

### Prerequisites
- **Node.js**: v18 or higher
- **Windows**: Required (PowerShell automation is Windows-only)
- **API Key**: Groq (free at [console.groq.com](https://console.groq.com)) or Gemini (free at [aistudio.google.com](https://aistudio.google.com))

### Installation

1. **Clone the repo**:
   ```bash
   git clone https://github.com/Dealer-09/Niro.git
   cd Niro
   ```

2. **Run the Desktop Agent**:
   ```bash
   cd electron-app
   npm install
   npm run dev
   ```

3. **Run the Web Landing Page** (optional):
   ```bash
   cd web
   npm install
   npm run dev
   ```

4. **First launch**: Hover at the top-center of your screen → click ⚙️ Settings → add your API key

## 📦 Building for Production

```bash
cd electron-app
npm run build
```

The installer (`Niro Setup 1.0.1.exe`) and portable executable (`win-unpacked/Niro.exe`) will be in `electron-app/dist/`.

## 🔑 API Keys

Niro uses **your own API keys** — no keys are bundled with the app.

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
