<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import * as app from "../stores/app.svelte.ts";
  import * as automation from "../stores/automation.svelte.ts";
  import { t, errMsg } from "../i18n/index.svelte.ts";
  import { writeText } from "../clipboard.ts";
  import { toast } from "../stores/toast.svelte.ts";

  let allowInput = $state(false);
  let connection = $derived(automation.connection());
  let config = $derived(automation.connectionConfig());

  async function start() {
    try {
      await automation.start(allowInput);
    } catch (error) { toast.error(errMsg(error)); }
  }
  async function stop() {
    try { await automation.stop(); } catch (error) { toast.error(errMsg(error)); }
  }
  async function copy() {
    try { await writeText(config); toast.success(t("about.copied")); }
    catch (error) { toast.error(errMsg(error)); }
  }
  async function copyCodexCommand() {
    try { await writeText("codex mcp add rssh -- rssh mcp-proxy"); toast.success(t("about.copied")); }
    catch (error) { toast.error(errMsg(error)); }
  }
  async function openConsole() {
    if (!connection) return;
    const url = new URL(connection.endpoint);
    url.pathname = "/";
    url.hash = new URLSearchParams({ token: connection.token }).toString();
    try { await invoke("open_external_url", { url: url.href }); }
    catch (error) { toast.error(errMsg(error)); }
  }
</script>

<div class="page">
  <h3>{t("automation.title")}</h3>
  <p>{t("automation.description")}</p>
  {#if app.isMobile}
    <p>{t("automation.desktop_only")}</p>
  {:else if connection}
    <div class="card">
      <strong>{automation.writable() ? t("automation.active_write") : t("automation.active_read")}</strong>
      <ul>
        {#each automation.sharedSessions() as session (session.sessionId)}
          <li>{session.label} · {session.type}</li>
        {/each}
      </ul>
      {#if !automation.sharedSessions().length}<p>{t("automation.no_shared_sessions")}</p>{/if}
      <code>{connection.endpoint}</code>
      <button class="btn" onclick={stop}>{t("automation.stop")}</button>
    </div>
    <h4>{t("automation.codex_title")}</h4>
    <p>{t("automation.codex_hint")}</p>
    <code>codex mcp add rssh -- rssh mcp-proxy</code>
    <button class="btn" onclick={copyCodexCommand}>{t("automation.codex_copy")}</button>
    <h4>{t("automation.connect")}</h4>
    <button class="btn btn-accent" onclick={openConsole}>{t("automation.open_console")}</button>
    <p>{t("automation.connect_hint")}</p>
    <button class="btn" onclick={copy}>{t("automation.copy_config")}</button>
    <details>
      <summary>{t("automation.show_config")}</summary>
      <pre>{config}</pre>
    </details>
    <p>{t("automation.client_support")}</p>
    <p>{t("automation.lifetime")}</p>
  {:else}
    <label class="choice">
      <input type="checkbox" bind:checked={allowInput} disabled={automation.busy()} />
      <span>{t("automation.allow_input")}</span>
    </label>
    <p>{t("automation.input_hint")}</p>
    <button class="btn btn-accent" onclick={start} disabled={automation.busy()}>
      {automation.busy() ? t("common.loading") : t("automation.start")}
    </button>
  {/if}
  {#if automation.error()}<p role="alert">{errMsg(automation.error())}</p>{/if}
</div>

<style>
  .page { padding: 24px; display: flex; flex-direction: column; gap: 16px; min-width: 0; }
  h3, h4, p { margin: 0; }
  p { color: var(--text-sub); font-size: 13px; line-height: 1.6; }
  .card { padding: 16px; border: 1px solid var(--divider); border-radius: var(--radius); display: flex; flex-direction: column; gap: 12px; }
  .card { background: var(--surface); }
  .choice { display: flex; gap: 10px; align-items: center; font-size: 13px; overflow-wrap: anywhere; }
  button { align-self: flex-start; }
  code, pre { font-family: var(--term-font); font-size: 12px; overflow-wrap: anywhere; }
  pre { padding: 12px; overflow-x: auto; background: var(--surface); }
  summary { cursor: pointer; color: var(--text-sub); font-size: 13px; }
</style>
