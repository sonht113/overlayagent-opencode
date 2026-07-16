<script lang="ts">
  import { generation, togglePanel } from "$lib/stores/generation.svelte";
</script>

<div class="drag-bar" data-tauri-drag-region>
  <div class="grip" data-tauri-drag-region aria-hidden="true">
    <span></span><span></span><span></span>
  </div>

  <div class="title" data-tauri-drag-region>
    <span class="dot" class:on={generation.isGenerating}></span>
    Agent Overlay
  </div>

  <button
    type="button"
    class="icon-btn"
    title={generation.panelOpen ? "Hide controls" : "Show controls"}
    aria-label={generation.panelOpen ? "Hide controls" : "Show controls"}
    aria-pressed={generation.panelOpen}
    onclick={togglePanel}
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
        stroke="currentColor"
        stroke-width="1.6"
      />
      <path
        d="M19.4 13a7.7 7.7 0 0 0 .05-2l1.7-1.3-1.6-2.8-2 .7a7.6 7.6 0 0 0-1.7-1L15.5 4h-3.2l-.35 2.1a7.6 7.6 0 0 0-1.7 1l-2-.7-1.6 2.8L8.35 11a7.7 7.7 0 0 0 0 2l-1.7 1.3 1.6 2.8 2-.7c.53.42 1.1.76 1.7 1L12.3 20h3.2l.35-2.1a7.6 7.6 0 0 0 1.7-1l2 .7 1.6-2.8L19.4 13Z"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linejoin="round"
      />
    </svg>
  </button>
</div>

<style>
  .drag-bar {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 0.5rem;
    height: 36px;
    padding: 0 0.55rem 0 0.75rem;
    flex-shrink: 0;
    border-radius: 14px 14px 0 0;
    background: linear-gradient(
      180deg,
      rgba(18, 20, 32, 0.82) 0%,
      rgba(12, 14, 22, 0.72) 100%
    );
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    user-select: none;
    cursor: grab;
  }

  .drag-bar:active {
    cursor: grabbing;
  }

  .grip {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 4px 2px;
    opacity: 0.45;
  }

  .grip span {
    display: block;
    width: 14px;
    height: 2px;
    border-radius: 1px;
    background: rgba(226, 232, 240, 0.85);
  }

  .title {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.78rem;
    font-weight: 560;
    letter-spacing: 0.04em;
    color: rgba(226, 232, 240, 0.78);
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: rgba(148, 163, 184, 0.55);
    box-shadow: none;
    transition: background 200ms ease, box-shadow 200ms ease;
  }

  .dot.on {
    background: #34d399;
    box-shadow: 0 0 10px rgba(52, 211, 153, 0.85);
  }

  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 28px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: rgba(226, 232, 240, 0.7);
    cursor: pointer;
    transition: background 150ms ease, color 150ms ease;
  }

  .icon-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    color: #f8fafc;
  }

  .icon-btn:focus-visible {
    outline: 2px solid rgba(91, 222, 255, 0.55);
    outline-offset: 1px;
  }
</style>
