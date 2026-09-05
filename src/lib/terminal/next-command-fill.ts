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
