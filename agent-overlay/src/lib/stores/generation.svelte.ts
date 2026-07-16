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
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(readPersistable()));
  } catch {
    // ignore quota / private mode
  }
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

export function startGeneration(source: "manual" | "opencode" = "manual") {
  generation.isGenerating = true;
  generation.source = source;
  if (source === "opencode") {
    generation.liveSessionActive = true;
  }
}

export function stopGeneration(source: "manual" | "opencode" = "manual") {
  generation.isGenerating = false;
  generation.source = source;
  if (source === "manual") {
    generation.liveSessionActive = false;
  }
}

export function clearLiveSession() {
  generation.liveSessionActive = false;
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
