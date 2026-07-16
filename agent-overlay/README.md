# Agent Overlay

Desktop overlay tối giản cho **Grok / OpenCode**: animation particles khi AI đang generate, **ẩn hoàn toàn** khi idle.

**Stack:** Tauri 2 · Svelte 5 · Canvas 2D · HTTP localhost bridge  

**Hướng dẫn setup & dùng end-to-end (Windows + macOS, shim, autostart, `oc`):**  
→ **[`README-oc.md`](../README-oc.md)**

### Preview

<video src="../public/demo.mp4" controls width="720" title="Agent Overlay demo"></video>

[▶ Demo video (MP4)](../public/demo.mp4)

| Settings | Generating |
|:---:|:---:|
| ![Settings panel](../public/demo-1.png) | ![Warp particles](../public/demo-2.png) |

---

## Tính năng

| Tính năng | Mô tả |
|-----------|--------|
| **10 animation styles** | Hyperspace, Classic, Aurora, Neon rain, Embers, Comet, Spark, Orbit, Vortex, Datastream |
| **Style alpha** | Độ sáng particle **theo từng style** (0.15–1.5×), persist riêng |
| Particle field | Depth layers, trail, token → intensity; soft draw cho Datastream |
| Speed / direction | Settings: tốc độ, hướng (0–360°), spread (ẩn với style radial) |
| Idle hide | Window ẩn; tray luôn sẵn |
| Live OpenCode | Event `generation_start` / `tokens_update` / `generation_end` |
| HTTP server | `127.0.0.1:9876` — trong process Tauri |
| Tray | Show settings · Hide · Quit · double-click mở settings |
| Autostart | Plugin login startup (best-effort) |
| Single-instance | Mở lần 2 → focus settings, không nhân đôi process |
| Diagnostics | Recent events trong settings; `GET /events` |
| Persist | `localStorage` key `agent-overlay.settings` |

---

## Hành vi UI

| State | UI |
|-------|-----|
| Idle | Không hiện window |
| Generating | Particles full-bleed, không border/title/nút |
| Settings | Right-click / tray → glass panel từ phải |

### Settings panel

- **Animation style** (10 nút preset)  
- **Style alpha · {style}** (0.15–1.5×) + Reset  
- Show token count  
- Opacity (shell CSS)  
- Particle intensity  
- **Speed** (0.4×–2×)  
- **Motion direction** / **spread** (khi style hỗ trợ)  
- Bridge status + recent events  
- Test warp / Hide overlay  

### Animation styles

| Style | ID | Ghi chú |
|-------|-----|---------|
| Hyperspace | `tunnel` | Default · radial từ tâm · burst start |
| Classic | `streaks` | Directional streaks |
| Aurora | `aurora` | Curved soft glow |
| Neon rain | `rain` | Dense downward |
| Embers | `embers` | Warm rising, size grow |
| Comet | `comet` | Sparse long tails |
| Spark | `spark` | Short multi-origin bursts |
| Orbit | `orbit` | Rings around center |
| Vortex | `vortex` | Spiral out |
| Datastream | `datastream` | Lane packets · soft bloom (ít lóa) |

Style radial (Hyperspace / Spark / Orbit / Vortex): **ẩn** motion direction/spread.

---

## Dev

### Chạy

```powershell
cd C:\Work\Tool\agent-overlay
npm install
npm run tauri dev
```

Build production:

```powershell
# Windows → agent-overlay.exe (+ MSI/NSIS)
npm run tauri build
npm run check
```

```bash
# macOS → Agent Overlay.app
npm run tauri build
# → src-tauri/target/release/bundle/macos/Agent Overlay.app
```

> **Lưu ý:** `start-overlay.ps1` / `start-overlay.sh` ưu tiên **release** binary. Sau khi sửa UI/particles cần **`npm run tauri build`** rồi restart — không chỉ `vite build`.

