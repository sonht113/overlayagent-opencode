<script lang="ts">
  import { showOverlayWindow } from "$lib/bridge/opencode";
  import {
    generation,
    startGeneration,
    stopGeneration,
    setTokenCount,
    setOpacity,
  } from "$lib/stores/generation.svelte";

  let tokenInput = $state(String(generation.tokenCount));

  $effect(() => {
    // Keep local input in sync when external updates arrive later
    tokenInput = String(generation.tokenCount);
  });

  function onTokenInput(e: Event) {
    const raw = (e.currentTarget as HTMLInputElement).value;
    tokenInput = raw;
    const n = Number(raw);
    if (!Number.isNaN(n)) setTokenCount(n);
  }

  function onOpacity(e: Event) {
    setOpacity(Number((e.currentTarget as HTMLInputElement).value));
  }

  async function onToggle() {
    if (generation.isGenerating) {
      stopGeneration("manual");
      return;
    }
    // Ensure window is visible if it was auto-hidden earlier
    await showOverlayWindow();
    startGeneration("manual");
  }

  const statusHint = $derived.by(() => {
    if (generation.isGenerating && generation.source === "opencode") {
      const model = generation.lastModel ?? "Grok";
      return `Live · ${model} — tokens drive warp`;
    }
    if (generation.isGenerating) {
      return "Manual warp — higher tokens intensify";
    }
    if (generation.bridgeConnected) {
      const port = generation.eventPort ?? 9876;
      return `Idle · bridge :${port} — ready for next event`;
    }
    return "Idle — set tokens, then Start";
  });
</script>

<aside class="panel" aria-label="Generation controls">
  <div class="row primary">
    <button
      type="button"
      class="btn"
      class:stop={generation.isGenerating}
      class:start={!generation.isGenerating}
      onclick={onToggle}
    >
      {#if generation.isGenerating}
        <span class="pulse"></span>
        Stop
      {:else}
        Start
      {/if}
    </button>
    <p class="hint">{statusHint}</p>
  </div>

  {#if generation.bridgeConnected}
    <p class="bridge">
      <span class="bridge-dot" class:live={generation.liveSessionActive}></span>
      OpenCode HTTP
      {#if generation.lastSessionId}
        · {generation.lastSessionId}
      {/if}
    </p>
  {/if}

  <label class="field">
    <span class="field-label">
      Token count
      <span class="meta">drives intensity</span>
    </span>
    <input
      type="number"
      min="0"
      step="1"
      inputmode="numeric"
      value={tokenInput}
      oninput={onTokenInput}
    />
  </label>

  <label class="field">
    <span class="field-label">
      Opacity
      <span class="meta">{Math.round(generation.opacity * 100)}%</span>
    </span>
    <input
      type="range"
      min="0.2"
      max="1"
      step="0.01"
      value={generation.opacity}
      oninput={onOpacity}
    />
  </label>
</aside>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    padding: 0.9rem 1rem 1rem;
    border-radius: 0 0 14px 14px;
    background: rgba(12, 14, 22, 0.78);
    border-top: 1px solid rgba(255, 255, 255, 0.04);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
  }

  .row.primary {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .hint {
    margin: 0;
    font-size: 0.75rem;
    color: rgba(203, 213, 225, 0.62);
    line-height: 1.3;
  }

  .bridge {
    margin: -0.25rem 0 0;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.68rem;
    letter-spacing: 0.04em;
    color: rgba(148, 163, 184, 0.7);
    font-variant-numeric: tabular-nums;
  }

  .bridge-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: rgba(52, 211, 153, 0.55);
    box-shadow: 0 0 6px rgba(52, 211, 153, 0.35);
  }

  .bridge-dot.live {
    background: #5bdeff;
    box-shadow: 0 0 8px rgba(91, 222, 255, 0.85);
    animation: pulse 1.2s ease-in-out infinite;
  }

  .btn {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    min-width: 5.5rem;
    padding: 0.55rem 1rem;
    border: 1px solid transparent;
    border-radius: 10px;
    font-size: 0.88rem;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition:
      background 160ms ease,
      border-color 160ms ease,
      box-shadow 160ms ease,
      transform 100ms ease;
  }

  .btn:active {
    transform: scale(0.97);
  }

  .btn.start {
    color: #0b1220;
    background: linear-gradient(135deg, #5bdeff 0%, #a78bfa 100%);
    box-shadow: 0 0 18px rgba(91, 222, 255, 0.28);
  }

  .btn.start:hover {
    box-shadow: 0 0 24px rgba(167, 139, 250, 0.4);
  }

  .btn.stop {
    color: #fecaca;
    background: rgba(127, 29, 29, 0.45);
    border-color: rgba(248, 113, 113, 0.35);
  }

  .btn.stop:hover {
    background: rgba(153, 27, 27, 0.55);
  }

  .pulse {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #f87171;
    box-shadow: 0 0 8px rgba(248, 113, 113, 0.9);
    animation: pulse 1.2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
      transform: scale(1);
    }
    50% {
      opacity: 0.45;
      transform: scale(0.85);
    }
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .field-label {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-size: 0.72rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: rgba(203, 213, 225, 0.6);
    font-weight: 550;
  }

  .meta {
    font-variant-numeric: tabular-nums;
    letter-spacing: 0;
    text-transform: none;
    color: rgba(226, 232, 240, 0.75);
  }

  input[type="number"] {
    width: 100%;
    box-sizing: border-box;
    padding: 0.55rem 0.7rem;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(8, 10, 18, 0.65);
    color: #f1f5f9;
    font-size: 0.95rem;
    font-family: inherit;
    font-variant-numeric: tabular-nums;
    outline: none;
    transition: border-color 150ms ease, box-shadow 150ms ease;
  }

  input[type="number"]:focus {
    border-color: rgba(91, 222, 255, 0.45);
    box-shadow: 0 0 0 3px rgba(91, 222, 255, 0.12);
  }

  input[type="range"] {
    width: 100%;
    accent-color: #a78bfa;
    cursor: pointer;
  }
</style>
