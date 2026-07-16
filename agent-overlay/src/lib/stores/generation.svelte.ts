/**
 * Generation + overlay UI state (manual + OpenCode bridge).
 */

import {
  getStylePreset,
  isAnimationStyle,
  STYLE_ORDER,
} from "$lib/particles/presets";
import type { AnimationStyle } from "$lib/particles/types";

const STORAGE_KEY = "agent-overlay.settings";

const STYLE_ALPHA_MIN = 0.15;
const STYLE_ALPHA_MAX = 1.5;

function defaultStyleAlphaMap(): Record<AnimationStyle, number> {
  const map = {} as Record<AnimationStyle, number>;
  for (const id of STYLE_ORDER) {
    map[id] = 1;
  }
  return map;
}

/** Concurrent live OpenCode generations (multi-process / multi-repo). */
export type ActiveSession = {
  key: string;
  session_id?: string | null;
  bridge_pid?: number | string | null;
  provider?: string | null;
  model?: string | null;
  tokens: number;
  startedAt: number;
  /** Last tokens_update / start touch — used for stale TTL sweep */
  lastSeenAt: number;
};

/** Drop sessions with no activity for this long (missed generation_end). */
const SESSION_STALE_MS = 90_000;
const SWEEP_INTERVAL_MS = 15_000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

export const generation = $state({
  isGenerating: false,
  tokenCount: 0,
  opacity: 1,
  /** @deprecated use settingsOpen */
  panelOpen: false,
  /** Right-click settings sliding panel */
  settingsOpen: false,
  /** Show static token counter over particles (off = pure ambient) */
  showTokenCount: false,
  /**
   * Spawn floating +N / total chips that ride the particle stream
   * when token count increases (default on).
   */
  tokenFlow: true,
  /**
   * User multiplier on token-based particle intensity (0.35–1.5).
   * Applied after intensityFromTokens().
   */
  userIntensity: 1,
  /**
   * Particle speed multiplier (0.4–2.0). 1 = default warp speed.
   */
  particleSpeed: 1,
  /**
   * Primary motion direction in degrees (canvas math):
   * 0° = right, 90° = down, 180° = left, 270° = up (default).
   */
  motionAngle: 270,
  /**
   * Random cone around primary direction (0–60°). Higher = more scattered rays.
   */
  motionSpread: 18,
  /**
   * Visual style preset for the particle field.
   * tunnel (default) | streaks | aurora | rain | embers | comet | spark | orbit | vortex | datastream
   */
  animationStyle: "tunnel" as AnimationStyle,
  /**
   * Per-style particle alpha multiplier (0.15–1.5). 1 = preset baseline.
   * Remembered separately for each animation style.
   */
  styleAlpha: defaultStyleAlphaMap(),
  source: "manual" as "manual" | "opencode",
  liveSessionActive: false,
  /**
   * Active OpenCode generations keyed by session/bridge identity.
   * Overlay stays live while this is non-empty (any-active UX).
   */
  activeSessions: {} as Record<string, ActiveSession>,
  /**
   * Hide window after live generation_end (product default: true for idle-hide UX).
   */
  autoHideOnEnd: true,
  lastModel: null as string | null,
  lastProvider: null as string | null,
  lastSessionId: null as string | null,
  bridgeConnected: false,
  eventPort: null as number | null,
  /** Rolling diagnostics log (newest last) */
  recentEvents: [] as { ts: string; event: string; detail?: string }[],
  /** Min ms overlay stays visible after start (debounce hide) */
  minVisibleMs: 1200,
});

const MAX_RECENT = 12;

type Persistable = {
  opacity: number;
  showTokenCount: boolean;
  tokenFlow: boolean;
  userIntensity: number;
  particleSpeed: number;
  motionAngle: number;
  motionSpread: number;
  animationStyle: AnimationStyle;
  styleAlpha: Partial<Record<AnimationStyle, number>>;
};

function readPersistable(): Persistable {
  return {
    opacity: generation.opacity,
    showTokenCount: generation.showTokenCount,
    tokenFlow: generation.tokenFlow,
    userIntensity: generation.userIntensity,
    particleSpeed: generation.particleSpeed,
    motionAngle: generation.motionAngle,
    motionSpread: generation.motionSpread,
    animationStyle: generation.animationStyle,
    styleAlpha: { ...generation.styleAlpha },
  };
}

export function persistSettings() {
  // Debounce disk writes while dragging sliders
  if (persistTimer != null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      if (typeof localStorage === "undefined") return;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(readPersistable()));
    } catch {
      // ignore quota / private mode
    }
  }, 200);
}

