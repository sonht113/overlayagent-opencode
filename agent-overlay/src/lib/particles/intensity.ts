import { WARP } from "./config";

/** Clamp helper shared by intensity math */
export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Map token count → warp intensity (0..intensityMax).
 *
 * Uses a log curve so early growth is noticeable, while very high
 * counts don't explode density/speed unbounded.
 *
 *  - 0 tokens     → intensityFloor (calm baseline)
 *  - ~tokenRef    → ~1.0
 *  - >tokenRef    → soft headroom up to intensityMax
 */
export function intensityFromTokens(
  tokens: number,
  ref: number = WARP.tokenRef,
): number {
  const t = Math.max(0, tokens);
  if (t <= 0) return WARP.intensityFloor;

  const n = Math.log1p(t) / Math.log1p(ref);
  // Blend floor → mapped value so low counts still feel a bit alive
  const mapped = WARP.intensityFloor + (1 - WARP.intensityFloor) * n;
  return clamp(mapped, WARP.intensityFloor, WARP.intensityMax);
}

/** Linear interpolate */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Exponential smoothing toward target.
 * `rate` is roughly "how fast" (higher = snappier).
 */
export function expSmooth(
  current: number,
  target: number,
  dt: number,
  rate: number,
): number {
  const k = 1 - Math.exp(-rate * dt);
  return current + (target - current) * k;
}
