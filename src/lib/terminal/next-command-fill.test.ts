import {describe, expect, it} from "vitest";
import {commandCompletionSuffix} from "./next-command-fill.ts";

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
});
