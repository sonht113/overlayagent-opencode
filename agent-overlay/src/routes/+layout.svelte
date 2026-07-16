<script lang="ts">
  import { onMount } from "svelte";
  import { startOpencodeBridge } from "$lib/bridge/opencode";
  import "../app.css";

  let { children } = $props();

  onMount(() => {
    let stop: (() => void) | undefined;
    startOpencodeBridge().then((unlisten) => {
      stop = unlisten;
    });
    return () => stop?.();
  });
</script>

{@render children()}
