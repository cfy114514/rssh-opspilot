<script lang="ts">
    import {t} from "../i18n/index.svelte.ts";
    import type {NextCommandSuggestion} from "../terminal/next-command.ts";

    let {
        suggestions,
        mobile = false,
        canAskAi = false,
        onAccept,
        onDismiss,
        onAskAi,
        onSummarize,
        onCopyContext,
    }: {
        suggestions: readonly NextCommandSuggestion[];
        mobile?: boolean;
        canAskAi?: boolean;
        onAccept: (suggestion: NextCommandSuggestion) => void;
        onDismiss: () => void;
        onAskAi: () => void;
        onSummarize: () => void;
        onCopyContext: () => void;
    } = $props();
</script>

{#if suggestions.length > 0}
    <section class="next-command-palette" class:is-mobile={mobile} aria-live="polite" aria-label={t("terminal.next_command.title")}>
        <div class="next-command-head">
            <div class="next-command-title">
                <span>{t("terminal.next_command.title")}</span>
                <span class="next-command-source">{t("terminal.next_command.local")}</span>
            </div>
            <div class="next-command-actions">
                <button
                    class="next-command-ask"
                    type="button"
                    disabled={!canAskAi}
                    onclick={onAskAi}
                    title={canAskAi ? t("terminal.next_command.ask_ai") : t("terminal.next_command.ai_disabled")}
                >{t("terminal.next_command.ask_ai")}</button>
                <button
                    class="next-command-summary"
                    type="button"
                    disabled={!canAskAi}
                    onclick={onSummarize}
                    title={canAskAi ? t("terminal.next_command.summarize") : t("terminal.next_command.ai_disabled")}
                >{t("terminal.next_command.summarize")}</button>
                <button
                    class="next-command-summary"
                    type="button"
                    onclick={onCopyContext}
                    title={t("terminal.next_command.copy_context_hint")}
                >{t("terminal.next_command.copy_context")}</button>
                <button class="next-command-dismiss" type="button" onclick={onDismiss} aria-label={t("terminal.next_command.dismiss")}>×</button>
            </div>
        </div>
        <div class="next-command-hint">{t("terminal.next_command.hint")}</div>
        <div class="next-command-list">
            {#each suggestions as suggestion (suggestion.id)}
                <button class="next-command-item" type="button" onclick={() => onAccept(suggestion)}>
                    <code>{suggestion.command}</code>
                    <span>{suggestion.reason}</span>
                </button>
            {/each}
        </div>
    </section>
{/if}

<style>
    .next-command-palette {
        position: absolute;
        z-index: 5;
        top: 10px;
        right: 16px;
        width: min(560px, calc(100% - 32px));
        padding: 9px 10px 10px;
        border: 1px solid var(--divider);
        border-radius: 8px;
        color: var(--text);
        background: color-mix(in srgb, var(--surface) 94%, transparent);
        box-shadow: var(--shadow-menu);
        backdrop-filter: blur(10px);
    }

    .next-command-palette.is-mobile {
        top: auto;
        right: 8px;
        bottom: 8px;
        width: calc(100% - 16px);
    }

    .next-command-head {
        flex-wrap: wrap;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
    }

    .next-command-title {
        display: flex;
        align-items: center;
        gap: 7px;
        font-size: 12px;
        font-weight: 650;
    }

    .next-command-source {
        padding: 1px 5px;
        border: 1px solid var(--accent);
        border-radius: 4px;
        color: var(--accent);
        font-size: 10px;
        letter-spacing: .04em;
    }

    .next-command-dismiss {
        width: 22px;
        height: 22px;
        padding: 0;
        border: 0;
        border-radius: 4px;
        color: var(--text-dim);
        background: transparent;
        cursor: pointer;
        font-size: 17px;
        line-height: 20px;
    }

    .next-command-actions {
        flex-wrap: wrap;
        display: flex;
        align-items: center;
        gap: 4px;
    }

    .next-command-ask {
        padding: 3px 7px;
        border: 1px solid var(--purple);
        border-radius: 4px;
        color: var(--purple);
        background: transparent;
        cursor: pointer;
        font-size: 10px;
    }

    .next-command-ask:hover:not(:disabled) {
        background: color-mix(in srgb, var(--purple) 14%, transparent);
    }

    .next-command-summary {
        padding: 3px 7px;
        border: 1px solid var(--accent);
        border-radius: 4px;
        color: var(--accent);
        background: transparent;
        cursor: pointer;
        font-size: 10px;
    }

    .next-command-summary:hover:not(:disabled) {
        background: var(--accent-soft);
    }

    .next-command-ask:disabled,
    .next-command-summary:disabled {
        border-color: var(--divider);
        color: var(--text-dim);
        cursor: not-allowed;
    }

    .next-command-dismiss:hover {
        color: var(--text);
        background: var(--accent-soft);
    }

    .next-command-hint {
        margin: 3px 0 7px;
        color: var(--text-dim);
        font-size: 11px;
    }

    .next-command-list {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    .next-command-item {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: baseline;
        gap: 10px;
        width: 100%;
        padding: 6px 8px;
        border: 1px solid transparent;
        border-radius: 5px;
        color: var(--text);
        background: color-mix(in srgb, var(--bg) 65%, transparent);
        text-align: left;
        cursor: pointer;
    }

    .next-command-item:hover,
    .next-command-item:focus-visible {
        border-color: var(--accent);
        outline: none;
        background: var(--accent-soft);
    }

    .next-command-item code {
        min-width: 0;
        overflow: hidden;
        color: var(--accent);
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 11px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .next-command-item span {
        color: var(--text-dim);
        font-size: 10px;
        text-align: right;
        white-space: nowrap;
    }

    @media (max-width: 560px) {
        .next-command-palette:not(.is-mobile) {
            top: 8px;
            right: 8px;
            width: calc(100% - 16px);
        }

        .next-command-item {
            grid-template-columns: 1fr;
            gap: 2px;
        }

        .next-command-item span {
            text-align: left;
        }
    }
</style>
