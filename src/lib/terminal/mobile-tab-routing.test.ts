import {describe, expect, it} from "vitest";
import {routeMobileTab} from "./mobile-tab-routing.ts";

describe("routeMobileTab", () => {
  it("accepts the first suggestion instead of sending raw Tab", () => {
    const calls: string[] = [];

    routeMobileTab(true, () => calls.push("suggestion"), () => calls.push("tab"));

    expect(calls).toEqual(["suggestion"]);
  });

  it("keeps native shell Tab completion when there is no suggestion", () => {
    const calls: string[] = [];

    routeMobileTab(false, () => calls.push("suggestion"), () => calls.push("tab"));

    expect(calls).toEqual(["tab"]);
  });
});
