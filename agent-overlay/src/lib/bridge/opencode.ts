/**
 * Frontend bridge: Tauri events from the localhost HTTP server → generation store.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  clearLiveSession,
  closeSettings,
  generation,
  openSettings,
  pushRecentEvent,
  setBridgeReady,
  stopGeneration,
  trackOpencodeEnd,
  trackOpencodeStart,
  updateOpencodeTokens,
} from "$lib/stores/generation.svelte";
import type {
  GenerationEndData,
  GenerationStartData,
  ServerReadyPayload,
  TokenBreakdown,
} from "$lib/types";

/** Match particle fade-out before hiding the window */
const HIDE_AFTER_END_MS = 900;

let started = false;
const unlistens: UnlistenFn[] = [];
let hideTimer: ReturnType<typeof setTimeout> | null = null;
/** Timestamp of last live generation_start (for min-visible debounce) */
let lastStartAt = 0;
let onStaleCleared: (() => void) | null = null;

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

export function aggregateTokens(data: unknown): number {
  if (data == null) return 0;
  if (typeof data === "number" && Number.isFinite(data)) {
    return Math.max(0, Math.floor(data));
  }
  if (typeof data !== "object") return 0;

  const obj = data as TokenBreakdown;

  if (obj.final_tokens && typeof obj.final_tokens === "object") {
    return aggregateTokens(obj.final_tokens);
  }

  if (typeof obj.total === "number") return Math.max(0, Math.floor(obj.total));
  if (typeof obj.tokens === "number") return Math.max(0, Math.floor(obj.tokens));

  const output = num(obj.output);
  const reasoning = num(obj.reasoning);
  if (output > 0 || reasoning > 0) return output + reasoning;

  // Ignore metadata strings like source=stream_est when summing
  let sum = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (k === "source" || k === "timestamp") continue;
    if (typeof v === "number" && Number.isFinite(v)) sum += v;
  }
  return Math.max(0, Math.floor(sum));
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function cancelHideTimer() {
  if (hideTimer != null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

/** Show ambient overlay without stealing IDE focus. */
export async function showOverlayWindow(opts?: { focus?: boolean }): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const win = getCurrentWindow();
    await win.show();
    await win.setAlwaysOnTop(true);
    // Focus only for explicit UI (settings/tray) — never on generation_start
    if (opts?.focus) {
      await win.setFocus();
    }
  } catch (e) {
    console.warn("[opencode bridge] show window failed", e);
  }
}

export async function hideOverlayWindow(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await getCurrentWindow().hide();
  } catch (e) {
    console.warn("[opencode bridge] hide window failed", e);
  }
}

/** Schedule hide after fade, only if no OpenCode sessions remain active. */
function scheduleHideAfterEnd() {
  cancelHideTimer();
  const elapsed = Date.now() - lastStartAt;
  const minV = generation.minVisibleMs ?? 1200;
  // Stay up at least minVisibleMs total; always allow particle fade time.
  const wait = Math.max(HIDE_AFTER_END_MS, minV - elapsed);

  hideTimer = setTimeout(async () => {
    hideTimer = null;
    // Another generation started (or still running) — keep overlay
    if (
      generation.isGenerating ||
      generation.liveSessionActive ||
      Object.keys(generation.activeSessions).length > 0
    ) {
      return;
    }
    clearLiveSession();
    await hideOverlayWindow();
  }, wait);
}

export async function startOpencodeBridge(): Promise<() => void> {
  if (started) return stopOpencodeBridge;
  if (!isTauriRuntime()) {
    console.info("[opencode bridge] not in Tauri runtime — skipped");
    return () => {};
  }

  started = true;

  onStaleCleared = () => {
    if (!generation.autoHideOnEnd) return;
    if (Object.keys(generation.activeSessions).length > 0) return;
    scheduleHideAfterEnd();
    pushRecentEvent("sessions_stale_cleared");
  };
  if (typeof window !== "undefined") {
    window.addEventListener("agent-overlay:sessions-stale-cleared", onStaleCleared);
  }

  try {
    unlistens.push(
      await listen<ServerReadyPayload>("opencode://server_ready", (ev) => {
        setBridgeReady(ev.payload.port);
        pushRecentEvent("server_ready", `:${ev.payload.port}`);
        console.info("[opencode bridge] server ready on port", ev.payload.port);
      }),
    );

    unlistens.push(
      await listen("overlay://open_settings", async () => {
        cancelHideTimer();
        await showOverlayWindow({ focus: true });
        openSettings();
        pushRecentEvent("open_settings");
      }),
    );

    unlistens.push(
      await listen("overlay://hide", async () => {
        closeSettings();
        // Force-idle: clear OpenCode sessions + manual state
        stopGeneration("manual");
        cancelHideTimer();
        await hideOverlayWindow();
        pushRecentEvent("hide");
      }),
    );

    unlistens.push(
      await listen<GenerationStartData>("opencode://generation_start", async (ev) => {
        cancelHideTimer();
        closeSettings();
        const data = ev.payload ?? {};
        trackOpencodeStart({
          provider: data.provider,
          model: data.model,
          session_id: data.session_id,
          bridge_pid: data.bridge_pid,
        });
        lastStartAt = Date.now();
        // Ambient only — do not steal focus from the IDE / OpenCode TUI
        await showOverlayWindow();
        const detail = [data.model, data.provider, data.bridge_pid != null ? `pid ${data.bridge_pid}` : ""]
          .filter(Boolean)
          .join(" · ");
        pushRecentEvent("generation_start", detail || undefined);
      }),
    );

    let lastTokenLogAt = 0;
    unlistens.push(
      await listen<TokenBreakdown>("opencode://tokens_update", (ev) => {
        const payload = ev.payload ?? {};
        const n = aggregateTokens(payload);
        updateOpencodeTokens(
          {
            session_id: payload.session_id as string | null | undefined,
            bridge_pid: payload.bridge_pid as number | string | null | undefined,
          },
          n,
        );
        // Rate-limit diagnostic log (once per second max)
        const now = Date.now();
        if (n > 0 && now - lastTokenLogAt > 1000) {
          lastTokenLogAt = now;
          pushRecentEvent("tokens_update", String(n));
        }
      }),
    );

    unlistens.push(
      await listen<GenerationEndData>("opencode://generation_end", async (ev) => {
        const data = ev.payload ?? {};
        const count = aggregateTokens(data);
        const allDone = trackOpencodeEnd(
          {
            session_id: data.session_id,
            bridge_pid: data.bridge_pid,
          },
          count,
        );
        closeSettings();
        pushRecentEvent("generation_end", count > 0 ? `${count} tok` : undefined);

        // Only hide when *all* concurrent OpenCode gens finished
        if (!allDone) return;
        if (!generation.autoHideOnEnd) {
          clearLiveSession();
          return;
        }
        scheduleHideAfterEnd();
      }),
    );

    // Do not mark connected until server_ready — optimistic flag misleads UI
  } catch (e) {
    started = false;
    while (unlistens.length) {
      try {
        unlistens.pop()?.();
      } catch {
        /* ignore */
      }
    }
    console.error("[opencode bridge] failed to start", e);
  }

  return stopOpencodeBridge;
}

export function stopOpencodeBridge() {
  cancelHideTimer();
  if (typeof window !== "undefined" && onStaleCleared) {
    window.removeEventListener(
      "agent-overlay:sessions-stale-cleared",
      onStaleCleared,
    );
  }
  onStaleCleared = null;
  while (unlistens.length) {
    const u = unlistens.pop();
    try {
      u?.();
    } catch {
      /* ignore */
    }
  }
  started = false;
}
