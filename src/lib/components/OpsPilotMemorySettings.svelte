<script lang="ts">
  import { onMount } from "svelte";
  import { errMsg, t } from "../i18n/index.svelte.ts";
  import * as app from "../stores/app.svelte.ts";
  import { pickTextFile } from "../pick-file.ts";
  import { writeText as writeClipboard } from "../clipboard.ts";
  import { redactCommandText } from "../terminal/command-block-redaction.ts";
  import {
    OFFLINE_CONTEXT_MAX_PAYLOAD_BYTES,
    OfflineContextValidationError,
  } from "../terminal/offline-context-schema.ts";
  import { OFFLINE_CONTEXT_AI_PROMPT } from "../terminal/offline-context-prompt.ts";
  import { offlineContextStore } from "../terminal/offline-context-store.svelte.ts";
  import {
    clearOpsPilotMemory,
    loadOpsPilotMemoryStats,
    type OpsPilotMemoryStats,
  } from "../terminal/opspilot-memory-api.ts";

  let historyEnabled = $state(false);
  let stats = $state<OpsPilotMemoryStats | null>(null);
  let loading = $state(false);
  let clearing = $state(false);
  let historySaving = $state(false);
  let confirmingClear = $state(false);
  let error = $state("");
  let contextImporting = $state(false);
  let contextClearing = $state(false);
  let contextConfirmingClear = $state(false);
  let contextMessage = $state("");
  let contextError = $state("");
  let contextStats = $derived.by(() => {
    offlineContextStore.revision();
    return offlineContextStore.stats();
  });

  function formatTime(value: number | null | undefined): string {
    if (value === null || value === undefined) return "—";
    return new Date(value).toLocaleString();
  }

  async function refresh(): Promise<void> {
    if (loading || clearing) return;
    loading = true;
    error = "";
    try {
      stats = await loadOpsPilotMemoryStats();
    } catch (cause) {
      error = t("settings.shell.opspilot_memory.error_stats", { error: errMsg(cause) });
    } finally {
      loading = false;
    }
  }

  async function saveHistory(): Promise<void> {
    if (historySaving) return;
    historySaving = true;
    error = "";
    try {
      await app.setOpsPilotCommandHistoryEnabled(historyEnabled);
    } catch (cause) {
      historyEnabled = app.opsPilotCommandHistoryEnabled();
      error = t("settings.shell.opspilot_memory.error_setting", { error: errMsg(cause) });
    } finally {
      historySaving = false;
    }
  }

  async function confirmClear(): Promise<void> {
    if (clearing) return;
    clearing = true;
    error = "";
    try {
      await clearOpsPilotMemory();
    } catch (cause) {
      error = t("settings.shell.opspilot_memory.error_clear", { error: errMsg(cause) });
      clearing = false;
      return;
    }
    confirmingClear = false;
    try {
      stats = await loadOpsPilotMemoryStats();
    } catch (cause) {
      error = t("settings.shell.opspilot_memory.error_stats", { error: errMsg(cause) });
    }
    clearing = false;
  }

  function contextErrorMessage(cause: unknown): string {
    if (cause instanceof OfflineContextValidationError) {
      return t("settings.shell.opspilot_context.error_invalid");
    }
    return errMsg(cause);
  }

  async function importOfflineContext(): Promise<void> {
    if (contextImporting) return;
    contextImporting = true;
    contextError = "";
    contextMessage = "";
    try {
      const file = await pickTextFile({
        accept: ".json,application/json",
        maxBytes: OFFLINE_CONTEXT_MAX_PAYLOAD_BYTES,
      });
      if (!file) return;
      const redaction = await app.loadCommandBlockRedaction();
      const result = offlineContextStore.importJson(file.text, {
        redactCommand: (command) => redactCommandText(command, redaction),
      });
      contextMessage = t("settings.shell.opspilot_context.imported", result);
    } catch (cause) {
      contextError = t("settings.shell.opspilot_context.error_import", {
        error: contextErrorMessage(cause),
      });
    } finally {
      contextImporting = false;
    }
  }

  function clearOfflineContext(): void {
    if (contextClearing) return;
    contextClearing = true;
    contextError = "";
    try {
      offlineContextStore.clear();
      contextConfirmingClear = false;
      contextMessage = t("settings.shell.opspilot_context.cleared");
    } catch (cause) {
      contextError = t("settings.shell.opspilot_context.error_clear", {
        error: contextErrorMessage(cause),
      });
    } finally {
      contextClearing = false;
    }
  }

  async function copyOfflineContextPrompt(): Promise<void> {
    contextError = "";
    try {
      await writeClipboard(OFFLINE_CONTEXT_AI_PROMPT);
      contextMessage = t("settings.shell.opspilot_context.prompt_copied");
    } catch (cause) {
      contextError = t("settings.shell.opspilot_context.error_import", {
        error: errMsg(cause),
      });
    }
  }

  onMount(() => {
    void (async () => {
      historyEnabled = await app.loadOpsPilotCommandHistoryEnabled();
      await refresh();
    })();
  });
</script>

