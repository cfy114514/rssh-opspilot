<script lang="ts">
    import { onDestroy } from "svelte";
    import { renderMarkdown } from "./markdown.ts";
    import { createMarkdownScheduler } from "./markdown-scheduler.ts";

    let { text, active, streaming } = $props<{
        text: string;
        active: boolean;
        streaming: boolean;
    }>();

    let html = $state("");
    const scheduler = createMarkdownScheduler({
        render: renderMarkdown,
        commit: (nextHtml) => (html = nextHtml),
    });

    $effect(() => scheduler.update(text, active, streaming));
    onDestroy(() => scheduler.destroy());
</script>

<!-- eslint-disable-next-line svelte/no-at-html-tags -->
{@html html}
