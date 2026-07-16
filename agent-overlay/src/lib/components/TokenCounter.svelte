<script lang="ts">
  import { intensityFromTokens } from "$lib/particles/intensity";
  import { generation } from "$lib/stores/generation.svelte";

  const formatted = $derived(generation.tokenCount.toLocaleString("en-US"));
  const intensity = $derived(intensityFromTokens(generation.tokenCount));
  const intensityPct = $derived(Math.round(Math.min(1, intensity) * 100));

  // Visual scale/glow driven by warp intensity
  const scale = $derived(0.95 + Math.min(1, intensity) * 0.12);
  const glow = $derived(10 + Math.min(1, intensity) * 28);
  const glowAlpha = $derived(0.25 + Math.min(1, intensity) * 0.45);
</script>

<div
  class="token-counter"
  class:live={generation.isGenerating}
  style="
    --tc-scale: {scale};
    --tc-glow: {glow}px;
    --tc-glow-a: {glowAlpha};
  "
>
  <span class="label">tokens</span>
  <span class="value">{formatted}</span>
  <span class="sub">warp {intensityPct}%</span>
</div>

<style>
  .token-counter {
    position: absolute;
    left: 50%;
    bottom: 14%;
    transform: translateX(-50%) scale(var(--tc-scale, 1));
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.1rem;
    pointer-events: none;
    user-select: none;
    opacity: 0;
    transition:
      opacity 320ms ease,
      transform 320ms ease,
      filter 200ms ease;
  }

  .token-counter.live {
    opacity: 0.92;
  }

  .label {
    font-size: 0.68rem;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: rgba(226, 232, 240, 0.55);
    font-weight: 500;
  }

  .value {
    font-size: 1.95rem;
    font-weight: 650;
    letter-spacing: 0.02em;
    font-variant-numeric: tabular-nums;
    background: linear-gradient(
      120deg,
      #5bdeff 0%,
      #a78bfa 40%,
      #f472b6 70%,
      #fbbf24 100%
    );
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    filter: drop-shadow(
      0 0 var(--tc-glow, 12px) rgba(167, 139, 250, var(--tc-glow-a, 0.35))
    );
  }

  .sub {
    font-size: 0.65rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: rgba(148, 163, 184, 0.55);
    font-variant-numeric: tabular-nums;
  }
</style>
