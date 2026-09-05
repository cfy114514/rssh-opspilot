import type {
  OfflineContextEntry,
  OfflineContextShell,
} from "./offline-context-schema.ts";
import type {NextCommandShell} from "./next-command.ts";

export interface OfflineContextMatchContext {
  readonly shell: NextCommandShell;
  readonly host?: string;
  readonly cwd?: string;
  readonly promptLine?: string;
  readonly input?: string;
  readonly recentBlocks: readonly string[];
}

export interface OfflineContextSuggestion {
  readonly command: string;
  readonly reason: string;
  readonly confidence: number;
}

function normalized(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLocaleLowerCase() : undefined;
}

function shellMatches(entryShell: OfflineContextShell, shell: NextCommandShell): boolean {
  return entryShell === "any" || entryShell === shell;
}

function commandMatchesPrefix(command: string, input: string, shell: NextCommandShell): boolean {
  const prefix = input.trimStart();
  if (!prefix) return true;
  if (shell === "posix") return command.startsWith(prefix);
  return command.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase());
}

function boundedConfidence(
  entry: OfflineContextEntry,
  hostSpecific: boolean,
  shellSpecific: boolean,
  triggerMatched: boolean,
  prefixMatched: boolean,
): number {
  // Scope is deliberately weighted before the imported confidence value:
  // ponytail: exact host beats a high-confidence global row; use a learned
  // per-host score only if this fixed priority becomes too coarse.
  return Math.min(
    1,
    entry.confidence * 0.7
      + (hostSpecific ? 0.25 : 0)
      + (shellSpecific ? 0.03 : 0)
      + (triggerMatched ? 0.04 : 0)
      + (prefixMatched ? 0.04 : 0),
  );
}

export function matchOfflineContext(
  entries: readonly OfflineContextEntry[],
  context: OfflineContextMatchContext,
): OfflineContextSuggestion[] {
  const currentHost = normalized(context.host);
  const haystack = [
    context.cwd,
    context.promptLine,
    context.input,
    ...context.recentBlocks,
  ].filter(Boolean).join("\n").toLocaleLowerCase();
  const out = new Map<string, OfflineContextSuggestion>();

  for (const item of entries) {
    const itemHost = normalized(item.scope.host);
    const hostSpecific = itemHost !== undefined;
    if (hostSpecific && itemHost !== currentHost) continue;
    if (!shellMatches(item.shell, context.shell)) continue;

    const triggerMatched = item.triggers.some((trigger) =>
      haystack.includes(trigger.toLocaleLowerCase()));
    const prefixMatched = Boolean(context.input?.trim())
      && commandMatchesPrefix(item.command, context.input ?? "", context.shell);
    if (!triggerMatched && !prefixMatched) continue;
    if (!commandMatchesPrefix(item.command, context.input ?? "", context.shell)) continue;

    const suggestion = {
      command: item.command,
      reason: item.reason,
      confidence: boundedConfidence(
        item,
        hostSpecific,
        item.shell === context.shell,
        triggerMatched,
        prefixMatched,
      ),
    } satisfies OfflineContextSuggestion;
    const previous = out.get(item.command);
    if (!previous || suggestion.confidence > previous.confidence) out.set(item.command, suggestion);
  }

  return [...out.values()]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);
}
