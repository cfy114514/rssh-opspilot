<script lang="ts">
  import { onDestroy } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import * as app from "../stores/app.svelte.ts";
  import type {
    AiCodexStatus,
    AiProviderRecord,
    LlmProtocol,
    ModelInfo,
  } from "../ai/types.ts";
  import { codexDefaultModel, codexDefaultReasoningEffort } from "../ai/types.ts";
  import * as ai from "../ai/store.svelte.ts";
  import { t, errMsg } from "../i18n/index.svelte.ts";
  import SearchSelect from "./SearchSelect.svelte";
  import AppIcon from "./AppIcon.svelte";

  let {
    provider,
    protocolCards,
    endpointChips,
    onSave,
    onCancel,
    onChanged,
  }: {
    provider: AiProviderRecord;
    protocolCards: { protocol: LlmProtocol; label: string; subKey: string }[];
    endpointChips: Record<LlmProtocol, { label: string; url: string }[]>;
    onSave: (id: string) => void | Promise<void>;
    onCancel: () => void;
    onChanged?: () => void | Promise<void>;
  } = $props();

  let formId = $state("");
  let formProtocol = $state<LlmProtocol>("openai-completions");
  let formName = $state("");
  let formEndpoint = $state("");
  let formApiKey = $state("");
  let formHasKey = $state(false);
  let formModel = $state("");
  let formReasoningEffort = $state("");
  let formExecutable = $state("");
  let saving = $state(false);
  let loadingModels = $state(false);
  let note = $state<string | null>(null);
  let modelOptions = $state<{ value: string; label: string }[]>([]);
  let modelCatalog = $state<ModelInfo[]>([]);
  let catalogLoaded = $state(false);
  let loadedSourceId = $state<string | null>(null);
  let codexStatus = $state<AiCodexStatus | null>(null);
  let codexStatusLoading = $state(false);
  let codexConfiguring = $state(false);
  let loginStarting = $state(false);
  let loginId = $state<string | null>(null);
  let loginUserCode = $state("");
  let loginPollTimer: number | null = null;
  let loginPolls = 0;
  let loginDeadline = 0;
  let codexRefreshSequence = 0;
  let modelRequestSequence = 0;
  let destroyed = false;

  const CODEX_LOGIN_POLL_MS = 1000;
  const CODEX_LOGIN_MAX_POLLS = 300;
  let loginGeneration = 0;

  function loadFromSource(p: AiProviderRecord) {
    formId = p.id;
    formProtocol = p.protocol;
    formName = p.name ?? "";
    formEndpoint = p.endpoint ?? "";
    formApiKey = "";
    formHasKey = p.has_api_key;
    formModel = p.model ?? "";
    formReasoningEffort = p.reasoning_effort ?? "";
    formExecutable = "";
    modelOptions = p.model ? [{ value: p.model, label: p.model }] : [];
    modelCatalog = [];
    catalogLoaded = false;
    codexStatus = null;
    note = null;
  }

  // New (id "") and edit (row) share one form; the parent remounts via {#key}
  // for a fresh add, so this effect only runs once per mount.
  $effect(() => {
    if (provider.id === loadedSourceId) return;
    loadedSourceId = provider.id;
    loadFromSource(provider);
  });

  $effect(() => {
    if (formProtocol !== "codex-subscription" || app.isMobile) return;
    void refreshCodex();
  });

  let selectedCodexModel = $derived(modelCatalog.find((model) => model.id === formModel));
  let codexModelInvalid = $derived(
    formProtocol === "codex-subscription"
      && (!catalogLoaded || !selectedCodexModel),
  );
  let codexEffortInvalid = $derived(
    formProtocol === "codex-subscription"
      && !!selectedCodexModel
      && (!formReasoningEffort
        || !selectedCodexModel.supported_reasoning_efforts.includes(formReasoningEffort)),
  );

  const formError = $derived(
    app.isMobile && formProtocol === "codex-subscription"
      ? t("ai.settings.codex.mobile_unavailable")
      : !formName.trim()
      ? t("ai.settings.provider.error.name_required")
      : formProtocol !== "codex-subscription" && !formEndpoint.trim()
        ? t("ai.settings.provider.error.endpoint_required")
        : !formModel.trim()
          ? t("ai.settings.provider.error.model_required")
          : codexModelInvalid
            ? t("ai.settings.codex.model_unavailable")
            : codexEffortInvalid
              ? t("ai.settings.codex.effort_invalid")
          : "",
  );

  function selectProtocol(protocol: LlmProtocol) {
    if (app.isMobile && protocol === "codex-subscription") return;
    if (protocol !== formProtocol) {
      loginGeneration += 1;
      codexRefreshSequence += 1;
      modelRequestSequence += 1;
      loadingModels = false;
      codexStatusLoading = false;
      modelOptions = [];
      modelCatalog = [];
      catalogLoaded = false;
    }
    if (protocol !== "codex-subscription") void cancelPendingLogin();
    formProtocol = protocol;
    if (protocol === "codex-subscription") {
      formEndpoint = "";
      formApiKey = "";
      formHasKey = false;
      formModel = "";
      formReasoningEffort = "";
      modelOptions = [];
      modelCatalog = [];
      catalogLoaded = false;
      note = null;
    }
  }

  function fillEndpoint(url: string) {
    formEndpoint = url;
  }

  function selectModel(value: string) {
    formModel = value;
    if (formProtocol !== "codex-subscription") return;
    formReasoningEffort = codexDefaultReasoningEffort(
      modelCatalog.find((model) => model.id === value),
    ) ?? "";
  }

  function installCodexCatalog(list: ModelInfo[]) {
    modelCatalog = list.map((model) => ({
      ...model,
      supported_reasoning_efforts: model.supported_reasoning_efforts ?? [],
      default_reasoning_effort: model.default_reasoning_effort ?? null,
    }));
    catalogLoaded = true;
    modelOptions = modelCatalog.map((model) => ({
      value: model.id,
      label: model.display_name ?? model.id,
    }));
    if (!formModel) {
      const defaultModel = codexDefaultModel(list);
      if (defaultModel) selectModel(defaultModel);
    } else if (selectedCodexModel && !formReasoningEffort) {
      formReasoningEffort = codexDefaultReasoningEffort(selectedCodexModel) ?? "";
    }
  }

  async function refreshCodex(): Promise<void> {
    const sequence = ++codexRefreshSequence;
    codexStatusLoading = true;
    try {
      const status = await ai.codexStatus();
      if (destroyed || sequence !== codexRefreshSequence || formProtocol !== "codex-subscription") return;
      codexStatus = status;
      if (status.available && status.authenticated) await loadModels(true, sequence);
    } catch (error) {
      if (!destroyed && sequence === codexRefreshSequence) note = t("ai.settings.note.models_failed", { error: errMsg(error) });
    } finally {
      if (sequence === codexRefreshSequence) codexStatusLoading = false;
    }
  }

  /** 拉模型：显式按钮，失败给反馈（接口不开放的厂商就留空手填）。 */
  async function loadModels(silent = false, sequence = codexRefreshSequence) {
    const protocol = formProtocol;
    if (protocol === "codex-subscription" && app.isMobile) return;
    const request = ++modelRequestSequence;
    const current = () => !destroyed && request === modelRequestSequence
      && protocol === formProtocol && (protocol !== "codex-subscription" || sequence === codexRefreshSequence);
    loadingModels = true;
    if (!silent) note = null;
    try {
      const list = await ai.listModels(protocol, protocol === "codex-subscription" ? "" : formEndpoint.trim(), {
        providerId: formId || undefined,
        apiKey: protocol === "codex-subscription" ? undefined : formApiKey.trim() || undefined,
      });
      if (!current()) return;
      if (protocol === "codex-subscription") installCodexCatalog(list);
      else modelOptions = list.map((model) => ({ value: model.id, label: model.display_name ?? model.id }));
      if (!silent) note = t("ai.settings.note.models_loaded", { count: list.length });
    } catch (error) {
      if (current()) note = t("ai.settings.note.models_failed", { error: errMsg(error) });
    } finally {
      if (!destroyed && request === modelRequestSequence) loadingModels = false;
    }
  }

  async function handleSave() {
    if (formError || saving) return;
    saving = true;
    note = null;
    try {
      const id = await ai.saveProvider({
        id: formId || undefined,
        name: formName.trim(),
        protocol: formProtocol,
        model: formModel.trim(),
        endpoint: formProtocol === "codex-subscription" ? "" : formEndpoint.trim(),
        apiKey: formProtocol === "codex-subscription"
          ? undefined
          : formApiKey.trim() ? formApiKey.trim() : undefined,
        ...(formProtocol === "codex-subscription"
          ? { reasoningEffort: formReasoningEffort }
          : {}),
      });
      await onSave(id);
    } catch (e: any) {
      note = t("ai.settings.note.save_failed", { error: errMsg(e) });
    } finally {
      saving = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") handleSave();
  }

  async function configureExecutable() {
    if (app.isMobile || codexConfiguring) return;
    codexConfiguring = true;
    note = null;
    try {
      await ai.configureCodex(formExecutable.trim());
      await refreshCodex();
      await onChanged?.();
    } catch (error) {
      note = t("ai.settings.note.save_failed", { error: errMsg(error) });
    } finally {
      codexConfiguring = false;
    }
  }

  function stopLoginPoll() {
    if (loginPollTimer !== null) {
      clearTimeout(loginPollTimer);
      loginPollTimer = null;
    }
  }

  function scheduleLoginPoll(id: string) {
    stopLoginPoll();
    loginPollTimer = window.setTimeout(() => { void pollLogin(id); }, CODEX_LOGIN_POLL_MS);
  }

  async function pollLogin(id: string) {
    loginPollTimer = null;
    const generation = loginGeneration;
    if (destroyed || loginId !== id) return;
    loginPolls += 1;
    if (loginPolls > CODEX_LOGIN_MAX_POLLS || Date.now() >= loginDeadline) {
      await cancelPendingLogin();
      note = t("ai.settings.codex.login_timeout");
      return;
    }
    try {
      const status = await ai.codexStatus();
      if (destroyed || loginId !== id) return;
      codexStatus = status;
      if (status.loginFailed) {
        await cancelPendingLogin();
        note = t("ai.settings.codex.authorization_failed");
        return;
      }
      if (status.authenticated) {
        loginId = null;
        loginUserCode = "";
        loginDeadline = 0;
        await refreshCodex();
        if (destroyed || generation !== loginGeneration) return;
        try {
          await onChanged?.();
        } catch (error) {
          note = t("ai.settings.codex.login_failed", { error: errMsg(error) });
          return;
        }
        if (destroyed || generation !== loginGeneration) return;
        note = t("ai.settings.codex.logged_in");
        return;
      }
    } catch (error) {
      note = t("ai.settings.codex.login_failed", { error: errMsg(error) });
    }
    if (!destroyed && loginId === id) scheduleLoginPoll(id);
  }

  async function cancelPendingLogin(): Promise<void> {
    loginGeneration += 1;
    stopLoginPoll();
    const id = loginId;
    loginId = null;
        loginUserCode = "";
    loginPolls = 0;
    loginDeadline = 0;
    if (id) await ai.cancelCodexLogin(id).catch(() => undefined);
  }

  async function startLogin() {
    if (app.isMobile || loginStarting || loginId) return;
    const generation = loginGeneration;
    loginStarting = true;
    note = null;
    try {
      const login = await ai.startCodexLogin();
      if (destroyed || generation !== loginGeneration || formProtocol !== "codex-subscription") {
        await ai.cancelCodexLogin(login.loginId).catch(() => undefined);
        return;
      }
      loginId = login.loginId;
      loginUserCode = login.userCode ?? "";
      loginPolls = 0;
      loginDeadline = Date.now() + CODEX_LOGIN_MAX_POLLS * CODEX_LOGIN_POLL_MS;
      try {
        await invoke("open_external_url", { url: login.authUrl });
      } catch (error) {
        const stillCurrent = !destroyed && generation === loginGeneration
          && formProtocol === "codex-subscription";
        await cancelPendingLogin();
        if (stillCurrent) {
          note = t("ai.settings.codex.login_failed", { error: errMsg(error) });
        }
        return;
      }
      if (destroyed || generation !== loginGeneration || formProtocol !== "codex-subscription"
        || loginId !== login.loginId) {
        await ai.cancelCodexLogin(login.loginId).catch(() => undefined);
        return;
      }
      scheduleLoginPoll(login.loginId);
    } catch (error) {
      if (!destroyed && generation === loginGeneration && formProtocol === "codex-subscription") {
        note = t("ai.settings.codex.login_failed", { error: errMsg(error) });
      }
    } finally {
      loginStarting = false;
    }
  }

  async function logout() {
    if (app.isMobile || loginStarting) return;
    await cancelPendingLogin();
    codexStatusLoading = true;
    note = null;
    try {
      await ai.logoutCodex();
      await refreshCodex();
      await onChanged?.();
      modelCatalog = [];
      catalogLoaded = false;
      note = t("ai.settings.codex.logged_out");
    } catch (error) {
      note = t("ai.settings.codex.login_failed", { error: errMsg(error) });
    } finally {
      codexStatusLoading = false;
    }
  }

  onDestroy(() => {
    destroyed = true;
    loginGeneration += 1;
    stopLoginPoll();
    const id = loginId;
    loginId = null;
        loginUserCode = "";
    loginDeadline = 0;
    if (id) void ai.cancelCodexLogin(id).catch(() => undefined);
  });
</script>

<div class="card inline-form">
  <div class="protocol-grid" aria-label={t("ai.settings.provider.protocol")} role="group">
    {#each protocolCards as card (card.protocol)}
      <button
        type="button"
        class="protocol-card"
        class:active={formProtocol === card.protocol}
        class:p-ds={card.protocol === "deepseek-thinking"}
        class:p-oai={card.protocol === "openai-completions"}
        class:p-ant={card.protocol === "anthropic-messages"}
        class:p-codex={card.protocol === "codex-subscription"}
        aria-pressed={formProtocol === card.protocol}
        disabled={app.isMobile && card.protocol === "codex-subscription"}
        onclick={() => selectProtocol(card.protocol)}
      >
        <span class="protocol-icon"><AppIcon name="ai" size={17} /></span>
        <span class="protocol-text">
          <span class="protocol-title">{card.label}</span>
          <span class="protocol-sub">{t(card.subKey)}</span>
        </span>
      </button>
    {/each}
  </div>

  <label class="field">
    <span class="label-text">{t("common.name")}</span>
    <input type="text" bind:value={formName} placeholder={t("ai.settings.provider.name_placeholder")} onkeydown={handleKeydown} />
  </label>

  {#if formProtocol === "codex-subscription"}
    <div class="codex-note">{t("ai.settings.codex.description")}</div>
    {#if app.isMobile}
      <div class="form-error">{t("ai.settings.codex.mobile_unavailable")}</div>
    {:else}
      <div class="field">
        <div class="label-row">
          <span class="label-text" id={`codex-executable-label-${formId || "new"}`}>{t("ai.settings.codex.executable")}</span>
          <span class="field-hint">{t("ai.settings.codex.executable_auto")}</span>
        </div>
        <div class="model-row">
          <input
            type="text"
            class="mono"
            bind:value={formExecutable}
            placeholder={t("ai.settings.codex.executable_placeholder")}
            aria-labelledby={`codex-executable-label-${formId || "new"}`}
            disabled={codexConfiguring || loginStarting || !!loginId}
          />
          <button type="button" class="btn btn-sm" onclick={configureExecutable} disabled={codexConfiguring || codexStatusLoading || !!loginId}>
            {codexConfiguring ? t("common.loading") : t("ai.settings.codex.configure")}
          </button>
        </div>
        {#if codexStatus}
          <div class="codex-status" class:ready={codexStatus.available && codexStatus.authenticated}>
            {#if !codexStatus.available}
              {t("ai.settings.codex.unavailable")}
            {:else if codexStatus.authenticated}
              {t("ai.settings.codex.authenticated")}
            {:else}
              {t("ai.settings.codex.auth_required")}
            {/if}
            {#if codexStatus.executable} · <code>{codexStatus.executable}</code>{/if}
            {#if codexStatus.version} · {codexStatus.version}{/if}
          </div>
        {/if}
        {#if !codexStatus && codexStatusLoading}<div class="field-hint">{t("common.loading")}</div>{/if}
      </div>

      <div class="codex-actions">
        {#if loginId}
          <button type="button" class="btn btn-sm" onclick={() => { void cancelPendingLogin(); }}>
            {t("ai.settings.codex.cancel_login")}
          </button>
          <span class="field-hint">{t("ai.settings.codex.waiting_login")}</span>
          {#if loginUserCode}
            <label class="field-hint">
              {t("ai.settings.codex.device_code")}
              <input class="mono" readonly value={loginUserCode} onclick={(event) => event.currentTarget.select()} />
            </label>
          {/if}
        {:else if codexStatus?.authenticated}
          <button type="button" class="btn btn-sm" onclick={logout} disabled={codexStatusLoading || loginStarting}>
            {t("ai.settings.codex.logout")}
          </button>
        {:else}
          <button type="button" class="btn btn-sm" onclick={startLogin} disabled={loginStarting || codexStatusLoading || codexStatus?.available === false}>
            {loginStarting ? t("common.loading") : t("ai.settings.codex.login")}
          </button>
        {/if}
      </div>
    {/if}
  {:else}
    <div class="field">
      <div class="label-row">
        <span class="label-text" id={`endpoint-label-${formId || "new"}`}>{t("ai.settings.label.endpoint")}</span>
        {#each endpointChips[formProtocol] ?? [] as chip (chip.url)}
          <button type="button" class="chip" onclick={() => fillEndpoint(chip.url)}>{chip.label}</button>
        {/each}
      </div>
      <input
        type="text"
        class="mono"
        bind:value={formEndpoint}
        placeholder="https://…"
        aria-labelledby={`endpoint-label-${formId || "new"}`}
        onkeydown={handleKeydown}
      />
    </div>

    <label class="field">
      <span class="label-text">{t("ai.settings.label.api_key")}</span>
      <input
        type="password"
        bind:value={formApiKey}
        placeholder={formHasKey ? t("ai.settings.placeholder.api_key_set") : t("ai.settings.placeholder.api_key_unset")}
      />
    </label>
  {/if}

  <div class="field">
    <label class="label-text" for={`ai-model-${formId || "new"}`}>{t("ai.settings.label.model")}</label>
    <div class="model-row">
      <SearchSelect
        id={`ai-model-${formId || "new"}`}
        bind:value={formModel}
        options={modelOptions}
        allowCustom={formProtocol !== "codex-subscription"}
        onchange={selectModel}
        ariaLabel={t("ai.settings.label.model")}
        placeholder={t("ai.settings.placeholder.model")}
        searchPlaceholder={t("ai.settings.placeholder.model")}
        emptyText={t("ai.settings.model.empty")}
      />
      <button
        type="button"
        class="btn btn-sm"
        onclick={() => { void loadModels(); }}
        disabled={loadingModels || (formProtocol === "codex-subscription"
          && (codexStatusLoading || codexStatus?.authenticated !== true))}
      >
        {loadingModels ? t("ai.settings.btn.loading_models") : t("ai.settings.btn.load_models")}
      </button>
    </div>
  </div>

  {#if formProtocol === "codex-subscription" && selectedCodexModel}
    <label class="field">
      <span class="label-text" for={`ai-effort-${formId || "new"}`}>{t("ai.settings.label.reasoning_effort")}</span>
      <select id={`ai-effort-${formId || "new"}`} bind:value={formReasoningEffort} disabled={loadingModels || selectedCodexModel.supported_reasoning_efforts.length === 0}>
        <option value="">{t("ai.settings.codex.choose_effort")}</option>
        {#each selectedCodexModel.supported_reasoning_efforts as effort (effort)}
          <option value={effort}>{effort}</option>
        {/each}
      </select>
    </label>
  {/if}

  <div class="form-actions">
    <button class="btn btn-accent btn-sm" onclick={handleSave} disabled={!!formError || saving || (formProtocol === "codex-subscription" && !codexStatus?.authenticated)}>
      {saving ? t("ai.settings.btn.saving") : t("common.save")}
    </button>
    <button class="btn btn-sm" onclick={onCancel}>{t("common.cancel")}</button>
    {#if note}<span class="note">{note}</span>{/if}
  </div>

  {#if formError}
    <div class="form-error">{formError}</div>
  {/if}
</div>

<style>
  .inline-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
    margin-bottom: 12px;
  }
  .protocol-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }
  .protocol-card {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 0 0 auto;
    width: max-content;
    max-width: 100%;
    padding: 10px;
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--text);
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s, color 0.15s;
  }
  .protocol-card:hover:not(.active) {
    background: var(--surface);
  }
  .protocol-card:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .protocol-card.active {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, var(--bg));
    color: var(--accent);
  }
  .protocol-card.p-ds.active {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, var(--bg));
    color: var(--accent);
  }
  .protocol-card.p-oai.active {
    border-color: var(--success);
    background: color-mix(in srgb, var(--success) 12%, var(--bg));
    color: var(--success);
  }
  .protocol-card.p-ant.active {
    border-color: var(--purple);
    background: color-mix(in srgb, var(--purple) 12%, var(--bg));
    color: var(--purple);
  }
  .protocol-card.p-codex.active {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, var(--bg));
    color: var(--accent);
  }
  .protocol-icon {
    width: 28px;
    height: 28px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--text-sub);
    background: var(--surface);
  }
  .protocol-card.p-ds .protocol-icon {
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .protocol-card.p-oai .protocol-icon {
    color: var(--success);
    background: color-mix(in srgb, var(--success) 12%, transparent);
  }
  .protocol-card.p-ant .protocol-icon {
    color: var(--purple);
    background: color-mix(in srgb, var(--purple) 12%, transparent);
  }
  .protocol-card.p-codex .protocol-icon {
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .protocol-text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .protocol-title {
    font-size: 13px;
    font-weight: 650;
    white-space: nowrap;
  }
  .protocol-sub {
    font-size: 11px;
    color: var(--text-sub);
    white-space: nowrap;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .label-text {
    font-size: 12px;
    color: var(--text-sub);
  }
  .field-hint, .codex-note, .codex-status {
    font-size: 11px;
    line-height: 1.45;
    color: var(--text-dim);
  }
  .codex-note {
    padding: 8px 10px;
    border-left: 3px solid var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, var(--bg));
  }
  .codex-status.ready { color: var(--success); }
  .codex-status code { overflow-wrap: anywhere; }
  .codex-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .label-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }
  /* Endpoint quick-fill chips — plain hyperlinks after the label, not pills. */
  .chip {
    padding: 0;
    border: none;
    background: none;
    font-family: inherit;
    font-size: 12px;
    color: var(--accent);
    cursor: pointer;
  }
  .chip:hover {
    text-decoration: underline;
  }
  .inline-form input[type="text"],
  .inline-form input[type="password"] {
    width: 100%;
    box-sizing: border-box;
  }
  .model-row {
    display: flex;
    gap: 8px;
    align-items: stretch;
  }
  .model-row :global(.search-select) {
    flex: 1;
    min-width: 0;
  }
  .model-row .btn {
    flex-shrink: 0;
  }
  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
  }
  .note {
    font-size: 12px;
    color: var(--accent);
  }
  .form-error {
    font-size: 12px;
    color: var(--error, #ff6b6b);
    background: rgba(255, 107, 107, 0.08);
    padding: 6px 10px;
    border-radius: 4px;
  }
  @media (max-width: 640px) {
    .protocol-grid {
      width: 100%;
    }
  }
</style>
