import type { TerminalTabType } from "../stores/app.svelte.ts";
import {
  redactCommandText,
  type CommandBlockRedactionSettings,
} from "./command-block-redaction.ts";
import { parsePromptLine } from "./next-command.ts";

export type OpsPilotTargetKind = "ssh" | "local" | "docker_exec" | "kubectl_exec";

export interface OpsPilotTargetRef {
  readonly targetKind: OpsPilotTargetKind;
  readonly targetId: string;
}

export interface OpsPilotCommandObservation {
  readonly sourceBlockId: number;
  readonly host: string | null;
  readonly cwd: string | null;
  readonly cwdSource: "prompt" | "unknown";
  readonly cwdConfidence: number;
  /** The only command representation that may cross the persistence boundary. */
  readonly commandRedacted: string;
  /** Raw, transient command used only to match a later explicit UI action. */
  readonly commandForOriginMatch: string;
  readonly exitCode: null;
  readonly exitSource: "unavailable";
}

interface OpsPilotTargetMetadata {
  readonly profileId?: string;
  readonly connectorSpec?: string;
}

interface ExtractObservationArgs {
  readonly blockId: number;
  readonly blockText: string;
  readonly returnedPromptLine: string;
  readonly host: string | null;
  readonly historyEnabled: boolean;
  readonly redactionSettings: CommandBlockRedactionSettings | null;
}

const ALWAYS_REJECT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /(?:^|\s)sshpass\s+-p(?:\s|=)/i,
  /(?:^|\s)--(?:password|passwd|token|secret)(?:\s|=)/i,
  /(?:^|\s)authorization\s*:/i,
] as const;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseConnectorSpec(value: string | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Resolve a stable, non-secret target key without querying the remote side. */
export function resolveOpsPilotTarget(
  type: TerminalTabType,
  tabId: string,
  metadata: OpsPilotTargetMetadata,
): OpsPilotTargetRef | null {
  if (type === "ssh") {
    return {
      targetKind: "ssh",
      targetId: nonEmptyString(metadata.profileId) ? metadata.profileId : tabId,
    };
  }
  if (type === "local") return { targetKind: "local", targetId: "local" };

  const spec = parseConnectorSpec(metadata.connectorSpec);
  if (type === "docker_exec") {
    if (
      spec && typeof spec === "object"
      && "type" in spec && spec.type === "docker_exec"
      && "context" in spec && nonEmptyString(spec.context)
      && "container_id" in spec && nonEmptyString(spec.container_id)
    ) {
      return {
        targetKind: "docker_exec",
        targetId: `${spec.context}/${spec.container_id}`,
      };
    }
    return { targetKind: "docker_exec", targetId: tabId };
  }
  if (type === "kubectl_exec") {
    if (
      spec && typeof spec === "object"
      && "type" in spec && spec.type === "kubectl_exec"
      && "context" in spec && nonEmptyString(spec.context)
      && "namespace" in spec && nonEmptyString(spec.namespace)
      && "pod" in spec && nonEmptyString(spec.pod)
      && (!('container' in spec) || spec.container === null || typeof spec.container === "string")
    ) {
      const container = "container" in spec && typeof spec.container === "string"
        ? spec.container
        : "";
      return {
        targetKind: "kubectl_exec",
        targetId: `${spec.context}/${spec.namespace}/${spec.pod}/${container}`,
      };
    }
    return { targetKind: "kubectl_exec", targetId: tabId };
  }
  return null;
}

/**
 * Convert one completed command block into a local, redacted observation.
 * Terminal output is deliberately absent from both the input parsing result
 * and the returned persistence shape.
 */
export function extractOpsPilotCommandObservation(
  args: ExtractObservationArgs,
): OpsPilotCommandObservation | null {
  if (!args.historyEnabled || !args.redactionSettings) return null;

  const firstLine = args.blockText.split("\n", 1)[0] ?? "";
  const commandContext = parsePromptLine(firstLine);
  if (!commandContext) return null;

  const rawCommand = commandContext.input.trim();
  if (!rawCommand || ALWAYS_REJECT.some((pattern) => pattern.test(rawCommand))) return null;

  let redacted: string;
  try {
    redacted = redactCommandText(rawCommand, args.redactionSettings).trim();
  } catch {
    // Invalid or unsafe synced redaction rules must never leak raw commands.
    return null;
  }
  if (!redacted) return null;

  const promptContext = parsePromptLine(args.returnedPromptLine);
  const cwd = promptContext?.cwd ?? null;

  return {
    sourceBlockId: args.blockId,
    host: promptContext?.host ?? args.host,
    cwd,
    cwdSource: cwd === null ? "unknown" : "prompt",
    cwdConfidence: cwd === null ? 0 : 0.8,
    commandRedacted: Array.from(redacted).slice(0, 4_096).join(""),
    commandForOriginMatch: rawCommand,
    exitCode: null,
    exitSource: "unavailable",
  };
}