<div class="memory-card card surface-raised">
  <div class="memory-head">
    <div class="memory-copy">
      <div class:on={historyEnabled} class="memory-title">
        {t("settings.shell.opspilot_memory.history")}
      </div>
      <div class="memory-desc">{t("settings.shell.opspilot_memory.history_desc")}</div>
    </div>
    <label class="switch">
      <input type="checkbox" bind:checked={historyEnabled} disabled={historySaving} onchange={saveHistory} />
      <span class="slider"></span>
    </label>
  </div>

  <div class="divider"></div>

  <div class="privacy-note">{t("settings.shell.opspilot_memory.privacy")}</div>
  <dl class="stats" aria-busy={loading || clearing}>
    <div><dt>{t("settings.shell.opspilot_memory.sessions")}</dt><dd>{stats?.sessions ?? "—"}</dd></div>
    <div><dt>{t("settings.shell.opspilot_memory.events")}</dt><dd>{stats?.events ?? "—"}</dd></div>
    <div><dt>{t("settings.shell.opspilot_memory.oldest")}</dt><dd>{formatTime(stats?.oldestAt)}</dd></div>
    <div><dt>{t("settings.shell.opspilot_memory.newest")}</dt><dd>{formatTime(stats?.newestAt)}</dd></div>
  </dl>

  {#if error}<div class="error" role="alert">{error}</div>{/if}

  <div class="actions">
    <button class="btn btn-sm" disabled={loading || clearing} onclick={refresh}>
      {loading ? t("common.loading") : t("settings.shell.opspilot_memory.refresh")}
    </button>
    {#if confirmingClear}
      <button class="btn btn-sm" disabled={clearing} onclick={() => { confirmingClear = false; }}>
        {t("common.cancel")}
      </button>
      <button class="btn btn-sm btn-danger" disabled={clearing} onclick={confirmClear}>
        {clearing ? t("settings.shell.opspilot_memory.clearing") : t("settings.shell.opspilot_memory.confirm_clear")}
      </button>
    {:else}
      <button class="btn btn-sm btn-danger" disabled={loading || clearing} onclick={() => { confirmingClear = true; }}>
        {t("settings.shell.opspilot_memory.clear")}
      </button>
    {/if}
  </div>

  <div class="divider"></div>

  <div class="memory-head">
    <div class="memory-copy">
      <div class="memory-title">{t("settings.shell.opspilot_context.title")}</div>
      <div class="memory-desc">{t("settings.shell.opspilot_context.desc")}</div>
    </div>
  </div>

  <div class="privacy-note">{t("settings.shell.opspilot_context.privacy")}</div>
  <dl class="stats">
    <div><dt>{t("settings.shell.opspilot_context.entries")}</dt><dd>{contextStats.total}</dd></div>
    <div><dt>{t("settings.shell.opspilot_context.host_specific")}</dt><dd>{contextStats.hostSpecific}</dd></div>
    <div><dt>{t("settings.shell.opspilot_context.global")}</dt><dd>{contextStats.global}</dd></div>
  </dl>

  {#if contextMessage}<div class="message" role="status">{contextMessage}</div>{/if}
  {#if contextError}<div class="error" role="alert">{contextError}</div>{/if}

  <div class="actions">
    <button class="btn btn-sm" disabled={contextImporting || contextClearing} onclick={importOfflineContext}>
      {contextImporting ? t("settings.shell.opspilot_context.importing") : t("settings.shell.opspilot_context.import")}
    </button>
    {#if contextConfirmingClear}
      <button class="btn btn-sm" disabled={contextClearing} onclick={() => { contextConfirmingClear = false; }}>
        {t("common.cancel")}
      </button>
      <button class="btn btn-sm btn-danger" disabled={contextClearing} onclick={clearOfflineContext}>
        {contextClearing ? t("settings.shell.opspilot_context.clearing") : t("settings.shell.opspilot_context.confirm_clear")}
      </button>
    {:else}
      <button class="btn btn-sm btn-danger" disabled={contextStats.total === 0 || contextImporting || contextClearing} onclick={() => { contextConfirmingClear = true; }}>
        {t("settings.shell.opspilot_context.clear")}
      </button>
    {/if}
  </div>

  <div class="divider"></div>

  <div class="prompt-head">
    <div class="memory-title">{t("settings.shell.opspilot_context.prompt_title")}</div>
    <div class="memory-desc">{t("settings.shell.opspilot_context.prompt_desc")}</div>
  </div>
  <textarea class="prompt" readonly rows="8" value={OFFLINE_CONTEXT_AI_PROMPT}></textarea>
  <div class="actions">
    <button class="btn btn-sm" onclick={copyOfflineContextPrompt}>
      {t("settings.shell.opspilot_context.copy_prompt")}
    </button>
  </div>
</div>

<style>
  .memory-card { padding: 18px; display: flex; flex-direction: column; gap: 14px; }
  .memory-head { display: flex; align-items: center; gap: 12px; }
  .memory-copy { flex: 1; display: flex; flex-direction: column; gap: 4px; }
  .memory-title { font-size: 13px; font-weight: 600; color: var(--text); text-transform: uppercase; letter-spacing: .04em; }
  .memory-title.on { color: var(--accent); }
  .memory-desc, .privacy-note { font-size: 11px; line-height: 1.5; color: var(--text-dim); }
  .divider { height: 1px; background: var(--divider); margin: 2px -18px; }
  .stats { margin: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 18px; }
  .stats div { min-width: 0; }
  .stats dt { font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: .04em; }
  .stats dd { margin: 3px 0 0; font-size: 12px; color: var(--text); overflow-wrap: anywhere; }
  .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
  .error { font-size: 11px; line-height: 1.5; color: var(--danger, #d9534f); overflow-wrap: anywhere; }
  .message { font-size: 11px; line-height: 1.5; color: var(--accent); overflow-wrap: anywhere; }
  .prompt-head { display: flex; flex-direction: column; gap: 4px; }
  .prompt { width: 100%; box-sizing: border-box; resize: vertical; min-height: 130px; padding: 10px; border: 1px solid var(--divider); border-radius: var(--radius-sm); background: var(--bg); color: var(--text-sub); font: 11px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; }
  @media (max-width: 520px) { .stats { grid-template-columns: 1fr; } }
</style>