export function loadPersistedSettings() {
  try {
    if (typeof localStorage === "undefined") return;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw) as Partial<Persistable>;
    if (typeof data.opacity === "number") {
      generation.opacity = Math.min(1, Math.max(0.25, data.opacity));
    }
    if (typeof data.showTokenCount === "boolean") {
      generation.showTokenCount = data.showTokenCount;
    }
    if (typeof data.tokenFlow === "boolean") {
      generation.tokenFlow = data.tokenFlow;
    }
    if (typeof data.userIntensity === "number") {
      generation.userIntensity = Math.min(1.5, Math.max(0.35, data.userIntensity));
    }
    if (typeof data.particleSpeed === "number") {
      generation.particleSpeed = Math.min(2, Math.max(0.4, data.particleSpeed));
    }
    if (typeof data.motionAngle === "number") {
      let d = data.motionAngle;
      d = ((d % 360) + 360) % 360;
      generation.motionAngle = d;
    }
    if (typeof data.motionSpread === "number") {
      generation.motionSpread = Math.min(60, Math.max(0, data.motionSpread));
    }
    if (isAnimationStyle(data.animationStyle)) {
      generation.animationStyle = data.animationStyle;
    }
    if (data.styleAlpha && typeof data.styleAlpha === "object") {
      const next = defaultStyleAlphaMap();
      for (const id of STYLE_ORDER) {
        const v = data.styleAlpha[id];
        if (typeof v === "number" && Number.isFinite(v)) {
          next[id] = Math.min(STYLE_ALPHA_MAX, Math.max(STYLE_ALPHA_MIN, v));
        }
      }
      generation.styleAlpha = next;
    }
  } catch {
    // ignore corrupt storage
  }
}

// Load once when store module is first imported (browser)
if (typeof window !== "undefined") {
  loadPersistedSettings();
}

export function pushRecentEvent(event: string, detail?: string) {
  generation.recentEvents = [
    ...generation.recentEvents,
    { ts: new Date().toLocaleTimeString(), event, detail },
  ].slice(-MAX_RECENT);
}

function activeSessionCount(): number {
  return Object.keys(generation.activeSessions).length;
}

function ensureSessionSweep() {
  if (typeof window === "undefined") return;
  if (sweepTimer != null) return;
  sweepTimer = setInterval(() => {
    pruneStaleSessions();
    if (activeSessionCount() === 0 && sweepTimer != null) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }, SWEEP_INTERVAL_MS);
}

/** Remove sessions with no token/start activity past SESSION_STALE_MS. */
export function pruneStaleSessions(now = Date.now()): string[] {
  const dropped: string[] = [];
  const next = { ...generation.activeSessions };
  for (const [key, s] of Object.entries(next)) {
    const seen = s.lastSeenAt || s.startedAt || 0;
    if (now - seen > SESSION_STALE_MS) {
      delete next[key];
      dropped.push(key);
    }
  }
  if (dropped.length) {
    generation.activeSessions = next;
    syncLiveFlagsFromSessions();
    if (
      activeSessionCount() === 0 &&
      typeof window !== "undefined"
    ) {
      window.dispatchEvent(
        new CustomEvent("agent-overlay:sessions-stale-cleared"),
      );
    }
  }
  return dropped;
}

function syncLiveFlagsFromSessions() {
  const n = activeSessionCount();
  const live = n > 0;
  if (generation.liveSessionActive !== live) {
    generation.liveSessionActive = live;
  }
  if (live) {
    if (!generation.isGenerating) generation.isGenerating = true;
    if (generation.source !== "opencode") generation.source = "opencode";
    let sum = 0;
    for (const s of Object.values(generation.activeSessions)) {
      sum += s.tokens || 0;
    }
    if (generation.tokenCount !== sum) generation.tokenCount = sum;
  } else if (generation.source === "opencode" && generation.isGenerating) {
    generation.isGenerating = false;
  }
}

/** Stable key for multi-process generation tracking. */
export function sessionKeyFromEvent(data: {
  session_id?: string | null;
  bridge_pid?: number | string | null;
}): string {
  const sid = data.session_id != null && String(data.session_id).trim()
    ? String(data.session_id).trim()
    : "";
  const pid =
    data.bridge_pid != null && String(data.bridge_pid).trim()
      ? String(data.bridge_pid).trim()
      : "";
  if (sid && pid) return `${pid}:${sid}`;
  if (sid) return `sid:${sid}`;
  if (pid) return `pid:${pid}`;
  // No identity — single shared anon bucket (never Date.now() per event)
  return "anon";
}

/**
 * Resolve which activeSessions key an event refers to.
 * Never steals another concurrent session via "only one left" heuristics.
 */
