# Niro AI Agent 🤖

Niro is a high-performance, desktop-native AI companion that lives quietly at the top of your screen and assists with your daily workflow. It combines a sleek, modern panel UI with a powerful Electron-based agent that supports vision, tools, and voice commands.

## ✨ Key Features

- **Dual LLM Support**: Groq (fast, free tier) and Gemini (vision, multi-step reasoning) — user supplies their own API key, no hardcoded keys
- **Smart Guardrails**: Common queries (IP, RAM, disk, file search, notifications) are handled instantly without hitting the LLM — saving tokens and rate limits
- **Vision & Screenshots**: Gemini can take a screenshot and describe exactly what's on your screen
- **Voice Commands**: Integrated Speech-to-Text using **Groq Whisper** (`whisper-large-v3`)
- **System Automation**: Open apps, run PowerShell commands, set timers, manage windows, search files
- **AI Browser Automation**: Connects to your real Chrome browser via CDP — uses your actual logins and cookies
- **Invisible Sensor UI**: Hover at the top of your screen to trigger the panel — stays out of your way
- **Quick Tasks**: One-click preset task buttons for your most common actions
- **Modern Aesthetics**: Dark-mode design with glassmorphism and smooth micro-animations

## 🛠️ Tech Stack

### Desktop Agent
- **Framework**: Electron (Node.js, ESM)
- **AI Providers**: Google Gemini (`@google/genai`) · Groq (OpenAI-compatible REST)
- **Speech-to-Text**: Groq Whisper via multipart fetch
- **Browser Automation**: Playwright (headless fallback) + Chrome CDP (real browser)
- **System Automation**: PowerShell via `-EncodedCommand` (no quoting issues)
- **State Management**: `electron-store`

### Web Landing Page
- **Framework**: React 19 + Vite + TypeScript
- **Styling**: Tailwind CSS v4
- **Routing**: React Router v7

## 🚀 Getting Started

### Prerequisites
- **Node.js**: v18 or higher
- **Windows**: Required (PowerShell automation is Windows-only)
- **API Key**: Groq (free at [console.groq.com](https://console.groq.com)) or Gemini (free at [aistudio.google.com](https://aistudio.google.com))

### Installation

1. **Clone the repo**:
   ```bash
   git clone https://github.com/Dealer-09/CICADA3301_PS02.git
   cd CICADA3301_PS02
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Run in development mode**:
   ```bash
   npm run dev
   ```

4. **First launch**: Hover at the top-center of your screen → click ⚙️ Settings → add your API key

## 📦 Building for Production

```bash
npm run build
```

The installer (`Niro Setup 1.0.0.exe`) and portable executable (`win-unpacked/Niro.exe`) will be in the `dist/` folder.

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

### Available Tools (20+)

| Category | Tools |
|---|---|
| **Apps** | `open_app`, `close_app`, `focus_window`, `list_windows` |
| **Web** | `open_website`, `run_task` (AI browser), `browser_open/click/type/read` |
| **System** | `run_command` (PowerShell), `search_files`, `take_screenshot` |
| **Input** | `type_text`, `press_key`, `mouse_click` |
| **Utilities** | `set_timer`, `show_notification`, `save_task` |

## 💬 Sample Prompts

### Works on both providers
```
Open Notepad
Open the YouTube channel @mkbhd in my browser
Open the GitHub repo for microsoft/vscode
Set a 5 minute timer called focus session
Show me a notification saying "Time to drink water"
What is my public IP address?
How much RAM do I have and how much is free?
How much disk space is free on C drive?
Show me the top 5 processes using the most memory
Find all PDF files on my desktop
```

### Gemini only (vision + multi-step)
```
Take a screenshot and tell me what's on my screen
Show me my public IP, computer name, and Windows version all in one response
Open Notepad and show me a notification saying it worked
What is my CPU model and how many cores does it have?
```

## 📄 License
This project is part of the CICADA3301 series. All rights reserved.
