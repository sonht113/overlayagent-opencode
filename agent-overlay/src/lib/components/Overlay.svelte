<script lang="ts">
  import { onMount } from "svelte";
  import ParticleCanvas from "$lib/components/ParticleCanvas.svelte";
  import SettingsPanel from "$lib/components/SettingsPanel.svelte";
  import TokenCounter from "$lib/components/TokenCounter.svelte";
  import {
    closeSettings,
    generation,
    openSettings,
  } from "$lib/stores/generation.svelte";

  /**
   * Right-click opens settings (never the OS context menu).
   * Left-click on the empty stage closes settings.
   */
  function onContextMenu(e: MouseEvent) {
    e.preventDefault();
    openSettings();
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button === 0 && generation.settingsOpen) {
      // SettingsPanel stops propagation; reaching here means click outside
      closeSettings();
    }
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSettings();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

<!--
  Minimal generating surface:
  - fully transparent (no frame / border / title)
  - particles only by default
  - data-tauri-drag-region for reposition without chrome
-->
<div
  class="overlay"
  class:live={generation.isGenerating}
  style="opacity: {generation.opacity}"
  oncontextmenu={onContextMenu}
  onpointerdown={onPointerDown}
  data-tauri-drag-region
  role="presentation"
>
  <ParticleCanvas />

  {#if generation.showTokenCount && generation.isGenerating}
    <div class="token-layer">
      <TokenCounter />
    </div>
  {/if}

  <!-- Panel is portaled visually on top; not a drag region -->
  <SettingsPanel />
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    margin: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: transparent;
    /* Intentionally no border, shadow, or glass frame while generating */
  }

  .token-layer {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 5;
  }
</style>
