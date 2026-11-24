# 🌌 Gravitational Spectrum

> *An ambient cinematic media engine, real-time audio spectrum, synced lyrics overlay, and glassmorphic workstation theme for Google Antigravity IDE.*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows-0078D6.svg)](#quick-start)

Gravitational Spectrum transforms your Antigravity IDE into a living studio workspace — extracting dominant colors from your music/videos in real time, driving a 48-bar Windows WASAPI audio spectrum behind frosted-glass panels, and syncing floating lyrics across YouTube, Spotify Desktop, TikTok, SoundCloud, and local media.

---

## ✨ Features

- **Real-Time WASAPI Ambient Spectrum:** Captures live Windows audio output (zero external dependencies) with a 16-band FFT across **48 interpolated bars** behind the glass (`Bottom`, `Middle`, or `Top`), plus a **Custom Spectrum Color Picker** (`Match ambient` or `Pick color`) and a **28-bar New Conversation Hero Spectrum** replacing the empty-state logo.
- **Smart Music Detection (`Auto | On | Off`):** Automatically detects music across Spotify Desktop, SoundCloud, TikTok (`music_info`), YouTube (`Music` category / lyrics / keywords), and local audio files while keeping non-music videos and wallpapers clean.
- **Universal Synced Lyrics:** Hybrid `LRCLIB` + pure-Node YouTube Timed Captions engine with **14 visual styles × 10 animations**, `1L / 2L / 3L Fade`, `Fixed / L-R / Random`, `Dual` mode, `Behind Chat`, per-track offset memory, and manual `Pick` switcher.
- **Multi-Platform Media Engine (Zero `yt-dlp` Required):**
  - **YouTube** videos, search, and playlists
  - **Spotify Desktop Live Sync** via Windows SMTC (Play/Pause/Next/Prev/Stop/Seek/Repeat + `Keep Video | Album Art | Custom BG`)
  - **TikTok** direct MP4 playback + automatic song metadata extraction
  - **SoundCloud & Spotify URLs** + **Local Folders** (`.mp4`, `.webm`, `.mp3`, `.flac`, `.wav`, images)
  - **Audio-Only Link Mode (`Link video: Off`):** Hide background video for web links to save RAM/GPU while keeping audio, ambient glow, spectrum, and lyrics active.
- **Three Layouts & Glassmorphism Profiles:** `Background`, `Split Side-Panel` (draggable sash), and `Floating PiP`, plus `Obsidian / Frosted / Clear / Neon` glass presets and a compact collapsible pill.

---

## 🚀 Quick Start (Windows)

1. Clone or download this repository.
2. Double-click **`Apply_Gravitational_Spectrum.bat`**.
   - Automatically restarts Antigravity with DevTools port `9222` if needed, starts the tokenized local bridge (`127.0.0.1:47831`), and injects the theme.
   - Uses Antigravity's built-in Electron Node runtime — **no separate Node.js or `yt-dlp` install required**.
3. To remove cleanly at any time, double-click **`Remove_Gravitational_Spectrum.bat`**.

---

## ⌨️ Global Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Alt + Shift + P` | Play / Pause |
| `Alt + Shift + M` | Mute / Unmute |
| `Alt + Shift + N` | Next Track |
| `Alt + Shift + B` | Previous Track |
| `Alt + Shift + L` | Toggle Synced Lyrics |
| `Alt + Shift + S` | Cycle Layout (`Background` → `Split` → `PiP`) |
| `Alt + Shift + H` | Hide / Show Controller (clean view for recording) |

---

## 📄 License

Released under the [MIT License](LICENSE).
