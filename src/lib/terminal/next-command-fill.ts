/**
 * Return the part of a local suggestion that is still missing from the
 * current terminal input. The caller owns the prompt spacing; leading
 * whitespace is ignored only for the prefix comparison.
 */
export function commandCompletionSuffix(input: string, command: string): string | null {
  const prefix = input.trimStart();
  if (prefix.length === 0) return command;
  if (!command.startsWith(prefix)) return null;
  return command.slice(prefix.length);
}
