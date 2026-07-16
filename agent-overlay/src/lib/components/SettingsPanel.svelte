<script lang="ts">
  import { fade, fly } from "svelte/transition";
  import { hideOverlayWindow } from "$lib/bridge/opencode";
  import {
    STYLE_ORDER,
    STYLE_PRESETS,
  } from "$lib/particles/presets";
  import {
    closeSettings,
    generation,
    getStyleAlpha,
    motionAngleLabel,
    resetStyleAlpha,
    setAnimationStyle,
    setMotionAngle,
    setMotionSpread,
    setOpacity,
    setParticleSpeed,
    setShowTokenCount,
    setStyleAlpha,
    setTokenFlow,
    setUserIntensity,
    startGeneration,
    stopGeneration,
  } from "$lib/stores/generation.svelte";

  const ANGLE_PRESETS = [
    { label: "↑ Up", deg: 270 },
    { label: "→ Right", deg: 0 },
    { label: "↓ Down", deg: 90 },
    { label: "← Left", deg: 180 },
  ] as const;

  const hideMotion = $derived(
    STYLE_PRESETS[generation.animationStyle].hideMotion,
  );

  const currentStyleAlpha = $derived(getStyleAlpha(generation.animationStyle));
  const currentStyleLabel = $derived(
    STYLE_PRESETS[generation.animationStyle].label,
  );

  /** Keep panel interactions from bubbling to overlay (close / drag). */
  function trap(e: Event) {
    e.stopPropagation();
  }

  async function hideOverlay() {
    closeSettings();
    stopGeneration("manual");
    await hideOverlayWindow();
  }

  async function testWarp() {
    if (generation.isGenerating) {
      stopGeneration("manual");
      return;
    }
    startGeneration("manual");
  }
</script>

