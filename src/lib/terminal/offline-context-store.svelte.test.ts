import { describe, expect, it } from "vitest";
import {
  createOfflineContextStore,
  type OfflineContextStore,
} from "./offline-context-store.svelte.ts";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  readonly length = 0;
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const entry = {
  id: "api-check",
  scope: { host: "api-01" },
  shell: "posix",
  triggers: ["error"],
  command: "ss -lntp",
  reason: "查看监听端口",
  risk: "read-only",
  confidence: 0.8,
};

function json(entries = [entry]): string {
  return JSON.stringify({ format: "rssh-offline-context", version: 1, entries });
}

describe("offline context store", () => {
  it("imports entries and reports host/global counts", () => {
    const store = createOfflineContextStore(new MemoryStorage());
    expect(store.importJson(json([{ ...entry }, { ...entry, id: "global", scope: {} }]))).toEqual({
      added: 2,
      updated: 0,
      total: 2,
    });
    expect(store.stats()).toEqual({ total: 2, hostSpecific: 1, global: 1 });
  });

  it("replaces duplicate ids only after the whole import validates", () => {
    const storage = new MemoryStorage();
    const store = createOfflineContextStore(storage);
    store.importJson(json());

    expect(store.importJson(json([{ ...entry, command: "ss -lntp 'sport = :8443'" }]))).toEqual({
      added: 0,
      updated: 1,
      total: 1,
    });
    expect(store.entries()[0]?.command).toBe("ss -lntp 'sport = :8443'");

    expect(() => store.importJson("not json")).toThrow("offline_context_invalid_json");
    expect(store.entries()[0]?.command).toBe("ss -lntp 'sport = :8443'");
    expect(storage.getItem("rssh.offline-context.v1")).toContain("8443");
  });

  it("reloads persisted entries and clears them immediately", () => {
    const storage = new MemoryStorage();
    const first = createOfflineContextStore(storage);
    first.importJson(json());
    const second: OfflineContextStore = createOfflineContextStore(storage);
    expect(second.entries().map((item) => item.id)).toEqual(["api-check"]);

    second.clear();
    expect(second.entries()).toEqual([]);
    expect(createOfflineContextStore(storage).entries()).toEqual([]);
  });
});
