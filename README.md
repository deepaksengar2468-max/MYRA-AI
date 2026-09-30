# MYRAA — Windows Desktop Application & Production Installer

**MYRAA** is an installable, ultra-natural real-time AI companion and Windows desktop assistant built with **Electron**, **React 19**, **TypeScript**, and Google Gemini Multimodal Live technology.

MYRAA runs natively on your physical Windows PC with real computer automation, Live Vision, low-latency voice, and system tray integration.

---

## 🏗️ Architecture Overview

```text
Myraa Desktop
│
├── Electron Main Process   (electron/main.ts, electron/main.cjs)
│   ├── Native Windows host & frameless window lifecycle
│   ├── Windows System Tray integration (Open, Toggle Voice, Toggle Vision, Settings, Exit)
│   ├── Global Shortcut (Ctrl + Shift + M)
│   ├── Auto-start with Windows (app.setLoginItemSettings)
│   └── Secure IPC Bridge (contextIsolation: true, nodeIntegration: false)
│
├── Secure Preload Layer    (electron/preload.ts, electron/preload.cjs)
│   ├── window.myraa.desktop & window.myraaDesktop
│   └── Strictly validates IPC channels; never exposes Node internals
│
├── React Renderer          (src/)
│   ├── Real-time holographic visualizer
│   ├── Live Vision Camera HUD & Screen Understanding panel
│   ├── Streaming chat & audio session manager
│   ├── Windows Computer Control action monitor
│   ├── Memory dashboard & Voice persona studio
│   └── Comprehensive Settings Modal
│
├── Myraa Local Agent & Services (services/, tools/)
│   ├── AI Service Layer (services/aiProvider.ts)
│   ├── Voice Service (services/voiceService.ts)
│   ├── Vision Service (services/visionService.ts)
│   ├── Computer Control Tools (services/computerControlService.ts)
│   ├── File System Tools (services/fileService.ts)
│   ├── Safe Messaging Service (services/messagingService.ts)
│   ├── Update Service Abstraction (services/updateService.ts)
│   └── Local Audit Logger (services/loggerService.ts -> logs/myraa.log)
│
└── Windows Packaging       (electron-builder.yml, electron-builder.json)
    ├── Output: release/Myraa Setup.exe
    └── Creates Start Menu shortcut, Desktop shortcut, and uninstaller
```

---

## 🚀 How to Build `Myraa Setup.exe` on Your Windows PC

Follow these 7 steps to package MYRAA into an installer and run it as a standard Windows program:

### 1. Export / Download the Project
You can download the project in either of two ways:
- **Method A (Direct in App):** Click **Settings** in the Myraa desktop interface -> go to **Windows App & Tray** tab -> click **Download ZIP**. This generates and downloads `myraa-windows-source.zip` directly through the running application.
- **Method B (AI Studio UI):** Click the **Export** / **Download Code** button in the top header of AI Studio.
- **Method C (CLI Script):** Run `npm run export:zip` in your terminal to create `release/myraa-windows-source.zip`.

Extract the downloaded zip file to a directory on your Windows PC (e.g., `C:\Projects\Myraa`).

### 2. Install Node.js & Dependencies
Make sure you have **Node.js 20+** installed on Windows ([nodejs.org](https://nodejs.org)).
Open PowerShell or Windows Terminal in the project directory:

```powershell
cd C:\Projects\Myraa
npm install
```

### 3. Configure Environment Variables (`.env`)
Copy `.env.example` to `.env` in the root folder:

```powershell
cp .env.example .env
```

Open `.env` in any text editor and supply your Gemini API key:

```env
GEMINI_API_KEY=
AI_MODEL="gemini-3.8-flash"
PORT=3000
```

> **Security Note:** Your API keys stay on your local computer in `.env` and are handled only by the local backend process. They are never hardcoded or exposed in public code.

### 4. Run Development Mode
To test Myraa in development on Windows with live reload:

```powershell
# Starts the local backend server & Vite
npm run dev
```

In a second terminal window (or run together):
```powershell
npm run dev:electron
```

### 5. Build Production Binaries
Compile the React frontend and server:

```powershell
npm run build
```

This generates:
- `dist/` — Optimized production web client
- `dist/server.cjs` — Bundled local agent backend

### 6. Package into `Myraa Setup.exe`
Run the Windows packaging script:

```powershell
npm run dist:win
```

Electron Builder will package the application using the NSIS Windows installer engine and the high-resolution icon in `build/icon.ico`.

### 7. Locate and Run the Installer
Once the build completes, your installer is generated in the **`release/`** directory:

```text
release/
├── Myraa Setup.exe       <-- DOUBLE-CLICK THIS TO INSTALL
├── Myraa-1.0.0.exe
└── win-unpacked/
    └── Myraa.exe
```

When you run `Myraa Setup.exe`:
1. It installs Myraa into your Windows user apps directory.
2. It adds a **Myraa AI Assistant** shortcut to your Windows **Start Menu**.
3. It creates a shortcut on your **Desktop**.
4. It registers the Windows **Uninstaller** in Windows Settings -> Apps.
5. It launches Myraa immediately upon completion.

---

## 🖥️ Desktop Features & Controls

| Feature | Description |
| :--- | :--- |
| **System Tray** | Right-click the Myraa icon in your Windows taskbar tray to Open, Toggle Voice, Toggle Vision, Open Settings, or Exit. |
| **Summon Hotkey** | Press <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>M</kbd> anywhere in Windows to bring Myraa to the foreground. |
| **Live Vision** | Explicit camera permission gate. Real-time visual analysis of objects, documents, screens, or webcam feeds. Includes an instant Emergency Stop. |
| **Computer Control** | Launch applications (`Chrome`, `VS Code`, `Spotify`, etc.), take screenshots, simulate mouse and keyboard, control volume, and query running processes. |
| **File Safety** | Read, create, search, and manage local files with automatic path validation. Destructive operations (delete, overwrite) require confirmation. |
| **Safe Messaging** | Prepares drafts for WhatsApp, Telegram, or Discord. Always displays Platform, Recipient, and Message content for confirmation before dispatch. |
| **Auto-Start** | Enable *"Start Myraa with Windows"* in Settings to have Myraa launch automatically on PC boot (OFF by default). |
| **Audit Logging** | Local runtime logs are sanitized and saved to `logs/myraa.log`. |

---

## 🛡️ Security Architecture

- **`contextIsolation: true`** — Prevents web code from directly accessing Node.js internals.
- **`nodeIntegration: false`** — Eliminates renderer-based script injection attacks.
- **Strict IPC Layer** — Only explicitly whitelisted functions are exposed via `window.myraa.desktop`.
- **Protected Processes** — Critical Windows system processes (`explorer.exe`, `dwm.exe`, `svchost.exe`, etc.) are protected from termination.
- **White-Screen Protection** — If an optional service (such as webcam or microphone) is unavailable, Myraa automatically degrades gracefully to text mode without crashing.
