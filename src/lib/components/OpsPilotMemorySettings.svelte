<script lang="ts">
  import { onMount } from "svelte";
  import { errMsg, t } from "../i18n/index.svelte.ts";
  import * as app from "../stores/app.svelte.ts";
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
  @media (max-width: 520px) { .stats { grid-template-columns: 1fr; } }
</style>
