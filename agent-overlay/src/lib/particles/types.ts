/** Warp particle + engine option types */

export type WarpLayer = 0 | 1 | 2;

export type AnimationStyle =
  | "tunnel"
  | "streaks"
  | "aurora"
  | "rain"
  | "embers"
  | "comet"
  | "spark"
  | "orbit"
  | "vortex"
  | "datastream"
  | "signal";

export type SpawnMode =
  | "directional"
  | "tunnel"
  | "spark"
  | "orbital"
  | "vortex"
  | "datastream"
  | "signal";

/** Lifecycle of a generation for reactive intensity / bloom. */
export type GenPhase = "idle" | "starting" | "streaming" | "ending";

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Remaining lifetime in seconds */
  life: number;
  maxLife: number;
  size: number;
  /** Size at birth (for grow styles) */
  baseSize: number;
  alpha: number;
  /** 0 = far/slow, 1 = mid, 2 = near/fast */
  layer: WarpLayer;
  /** HSL for soft color shift over time */
  hue: number;
  sat: number;
  light: number;
  /** Multi-point afterimages */
  hasTrail: boolean;
  /** Ring buffer: [x0,y0, x1,y1, ...] length = trailCap * 2 */
  trail: Float32Array;
  trailCap: number;
  /** Next write index in the ring (0..trailCap-1) */
  trailIdx: number;
  /** How many valid points currently stored */
  trailCount: number;
  /** Use curved streak draw path */
  curved: boolean;
  /** Embers: grow size over life */
  grow: boolean;
  /** Orbit: preferred radius from center (0 = unused) */
  orbitR: number;
  /** Datastream: signed offset from center along perpendicular (px) */
  laneOffset: number;
  /** Token floater chip (label rides the stream) */
  isTokenChip: boolean;
  /** Text drawn for token chips, e.g. "+48" or "1.2k" */
  label: string;
  /** Active flag for object pool */
  alive: boolean;
}

export interface LayerConfig {
  speedMul: number;
  sizeMul: number;
  alphaMul: number;
  /** Relative spawn weight (normalized at runtime) */
  weight: number;
}

export interface HslColor {
  h: number;
  s: number;
  l: number;
}

export interface StylePreset {
  id: AnimationStyle;
  label: string;
  hint: string;
  spawnMode: SpawnMode;
  /** Override WARP defaults (multipliers / absolute where noted) */
  speedMul: number;
  stretchMul: number;
  spawnMul: number;
  trailChance: number;
  lifeMin: number;
  lifeMax: number;
  radialBias: number;
  /** Fraction of particles drawn with curve (0–1) */
  curveChance: number;
  /** Particles injected on start() */
  burstCount: number;
  /** Breathing amplitude on glow (0 = off) */
  breathAmp: number;
  breathHz: number;
  /** Default motion angle when switching to this style (null = keep user) */
  defaultAngle: number | null;
  defaultSpread: number | null;
  /** Hide direction controls in settings */
  hideMotion: boolean;
  /** Embers-style size growth over lifetime */
  sizeGrow: boolean;
  /** Extra size multiplier at spawn */
  sizeMul: number;
  /** Trail ring points override (null = WARP default) */
  trailMaxPoints: number | null;
  /**
   * Draw brightness scale (1 = default warp).
   * <1 for crisp styles that should not bloom/glare.
   */
  glowDrawMul?: number;
  /**
   * When true: thin streaks, no outer bloom, tiny head —
   * packet-like, less additive glare.
   */
  softBloom?: boolean;
  palette: readonly HslColor[];
}

export interface ParticleSystemOptions {
  /** Override WARP.maxParticlesPeak soft cap */
  maxParticles?: number;
}
