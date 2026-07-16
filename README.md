# Grok Overlay for OpenCode

A sleek, transparent desktop overlay that automatically triggers a beautiful **Warp Speed** particle animation when using Grok through **[OpenCode](https://opencode.ai/)**.

### ✨ Features

- Auto show/hide animation when Grok is generating  
- Smooth, high-performance particle animation (Warp Speed style + **10 presets**: Hyperspace, Datastream, Orbit, …)  
- Fully transparent & draggable overlay  
- Works with your existing Grok / OpenCode setup (**no extra API key** needed)  
- Built with **Tauri** (Rust) + **Svelte**  
- Real-time monitoring via **Python** bridge (logs + SQLite token poll)  
- Token flow chips on the stream · per-style alpha · Windows & macOS  

### 🛠 Tech Stack

- Tauri 2 + Svelte 5  
- Python (OpenCode log / DB monitoring)  
- Canvas 2D particle system  

> ⚠️ Actively developed. Contributions and feedback are welcome!

> **Status:** stable for daily use — OpenCode TUI works normally, particles auto show/hide, no `[EVENT]` spam on chat (logs go to file / settings diagnostics).

### Preview

<video src="./public/demo.mp4" controls width="720" title="Agent Overlay demo"></video>

<p align="center">
  <a href="./public/demo.mp4">▶ Watch demo (MP4)</a>
</p>

| Settings panel | Generating (warp particles) |
|:---:|:---:|
| ![Settings — animation styles, alpha, speed](./public/demo-1.png) | ![Overlay particles while AI generates](./public/demo-2.png) |

- **demo-1** — Settings (styles, Style alpha, Token flow, intensity, speed, Test warp)  
- **demo-2** — Transparent overlay, full-bleed particles while generating  
- **demo.mp4** — End-to-end clip  

Media: [`public/`](./public/). Full setup guide (Windows + macOS) below.

---

## Mục lục / Full guide

1. [Tổng quan](#1-tổng-quan)
2. [Yêu cầu](#2-yêu-cầu)
3. [Setup Windows](#3-setup-windows)
4. [Setup macOS](#4-setup-macos)
5. [Dùng hàng ngày](#5-dùng-hàng-ngày)
6. [Settings overlay](#6-settings-overlay)
7. [Lệnh & API](#7-lệnh--api)
8. [Kiến trúc](#8-kiến-trúc)
9. [Cấu trúc thư mục](#9-cấu-trúc-thư-mục)
10. [Troubleshooting](#10-troubleshooting)
11. [Gỡ cài đặt](#11-gỡ-cài-đặt)

---

## 1. Tổng quan

**Agent Overlay** là cửa sổ desktop trong suốt (Tauri) hiển thị animation particles khi Grok/OpenCode đang generate. Có **nhiều style** (Hyperspace, Datastream, Orbit, …) và chỉnh **alpha theo style**.

| Trạng thái | Hành vi |
|------------|---------|
| **Idle** | Window **ẩn** — chỉ còn icon tray |
| **Generating** | Window hiện, **chỉ particles** (không chrome/debug UI) — xem [demo-2](./public/demo-2.png) |
| **Settings** | **Right-click** / tray → panel (style, alpha, speed, …) — xem [demo-1](./public/demo-1.png) |

Luồng tự động (Windows / macOS giống nhau):

```text
Login
  → start-overlay (autostart) → tray, window ẩn, HTTP :9876

Terminal
  → gõ: opencode   (hoặc oc)
  → shim → opencode_bridge → OpenCode TUI (thật)
  → generate
  → POST event → Overlay particles
  → generation_end → fade → ẩn window
```

| OS | Install / launcher | Shim |
|----|--------------------|------|
| **Windows** | `*.ps1`, `oc.cmd` | `shim\opencode.cmd` |
| **macOS** | `*.sh`, `oc.sh` | `shim/opencode` |

Env chung: `AGENT_TOOL_ROOT`, `OPENCODE_CMD`, `OPENCODE_REAL`, `TAURI_EVENT_URL`.

---

## 2. Yêu cầu

| Thành phần | Windows | macOS |
|------------|---------|-------|
| OS | Windows 10/11 (đã test) | macOS 12+ (Apple Silicon / Intel) |
| [Node.js](https://nodejs.org/) 18+ | ✓ | ✓ (`brew install node`) |
| [Rust](https://rustup.rs/) | + MSVC Build Tools | `rustup` + Xcode CLT |
| Python 3.x | `py -3` hoặc `python` | `python3` |
| [OpenCode](https://opencode.ai/) | `npm i -g opencode-ai` | cùng / brew |
| curl | — | có sẵn (health check scripts) |

Doc Windows dùng `C:\Work\Tool\`. Trên Mac: clone repo rồi `export AGENT_TOOL_ROOT=/path/to/Tool`.

---

## 3. Setup Windows

Làm **tuần tự**. Sau bước 2–4 nên **đóng hết terminal** rồi mở lại.

### Bước 1 — Build / chạy Overlay

```powershell
cd C:\Work\Tool\agent-overlay
npm install

# Production binary (khuyến nghị cho dùng thật)
npm run tauri build

# Hoặc dev (hot reload, chậm lần đầu)
# npm run tauri dev
```

Thành công: icon **Agent Overlay** trên system tray, window **ẩn**.

Kiểm tra HTTP bridge:

```powershell
Invoke-RestMethod http://127.0.0.1:9876/health
# Kỳ vọng: ok=true, service=agent-overlay, port=9876
```

Nếu chưa có exe release, `start-overlay.ps1` vẫn dùng `target\debug\agent-overlay.exe` nếu đã `tauri dev` / `cargo build` trước đó.

### Bước 2 — PATH shim (`opencode` = monitored)

```powershell
cd C:\Work\Tool
powershell -ExecutionPolicy Bypass -File .\install-shim.ps1
```

Script sẽ:

- Tìm **OpenCode thật** (ưu tiên `…\opencode-ai\bin\opencode.exe`)
- Ghi config: `C:\Work\Tool\.agent-bridge\config.json`
- Bật monitoring: `.agent-bridge\monitoring.enabled`
- Prepend `C:\Work\Tool\shim` (+ Tool root) vào **User PATH**

### Bước 3 — Autostart khi login (khuyến nghị)

```powershell
powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1
```

Optional — thêm daemon giữ overlay sống:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1 -WithDaemon
```

Tạo shortcut trong thư mục **Startup** của Windows.

### Bước 4 — Profile Warp / PowerShell

```powershell
notepad $PROFILE
```

Thêm:

```powershell
. C:\Work\Tool\profile-snippet.ps1
```

Lưu → **restart Warp / PowerShell**.

Profile cung cấp:

- `oc`, `Start-AgentOverlay`
- `Enable-AgentMonitor` / `Disable-AgentMonitor` / `Get-AgentStatus`
- PATH shim + Tool root trong session

### Bước 5 — Xác nhận

Trong **terminal mới**:

```powershell
where.exe opencode
# Dòng đầu: C:\Work\Tool\shim\opencode.cmd

Get-Content C:\Work\Tool\.agent-bridge\config.json
# opencode_cmd trỏ tới ...\opencode.exe (không phải shim)

Invoke-RestMethod http://127.0.0.1:9876/health

# Mở TUI (phải vào giao diện OpenCode, chat sạch)
opencode
```

---

## 4. Setup macOS

Làm trên MacBook (bash/zsh). Repo path ví dụ: `~/Tool` hoặc clone git.

### 4.1 Dependencies

```bash
# Xcode command line tools (nếu chưa)
xcode-select --install

# Node, Python (Homebrew)
brew install node python rustup
rustup default stable

# OpenCode
npm install -g opencode-ai
# hoặc theo hướng dẫn opencode.ai
```

### 4.2 Build Overlay

```bash
export AGENT_TOOL_ROOT=/path/to/Tool   # thư mục chứa opencode_bridge + agent-overlay
cd "$AGENT_TOOL_ROOT/agent-overlay"
npm install
npm run tauri build
# → …/src-tauri/target/release/bundle/macos/Agent Overlay.app
```

Dev (hot reload):

```bash
npm run tauri dev
```

### 4.3 Shim + PATH

```bash
cd "$AGENT_TOOL_ROOT"
chmod +x start-overlay.sh oc.sh install-shim.sh install-autostart.sh shim/opencode
./install-shim.sh
```

Script sẽ:

- Tìm **OpenCode thật** (PATH, npm global, Homebrew)
- Ghi `.agent-bridge/config.json`
- Thêm `shim` + `AGENT_TOOL_ROOT` vào `~/.zshrc` (hoặc `.bashrc`)

```bash
source ~/.zshrc
which opencode
# …/Tool/shim/opencode
```

### 4.4 Autostart (tuỳ chọn)

```bash
./install-autostart.sh
# LaunchAgent: ~/Library/LaunchAgents/com.agent.overlay.plist
```

### 4.5 Profile helpers (tuỳ chọn)

```bash
# ~/.zshrc
export AGENT_TOOL_ROOT=/path/to/Tool
source $AGENT_TOOL_ROOT/profile-snippet.zsh
```

Helpers: `oc`, `start-agent-overlay`, `enable-agent-monitor`, `get-agent-status`.

### 4.6 Xác nhận

```bash
./start-overlay.sh
curl -s http://127.0.0.1:9876/health
# {"ok":true,"service":"agent-overlay",…}

opencode
# hoặc: ./oc.sh
```

### 4.7 Workaround không install shim

```bash
export AGENT_TOOL_ROOT=/path/to/Tool
export OPENCODE_CMD="$(command -v opencode)"  # binary thật, trước khi prepend shim
cd "$AGENT_TOOL_ROOT"
./start-overlay.sh
python3 -m opencode_bridge run
```

---

## 5. Dùng hàng ngày

### 5.1 Luồng chuẩn

1. Login → overlay chạy nền (tray) nếu đã autostart.  
2. Mở terminal.  
3. Chạy:

```powershell
opencode
```

hoặc:

```powershell
oc
```

4. Làm việc / generate với **Grok** như bình thường.  
5. Overlay **tự hiện** khi generate, **tự ẩn** khi xong.  
6. **Không** còn dòng `[EVENT] …` đè lên ô chat (đã tắt print console).

### 5.2 Phân biệt lệnh

| Lệnh | Ý nghĩa |
|------|---------|
| `opencode` / `oc` | Mở **TUI interactive** (+ monitor overlay) |
| `opencode run "prompt"` / `oc run "prompt"` | Chạy **một prompt** non-interactive |
| `oc "hello"` | OpenCode hiểu `"hello"` là **project path**, **không** phải nội dung chat |

### 5.3 Tray menu

| Mục | Việc |
|-----|------|
| **Show settings** / double-click tray | Hiện window + mở panel settings |
| **Hide overlay** | Ẩn window |
| **Quit** | Thoát app |

### 5.4 Debug verbose (tuỳ chọn)

Mặc định **im lặng** trên console để không phá TUI. Muốn xem log event trên terminal:

```powershell
# Windows
$env:AGENT_BRIDGE_VERBOSE = "1"
opencode
```

```bash
# macOS
export AGENT_BRIDGE_VERBOSE=1
opencode
```

Event vẫn luôn được ghi vào:

- `$AGENT_TOOL_ROOT/.agent-bridge/last_events.jsonl` (Win: `C:\Work\Tool\…`)
- Settings → **Recent events**
- `GET http://127.0.0.1:9876/events`

### 5.5 Test overlay không cần OpenCode

```powershell
# Windows
Invoke-RestMethod -Method POST http://127.0.0.1:9876/event `
  -ContentType "application/json" `
  -Body '{"event":"generation_start","data":{"model":"test","provider":"xai"}}'
```

```bash
# macOS
curl -s -X POST http://127.0.0.1:9876/event \
  -H "Content-Type: application/json" \
  -d '{"event":"generation_start","data":{"model":"test","provider":"xai"}}'
```

Hoặc tray → Show settings → **Test warp**.

---

## 6. Settings overlay

Mở panel: **Right-click** lên overlay (khi đang generate) · tray → **Show settings** · double-click tray.

Settings được **persist** trong `localStorage` (`agent-overlay.settings`) — style, alpha từng style, opacity, intensity, speed, hướng.

| Setting | Phạm vi | Mặc định | Ý nghĩa |
|---------|---------|----------|---------|
| **Animation style** | 10 presets | Hyperspace | Kiểu particle field |
| **Style alpha** | 0.15–1.5× | 1× | Độ sáng particle **của style đang chọn** (nhớ riêng từng style) |
| **Token flow on stream** | on/off | **on** | Chip `+N` / total trôi theo particle stream khi token tăng |
| Show token count | on/off | off | Số token tĩnh giữa màn (bổ sung) |
| Opacity | 25–100% | 100% | Độ mờ **shell** (cả cửa sổ) |
| Particle intensity | 0.35–1.5× | 1× | Mật độ / độ mạnh field (kết hợp token) |
| **Speed** | 0.4–2× | 1× | Tốc độ particle |
| **Motion direction** | 0–360° + preset | theo style | Hướng chính (ẩn với style radial) |
| **Motion spread** | 0–60° | theo style | Độ xòe (ẩn với style radial) |
| Test warp | — | — | Bật/tắt animation tay |
| Hide overlay | — | — | Ẩn window |
| Recent events | — | — | Log event gần đây |
| OpenCode bridge status | — | — | Port / model / generating |

**Phân biệt Opacity vs Style alpha**

| Control | Tác động |
|---------|----------|
| Opacity | CSS cả window (mờ toàn shell) |
| Style alpha | Chỉ độ sáng/alpha **particle** style hiện tại |
| Particle intensity | Mật độ + strength field (token-driven) |

### 6.1 Animation styles

| Style | ID | Mô tả | Direction UI |
|-------|-----|--------|--------------|
| **Hyperspace** | `tunnel` | Radial từ tâm, burst lúc start (default) | Ẩn (radial) |
| **Classic** | `streaks` | Streaks theo hướng | Hiện |
| **Aurora** | `aurora` | Cong, glow mềm | Hiện |
| **Neon rain** | `rain` | Mưa dọc, mật độ cao | Hiện (mặc định ↓) |
| **Embers** | `embers` | Tàn lửa bay lên, size to dần | Hiện (mặc định ↑) |
| **Comet** | `comet` | Ít particle, đuôi dài | Hiện |
| **Spark** | `spark` | Nổ ngắn từ nhiều điểm | Ẩn |
| **Orbit** | `orbit` | Vòng quanh tâm | Ẩn |
| **Vortex** | `vortex` | Xoáy bung ra | Ẩn |
| **Datastream** | `datastream` | Làn packet (data flow), soft bloom | Hiện (mặc định →) |

- **Style alpha · {tên}**: chỉnh riêng style đang chọn; nút **Reset** → 1.0×.  
- Datastream dùng draw “soft” (ít bloom) — nếu vẫn sáng/tối, chỉnh **Style alpha**.

### 6.2 Hướng chuyển động (degrees, canvas)

Chỉ áp dụng style **không** ẩn motion (Classic, Aurora, Rain, Embers, Comet, Datastream).

| Góc | Hướng |
|-----|--------|
| **270°** | ↑ Lên |
| **0°** | → Phải |
| **90°** | ↓ Xuống |
| **180°** | ← Trái |

- Spread **thấp** (6–15°): tia/làn gọn.  
- Spread **cao** (30–45°): tỏa rộng.

Preset nút: **↑ Up / → Right / ↓ Down / ← Left**.

---

## 7. Lệnh & API

### 7.1 CLI bridge (`opencode_bridge`)

Từ repo root (set `PYTHONPATH` hoặc `cd` vào root):

```powershell
# Windows
cd C:\Work\Tool
py -3 -m opencode_bridge status
py -3 -m opencode_bridge enable
py -3 -m opencode_bridge disable
py -3 -m opencode_bridge run
py -3 -m opencode_bridge daemon
```

```bash
# macOS
cd "$AGENT_TOOL_ROOT"
python3 -m opencode_bridge status
python3 -m opencode_bridge enable|disable|run|daemon
```

Profile helpers:

| Windows (`profile-snippet.ps1`) | macOS (`profile-snippet.zsh`) |
|---------------------------------|-------------------------------|
| `Get-AgentStatus` | `get-agent-status` |
| `Enable-AgentMonitor` | `enable-agent-monitor` |
| `Disable-AgentMonitor` | `disable-agent-monitor` |
| `Start-AgentOverlay` | `start-agent-overlay` |
| `oc` | `oc` |

### 7.2 Launcher scripts

| Windows | macOS | Việc |
|---------|-------|------|
| `oc.cmd` / `oc.ps1` | `oc.sh` | Health overlay → bridge run |
| `start-overlay.ps1` | `start-overlay.sh` | Chỉ bật overlay |
| `install-shim.ps1` | `install-shim.sh` | PATH shim |
| `install-autostart.ps1` | `install-autostart.sh` | Login autostart |
| `profile-snippet.ps1` | `profile-snippet.zsh` | Shell helpers |
| `shim\opencode.cmd` | `shim/opencode` | Intercept `opencode` |

### 7.3 Biến môi trường

| Biến | Ý nghĩa |
|------|---------|
| `AGENT_TOOL_ROOT` | Root repo (chứa `opencode_bridge`, `agent-overlay`) |
| `AGENT_BRIDGE_STATE` | Thư mục state (mặc định `$ROOT/.agent-bridge`) |
| `OPENCODE_CMD` / `OPENCODE_REAL` | Binary OpenCode thật |
| `TAURI_EVENT_URL` | Mặc định `http://127.0.0.1:9876/event` |
| `AGENT_OVERLAY_HEALTH` | Mặc định `http://127.0.0.1:9876/health` |
| `AGENT_OPENCODE_SHIM_DIR` | Shim dir (strip khỏi PATH child process) |
| `AGENT_BRIDGE_VERBOSE` | `1` = log event ra stderr |

### 7.4 HTTP API (trong process Tauri)

Base: `http://127.0.0.1:9876` (chỉ localhost)

| Endpoint | Method | Mô tả |
|----------|--------|--------|
| `/health` | GET | Liveness |
| `/event` | POST | Nhận event từ monitor |
| `/events` | GET | Ring buffer event (diagnostics) |

**Payload event:**

```json
{
  "event": "generation_start",
  "timestamp": "2026-07-16T00:00:00",
  "data": {
    "provider": "xai",
    "model": "grok-4.5",
    "session_id": "ses_xxx"
  }
}
```

| `event` | Hành vi overlay |
|---------|-----------------|
| `generation_start` | Show window, start particles, reset token counter |
| `tokens_update` | Cập nhật intensity (`output + reasoning`) — **poll SQLite OpenCode** khi generate |
| `generation_end` | Stop particles, ẩn window sau fade (~0.9s+, có min-visible) |

**Token realtime:** log INFO không còn emit `tokens.*` giữa stream. Bridge poll `~/.local/share/opencode/opencode.db` (message + stream estimate + session delta) mỗi ~0.4s khi `generation_start` có `session_id`. Override path: `OPENCODE_DB`.

---

## 8. Kiến trúc

### 8.1 Sơ đồ

```text
┌─────────────────────────────────────────────────────────┐
│  Agent Overlay (Tauri 2 + Svelte 5)                     │
│  • Tray + autostart + single-instance                   │
│  • HTTP 127.0.0.1:9876  (/health /event /events)        │
│  • Canvas particles (10 styles) + Settings + style alpha│
└──────────────────────────▲──────────────────────────────┘
                           │ POST JSON events
┌──────────────────────────┴──────────────────────────────┐
│  opencode_bridge (Python)                               │
│  • detect: parse log stream / file                      │
│  • emit: HTTP + last_events.jsonl (im lặng trên TUI)    │
│  • runner: OpenCode TUI thật (stdout inherit)           │
│           + --print-logs trên stderr + tail log file    │
└──────────────────────────▲──────────────────────────────┘
                           │
              shim (opencode.cmd | opencode)  hoặc  oc
                           │
                    OpenCode binary (TUI)
```

### 8.2 Vì sao TUI không bị vỡ

| Sai (cũ) | Đúng (hiện tại) |
|----------|------------------|
| `stdout=PIPE` → OpenCode không vào UI | **stdout/stdin inherit** → TUI đầy đủ |
| `print([EVENT])` đè chat | **Không print** console; log file + overlay panel |
| Binary mơ hồ / shim đệ quy | Ưu tiên **binary thật**; strip shim khỏi PATH child |

Detect generation:

1. Ưu tiên: stderr với `--print-logs --log-level INFO` (`message=stream` → start)  
2. Fallback: tail `~/.local/share/opencode/log/`  
3. **Tokens:** poll `opencode.db` (không dựa log `tokens.*` — hiện luôn 0 trên INFO)

Bỏ qua stream `small=true` (title helper); nhận mọi `providerID` (xai, aibox, …).

### 8.3 Kill switch

```bash
python3 -m opencode_bridge disable   # hoặc py -3 trên Windows
python3 -m opencode_bridge enable
```

File: `$AGENT_TOOL_ROOT/.agent-bridge/monitoring.enabled` (`1` / `0`).

### 8.4 Cross-platform notes

| Thành phần | Portable? |
|------------|-----------|
| `opencode_bridge` (Python) | Có — `TOOL_ROOT` từ env hoặc repo parent |
| Overlay UI (Svelte) | Có — build per OS |
| Tauri tray / transparent | Có — mac cần `macOSPrivateApi` (đã bật) |
| Install scripts | Tách: `.ps1` Win · `.sh` mac |

---

## 9. Cấu trúc thư mục

```text
Tool/   (AGENT_TOOL_ROOT)
├── README-oc.md
├── public/                     # demo media (README)
│   ├── demo.mp4
│   ├── demo-1.png              # Settings panel
│   └── demo-2.png              # Generating particles
├── oc.cmd / oc.ps1 / oc.sh
├── start-overlay.ps1 / .bat / start-overlay.sh
├── install-shim.ps1 / install-shim.sh
├── install-autostart.ps1 / install-autostart.sh
├── profile-snippet.ps1 / profile-snippet.zsh
├── opencode_monitor.py
├── opencode_bridge/            # Python (cross-platform)
│   ├── config.py               # TOOL_ROOT portable
│   ├── runner.py               # resolve binary Win/mac
│   ├── detect.py / emit.py / daemon.py / db_tokens.py
├── shim/
│   ├── opencode.cmd / opencode.ps1   # Windows
│   └── opencode                      # macOS / Linux
├── .agent-bridge/              # config, status, logs
└── agent-overlay/              # Tauri app
    ├── src/                    # Svelte + particles
    └── src-tauri/
```

---

## 10. Troubleshooting

| Triệu chứng | Cách xử |
|-------------|---------|
| `where`/`which opencode` không ra shim | Chạy lại `install-shim` (.ps1 / .sh), **mở terminal mới** |
| Chỉ in path rồi thoát, không vào TUI | Binary thật trong `config.json`; không pipe stdout |
| Vào TUI nhưng **chat bị đè `[EVENT]`** | Quiet default; tắt `AGENT_BRIDGE_VERBOSE` |
| Generate nhưng **không có particles** | Health `:9876`; tray còn sống? `enable` monitoring? |
| Overlay không tự bật | `start-overlay` + `install-autostart` |
| Path OpenCode sai | Sửa `opencode_cmd` trong `.agent-bridge/config.json` |
| Python không chạy | Win: `py -3`; Mac: `python3` |
| Hai instance overlay | Single-instance: lần 2 mở settings |
| Port 9876 bận | Tắt process overlay; hoặc đổi port (khớp URL monitor) |
| Mac: không tìm thấy `.app` | `cd agent-overlay && npm run tauri build` |
| Mac: transparent/tray lạ | Đã bật `macOSPrivateApi`; thử `tauri dev` log |
| Win: đổi code UI nhưng bản cũ | `npm run tauri build` + restart (release exe) |

### Kiểm tra nhanh health + event log

```powershell
Invoke-RestMethod http://127.0.0.1:9876/health
Invoke-RestMethod http://127.0.0.1:9876/events
Get-Content C:\Work\Tool\.agent-bridge\last_events.jsonl -Tail 10
py -3 -m opencode_bridge status
```

---

## 11. Gỡ cài đặt

```powershell
# Windows
powershell -File C:\Work\Tool\install-shim.ps1 -Uninstall
powershell -File C:\Work\Tool\install-autostart.ps1 -Uninstall
# Tray → Quit
# Remove-Item -Recurse C:\Work\Tool\.agent-bridge
```

```bash
# macOS
./install-shim.sh --uninstall
./install-autostart.sh --uninstall
# Tray → Quit
# rm -rf "$AGENT_TOOL_ROOT/.agent-bridge"
```

Gỡ dòng `source …/profile-snippet` trong shell profile nếu đã thêm.

---

## Dev overlay (developer)

```powershell
cd C:\Work\Tool\agent-overlay
npm install
npm run tauri dev
npm run check
# Sau khi đổi UI/particles: npm run tauri build rồi restart overlay
# (start-overlay.ps1 ưu tiên release exe — dev source không tự hot-reload bản release)
```

| File | Việc |
|------|------|
| `src/lib/particles/config.ts` | Tunables `WARP` (speed, density, tunnel, lanes, …) |
| `src/lib/particles/presets.ts` | 10 animation styles + palette / softBloom |
| `src/lib/particles/ParticleSystem.ts` | Engine spawn/update/draw |
| `src/lib/stores/generation.svelte.ts` | State, style alpha map, localStorage |
| `src/lib/components/SettingsPanel.svelte` | UI settings |
| `src/lib/bridge/opencode.ts` | Listen Tauri events |
| `src-tauri/src/event_server.rs` | HTTP `:9876` |

Chi tiết app: [`agent-overlay/README.md`](./agent-overlay/README.md).
