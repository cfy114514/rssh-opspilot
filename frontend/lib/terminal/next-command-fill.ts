/**
 * Return the part of a local suggestion that is still missing from the
 * current terminal input. The caller owns the prompt spacing; leading
 * whitespace is ignored only for the prefix comparison.
 */
export function commandCompletionSuffix(
  input: string,
  command: string,
  caseInsensitive = false,
): string | null {
  const prefix = input.trimStart();
  if (prefix.length === 0) return command;
  const comparablePrefix = caseInsensitive ? prefix.toLocaleLowerCase() : prefix;
  const comparableCommand = caseInsensitive ? command.toLocaleLowerCase() : command;
  if (!comparableCommand.startsWith(comparablePrefix)) return null;
  return command.slice(prefix.length);
}

/**
 * Decide whether terminal input can change the editable command prefix.
 * Control sequences are handed to the shell and must not cause a stale local
 * suggestion to be refreshed before the shell has redrawn its prompt.
 */
export function shouldRefreshNextCommandSuggestions(data: string): boolean {
  if (!data) return false;
  let editable = false;
  for (const ch of data) {
    if (ch === "\x7f" || ch === "\b") {
      editable = true;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (ch === "\r" || ch === "\n" || ch === "\t" || code < 0x20) return false;
    editable = true;
  }
  return editable;
}
