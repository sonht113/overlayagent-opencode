import type { HslColor, LayerConfig } from "./types";

/**
 * Central tunables for the warp-speed field.
 * Adjust these first when dialing the look/feel.
 *
 * Tuned for denser, faster, brighter streaks (premium hyperspace look).
 */
export const WARP = {
  /**
   * Depth layers (parallax):
   * far = slower/dimmer; near = faster/brighter.
   * Raised alphaMul so far layers still read as light, not fog.
   */
  layers: [
    { speedMul: 0.55, sizeMul: 0.75, alphaMul: 0.55, weight: 0.32 },
    { speedMul: 1.05, sizeMul: 1.1, alphaMul: 0.9, weight: 0.4 },
    { speedMul: 1.65, sizeMul: 1.4, alphaMul: 1.15, weight: 0.28 },
  ] as const satisfies readonly LayerConfig[],

  /** Upward speed range (px/s) before layer + intensity multipliers */
  baseSpeedMin: 480,
  baseSpeedMax: 1100,

  /** Max lateral velocity component (px/s) */
  lateralJitter: 55,

  /** Subtle outward bias from center for a tunnel feel (0–1) */
  radialBias: 0.22,

  /**
   * Stretch length ≈ speed * stretchPerSpeed * intensityScale.
   * Higher = longer light streaks (stronger warp feel).
   */
  stretchPerSpeed: 0.1,
  minStretch: 14,
  maxStretch: 200,

  /** Bloom / core sizing relative to particle size */
  glowWidthMul: 5.2,
  midWidthMul: 2.0,
  coreWidthMul: 0.72,
  coreScale: 0.5,

  /** Density driven by intensity (token count) — denser field */
  maxParticlesBase: 160,
  maxParticlesPeak: 340,
  spawnBase: 70,
  spawnPeak: 190,

  /** Log curve reference: ~this many tokens ≈ intensity 1.0 */
  tokenRef: 2000,
  /** Soft cap above ref */
  intensityMax: 1.25,
  /** Baseline intensity even at 0 tokens — brighter idle warp */
  intensityFloor: 0.38,
  /** Exponential smooth rate toward target intensity */
  intensityLerp: 7,

  /** Speed scale range vs intensity */
  speedScaleMin: 0.85,
  speedScaleMax: 1.55,

  /** Stretch intensity blend */
  stretchIntensityMin: 0.75,
  stretchIntensityMax: 1.55,

  /** Glow alpha multiplier range — push brightness */
  glowIntensityMin: 0.95,
  glowIntensityMax: 1.75,

  /** Soft stop duration (seconds) */
  fadeOutDuration: 0.75,

  /** Fraction of particles that keep motion afterimages */
  trailChance: 0.42,
  trailMaxPoints: 4,

  /** Hue shift (degrees/sec) scaled by intensity */
  hueShiftSpeed: 28,

  /** Particle lifetime range (seconds) — slightly shorter = more turnover */
  lifeMin: 0.45,
  lifeMax: 1.15,

  /** Cap devicePixelRatio for perf on HiDPI */
  maxDpr: 1.75,

  /** Tunnel: spawn ring radius as fraction of min(w,h) */
  tunnelSpawnMin: 0.02,
  tunnelSpawnMax: 0.12,
  /** Tunnel: speed scales with distance from center */
  tunnelSpeedNear: 0.45,
  tunnelSpeedFar: 1.85,

  /** Orbit ring radii (fraction of min dimension) */
  orbitRMin: 0.12,
  orbitRMax: 0.42,
  /** Soft spring keeping particles on ring */
  orbitSpring: 3.2,
  /** Vortex: tangent vs radial mix at spawn (0–1 radial weight) */
  vortexRadialMix: 0.35,
  vortexTangentMix: 0.9,
  /** Spark: max origin seeds per frame burst */
  sparkSeedCount: 3,

  /** Datastream: parallel packet lanes */
  streamLaneCount: 4,
  /** Gap between lanes as fraction of min(w,h) */
  streamLaneGap: 0.07,
  /** Soft spring keeping packets on their lane */
  streamLaneSpring: 9,

  /** Token flow chips: max spawns per second */
  tokenChipMaxPerSec: 8,
  /** Max chips created from a single delta event */
  tokenChipMaxPerDelta: 3,
  tokenChipLifeMin: 0.9,
  tokenChipLifeMax: 1.55,

  /**
   * Spawn palette anchors (HSL) — higher L for brighter light.
   * cyan / violet / pink / amber / mint
   */
  palette: [
    { h: 192, s: 100, l: 78 },
    { h: 262, s: 95, l: 80 },
    { h: 330, s: 92, l: 78 },
    { h: 42, s: 100, l: 74 },
    { h: 158, s: 88, l: 72 },
  ] as const satisfies readonly HslColor[],
} as const;

/** @deprecated use WARP.palette — kept for any external imports */
export const PARTICLE_COLORS = [
  "#5BDEFF",
  "#A78BFA",
  "#F472B6",
  "#FBBF24",
  "#34D399",
] as const;

export const FADE_OUT_DURATION = WARP.fadeOutDuration;
