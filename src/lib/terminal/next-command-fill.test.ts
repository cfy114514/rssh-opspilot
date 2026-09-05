import {describe, expect, it} from "vitest";
import {
  commandCompletionSuffix,
  shouldRefreshNextCommandSuggestions,
} from "./next-command-fill.ts";

describe("commandCompletionSuffix", () => {
  it("returns only the missing suffix after a prompt-space-prefixed input", () => {
    expect(commandCompletionSuffix(" pw", "pwd")).toBe("d");
  });

  it("returns the complete command for an empty input", () => {
    expect(commandCompletionSuffix("", "pwd")).toBe("pwd");
  });

  it("rejects a suggestion that is not an exact prefix", () => {
    expect(commandCompletionSuffix("ls", "pwd")).toBeNull();
  });

  it("does not ignore trailing input whitespace when matching a prefix", () => {
    expect(commandCompletionSuffix(" pw ", "pwd")).toBeNull();
  });

  it("supports case-insensitive completion for Windows shell commands", () => {
    expect(commandCompletionSuffix(" get-", "Get-Location", true)).toBe("Location");
  });

  it("keeps POSIX completion case-sensitive by default", () => {
    expect(commandCompletionSuffix("PWD", "pwd")).toBeNull();
  });

  it("refreshes suggestions only for editable line input", () => {
    expect(shouldRefreshNextCommandSuggestions("get-")).toBe(true);
    expect(shouldRefreshNextCommandSuggestions("\x7f")).toBe(true);
    expect(shouldRefreshNextCommandSuggestions("\b")).toBe(true);
    expect(shouldRefreshNextCommandSuggestions("\r")).toBe(false);
    expect(shouldRefreshNextCommandSuggestions("\x03")).toBe(false);
    expect(shouldRefreshNextCommandSuggestions("\t")).toBe(false);
    expect(shouldRefreshNextCommandSuggestions("\x1b[A")).toBe(false);
    expect(shouldRefreshNextCommandSuggestions("paste\nmore")).toBe(false);
  });
});
