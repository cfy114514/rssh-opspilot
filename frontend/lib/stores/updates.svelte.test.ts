import { beforeEach, expect, it, vi } from "vitest";

const { invoke, getVersion } = vi.hoisted(() => ({ invoke: vi.fn(), getVersion: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion }));

beforeEach(() => {
  vi.resetModules();
  invoke.mockReset();
  getVersion.mockResolvedValue("0.2.20");
});

it.each([["v0.2.20", "latest"], ["v0.2.21", "outdated"]])(
  "checks the project's releases: %s is %s",
  async (tag, kind) => {
    invoke.mockResolvedValue(tag);
    const updates = await import("./updates.svelte.ts");
    await updates.runCheck();
    expect(invoke).toHaveBeenCalledWith("fetch_latest_release_tag", { repo: "cfy114514/rssh-opspilot" });
    expect(updates.REPO).toBe("cfy114514/rssh-opspilot");
    expect(updates.state().kind).toBe(kind);
  },
);