export function resolveActiveSessionKey(meta: {
  session_id?: string | null;
  bridge_pid?: number | string | null;
  key?: string;
}): string | null {
  if (meta.key && generation.activeSessions[meta.key]) return meta.key;

  const exact = sessionKeyFromEvent(meta);
  if (generation.activeSessions[exact]) return exact;

  const sid =
    meta.session_id != null && String(meta.session_id).trim()
      ? String(meta.session_id).trim()
      : "";
  const pid =
    meta.bridge_pid != null && String(meta.bridge_pid).trim()
      ? String(meta.bridge_pid).trim()
      : "";
  const entries = Object.entries(generation.activeSessions);

  if (sid) {
    const bySid = entries.filter(
      ([, s]) => s.session_id != null && String(s.session_id) === sid,
    );
    if (bySid.length === 1) return bySid[0][0];
    if (bySid.length > 1 && pid) {
      const both = bySid.find(
        ([, s]) => s.bridge_pid != null && String(s.bridge_pid) === pid,
      );
      if (both) return both[0];
    }
  }

  if (pid) {
    const byPid = entries.filter(
      ([, s]) => s.bridge_pid != null && String(s.bridge_pid) === pid,
    );
    if (byPid.length === 1) return byPid[0][0];
  }

  return null;
}

/**
 * Register a live OpenCode generation. Returns the session key.
 * Overlay stays visible while any session is active.
 */
export function trackOpencodeStart(meta: {
  session_id?: string | null;
  bridge_pid?: number | string | null;
  provider?: string | null;
  model?: string | null;
  key?: string;
}): string {
  const key = meta.key || sessionKeyFromEvent(meta);
  const now = Date.now();
  generation.activeSessions = {
    ...generation.activeSessions,
    [key]: {
      key,
      session_id: meta.session_id ?? null,
      bridge_pid: meta.bridge_pid ?? null,
      provider: meta.provider ?? null,
      model: meta.model ?? null,
      tokens: generation.activeSessions[key]?.tokens ?? 0,
      startedAt: now,
      lastSeenAt: now,
    },
  };
  if (meta.provider != null) generation.lastProvider = String(meta.provider);
  if (meta.model != null) generation.lastModel = String(meta.model);
  if (meta.session_id != null) generation.lastSessionId = String(meta.session_id);
  syncLiveFlagsFromSessions();
  ensureSessionSweep();
  return key;
}

/**
 * End one live generation. Returns true if no OpenCode sessions remain
 * (caller may hide overlay).
 */
export function trackOpencodeEnd(
  meta: {
    session_id?: string | null;
    bridge_pid?: number | string | null;
    key?: string;
  },
  finalTokens?: number,
): boolean {
  let key = resolveActiveSessionKey(meta);
  // Sole active session + unscoped end (missing session_id) → end that session.
  // Never guess when ≥2 sessions (multi-process Mac/Windows safe).
  if (!key && activeSessionCount() === 1) {
    key = Object.keys(generation.activeSessions)[0] ?? null;
  }
  if (key && generation.activeSessions[key]) {
    const next = { ...generation.activeSessions };
    delete next[key];
    generation.activeSessions = next;
  }

  syncLiveFlagsFromSessions();
  if (finalTokens != null && finalTokens > 0 && activeSessionCount() === 0) {
    generation.tokenCount = finalTokens;
  }
  return activeSessionCount() === 0;
}

export function updateOpencodeTokens(
  meta: {
    session_id?: string | null;
    bridge_pid?: number | string | null;
    key?: string;
  },
  tokens: number,
) {
  const n = Math.max(0, Math.floor(Number.isFinite(tokens) ? tokens : 0));
  let key = resolveActiveSessionKey(meta);
  // Orphan token ticks often omit session_id (stream_est). If exactly one
  // OpenCode session is live, attach there — never when ≥2 (multi-process safe).
  if (!key && activeSessionCount() === 1) {
    key = Object.keys(generation.activeSessions)[0] ?? null;
  }
  if (!key) {
    key = sessionKeyFromEvent(meta);
  }
  const cur = key ? generation.activeSessions[key] : undefined;
  if (cur && key) {
    if (cur.tokens === n) {
      // Still refresh liveness without cloning the map when tokens unchanged
      cur.lastSeenAt = Date.now();
      return;
    }
    generation.activeSessions = {
      ...generation.activeSessions,
      [key]: { ...cur, tokens: n, lastSeenAt: Date.now() },
    };
    syncLiveFlagsFromSessions();
  } else if (activeSessionCount() === 0) {
    // No tracked session (orphan update) — only drive display when idle map empty
    if (generation.tokenCount !== n) generation.tokenCount = n;
  }
}

export function startGeneration(source: "manual" | "opencode" = "manual") {
  generation.isGenerating = true;
  generation.source = source;
  if (source === "opencode") {
    generation.liveSessionActive = true;
  }
}

