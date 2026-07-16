import { WARP } from "./config";
import {
  clamp,
  expSmooth,
  intensityFromTokens,
  lerp,
} from "./intensity";
import { getStylePreset } from "./presets";
import type {
  AnimationStyle,
  GenPhase,
  Particle,
  ParticleSystemOptions,
  StylePreset,
  WarpLayer,
} from "./types";

type SignalRing = {
  r: number;
  maxR: number;
  life: number;
  maxLife: number;
  width: number;
  hue: number;
  sat: number;
  light: number;
  alpha: number;
};

/**
 * High-performance warp-speed Canvas field for transparent overlays.
 *
 * Design goals:
 *  - Long velocity-aligned streaks (stretch) sell "hyperspace"
 *  - Depth layers (far/mid/near) with different speeds
 *  - Token count drives density / speed / stretch / glow
 *  - Style presets + signal waves; reactive phases / multi-session
 *  - No full-frame alpha residual (breaks desktop transparency)
 */
export class ParticleSystem {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private pool: Particle[] = [];
  private active: Particle[] = [];
  private running = false;
  private spawning = false;
  private raf = 0;
  private last = 0;
  private spawnAcc = 0;
  private dpr = 1;
  private elapsed = 0;

  private targetIntensity: number = WARP.intensityFloor;
  private intensity: number = WARP.intensityFloor;
  private userMul = 1;
  private userSpeed = 1;
  /** Per-style user alpha (Settings), multiplies preset glowDrawMul */
  private userStyleAlpha = 1;
  /** Spawn floating +N / total chips that ride the stream */
  private tokenFlow = true;
  private tokenChipBudget: number = WARP.tokenChipMaxPerSec;
  private dirAngle = -Math.PI / 2;
  private dirSpread = (18 * Math.PI) / 180;
  private lastTokens = 0;
  private fade = 1;
  private fadingOut = false;
  private onIdle: (() => void) | null = null;
  private hardMax: number;

  private style: StylePreset = getStylePreset("tunnel");
  private layerCdf: number[];

  /** Reactive generation lifecycle */
  private phase: GenPhase = "idle";
  private phaseAge = 0;
  private heartbeat = 0;
  private sessionCount = 1;
  private rings: SignalRing[] = [];
  private ringAcc = 0;
  /** Cooldown before next heartbeat-driven ring (seconds remaining) */
  private ringCooldown = 0;

  constructor(canvas: HTMLCanvasElement, opts: ParticleSystemOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("2d context unavailable");
    this.ctx = ctx;

    this.hardMax = opts.maxParticles ?? WARP.maxParticlesPeak;
    this.layerCdf = buildLayerCdf();
    this.resize();
  }