| Launcher | Binary ưu tiên |
|----------|----------------|
| Windows `start-overlay.ps1` | `target/release/agent-overlay.exe` |
| macOS `start-overlay.sh` | `bundle/macos/Agent Overlay.app` → `target/release/agent-overlay` |

### Cấu trúc

```text
src/
  routes/+page.svelte              # → Overlay
  lib/components/
    Overlay.svelte                 # Surface trong suốt + r-click
    SettingsPanel.svelte           # Panel settings
    ParticleCanvas.svelte          # Host Canvas engine
    TokenCounter.svelte            # Optional
  lib/bridge/opencode.ts           # Listen Tauri events → store
  lib/stores/generation.svelte.ts  # State + style alpha + persist
  lib/particles/
    ParticleSystem.ts              # Engine (spawn modes + draw)
    presets.ts                     # STYLE_PRESETS + STYLE_ORDER
    config.ts                      # WARP tunables
    intensity.ts                   # token → intensity
    types.ts                       # AnimationStyle, Particle, …
src-tauri/
  src/event_server.rs              # tiny_http :9876
  src/lib.rs                       # tray, autostart, single-instance
  tauri.conf.json                  # transparent, alwaysOnTop, visible:false
```

### HTTP API (localhost only)

| Endpoint | Method | Body / response |
|----------|--------|-----------------|
| `/health` | GET | `{ ok, service, port }` |
| `/event` | POST | `{ "event": "generation_start\|tokens_update\|generation_end", "data": {} }` |
| `/events` | GET | `{ ok, events: [...] }` |

Ví dụ smoke test:

```powershell
Invoke-RestMethod http://127.0.0.1:9876/health

Invoke-RestMethod -Method POST http://127.0.0.1:9876/event `
  -ContentType "application/json" `
  -Body '{"event":"generation_start","data":{"model":"test"}}'
```

### Tunables particles

| File | Nội dung |
|------|----------|
| `config.ts` → `WARP` | speed, density, tunnel, orbit, stream lanes, glow |
| `presets.ts` | mỗi style: spawnMode, palette, softBloom, glowDrawMul, burst, … |
| Store (Settings) | `userIntensity`, `particleSpeed`, `motionAngle`, `motionSpread`, `styleAlpha[style]` |

Draw alpha (rút gọn):

```text
a ≈ particleAlpha × life × fade × glowScale × preset.glowDrawMul × userStyleAlpha
```

---

## Tích hợp OpenCode (tóm tắt)

| | Windows | macOS |
|--|---------|-------|
| Shim | `install-shim.ps1` | `install-shim.sh` |
| Autostart | `install-autostart.ps1` | `install-autostart.sh` |
| Profile | `profile-snippet.ps1` | `profile-snippet.zsh` |
| One-shot | `oc` / `oc.ps1` | `./oc.sh` / `oc` |

**Bridge** (`../opencode_bridge` — portable):

- `AGENT_TOOL_ROOT` = repo root (tự detect nếu chạy từ package)  
- OpenCode TUI thật (stdout inherit)  
- Log: `--print-logs` stderr + tail `~/.local/share/opencode/log`  
- Quiet console; verbose: `AGENT_BRIDGE_VERBOSE=1`

Chi tiết: **[README-oc.md](../README-oc.md)** (§3 Windows · §4 macOS).

---

## Troubleshooting nhanh

| Vấn đề | Xử lý |
|--------|--------|
| Health fail | `start-overlay.ps1 -Force` / tray Quit rồi start lại |
| Không particles khi generate | Bridge enable? Port 9876? Xem Recent events |
| Chat bị chữ `[EVENT]` | Cần bản bridge quiet; tắt `AGENT_BRIDGE_VERBOSE` |
| Không vào TUI OpenCode | Dùng `.exe` thật; không pipe stdout (đã fix trong runner) |
| Đổi code nhưng UI cũ | `npm run tauri build` + restart (đang chạy release exe) |
| Datastream vẫn lóa / quá mờ | Settings → **Style alpha · Datastream** |

---

## License

MIT
