import {
  containsRejectedCommandData,
} from "./opspilot-observation.ts";
import type {NextCommandShell} from "./next-command.ts";

export const OFFLINE_CONTEXT_FORMAT = "rssh-offline-context" as const;
export const OFFLINE_CONTEXT_VERSION = 1 as const;
export const OFFLINE_CONTEXT_MAX_ENTRIES = 200;
export const OFFLINE_CONTEXT_MAX_PAYLOAD_BYTES = 512 * 1024;

const MAX_ID_CHARS = 128;
const MAX_HOST_CHARS = 255;
const MAX_COMMAND_CHARS = 4_096;
const MAX_REASON_CHARS = 256;
const MAX_TRIGGER_CHARS = 120;
const MAX_TRIGGERS = 8;

export type OfflineContextShell = NextCommandShell | "any";

export interface OfflineContextScope {
  readonly host?: string;
}

export interface OfflineContextEntry {
  readonly id: string;
  readonly scope: OfflineContextScope;
  readonly shell: OfflineContextShell;
  readonly triggers: readonly string[];
  readonly command: string;
  readonly reason: string;
  readonly risk: "read-only";
  readonly confidence: number;
}

export interface OfflineContextArtifact {
  readonly format: typeof OFFLINE_CONTEXT_FORMAT;
  readonly version: typeof OFFLINE_CONTEXT_VERSION;
  readonly entries: readonly OfflineContextEntry[];
}

export interface OfflineContextParseOptions {
  readonly redactCommand?: (command: string) => string;
}

export type OfflineContextErrorCode =
  | "invalid_json"
  | "format"
  | "version"
  | "entries"
  | "entry"
  | "id"
  | "scope"
  | "host"
  | "shell"
  | "triggers"
  | "trigger"
  | "command"
  | "reason"
  | "risk"
  | "confidence"
  | "sensitive"
  | "payload";

export class OfflineContextValidationError extends Error {
  readonly code: OfflineContextErrorCode;

  constructor(code: OfflineContextErrorCode) {
    super(`offline_context_${code}`);
    this.name = "OfflineContextValidationError";
    this.code = code;
  }
}

function invalid(code: OfflineContextErrorCode): never {
  throw new OfflineContextValidationError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, code: OfflineContextErrorCode, max: number): string {
  if (typeof value !== "string") invalid(code);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) invalid(code);
  return normalized;
}

function optionalHost(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const host = text(value, "host", MAX_HOST_CHARS);
  return host.toLocaleLowerCase();
}

function shell(value: unknown): OfflineContextShell {
  if (value === "posix" || value === "cmd" || value === "powershell" || value === "any") return value;
  invalid("shell");
}

function entry(value: unknown, options: OfflineContextParseOptions): OfflineContextEntry {
  if (!isRecord(value)) invalid("entry");
  const id = text(value.id, "id", MAX_ID_CHARS);
  const rawScope = value.scope;
  if (rawScope !== undefined && !isRecord(rawScope)) invalid("scope");
  const scopeRecord = rawScope as Record<string, unknown> | undefined;
  const scope: OfflineContextScope = { host: optionalHost(scopeRecord?.host) };
  const triggersValue = value.triggers;
  if (!Array.isArray(triggersValue) || triggersValue.length > MAX_TRIGGERS) invalid("triggers");
  const triggers = triggersValue.map((trigger) => text(trigger, "trigger", MAX_TRIGGER_CHARS));

  let command = text(value.command, "command", MAX_COMMAND_CHARS);
  if (/[\r\n]/.test(command)) invalid("command");
  if (containsRejectedCommandData(command)) invalid("sensitive");
  if (options.redactCommand) {
    try {
      command = options.redactCommand(command);
    } catch {
      invalid("sensitive");
    }
    if (typeof command !== "string" || !command.trim()) invalid("command");
    command = command.trim();
  }
  if (command.length > MAX_COMMAND_CHARS || /[\r\n]/.test(command)) invalid("command");
  if (containsRejectedCommandData(command)) invalid("sensitive");

  const reason = text(value.reason, "reason", MAX_REASON_CHARS);
  if (value.risk !== "read-only") invalid("risk");
  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence)
    || value.confidence < 0 || value.confidence > 1) invalid("confidence");

  return {
    id,
    scope,
    shell: shell(value.shell),
    triggers,
    command,
    reason,
    risk: "read-only",
    confidence: value.confidence,
  };
}

export function parseOfflineContextJson(
  raw: string,
  options: OfflineContextParseOptions = {},
): OfflineContextArtifact {
  if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > OFFLINE_CONTEXT_MAX_PAYLOAD_BYTES) {
    invalid("payload");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    invalid("invalid_json");
  }
  if (!isRecord(value)) invalid("format");
  if (value.format !== OFFLINE_CONTEXT_FORMAT) invalid("format");
  if (value.version !== OFFLINE_CONTEXT_VERSION) invalid("version");
  if (!Array.isArray(value.entries) || value.entries.length > OFFLINE_CONTEXT_MAX_ENTRIES) invalid("entries");
  return {
    format: OFFLINE_CONTEXT_FORMAT,
    version: OFFLINE_CONTEXT_VERSION,
    entries: value.entries.map((item) => entry(item, options)),
  };
}