export function stopGeneration(source: "manual" | "opencode" = "manual") {
  if (source === "manual") {
    // Explicit force-idle (tray Hide / Test Warp off) — clear everything
    generation.activeSessions = {};
    generation.isGenerating = false;
    generation.liveSessionActive = false;
    generation.source = "manual";
    return;
  }
  // opencode path should use trackOpencodeEnd; hard-stop only if nothing left
  if (activeSessionCount() === 0) {
    generation.isGenerating = false;
    generation.liveSessionActive = false;
    generation.source = source;
  }
}

export function clearLiveSession() {
  generation.activeSessions = {};
  generation.liveSessionActive = false;
  if (generation.source === "opencode") {
    generation.isGenerating = false;
  }
}

export function toggleGeneration() {
  if (generation.isGenerating) stopGeneration("manual");
  else startGeneration("manual");
}

export function setTokenCount(n: number) {
  generation.tokenCount = Math.max(0, Math.floor(Number.isFinite(n) ? n : 0));
}

export function setOpacity(v: number) {
  generation.opacity = Math.min(1, Math.max(0.25, v));
  persistSettings();
}

export function setUserIntensity(v: number) {
  generation.userIntensity = Math.min(1.5, Math.max(0.35, v));
  persistSettings();
}

export function setParticleSpeed(v: number) {
  generation.particleSpeed = Math.min(2, Math.max(0.4, v));
  persistSettings();
}

/** Degrees 0–360; wraps safely. */
export function setMotionAngle(deg: number) {
  let d = Number.isFinite(deg) ? deg : 270;
  d = ((d % 360) + 360) % 360;
  generation.motionAngle = d;
  persistSettings();
}

export function setMotionSpread(deg: number) {
  generation.motionSpread = Math.min(60, Math.max(0, deg));
  persistSettings();
}

export function setShowTokenCount(on: boolean) {
  generation.showTokenCount = on;
  persistSettings();
}

export function setTokenFlow(on: boolean) {
  generation.tokenFlow = on;
  persistSettings();
}

export function setAnimationStyle(id: AnimationStyle) {
  if (!isAnimationStyle(id)) return;
  generation.animationStyle = id;
  const preset = getStylePreset(id);
  if (preset.defaultAngle != null) {
    let d = preset.defaultAngle;
    d = ((d % 360) + 360) % 360;
    generation.motionAngle = d;
  }
  if (preset.defaultSpread != null) {
    generation.motionSpread = Math.min(60, Math.max(0, preset.defaultSpread));
  }
  persistSettings();
}

export function getStyleAlpha(id: AnimationStyle = generation.animationStyle): number {
  const v = generation.styleAlpha[id];
  if (typeof v === "number" && Number.isFinite(v)) {
    return Math.min(STYLE_ALPHA_MAX, Math.max(STYLE_ALPHA_MIN, v));
  }
  return 1;
}

/** Per-style particle brightness/alpha (0.15–1.5). */
export function setStyleAlpha(v: number, id: AnimationStyle = generation.animationStyle) {
  if (!isAnimationStyle(id)) return;
  const clamped = Math.min(
    STYLE_ALPHA_MAX,
    Math.max(STYLE_ALPHA_MIN, Number.isFinite(v) ? v : 1),
  );
  generation.styleAlpha = { ...generation.styleAlpha, [id]: clamped };
  persistSettings();
}

export function resetStyleAlpha(id: AnimationStyle = generation.animationStyle) {
  setStyleAlpha(1, id);
}

/** Short label for angle presets in UI */
export function motionAngleLabel(deg: number): string {
  const d = ((deg % 360) + 360) % 360;
  if (d >= 335 || d < 25) return "Right →";
  if (d >= 25 && d < 65) return "Down-right";
  if (d >= 65 && d < 115) return "Down ↓";
  if (d >= 115 && d < 155) return "Down-left";
  if (d >= 155 && d < 205) return "Left ←";
  if (d >= 205 && d < 245) return "Up-left";
  if (d >= 245 && d < 295) return "Up ↑";
  return "Up-right";
}

export function openSettings() {
  generation.settingsOpen = true;
  generation.panelOpen = true;
}

export function closeSettings() {
  generation.settingsOpen = false;
  generation.panelOpen = false;
}

export function toggleSettings() {
  if (generation.settingsOpen) closeSettings();
  else openSettings();
}

/** @deprecated use toggleSettings */
export function togglePanel() {
  toggleSettings();
}

export function setBridgeReady(port: number) {
  generation.bridgeConnected = true;
  generation.eventPort = port;
}

export function setSessionMeta(meta: {
  provider?: string | null;
  model?: string | null;
  session_id?: string | null;
}) {
  if (meta.provider != null) generation.lastProvider = String(meta.provider);
  if (meta.model != null) generation.lastModel = String(meta.model);
  if (meta.session_id != null) generation.lastSessionId = String(meta.session_id);
}
