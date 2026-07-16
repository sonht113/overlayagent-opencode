<script lang="ts">
  import { onMount } from "svelte";
  import { ParticleSystem } from "$lib/particles/ParticleSystem";
  import {
    generation,
    getStyleAlpha,
  } from "$lib/stores/generation.svelte";

  let canvas: HTMLCanvasElement;
  let system: ParticleSystem | null = null;
  let visualActive = $state(false);
  let prevTokens = 0;
  /** Edge detect isGenerating so token/settings updates never re-burst */
  let lastGenerating = false;

  function applyMotionSettings(sys: ParticleSystem) {
    sys.setStyle(generation.animationStyle);
    sys.setStyleAlpha(getStyleAlpha(generation.animationStyle));
    sys.setTokenFlow(generation.tokenFlow);
    sys.setUserMultiplier(generation.userIntensity);
    sys.setUserSpeed(generation.particleSpeed);
    sys.setMotionDirection(generation.motionAngle, generation.motionSpread);
    sys.setTokenCount(generation.tokenCount);
    const sessions = Object.keys(generation.activeSessions).length;
    sys.setSessionCount(Math.max(1, sessions || 1));
  }

  onMount(() => {
    system = new ParticleSystem(canvas);
    prevTokens = generation.tokenCount;
    applyMotionSettings(system);

    const ro = new ResizeObserver(() => system?.resize());
    ro.observe(canvas);

    if (generation.isGenerating) {
      visualActive = true;
      lastGenerating = true;
      system.start();
    }

    return () => {
      ro.disconnect();
      system?.destroy();
      system = null;
    };
  });

  // Start / stop only on isGenerating edge — never re-burst on token/settings churn
  $effect(() => {
    const generating = generation.isGenerating;
    if (!system) return;

    if (generating && !lastGenerating) {
      visualActive = true;
      prevTokens = generation.tokenCount;
      applyMotionSettings(system);
      system.start();
    } else if (!generating && lastGenerating) {
      system.stop(() => {
        visualActive = false;
      });
    }
    lastGenerating = generating;
  });

  // Live token → intensity + floating chips on delta
  $effect(() => {
    const tokens = generation.tokenCount;
    if (!system) return;
    system.setTokenCount(tokens);
    if (generation.isGenerating && generation.tokenFlow) {
      const delta = tokens - prevTokens;
      if (delta > 0) {
        system.pushTokenDelta(delta, tokens);
      }
    }
    prevTokens = tokens;
  });

  // Settings: intensity
  $effect(() => {
    const mul = generation.userIntensity;
    system?.setUserMultiplier(mul);
  });

  // Settings: speed
  $effect(() => {
    const speed = generation.particleSpeed;
    system?.setUserSpeed(speed);
  });

  // Settings: direction + spread
  $effect(() => {
    const angle = generation.motionAngle;
    const spread = generation.motionSpread;
    system?.setMotionDirection(angle, spread);
  });

  // Settings: animation style
  $effect(() => {
    const style = generation.animationStyle;
    system?.setStyle(style);
    system?.setStyleAlpha(getStyleAlpha(style));
  });

  // Settings: per-style alpha
  $effect(() => {
    const style = generation.animationStyle;
    const alpha = generation.styleAlpha[style];
    system?.setStyleAlpha(
      typeof alpha === "number" && Number.isFinite(alpha) ? alpha : 1,
    );
  });

  // Settings: token flow toggle
  $effect(() => {
    system?.setTokenFlow(generation.tokenFlow);
  });

  // Multi-session tint / density (OpenCode concurrent gens)
  $effect(() => {
    const n = Object.keys(generation.activeSessions).length;
    system?.setSessionCount(Math.max(1, n || 1));
  });
</script>

<canvas
  bind:this={canvas}
  class="particles"
  class:active={visualActive}
  aria-hidden="true"
></canvas>

<style>
  .particles {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    opacity: 0;
    transition: opacity 420ms ease;
  }

  .particles.active {
    opacity: 1;
  }
</style>
