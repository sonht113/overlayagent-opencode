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
  setSessionMeta,
  setTokenCount,
  startGeneration,
  stopGeneration,
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

export async function showOverlayWindow(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const win = getCurrentWindow();
    await win.show();
    await win.setAlwaysOnTop(true);
    await win.setFocus();
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

/** Schedule hide after fade, respecting minVisibleMs from last start. */
function scheduleHideAfterEnd() {
  cancelHideTimer();
  const elapsed = Date.now() - lastStartAt;
  const minV = generation.minVisibleMs ?? 1200;
  // Stay up at least minVisibleMs total; always allow particle fade time.
  const wait = Math.max(HIDE_AFTER_END_MS, minV - elapsed);

  hideTimer = setTimeout(async () => {
    hideTimer = null;
    if (generation.isGenerating) {
      clearLiveSession();
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
        await showOverlayWindow();
        openSettings();
        pushRecentEvent("open_settings");
      }),
    );

    unlistens.push(
      await listen("overlay://hide", async () => {
        closeSettings();
        stopGeneration("manual");
        clearLiveSession();
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
        setSessionMeta({
          provider: data.provider,
          model: data.model,
          session_id: data.session_id,
        });
        setTokenCount(0);
        lastStartAt = Date.now();
        startGeneration("opencode");
        await showOverlayWindow();
        pushRecentEvent(
          "generation_start",
          [data.model, data.provider].filter(Boolean).join(" · ") || undefined,
        );
      }),
    );

    unlistens.push(
      await listen<TokenBreakdown>("opencode://tokens_update", (ev) => {
        const n = aggregateTokens(ev.payload);
        setTokenCount(n);
        // Don't spam log every token tick — only milestone-ish
        if (n > 0 && n % 50 < 5) {
          pushRecentEvent("tokens_update", String(n));
        }
      }),
    );

    unlistens.push(
      await listen<GenerationEndData>("opencode://generation_end", async (ev) => {
        const data = ev.payload ?? {};
        const count = aggregateTokens(data);
        if (count > 0) setTokenCount(count);

        const wasLive = generation.liveSessionActive;
        stopGeneration("opencode");
        closeSettings();
        pushRecentEvent("generation_end", count > 0 ? `${count} tok` : undefined);

        const shouldHide = wasLive && generation.autoHideOnEnd;
        if (!shouldHide) {
          clearLiveSession();
          return;
        }
        scheduleHideAfterEnd();
      }),
    );

    if (!generation.bridgeConnected) {
      generation.bridgeConnected = true;
      generation.eventPort = generation.eventPort ?? 9876;
    }
  } catch (e) {
    started = false;
    console.error("[opencode bridge] failed to start", e);
  }

  return stopOpencodeBridge;
}

export function stopOpencodeBridge() {
  cancelHideTimer();
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
