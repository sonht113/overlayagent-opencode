/**
 * Apply overlay opacity to a shell element.
 * Phase 1 uses CSS opacity; later can call Tauri window effects APIs.
 */
export function applyShellOpacity(el: HTMLElement | null, opacity: number) {
  if (!el) return;
  el.style.opacity = String(Math.min(1, Math.max(0.2, opacity)));
}