  // ── Public API ──────────────────────────────────────────────

  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, WARP.maxDpr);
    this.canvas.width = Math.max(1, Math.floor(w * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(h * this.dpr));
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  start() {
    this.spawning = true;
    this.fade = 1;
    this.fadingOut = false;
    this.onIdle = null;
    this.phase = "starting";
    this.phaseAge = 0;
    this.heartbeat = 0;
    this.ringAcc = 0;
    this.ringCooldown = 0;
    this.rings.length = 0;
    this.ensureLoop();
    // Two-step kick: main burst + smaller follow-up feel via higher spawn rate
    this.burst(this.style.burstCount);
    this.burst(Math.min(20, Math.floor(this.style.burstCount * 0.35)));
    // Opening wave — Signal only (other styles stay pure particle field)
    if (this.style.spawnMode === "signal") {
      this.spawnRing(1.0);
      this.spawnRing(0.55);
    }
    this.recomputeTarget();
  }

  stop(onDone?: () => void) {
    this.spawning = false;
    this.fadingOut = true;
    this.phase = "ending";
    this.phaseAge = 0;
    this.onIdle = onDone ?? null;
    this.targetIntensity = 0;
    // Completion bloom before fade settles (short-lived rings)
    if (this.style.spawnMode === "signal") {
      this.spawnRing(1.05, WARP.completionRingLifeMul);
      this.spawnRing(0.6, WARP.completionRingLifeMul);
    } else {
      // Soft single ring on non-signal end (optional accent, short)
      this.spawnRing(0.75, WARP.completionRingLifeMul * 0.85);
    }
    this.burst(Math.min(18, Math.floor(this.style.burstCount * 0.35)));

    if (this.active.length === 0 && this.rings.length === 0) {
      this.halt();
      return;
    }
    this.ensureLoop();
  }

  destroy() {
    this.halt();
  }

  setTokenCount(tokens: number) {
    if (this.fadingOut) return;
    this.lastTokens = tokens;
    this.recomputeTarget();
  }

  /** Concurrent OpenCode sessions — tints palette + slight density. */
  setSessionCount(n: number) {
    this.sessionCount = Math.max(1, Math.floor(n || 1));
    if (!this.fadingOut) this.recomputeTarget();
  }

  /** Enable/disable floating token chips on the stream. */
  setTokenFlow(on: boolean) {
    this.tokenFlow = on;
  }

  /**
   * When token count rises, spawn label chips that ride the flow.
   * @param delta positive increase since last update
   * @param total absolute token count (for occasional total badge)
   */
  pushTokenDelta(delta: number, total: number) {
    if (this.fadingOut || this.phase === "ending") return;
    const d = Math.max(0, Math.floor(delta));
    if (d <= 0) return;

    this.ensureLoop();
    this.spawning = true;

    // Heartbeat pulse even when chips off
    if (d >= WARP.heartbeatMinDelta) {
      this.heartbeat = Math.min(
        0.45,
        this.heartbeat + WARP.heartbeatPulse * (d >= 40 ? 1.4 : 1),
      );
      // Rings: Signal only, rate-limited (avoid spam on every token tick)
      if (
        this.style.spawnMode === "signal" &&
        this.ringCooldown <= 0 &&
        d >= WARP.heartbeatMinDelta
      ) {
        this.spawnRing(0.55 + Math.min(0.35, d / 200));
        this.ringCooldown = WARP.heartbeatRingCooldown;
      }
    }

    if (!this.tokenFlow) return;

    const budget = Math.floor(this.tokenChipBudget);
    if (budget <= 0) return;

    let n = 1;
    if (d >= 80) n = 3;
    else if (d >= 20) n = 2;
    n = Math.min(n, WARP.tokenChipMaxPerDelta, budget);

    for (let i = 0; i < n; i++) {
      // First chips show +delta; last may show running total
      const showTotal = i === n - 1 && total > 0 && (d >= 30 || Math.random() < 0.35);
      const label = showTotal
        ? formatTokenLabel(total, false)
        : formatTokenLabel(d, true);
      this.spawnTokenChip(label);
      this.tokenChipBudget = Math.max(0, this.tokenChipBudget - 1);
    }
  }

  setUserMultiplier(m: number) {
    this.userMul = clamp(m, 0.35, 1.5);
    if (!this.fadingOut) this.recomputeTarget();
  }

  setUserSpeed(m: number) {
    this.userSpeed = clamp(m, 0.4, 2);
  }

  setMotionDirection(degrees: number, spreadDegrees = 18) {
    const deg = ((degrees % 360) + 360) % 360;
    this.dirAngle = (deg * Math.PI) / 180;
    this.dirSpread = (clamp(spreadDegrees, 0, 60) * Math.PI) / 180;
  }

  setStyle(id: AnimationStyle) {
    const next = getStylePreset(id);
    const prevMode = this.style.spawnMode;
    this.style = next;
    // Drop rings from previous style so modes don't mix mid-gen
    this.rings.length = 0;
    this.ringAcc = 0;
    this.ringCooldown = 0;
    // Soft intro when switching to Signal while already generating
    if (
      this.running &&
      this.spawning &&
      !this.fadingOut &&
      next.spawnMode === "signal" &&
      prevMode !== "signal"
    ) {
      this.spawnRing(0.75);
    }
  }

  /** Settings: per-style particle alpha multiplier (0.15–1.5). */
  setStyleAlpha(m: number) {
    this.userStyleAlpha = clamp(m, 0.15, 1.5);
  }

  setIntensity(value: number) {
    if (this.fadingOut) return;
    this.targetIntensity = clamp(value, 0, WARP.intensityMax);
  }

  private recomputeTarget() {
    const base = intensityFromTokens(this.lastTokens);
    const sessionBoost =
      1 + Math.min(0.35, (this.sessionCount - 1) * WARP.multiSessionSpawnMul * 2);
    let t = base * this.userMul * sessionBoost;

    // Starting kick: strong then eases out over phaseStartingSec
    if (this.phase === "starting") {
      const u = clamp(this.phaseAge / WARP.phaseStartingSec, 0, 1);
      const kick = WARP.phaseStartingKick * (1 - u) * (1 - u);
      t = Math.max(t, WARP.intensityFloor * 1.05) + kick;
    }

    // Idle breath when no tokens yet (shimmer, not full field)
    if (this.lastTokens <= 0 && this.spawning && !this.fadingOut) {
      const hz = Math.max(0.15, this.style.breathHz || 0.4);
      const amp =
        WARP.idleBreathDepth * (0.6 + (this.style.breathAmp || 0.1) * 2);
      const breath = Math.sin(this.elapsed * Math.PI * 2 * hz) * amp;
      t = Math.max(WARP.intensityFloorIdle * 0.85, t + breath);
    }

    this.targetIntensity = clamp(t + this.heartbeat, 0, WARP.intensityMax);
  }

  private spawnRing(strength = 1, lifeMul = 1) {
    if (this.rings.length >= WARP.signalRingMax) {
      this.rings.shift();
    }
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const minDim = Math.min(w, h) || 400;
    const pal = this.style.palette;
    const c = pal[Math.floor(Math.random() * pal.length)] ?? pal[0];
    const hueShift =
      this.sessionCount > 1
        ? WARP.multiSessionHueShift * (this.sessionCount - 1)
        : 0;
    // Single alpha path — drawRings applies userStyleAlpha only (no double glowDrawMul)
    const baseA = this.style.spawnMode === "signal" ? 0.78 : 0.42;
    const life = WARP.signalRingLife * strength * lifeMul;
    this.rings.push({
      r: minDim * 0.02,
      maxR: minDim * (0.42 + 0.12 * strength),
      life,
      maxLife: life,
      width: WARP.signalRingWidth * (0.85 + 0.3 * strength),
      hue: (c.h + hueShift) % 360,
      sat: c.s,
      light: c.l,
      alpha: baseA * strength,
    });
  }

  get isRunning() {
    return this.running;
  }

  get currentIntensity() {
    return this.intensity;
  }

  get currentStyle() {
    return this.style.id;
  }

  // ── Loop ────────────────────────────────────────────────────

  private ensureLoop() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (t: number) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (t - this.last) / 1000);
      this.last = t;
      this.update(dt);
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private halt() {
    this.running = false;
    this.spawning = false;
    this.fadingOut = false;
    this.phase = "idle";
    this.phaseAge = 0;
    this.heartbeat = 0;
    this.rings.length = 0;
    this.ringAcc = 0;
    this.ringCooldown = 0;
    cancelAnimationFrame(this.raf);
    for (const p of this.active) {
      p.alive = false;
      this.pool.push(p);
    }
    this.active.length = 0;
    this.spawnAcc = 0;
    this.fade = 1;
    this.intensity = WARP.intensityFloorIdle;
    this.targetIntensity = WARP.intensityFloorIdle;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.ctx.clearRect(0, 0, w, h);
    const cb = this.onIdle;
    this.onIdle = null;
    cb?.();
  }

  // ── Intensity-driven params ─────────────────────────────────

  private maxParticlesNow(): number {
    const i = this.intensity;
    return Math.floor(
      lerp(WARP.maxParticlesBase, WARP.maxParticlesPeak, clamp(i, 0, 1)),
    );
  }

  private spawnRateNow(): number {
    if (!this.spawning) return 0;
    const i = this.intensity;
    const sessionMul =
      1 + Math.min(0.4, (this.sessionCount - 1) * WARP.multiSessionSpawnMul);
    const phaseMul = this.phase === "starting" ? 1.25 : 1;
    return (
      lerp(WARP.spawnBase, WARP.spawnPeak, clamp(i, 0, 1)) *
      this.style.spawnMul *
      sessionMul *
      phaseMul
    );
  }

  private speedScaleNow(): number {
    return (
      lerp(WARP.speedScaleMin, WARP.speedScaleMax, clamp(this.intensity, 0, 1)) *
      this.userSpeed *
      this.style.speedMul
    );
  }

  private stretchScaleNow(): number {
    return (
      lerp(
        WARP.stretchIntensityMin,
        WARP.stretchIntensityMax,
        clamp(this.intensity, 0, 1),
      ) * this.style.stretchMul
    );
  }

  private glowScaleNow(): number {
    const base = lerp(
      WARP.glowIntensityMin,
      WARP.glowIntensityMax,
      clamp(this.intensity, 0, 1),
    );
    const amp = this.style.breathAmp;
    if (amp <= 0) return base;
    const breath =
      1 + amp * Math.sin(this.elapsed * Math.PI * 2 * this.style.breathHz);
    return base * breath;
  }

  // ── Spawn / pool ────────────────────────────────────────────

  private acquire(): Particle {
    const p = this.pool.pop();
    if (p) return p;
    return createParticleShell();
  }

  private release(p: Particle) {
    p.alive = false;
    this.pool.push(p);
  }

  private pickLayer(): WarpLayer {
    const r = Math.random();
    for (let i = 0; i < this.layerCdf.length; i++) {
      if (r <= this.layerCdf[i]) return i as WarpLayer;
    }
    return 2;
  }

  private burst(count: number) {
    const cap = Math.min(this.hardMax, this.maxParticlesNow());
    const n = Math.min(count, Math.max(0, cap - this.active.length));
    for (let i = 0; i < n; i++) {
      this.spawnOne(true);
    }
  }

  private spawnOne(isBurst = false) {
    switch (this.style.spawnMode) {
      case "tunnel":
        this.spawnTunnel(isBurst);
        break;
      case "spark":
        this.spawnSpark(isBurst);
        break;
      case "orbital":
        this.spawnOrbital(isBurst);
        break;
      case "vortex":
        this.spawnVortex(isBurst);
        break;
      case "datastream":
        this.spawnDatastream(isBurst);
        break;
      case "signal":
        this.spawnSignal(isBurst);
        break;
      default:
        this.spawnDirectional(isBurst);
    }
  }

  private spawnSignal(isBurst: boolean) {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w <= 0 || h <= 0) return;

    const layer = this.pickLayer();
    const L = WARP.layers[layer];
    const speedScale = this.speedScaleNow();
    const cx = w * 0.5;
    const cy = h * 0.5;
    const minDim = Math.min(w, h);

    const ringT = Math.random();
    const ringR =
      minDim *
      lerp(WARP.signalSpawnMin, WARP.signalSpawnMax, ringT) *
      (layer === 2 ? 0.75 : layer === 0 ? 1.2 : 1);
    const theta = Math.random() * Math.PI * 2;
    const x = cx + Math.cos(theta) * ringR;
    const y = cy + Math.sin(theta) * ringR;

    let rx = x - cx;
    let ry = y - cy;
    const dist = Math.hypot(rx, ry) || 1;
    rx /= dist;
    ry /= dist;
    const angJitter = (Math.random() - 0.5) * 0.22;
    const cosJ = Math.cos(angJitter);
    const sinJ = Math.sin(angJitter);
    const dx = rx * cosJ - ry * sinJ;
    const dy = rx * sinJ + ry * cosJ;

    const distNorm = clamp(dist / (minDim * 0.5), 0, 1);
    const radialSpeedMul = lerp(
      WARP.signalSpeedNear,
      WARP.signalSpeedFar,
      distNorm,
    );
    const base =
      WARP.baseSpeedMin * 0.55 +
      Math.random() * (WARP.baseSpeedMax * 0.55 - WARP.baseSpeedMin * 0.55);
    const speed =
      base * L.speedMul * speedScale * radialSpeedMul * (isBurst ? 1.25 : 1);

    const sideNoise =
      (Math.random() - 0.5) * WARP.lateralJitter * 0.25 * L.speedMul;
    const px = -dy;
    const py = dx;
    const vx = dx * speed + px * sideNoise;
    const vy = dy * speed + py * sideNoise;

    this.initParticle(x, y, vx, vy, layer, isBurst);
  }

  private spawnDirectional(isBurst: boolean) {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w <= 0 || h <= 0) return;

    const layer = this.pickLayer();
    const L = WARP.layers[layer];
    const speedScale = this.speedScaleNow();

    const base =
      WARP.baseSpeedMin + Math.random() * (WARP.baseSpeedMax - WARP.baseSpeedMin);
    const speed = base * L.speedMul * speedScale * (isBurst ? 1.25 : 1);

    const jitter = (Math.random() - 0.5) * 2 * this.dirSpread;
    const angle = this.dirAngle + jitter;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);

    const px = -dy;
    const py = dx;
    const along = 0.42 + Math.random() * 0.12;
    const side = (Math.random() - 0.5) * 1.7;
    let nx = 0.5 - dx * along + px * side * 0.45;
    let ny = 0.5 - dy * along + py * side * 0.45;
    if (layer === 2) {
      nx = 0.5 - dx * (0.48 + Math.random() * 0.08) + px * side * 0.5;
      ny = 0.5 - dy * (0.48 + Math.random() * 0.08) + py * side * 0.5;
    } else if (layer === 0) {
      nx += (Math.random() - 0.5) * 0.2;
      ny += (Math.random() - 0.5) * 0.2;
    }
    nx = clamp(nx, 0.02, 0.98);
    ny = clamp(ny, 0.02, 0.98);
    const x = w * nx;
    const y = h * ny;

    const cx = w * 0.5;
    const cy = h * 0.5;
    const radialBias = this.style.radialBias;
    const outwardX = ((x - cx) / Math.max(w * 0.5, 1)) * radialBias;
    const outwardY = ((y - cy) / Math.max(h * 0.5, 1)) * radialBias;
    const sideNoise =
      (Math.random() - 0.5) * WARP.lateralJitter * L.speedMul * speedScale;
    const vx = dx * speed + px * sideNoise * 0.35 + outwardX * speed * 0.2;
    const vy = dy * speed + py * sideNoise * 0.35 + outwardY * speed * 0.2;

    this.initParticle(x, y, vx, vy, layer, isBurst);
  }

  private spawnTunnel(isBurst: boolean) {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w <= 0 || h <= 0) return;

    const layer = this.pickLayer();
    const L = WARP.layers[layer];
    const speedScale = this.speedScaleNow();
    const cx = w * 0.5;
    const cy = h * 0.5;
    const minDim = Math.min(w, h);

    // Spawn in a small ring around center (hyperspace vanishing point)
    const ringT = Math.random();
    const ringR =
      minDim *
      lerp(WARP.tunnelSpawnMin, WARP.tunnelSpawnMax, ringT) *
      (layer === 2 ? 0.7 : layer === 0 ? 1.25 : 1);
    const theta = Math.random() * Math.PI * 2;
    const x = cx + Math.cos(theta) * ringR;
    const y = cy + Math.sin(theta) * ringR;

    // Radial outward + slight angular jitter
    let rx = x - cx;
    let ry = y - cy;
    const dist = Math.hypot(rx, ry) || 1;
    rx /= dist;
    ry /= dist;
    const angJitter = (Math.random() - 0.5) * 0.35;
    const cosJ = Math.cos(angJitter);
    const sinJ = Math.sin(angJitter);
    const dx = rx * cosJ - ry * sinJ;
    const dy = rx * sinJ + ry * cosJ;

    const distNorm = clamp(dist / (minDim * 0.5), 0, 1);
    const radialSpeedMul = lerp(
      WARP.tunnelSpeedNear,
      WARP.tunnelSpeedFar,
      distNorm,
    );
    const base =
      WARP.baseSpeedMin + Math.random() * (WARP.baseSpeedMax - WARP.baseSpeedMin);
    const speed =
      base * L.speedMul * speedScale * radialSpeedMul * (isBurst ? 1.4 : 1);

    const sideNoise =
      (Math.random() - 0.5) * WARP.lateralJitter * 0.4 * L.speedMul;
    const px = -dy;
    const py = dx;
    const vx = dx * speed + px * sideNoise;
    const vy = dy * speed + py * sideNoise;

    this.initParticle(x, y, vx, vy, layer, isBurst);
  }

  private spawnSpark(isBurst: boolean) {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w <= 0 || h <= 0) return;

    const layer = this.pickLayer();
    const L = WARP.layers[layer];
    const speedScale = this.speedScaleNow();

    // Multi-origin: scatter seeds across the view
    const sx = w * (0.12 + Math.random() * 0.76);
    const sy = h * (0.12 + Math.random() * 0.76);
    const theta = Math.random() * Math.PI * 2;
    const dx = Math.cos(theta);
    const dy = Math.sin(theta);

    const base =
      WARP.baseSpeedMin * 0.55 +
      Math.random() * (WARP.baseSpeedMax * 0.7 - WARP.baseSpeedMin * 0.55);
    const speed = base * L.speedMul * speedScale * (isBurst ? 1.5 : 1);
    const x = sx + dx * (2 + Math.random() * 8);
    const y = sy + dy * (2 + Math.random() * 8);
    this.initParticle(x, y, dx * speed, dy * speed, layer, isBurst);
  }

  private spawnOrbital(isBurst: boolean) {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w <= 0 || h <= 0) return;

    const layer = this.pickLayer();
    const L = WARP.layers[layer];
    const speedScale = this.speedScaleNow();
    const cx = w * 0.5;
    const cy = h * 0.5;
    const minDim = Math.min(w, h);

    // Prefer a few discrete ring bands
    const band = Math.random();
    const rNorm =
      band < 0.34
        ? lerp(WARP.orbitRMin, WARP.orbitRMin + 0.08, Math.random())
        : band < 0.67
          ? lerp(0.22, 0.3, Math.random())
          : lerp(0.32, WARP.orbitRMax, Math.random());
    const orbitR = minDim * rNorm * (layer === 0 ? 1.08 : layer === 2 ? 0.92 : 1);
    const theta = Math.random() * Math.PI * 2;
    const x = cx + Math.cos(theta) * orbitR;
    const y = cy + Math.sin(theta) * orbitR;

    // Tangential velocity (CW or CCW)
    const dir = Math.random() < 0.5 ? 1 : -1;
    const tx = -Math.sin(theta) * dir;
    const ty = Math.cos(theta) * dir;
    const base =
      WARP.baseSpeedMin * 0.35 +
      Math.random() * (WARP.baseSpeedMax * 0.45 - WARP.baseSpeedMin * 0.35);
    const speed = base * L.speedMul * speedScale * (isBurst ? 1.2 : 1);
    // Tiny radial kick so rings feel alive
    const radial = (Math.random() - 0.5) * speed * 0.08;
    const rx = Math.cos(theta);
    const ry = Math.sin(theta);

    this.initParticle(
      x,
      y,
      tx * speed + rx * radial,
      ty * speed + ry * radial,
      layer,
      isBurst,
      orbitR,
    );
  }

  private spawnVortex(isBurst: boolean) {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w <= 0 || h <= 0) return;

    const layer = this.pickLayer();
    const L = WARP.layers[layer];
    const speedScale = this.speedScaleNow();
    const cx = w * 0.5;
    const cy = h * 0.5;
    const minDim = Math.min(w, h);

    const ringR =
      minDim *
      lerp(0.03, 0.14, Math.random()) *
      (layer === 2 ? 0.75 : layer === 0 ? 1.2 : 1);
    const theta = Math.random() * Math.PI * 2;
    const x = cx + Math.cos(theta) * ringR;
    const y = cy + Math.sin(theta) * ringR;

    const rx = Math.cos(theta);
    const ry = Math.sin(theta);
    const spin = Math.random() < 0.5 ? 1 : -1;
    const tx = -ry * spin;
    const ty = rx * spin;

    const base =
      WARP.baseSpeedMin + Math.random() * (WARP.baseSpeedMax - WARP.baseSpeedMin);
    const speed = base * L.speedMul * speedScale * 0.75 * (isBurst ? 1.35 : 1);
    const vx =
      rx * speed * WARP.vortexRadialMix + tx * speed * WARP.vortexTangentMix;
    const vy =
      ry * speed * WARP.vortexRadialMix + ty * speed * WARP.vortexTangentMix;

    this.initParticle(x, y, vx, vy, layer, isBurst);
  }

  private spawnDatastream(isBurst: boolean) {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w <= 0 || h <= 0) return;

    const layer = this.pickLayer();
    const L = WARP.layers[layer];
    const speedScale = this.speedScaleNow();
    const cx = w * 0.5;
    const cy = h * 0.5;
    const minDim = Math.min(w, h);

    // Primary flow direction (tight cone)
    const jitter = (Math.random() - 0.5) * 2 * this.dirSpread * 0.35;
    const angle = this.dirAngle + jitter;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    // Perpendicular = lane axis
    const px = -dy;
    const py = dx;

    const laneCount = WARP.streamLaneCount;
    const lane = (Math.random() * laneCount) | 0;
    const mid = (laneCount - 1) * 0.5;
    const gap = minDim * WARP.streamLaneGap;
    const laneOffset = (lane - mid) * gap;
    // Tiny in-lane noise so packets don't stack perfectly
    const laneNoise = (Math.random() - 0.5) * gap * 0.18;

    // Spawn behind flow so packets cross the view
    const along = 0.48 + Math.random() * 0.08;
    const x = cx - dx * (minDim * along * 0.55) + px * (laneOffset + laneNoise);
    const y = cy - dy * (minDim * along * 0.55) + py * (laneOffset + laneNoise);

    const base =
      WARP.baseSpeedMin * 0.75 +
      Math.random() * (WARP.baseSpeedMax * 0.85 - WARP.baseSpeedMin * 0.75);
    const speed = base * L.speedMul * speedScale * (isBurst ? 1.2 : 1);
    // Slight speed variance only — no bright "priority" bloom packets
    const priority = Math.random() < 0.12 ? 1.08 : 1;

    this.initParticle(
      x,
      y,
      dx * speed * priority,
      dy * speed * priority,
      layer,
      isBurst,
      0,
      laneOffset,
    );
  }

  private initParticle(
    x: number,
    y: number,
    vx: number,
    vy: number,
    layer: WarpLayer,
    isBurst: boolean,
    orbitR = 0,
    laneOffset = 0,
  ) {
    const L = WARP.layers[layer];
    const maxLife =
      this.style.lifeMin +
      Math.random() * (this.style.lifeMax - this.style.lifeMin);
    const life = maxLife * (layer === 2 ? 0.85 : 1) * (isBurst ? 0.75 : 1);

    const palette =
      this.style.palette[(Math.random() * this.style.palette.length) | 0];
    const hasTrail = Math.random() < this.style.trailChance;
    const trailPts = this.style.trailMaxPoints ?? WARP.trailMaxPoints;
    const trailCap = hasTrail ? trailPts : 0;
    const curved = Math.random() < this.style.curveChance;

    const p = this.acquire();
    p.x = x;
    p.y = y;
    p.vx = vx;
    p.vy = vy;
    p.life = life;
    p.maxLife = life;
    const baseSize =
      (1.4 + Math.random() * 3.2) * L.sizeMul * this.style.sizeMul;
    p.baseSize = baseSize;
    p.size = baseSize;
    p.alpha =
      (this.style.softBloom
        ? 0.38 + Math.random() * 0.22
        : 0.7 + Math.random() * 0.35) * L.alphaMul;
    p.layer = layer;
    p.hue = palette.h + (Math.random() - 0.5) * 16;
    p.sat = palette.s;
    p.light = palette.l;
    p.hasTrail = hasTrail;
    p.trailCap = trailCap;
    p.curved = curved;
    p.grow = this.style.sizeGrow;
    p.orbitR = orbitR;
    p.laneOffset = laneOffset;
    p.isTokenChip = false;
    p.label = "";
    if (hasTrail) {
      if (!p.trail || p.trail.length !== trailCap * 2) {
        p.trail = new Float32Array(trailCap * 2);
      } else {
        p.trail.fill(0);
      }
      p.trailIdx = 0;
      p.trailCount = 0;
    } else {
      p.trailCap = 0;
      p.trailCount = 0;
      p.trailIdx = 0;
    }
    p.alive = true;
    this.active.push(p);
  }

  // ── Update ──────────────────────────────────────────────────

  private spawnTokenChip(label: string) {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w <= 0 || h <= 0) return;

    const speedScale = this.speedScaleNow();
    const cx = w * 0.5;
    const cy = h * 0.5;
    const minDim = Math.min(w, h);

    const mode = this.style.spawnMode;
    let dx = Math.cos(this.dirAngle);
    let dy = Math.sin(this.dirAngle);
    let x: number;
    let y: number;
    let laneOffset = 0;

    if (mode === "datastream") {
      const px = -dy;
      const py = dx;
      const laneCount = WARP.streamLaneCount;
      const lane = (Math.random() * laneCount) | 0;
      const mid = (laneCount - 1) * 0.5;
      const gap = minDim * WARP.streamLaneGap;
      laneOffset = (lane - mid) * gap;
      const along = 0.48 + Math.random() * 0.1;
      x = cx - dx * (minDim * along * 0.55) + px * laneOffset;
      y = cy - dy * (minDim * along * 0.55) + py * laneOffset;
    } else if (mode === "tunnel" || mode === "vortex") {
      const theta = Math.random() * Math.PI * 2;
      const ringR = minDim * (0.04 + Math.random() * 0.1);
      x = cx + Math.cos(theta) * ringR;
      y = cy + Math.sin(theta) * ringR;
      dx = (x - cx) / (Math.hypot(x - cx, y - cy) || 1);
      dy = (y - cy) / (Math.hypot(x - cx, y - cy) || 1);
    } else {
      const px = -dy;
      const py = dx;
      const along = 0.45 + Math.random() * 0.1;
      const side = (Math.random() - 0.5) * 0.9;
      x = cx - dx * (minDim * along * 0.5) + px * side * minDim * 0.2;
      y = cy - dy * (minDim * along * 0.5) + py * side * minDim * 0.2;
    }

    const base =
      WARP.baseSpeedMin * 0.55 +
      Math.random() * (WARP.baseSpeedMax * 0.55 - WARP.baseSpeedMin * 0.55);
    const speed = base * speedScale * 0.85;
    const life =
      WARP.tokenChipLifeMin +
      Math.random() * (WARP.tokenChipLifeMax - WARP.tokenChipLifeMin);

    const palette =
      this.style.palette[(Math.random() * this.style.palette.length) | 0];
    const p = this.acquire();
    p.x = x;
    p.y = y;
    p.vx = dx * speed;
    p.vy = dy * speed;
    p.life = life;
    p.maxLife = life;
    p.baseSize = 10;
    p.size = 10;
    p.alpha = 0.95;
    p.layer = 2;
    p.hue = palette.h;
    p.sat = Math.min(100, palette.s + 5);
    p.light = Math.min(92, palette.l + 8);
    p.hasTrail = false;
    p.trailCap = 0;
    p.trailCount = 0;
    p.trailIdx = 0;
    p.curved = false;
    p.grow = false;
    p.orbitR = 0;
    p.laneOffset = laneOffset;
    p.isTokenChip = true;
    p.label = label;
    p.alive = true;
    this.active.push(p);
  }

  private update(dt: number) {
    this.elapsed += dt;
    this.phaseAge += dt;

    if (this.phase === "starting" && this.phaseAge >= WARP.phaseStartingSec) {
      this.phase = "streaming";
      this.phaseAge = 0;
    }

    if (this.ringCooldown > 0) {
      this.ringCooldown = Math.max(0, this.ringCooldown - dt);
    }

    // Heartbeat decay + recompute target (also idle breath / starting kick)
    if (this.heartbeat > 0.001) {
      this.heartbeat = Math.max(
        0,
        this.heartbeat - WARP.heartbeatDecay * dt * this.heartbeat,
      );
    } else {
      this.heartbeat = 0;
    }
    if (!this.fadingOut && this.spawning) {
      this.recomputeTarget();
    }

    // Refill token chip spawn budget
    this.tokenChipBudget = Math.min(
      WARP.tokenChipMaxPerSec,
      this.tokenChipBudget + WARP.tokenChipMaxPerSec * dt,
    );

    const target = this.fadingOut ? 0 : this.targetIntensity;
    this.intensity = expSmooth(
      this.intensity,
      target,
      dt,
      WARP.intensityLerp,
    );

    if (this.fadingOut) {
      this.fade = Math.max(0, this.fade - dt / WARP.fadeOutDuration);
    }

    // Ambient rings: Signal only (other styles no periodic waves)
    if (
      this.spawning &&
      !this.fadingOut &&
      this.style.spawnMode === "signal"
    ) {
      this.ringAcc += dt;
      if (this.ringAcc >= WARP.signalRingInterval) {
        this.ringAcc = 0;
        this.spawnRing(0.45 + this.intensity * 0.25);
      }
    }

    // Expand / age rings — single ease-out from birth fraction
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const ring = this.rings[i];
      ring.life -= dt;
      const lifeT = clamp(1 - ring.life / ring.maxLife, 0, 1);
      // easeOutCubic
      const e = 1 - (1 - lifeT) ** 3;
      const r0 = ring.maxR * 0.04;
      ring.r = r0 + (ring.maxR - r0) * e;
      if (ring.life <= 0 || lifeT >= 0.99) {
        this.rings.splice(i, 1);
      }
    }

    const cap = Math.min(this.hardMax, this.maxParticlesNow());
    const rate = this.spawnRateNow();
    this.spawnAcc += rate * dt;
    while (this.spawnAcc >= 1 && this.active.length < cap) {
      this.spawnOne(false);
      this.spawnAcc -= 1;
    }
    if (this.active.length >= cap) this.spawnAcc = Math.min(this.spawnAcc, 1);

    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const hueShift =
      WARP.hueShiftSpeed * this.intensity * dt +
      (this.sessionCount > 1 ? WARP.multiSessionHueShift * 0.15 * dt : 0);
    const mode = this.style.spawnMode;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const accel = 42 * this.speedScaleNow();

    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i];

      p.x += p.vx * dt;
      p.y += p.vy * dt;

      if (p.isTokenChip) {
        // Token chips ride stream: lane spring (datastream) or primary direction
        const adx = Math.cos(this.dirAngle);
        const ady = Math.sin(this.dirAngle);
        if (mode === "tunnel" || mode === "vortex" || mode === "signal") {
          let rx = p.x - cx;
          let ry = p.y - cy;
          const d = Math.hypot(rx, ry) || 1;
          rx /= d;
          ry /= d;
          p.vx += rx * accel * 1.05 * dt;
          p.vy += ry * accel * 1.05 * dt;
        } else if (mode === "datastream") {
          const px = -ady;
          const py = adx;
          p.vx += adx * accel * 0.85 * dt;
          p.vy += ady * accel * 0.85 * dt;
          const relX = p.x - cx;
          const relY = p.y - cy;
          const across = relX * px + relY * py;
          const err = across - p.laneOffset;
          p.vx += -px * err * WARP.streamLaneSpring * dt;
          p.vy += -py * err * WARP.streamLaneSpring * dt;
          const vAcross = p.vx * px + p.vy * py;
          p.vx -= px * vAcross * (1 - Math.exp(-8 * dt));
          p.vy -= py * vAcross * (1 - Math.exp(-8 * dt));
        } else {
          p.vx += adx * accel * 0.9 * dt;
          p.vy += ady * accel * 0.9 * dt;
        }
      } else if (mode === "tunnel") {
        let rx = p.x - cx;
        let ry = p.y - cy;
        const d = Math.hypot(rx, ry) || 1;
        rx /= d;
        ry /= d;
        p.vx += rx * accel * 1.15 * dt + (Math.random() - 0.5) * 22 * dt;
        p.vy += ry * accel * 1.15 * dt + (Math.random() - 0.5) * 22 * dt;
      } else if (mode === "signal") {
        // Wave field: slower radial + slight tangent so it reads as ripple, not hyperspace
        let rx = p.x - cx;
        let ry = p.y - cy;
        const d = Math.hypot(rx, ry) || 1;
        rx /= d;
        ry /= d;
        const tx = -ry;
        const ty = rx;
        const far = clamp(d / (Math.min(w, h) * 0.45), 0, 1);
        const push = lerp(0.55, 0.95, far);
        p.vx +=
          (rx * accel * push + tx * accel * 0.22) * dt +
          (Math.random() - 0.5) * 10 * dt;
        p.vy +=
          (ry * accel * push + ty * accel * 0.22) * dt +
          (Math.random() - 0.5) * 10 * dt;
        // Soft speed cap so far rings don't streak like tunnel
        const spd = Math.hypot(p.vx, p.vy);
        const cap = 520 * this.speedScaleNow() * (0.7 + p.layer * 0.15);
        if (spd > cap) {
          p.vx *= cap / spd;
          p.vy *= cap / spd;
        }
      } else if (mode === "orbital") {
        let rx = p.x - cx;
        let ry = p.y - cy;
        const r = Math.hypot(rx, ry) || 1;
        rx /= r;
        ry /= r;
        const tx = -ry;
        const ty = rx;
        const targetR = p.orbitR > 0 ? p.orbitR : r;
        const err = r - targetR;
        p.vx += (-rx * err * WARP.orbitSpring + tx * accel * 0.15) * dt;
        p.vy += (-ry * err * WARP.orbitSpring + ty * accel * 0.15) * dt;
        p.vx *= 1 - 0.35 * dt;
        p.vy *= 1 - 0.35 * dt;
        const spd = Math.hypot(p.vx, p.vy);
        const want = 180 * this.speedScaleNow() * (0.7 + p.layer * 0.2);
        if (spd > 1 && spd < want * 0.5) {
          p.vx += tx * want * 0.4 * dt;
          p.vy += ty * want * 0.4 * dt;
        }
      } else if (mode === "vortex") {
        let rx = p.x - cx;
        let ry = p.y - cy;
        const d = Math.hypot(rx, ry) || 1;
        rx /= d;
        ry /= d;
        const tx = -ry;
        const ty = rx;
        p.vx +=
          (rx * accel * 0.85 + tx * accel * 1.1) * dt +
          (Math.random() - 0.5) * 18 * dt;
        p.vy +=
          (ry * accel * 0.85 + ty * accel * 1.1) * dt +
          (Math.random() - 0.5) * 18 * dt;
      } else if (mode === "spark") {
        p.vx *= 1 - 1.8 * dt;
        p.vy *= 1 - 1.8 * dt;
      } else if (mode === "datastream") {
        const adx = Math.cos(this.dirAngle);
        const ady = Math.sin(this.dirAngle);
        const px = -ady;
        const py = adx;
        p.vx += adx * accel * 0.85 * dt;
        p.vy += ady * accel * 0.85 * dt;
        const relX = p.x - cx;
        const relY = p.y - cy;
        const across = relX * px + relY * py;
        const err = across - p.laneOffset;
        p.vx += -px * err * WARP.streamLaneSpring * dt;
        p.vy += -py * err * WARP.streamLaneSpring * dt;
        const vAcross = p.vx * px + p.vy * py;
        p.vx -= px * vAcross * (1 - Math.exp(-8 * dt));
        p.vy -= py * vAcross * (1 - Math.exp(-8 * dt));
        const vAlong = p.vx * adx + p.vy * ady;
        if (vAlong < 120 * this.speedScaleNow()) {
          p.vx += adx * 80 * this.speedScaleNow() * dt;
          p.vy += ady * 80 * this.speedScaleNow() * dt;
        }
      } else {
        const adx = Math.cos(this.dirAngle);
        const ady = Math.sin(this.dirAngle);
        const jitter = mode === "directional" && this.style.sizeGrow ? 40 : 28;
        p.vx += adx * accel * dt + (Math.random() - 0.5) * jitter * dt;
        p.vy += ady * accel * dt + (Math.random() - 0.5) * jitter * dt;
        if (this.style.sizeGrow) {
          p.vx *= 1 - 0.4 * dt;
          p.vy *= 1 - 0.15 * dt;
        }
      }

      if (p.grow) {
        const age = 1 - Math.max(0, p.life / p.maxLife);
        p.size = p.baseSize * (1 + age * 1.6);
      }

      p.hue = (p.hue + hueShift) % 360;

      if (p.hasTrail && p.trailCap > 0) {
        const idx = p.trailIdx % p.trailCap;
        p.trail[idx * 2] = p.x;
        p.trail[idx * 2 + 1] = p.y;
        p.trailIdx = (p.trailIdx + 1) % p.trailCap;
        p.trailCount = Math.min(p.trailCap, p.trailCount + 1);
      }

      p.life -= dt;

      const out =
        p.life <= 0 ||
        p.y < -WARP.maxStretch - 40 ||
        p.x < -80 ||
        p.x > w + 80 ||
        p.y > h + 80;

      if (out) {
        this.active.splice(i, 1);
        this.release(p);
      }
    }

    if (
      this.fadingOut &&
      (this.fade <= 0.01 || (this.active.length === 0 && this.rings.length === 0))
    ) {
      this.halt();
    }
  }

  // ── Draw ────────────────────────────────────────────────────

  private draw() {
    const { ctx, canvas } = this;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    if (
      (this.active.length === 0 && this.rings.length === 0) ||
      this.fade <= 0.01
    ) {
      return;
    }

    const stretchScale = this.stretchScaleNow();
    const glowScale = this.glowScaleNow();
    const globalA = this.fade;

    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    this.drawRings(globalA);

    for (let layer = 0; layer <= 2; layer++) {
      for (const p of this.active) {
        if (p.layer !== layer || p.isTokenChip) continue;
        this.drawParticle(p, stretchScale, glowScale, globalA);
      }
    }

    // Token chips on top, readable text (source-over)
    ctx.globalCompositeOperation = "source-over";
    for (const p of this.active) {
      if (!p.isTokenChip) continue;
      this.drawTokenChip(p, globalA);
    }

    ctx.globalCompositeOperation = "source-over";
  }

  private drawRings(globalA: number) {
    if (this.rings.length === 0) return;
    const ctx = this.ctx;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const cx = w * 0.5;
    const cy = h * 0.5;
    // Single multiplier path (spawn alpha already style-aware)
    const styleA = this.userStyleAlpha;
    const isSignal = this.style.spawnMode === "signal";

    for (const ring of this.rings) {
      const lifeT = clamp(ring.life / ring.maxLife, 0, 1);
      // Soft in, soft out
      const envelope = Math.sin(lifeT * Math.PI);
      const a = Math.min(1, ring.alpha * envelope * globalA * styleA * (isSignal ? 1.15 : 0.9));
      if (a < 0.02 || ring.r < 1) continue;
      const color = hslToRgb(ring.hue, ring.sat, Math.min(96, ring.light + 4));
      ctx.beginPath();
      ctx.arc(cx, cy, ring.r, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(color.r, color.g, color.b, a);
      ctx.lineWidth = ring.width * (0.85 + lifeT * 0.45);
      ctx.stroke();
      // Outer halo — Signal only (cheaper on other styles' completion ring)
      if (isSignal) {
        ctx.beginPath();
        ctx.arc(cx, cy, ring.r + ring.width * 1.35, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(color.r, color.g, color.b, a * 0.38);
        ctx.lineWidth = ring.width * 0.5;
        ctx.stroke();
      }
    }
  }

  private drawTokenChip(p: Particle, globalA: number) {
    const ctx = this.ctx;
    const lifeT = Math.max(0, p.life / p.maxLife);
    const lifeAlpha = easeLife(lifeT);
    const a =
      p.alpha * lifeAlpha * globalA * this.userStyleAlpha * 0.95;
    if (a < 0.04 || !p.label) return;

    const color = hslToRgb(p.hue, p.sat, p.light);
    const fontSize = clamp(11 + Math.min(6, p.label.length * 0.15), 11, 16);

    ctx.save();
    ctx.font = `600 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Soft pill behind label for contrast on any desktop
    const metrics = ctx.measureText(p.label);
    const tw = metrics.width + 10;
    const th = fontSize + 6;
    ctx.fillStyle = rgba(8, 12, 22, a * 0.45);
    ctx.beginPath();
    const rx = tw * 0.5;
    const ry = th * 0.5;
    const x0 = p.x - rx;
    const y0 = p.y - ry;
    const r = 6;
    ctx.moveTo(x0 + r, y0);
    ctx.arcTo(x0 + tw, y0, x0 + tw, y0 + th, r);
    ctx.arcTo(x0 + tw, y0 + th, x0, y0 + th, r);
    ctx.arcTo(x0, y0 + th, x0, y0, r);
    ctx.arcTo(x0, y0, x0 + tw, y0, r);
    ctx.closePath();
    ctx.fill();

    // Accent edge
    ctx.strokeStyle = rgba(color.r, color.g, color.b, a * 0.55);
    ctx.lineWidth = 1;
    ctx.stroke();

    // Label
    ctx.fillStyle = rgba(color.r, color.g, color.b, Math.min(1, a * 1.05));
    ctx.shadowColor = rgba(color.r, color.g, color.b, a * 0.45);
    ctx.shadowBlur = 8;
    ctx.fillText(p.label, p.x, p.y);
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  private drawParticle(
    p: Particle,
    stretchScale: number,
    glowScale: number,
    globalA: number,
  ) {
    const ctx = this.ctx;
    const speed = Math.hypot(p.vx, p.vy);
    if (speed < 1) return;

    const soft = !!this.style.softBloom;
    const drawMul = (this.style.glowDrawMul ?? 1) * this.userStyleAlpha;
    // Soft styles: cap intensity-driven glow so packets don't bloom white
    const effectiveGlow = soft
      ? lerp(0.55, 0.85, clamp(this.intensity, 0, 1))
      : glowScale;

    const lifeT = Math.max(0, p.life / p.maxLife);
    const lifeAlpha = easeLife(lifeT);
    const a = p.alpha * lifeAlpha * globalA * effectiveGlow * drawMul;
    if (a < 0.02) return;

    const stretch = clamp(
      speed * WARP.stretchPerSpeed * stretchScale,
      soft ? Math.min(WARP.minStretch, 8) : WARP.minStretch,
      soft ? Math.min(WARP.maxStretch, 72) : WARP.maxStretch,
    );

    const ux = p.vx / speed;
    const uy = p.vy / speed;
    const headX = p.x;
    const headY = p.y;
    const tailX = p.x - ux * stretch;
    const tailY = p.y - uy * stretch;

    const color = hslToRgb(p.hue, p.sat, p.light);
    const size = soft ? p.size * 0.75 : p.size;

    if (p.hasTrail && p.trailCount > 1) {
      this.drawTrailGhosts(
        p,
        ux,
        uy,
        stretch,
        size,
        color,
        soft ? a * 0.45 : a,
      );
    }

    if (soft) {
      // Single thin body + faint core — no outer bloom halo
      this.strokeStreak(
        tailX,
        tailY,
        headX,
        headY,
        Math.max(0.7, size * 1.15),
        color,
        a * 0.25,
        a * 0.7,
      );
      this.strokeStreak(
        lerp(tailX, headX, 0.35),
        lerp(tailY, headY, 0.35),
        headX,
        headY,
        Math.max(0.55, size * 0.55),
        color,
        a * 0.35,
        Math.min(0.85, a * 0.95),
      );
      // Tiny head dot (not a radial bloom)
      ctx.fillStyle = rgba(color.r, color.g, color.b, Math.min(0.75, a * 0.9));
      ctx.beginPath();
      ctx.arc(headX, headY, Math.max(0.6, size * 0.45), 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    if (p.curved) {
      this.strokeCurvedStreak(
        tailX,
        tailY,
        headX,
        headY,
        ux,
        uy,
        size * WARP.glowWidthMul,
        color,
        a * 0.4,
        a * 0.85,
      );
      this.strokeCurvedStreak(
        tailX,
        tailY,
        headX,
        headY,
        ux,
        uy,
        size * WARP.midWidthMul,
        color,
        a * 0.55,
        Math.min(1, a * 1.15),
      );
      this.strokeCurvedStreak(
        lerp(tailX, headX, 0.4),
        lerp(tailY, headY, 0.4),
        headX,
        headY,
        ux,
        uy,
        Math.max(0.9, size * WARP.coreWidthMul),
        { r: 255, g: 255, b: 255 },
        a * 0.45,
        Math.min(1, a * 1.2),
      );
    } else {
      this.strokeStreak(
        tailX,
        tailY,
        headX,
        headY,
        size * WARP.glowWidthMul,
        color,
        a * 0.4,
        a * 0.85,
      );
      this.strokeStreak(
        tailX,
        tailY,
        headX,
        headY,
        size * WARP.midWidthMul,
        color,
        a * 0.55,
        Math.min(1, a * 1.15),
      );
      this.strokeStreak(
        lerp(tailX, headX, 0.4),
        lerp(tailY, headY, 0.4),
        headX,
        headY,
        Math.max(0.9, size * WARP.coreWidthMul),
        { r: 255, g: 255, b: 255 },
        a * 0.45,
        Math.min(1, a * 1.2),
      );
    }

    if (p.layer >= 1) {
      const glowR = size * WARP.glowWidthMul * (p.layer === 2 ? 1.35 : 0.9);
      const g = ctx.createRadialGradient(headX, headY, 0, headX, headY, glowR);
      g.addColorStop(0, rgba(255, 255, 255, Math.min(1, a * 1.05)));
      g.addColorStop(0.2, rgba(color.r, color.g, color.b, a * 0.7));
      g.addColorStop(0.55, rgba(color.r, color.g, color.b, a * 0.22));
      g.addColorStop(1, rgba(color.r, color.g, color.b, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(headX, headY, glowR, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = rgba(255, 255, 255, Math.min(1, a * 0.95));
      ctx.beginPath();
      ctx.arc(headX, headY, Math.max(0.7, size * WARP.coreScale), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawTrailGhosts(
    p: Particle,
    ux: number,
    uy: number,
    stretch: number,
    size: number,
    color: Rgb,
    baseA: number,
  ) {
    const cap = p.trailCap;
    const count = p.trailCount;
    for (let k = 0; k < count - 1; k++) {
      const age = count - 1 - k;
      const slot = (p.trailIdx - 1 - k + cap * 8) % cap;
      const gx = p.trail[slot * 2];
      const gy = p.trail[slot * 2 + 1];
      if (gx === 0 && gy === 0 && k > 0) continue;

      const ghostT = 1 - age / count;
      const ga = baseA * 0.22 * ghostT;
      if (ga < 0.02) continue;

      const gs = stretch * (0.35 + 0.45 * ghostT);
      const tx = gx - ux * gs;
      const ty = gy - uy * gs;

      this.strokeStreak(
        tx,
        ty,
        gx,
        gy,
        size * WARP.midWidthMul * 0.7,
        color,
        ga * 0.2,
        ga * 0.7,
      );
    }
  }

  private strokeStreak(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    width: number,
    color: Rgb,
    aTail: number,
    aHead: number,
  ) {
    const ctx = this.ctx;
    const grad = ctx.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, rgba(color.r, color.g, color.b, Math.max(0, aTail)));
    grad.addColorStop(
      0.55,
      rgba(color.r, color.g, color.b, Math.max(0, (aTail + aHead) * 0.5)),
    );
    grad.addColorStop(1, rgba(color.r, color.g, color.b, Math.max(0, aHead)));
    ctx.strokeStyle = grad;
    ctx.lineWidth = Math.max(0.5, width);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  /** Soft quadratic curve for aurora / organic streaks */
  private strokeCurvedStreak(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    ux: number,
    uy: number,
    width: number,
    color: Rgb,
    aTail: number,
    aHead: number,
  ) {
    const ctx = this.ctx;
    const mx = (x0 + x1) * 0.5;
    const my = (y0 + y1) * 0.5;
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    // Perpendicular bend
    const bend = len * 0.12;
    const cpx = mx - uy * bend;
    const cpy = my + ux * bend;

    const grad = ctx.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, rgba(color.r, color.g, color.b, Math.max(0, aTail)));
    grad.addColorStop(
      0.55,
      rgba(color.r, color.g, color.b, Math.max(0, (aTail + aHead) * 0.5)),
    );
    grad.addColorStop(1, rgba(color.r, color.g, color.b, Math.max(0, aHead)));
    ctx.strokeStyle = grad;
    ctx.lineWidth = Math.max(0.5, width);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(cpx, cpy, x1, y1);
    ctx.stroke();
  }
}

// ── Helpers ───────────────────────────────────────────────────

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function createParticleShell(): Particle {
  return {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    life: 0,
    maxLife: 1,
    size: 1,
    baseSize: 1,
    alpha: 1,
    layer: 0,
    hue: 0,
    sat: 80,
    light: 70,
    hasTrail: false,
    trail: new Float32Array(0),
    trailCap: 0,
    trailIdx: 0,
    trailCount: 0,
    curved: false,
    grow: false,
    orbitR: 0,
    laneOffset: 0,
    isTokenChip: false,
    label: "",
    alive: false,
  };
}

/** Format +12 / 1.2k for floating chips */
function formatTokenLabel(n: number, asDelta: boolean): string {
  const v = Math.max(0, Math.floor(n));
  let body: string;
  if (v >= 1_000_000) body = `${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  else if (v >= 10_000) body = `${Math.round(v / 1000)}k`;
  else if (v >= 1000) body = `${(v / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  else body = String(v);
  return asDelta ? `+${body}` : body;
}

function buildLayerCdf(): number[] {
  const weights = WARP.layers.map((l) => l.weight);
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  return weights.map((w) => {
    acc += w / sum;
    return acc;
  });
}

/** Quick fade-in, longer soft fade-out (whip feel) */
function easeLife(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const age = 1 - t;
  const fadeIn = Math.min(1, age / 0.05);
  const fadeOut = Math.min(1, t / 0.32);
  return fadeIn * fadeOut;
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const hh = ((h % 360) + 360) % 360;
  const ss = clamp(s, 0, 100) / 100;
  const ll = clamp(l, 0, 100) / 100;

  if (ss === 0) {
    const v = Math.round(ll * 255);
    return { r: v, g: v, b: v };
  }

  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  const hk = hh / 360;
  const r = hue2rgb(p, q, hk + 1 / 3);
  const g = hue2rgb(p, q, hk);
  const b = hue2rgb(p, q, hk - 1 / 3);
  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255),
  };
}

function hue2rgb(p: number, q: number, t: number): number {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

function rgba(r: number, g: number, b: number, a: number): string {
  return `rgba(${r | 0},${g | 0},${b | 0},${clamp(a, 0, 1)})`;
}