{#if generation.settingsOpen}
  <!-- Transparent scrim: click to dismiss (not a drag region) -->
  <button
    type="button"
    class="scrim"
    transition:fade={{ duration: 160 }}
    aria-label="Close settings"
    onclick={closeSettings}
  ></button>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="panel"
    transition:fly={{ x: 36, duration: 280, opacity: 0 }}
    role="presentation"
    onpointerdown={trap}
    oncontextmenu={(e) => {
      e.preventDefault();
      e.stopPropagation();
    }}
  >
    <header class="head">
      <div>
        <h2>Settings</h2>
        <p class="sub">Right-click overlay to reopen</p>
      </div>
      <button type="button" class="icon" onclick={closeSettings} aria-label="Close">
        ✕
      </button>
    </header>

    <div class="field">
      <span class="field-label">
        Animation style
        <em>{STYLE_PRESETS[generation.animationStyle].label}</em>
      </span>
      <div class="presets style-presets">
        {#each STYLE_ORDER as id}
          <button
            type="button"
            class="preset"
            class:active={generation.animationStyle === id}
            onclick={() => setAnimationStyle(id)}
          >
            {STYLE_PRESETS[id].label}
          </button>
        {/each}
      </div>
      <p class="hint">{STYLE_PRESETS[generation.animationStyle].hint}</p>
    </div>

    <div class="field">
      <span class="field-label">
        Style alpha · {currentStyleLabel}
        <em>{currentStyleAlpha.toFixed(2)}×</em>
      </span>
      <input
        type="range"
        min="0.15"
        max="1.5"
        step="0.05"
        value={currentStyleAlpha}
        oninput={(e) => setStyleAlpha(Number(e.currentTarget.value))}
      />
      <div class="alpha-row">
        <p class="hint">Particle brightness for this style only</p>
        {#if Math.abs(currentStyleAlpha - 1) > 0.01}
          <button
            type="button"
            class="linkish"
            onclick={() => resetStyleAlpha()}
          >
            Reset
          </button>
        {/if}
      </div>
    </div>

    <label class="row">
      <span>Token flow on stream</span>
      <input
        type="checkbox"
        checked={generation.tokenFlow}
        onchange={(e) => setTokenFlow(e.currentTarget.checked)}
      />
    </label>

    <label class="row">
      <span>Show token count</span>
      <input
        type="checkbox"
        checked={generation.showTokenCount}
        onchange={(e) => setShowTokenCount(e.currentTarget.checked)}
      />
    </label>

    <label class="field">
      <span class="field-label">
        Opacity
        <em>{Math.round(generation.opacity * 100)}%</em>
      </span>
      <input
        type="range"
        min="0.25"
        max="1"
        step="0.01"
        value={generation.opacity}
        oninput={(e) => setOpacity(Number(e.currentTarget.value))}
      />
    </label>

    <label class="field">
      <span class="field-label">
        Particle intensity
        <em>{generation.userIntensity.toFixed(2)}×</em>
      </span>
      <input
        type="range"
        min="0.35"
        max="1.5"
        step="0.05"
        value={generation.userIntensity}
        oninput={(e) => setUserIntensity(Number(e.currentTarget.value))}
      />
    </label>

    <label class="field">
      <span class="field-label">
        Speed
        <em>{generation.particleSpeed.toFixed(2)}×</em>
      </span>
      <input
        type="range"
        min="0.4"
        max="2"
        step="0.05"
        value={generation.particleSpeed}
        oninput={(e) => setParticleSpeed(Number(e.currentTarget.value))}
      />
    </label>

    {#if hideMotion}
      <p class="hint motion-note">Direction locked · radial from center</p>
    {:else}
      <div class="field">
        <span class="field-label">
          Motion direction
          <em>{motionAngleLabel(generation.motionAngle)} · {Math.round(generation.motionAngle)}°</em>
        </span>
        <div class="presets">
          {#each ANGLE_PRESETS as p}
            <button
              type="button"
              class="preset"
              class:active={Math.abs(generation.motionAngle - p.deg) < 2 || (p.deg === 0 && generation.motionAngle > 358)}
              onclick={() => setMotionAngle(p.deg)}
            >
              {p.label}
            </button>
          {/each}
        </div>
        <input
          type="range"
          min="0"
          max="360"
          step="1"
          value={generation.motionAngle}
          oninput={(e) => setMotionAngle(Number(e.currentTarget.value))}
        />
      </div>

      <label class="field">
        <span class="field-label">
          Motion spread
          <em>{Math.round(generation.motionSpread)}°</em>
        </span>
        <input
          type="range"
          min="0"
          max="60"
          step="1"
          value={generation.motionSpread}
          oninput={(e) => setMotionSpread(Number(e.currentTarget.value))}
        />
      </label>
    {/if}

    <div class="status">
      <span class="dot" class:on={generation.bridgeConnected}></span>
      <div class="status-text">
        <strong>OpenCode bridge</strong>
        <span>
          {#if generation.bridgeConnected}
            connected{generation.eventPort ? ` · :${generation.eventPort}` : ""}
          {:else}
            waiting…
          {/if}
          {#if generation.isGenerating}
            {" "}· generating
          {/if}
        </span>
        {#if generation.lastModel}
          <span class="meta">{generation.lastModel}</span>
        {/if}
      </div>
    </div>

    {#if generation.recentEvents.length > 0}
      <div class="diag">
        <span class="field-label">Recent events</span>
        <ul class="diag-list">
          {#each [...generation.recentEvents].reverse().slice(0, 8) as ev}
            <li>
              <span class="t">{ev.ts}</span>
              <span class="e">{ev.event}</span>
              {#if ev.detail}
                <span class="d">{ev.detail}</span>
              {/if}
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <div class="actions">
      <button type="button" class="btn ghost" onclick={testWarp}>
        {generation.isGenerating ? "Stop test warp" : "Test warp"}
      </button>
      <button type="button" class="btn danger" onclick={hideOverlay}>
        Hide overlay
      </button>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
    margin: 0;
    padding: 0;
    border: none;
    background: rgba(0, 0, 0, 0.12);
    cursor: default;
    -webkit-app-region: no-drag;
  }

  .panel {
    position: fixed;
    top: 14px;
    right: 14px;
    bottom: 14px;
    width: min(300px, calc(100vw - 28px));
    z-index: 50;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1.05rem 1.15rem 1.15rem;
    border-radius: 16px;
    background: rgba(12, 14, 22, 0.86);
    border: 1px solid rgba(255, 255, 255, 0.09);
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.4);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    color: #e2e8f0;
    -webkit-app-region: no-drag;
    overflow: auto;
  }

  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }

  h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 620;
    letter-spacing: 0.02em;
  }

  .sub {
    margin: 0.2rem 0 0;
    font-size: 0.68rem;
    color: rgba(148, 163, 184, 0.75);
  }

  .icon {
    width: 30px;
    height: 30px;
    border: none;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.06);
    color: rgba(226, 232, 240, 0.8);
    cursor: pointer;
    font-size: 0.85rem;
  }

  .icon:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    font-size: 0.85rem;
    color: rgba(226, 232, 240, 0.88);
  }

  .row input[type="checkbox"] {
    width: 1rem;
    height: 1rem;
    accent-color: #a78bfa;
    cursor: pointer;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .field-label {
    display: flex;
    justify-content: space-between;
    font-size: 0.72rem;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: rgba(203, 213, 225, 0.58);
    font-weight: 550;
  }

  .field-label em {
    font-style: normal;
    font-variant-numeric: tabular-nums;
    color: rgba(226, 232, 240, 0.78);
    text-transform: none;
    letter-spacing: 0;
  }

  input[type="range"] {
    width: 100%;
    accent-color: #a78bfa;
    cursor: pointer;
  }

  .presets {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.35rem;
  }

  .style-presets {
    grid-template-columns: 1fr 1fr;
  }

  .hint {
    margin: 0;
    font-size: 0.68rem;
    color: rgba(148, 163, 184, 0.7);
    line-height: 1.35;
  }

  .alpha-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .linkish {
    appearance: none;
    border: none;
    background: transparent;
    padding: 0;
    margin: 0;
    font: inherit;
    font-size: 0.68rem;
    font-weight: 600;
    color: #a78bfa;
    cursor: pointer;
    flex-shrink: 0;
  }

  .linkish:hover {
    color: #c4b5fd;
    text-decoration: underline;
  }

  .motion-note {
    padding: 0.45rem 0.55rem;
    border-radius: 8px;
    background: rgba(91, 222, 255, 0.08);
    border: 1px solid rgba(91, 222, 255, 0.15);
    color: rgba(165, 230, 255, 0.85);
  }

  .preset {
    appearance: none;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    padding: 0.35rem 0.4rem;
    font-size: 0.72rem;
    font-weight: 600;
    font-family: inherit;
    color: rgba(226, 232, 240, 0.75);
    background: rgba(255, 255, 255, 0.04);
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease;
  }

  .preset:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  .preset.active {
    color: #0b1220;
    background: linear-gradient(135deg, #5bdeff 0%, #a78bfa 100%);
    border-color: transparent;
  }

  .status {
    display: flex;
    gap: 0.65rem;
    align-items: flex-start;
    padding: 0.75rem 0.8rem;
    border-radius: 12px;
    background: rgba(8, 10, 18, 0.45);
    border: 1px solid rgba(255, 255, 255, 0.05);
  }

  .dot {
    width: 8px;
    height: 8px;
    margin-top: 0.3rem;
    border-radius: 50%;
    flex-shrink: 0;
    background: rgba(148, 163, 184, 0.45);
  }

  .dot.on {
    background: #34d399;
    box-shadow: 0 0 10px rgba(52, 211, 153, 0.75);
  }

  .status-text {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    font-size: 0.78rem;
    color: rgba(203, 213, 225, 0.72);
    min-width: 0;
  }

  .status-text strong {
    font-weight: 600;
    color: rgba(226, 232, 240, 0.9);
  }

  .meta {
    font-size: 0.7rem;
    color: rgba(148, 163, 184, 0.65);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .diag {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .diag-list {
    list-style: none;
    margin: 0;
    padding: 0.5rem 0.55rem;
    border-radius: 10px;
    background: rgba(8, 10, 18, 0.5);
    border: 1px solid rgba(255, 255, 255, 0.05);
    max-height: 9rem;
    overflow: auto;
    font-size: 0.68rem;
    color: rgba(148, 163, 184, 0.9);
  }

  .diag-list li {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.25rem 0.45rem;
    padding: 0.2rem 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  }

  .diag-list li:last-child {
    border-bottom: none;
  }

  .diag-list .t {
    color: rgba(148, 163, 184, 0.55);
    font-variant-numeric: tabular-nums;
  }

  .diag-list .e {
    color: rgba(226, 232, 240, 0.85);
    font-weight: 560;
  }

  .diag-list .d {
    grid-column: 2;
    color: rgba(148, 163, 184, 0.65);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .actions {
    margin-top: auto;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .btn {
    appearance: none;
    border-radius: 10px;
    padding: 0.55rem 0.85rem;
    font-size: 0.85rem;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    border: 1px solid transparent;
    transition: background 150ms ease, border-color 150ms ease;
  }

  .btn.ghost {
    color: #e2e8f0;
    background: rgba(255, 255, 255, 0.06);
    border-color: rgba(255, 255, 255, 0.08);
  }

  .btn.ghost:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .btn.danger {
    color: #fecaca;
    background: rgba(127, 29, 29, 0.35);
    border-color: rgba(248, 113, 113, 0.28);
  }

  .btn.danger:hover {
    background: rgba(153, 27, 27, 0.48);
  }
</style>
