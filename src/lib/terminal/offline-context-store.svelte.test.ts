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

import type { OfflineContextEntry } from "./offline-context-schema.ts";

const entry: OfflineContextEntry = {
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


describe("offline context import review", () => {
  it("previews the final deduplicated changes without writing or activating them", () => {
    const storage = new MemoryStorage();
    const store = createOfflineContextStore(storage);
    store.importJson(json());
    const before = storage.getItem("rssh.offline-context.v1");
    const revision = store.revision();
    const preview = store.previewJson(json([
      { ...entry, command: "ss -a" },
      { ...entry, command: "ss -lnt" },
      { ...entry, id: "global", scope: {}, command: "df -h" },
    ]));
    expect(preview.result).toEqual({ added: 1, updated: 1, total: 2 });
    expect(preview.changes.map((c) => [c.entry.command, c.previous?.command])).toEqual([
      ["ss -lnt", "ss -lntp"], ["df -h", undefined],
    ]);
    // Closing/cancelling a preview simply discards it, never touching the store.
    expect(store.entries().map((e) => e.command)).toEqual(["ss -lntp"]);
    expect(store.revision()).toBe(revision);
    expect(storage.getItem("rssh.offline-context.v1")).toBe(before);
  });

  it("confirms exactly the reviewed entries once", () => {
    const storage = new MemoryStorage();
    const store = createOfflineContextStore(storage);
    const preview = store.previewJson(json());
    expect(store.confirmImport(preview)).toEqual({ added: 1, updated: 0, total: 1 });
    expect(createOfflineContextStore(storage).entries()[0]?.command).toBe("ss -lntp");
    expect(() => store.confirmImport(preview)).toThrow("offline_context_preview_stale");
  });

  it("shows scope changes when an existing id would be overwritten", () => {
    const store = createOfflineContextStore(new MemoryStorage());
    store.importJson(json());
    const preview = store.previewJson(json([{ ...entry, scope: {} }]));
    expect(preview.changes[0].previous?.scope.host).toBe("api-01");
    expect(preview.changes[0].entry.scope.host).toBeUndefined();
  });

  it("validates every row and merged capacity before offering a preview", () => {
    const store = createOfflineContextStore(new MemoryStorage());
    store.importJson(json());
    expect(() => store.previewJson(json([entry, { ...entry, id: "bad", command: "a\nb" }]))).toThrow();
    const full = Array.from({ length: 200 }, (_, i) => ({ ...entry, id: `item-${i}` }));
    expect(() => store.previewJson(json(full))).toThrow("offline_context_entries");
    expect(store.entries()).toHaveLength(1);
  });

  it("rejects a preview after clearing or another import", () => {
    const store = createOfflineContextStore(new MemoryStorage());
    let preview = store.previewJson(json());
    store.clear();
    expect(() => store.confirmImport(preview)).toThrow("offline_context_preview_stale");
    preview = store.previewJson(json());
    store.importJson(json([{ ...entry, id: "other" }]));
    expect(() => store.confirmImport(preview)).toThrow("offline_context_preview_stale");
    expect(store.entries().map((e) => e.id)).toEqual(["other"]);
  });

  it("does not overwrite changes saved by another window while reviewing", () => {
    const storage = new MemoryStorage();
    const store = createOfflineContextStore(storage);
    const preview = store.previewJson(json());
    createOfflineContextStore(storage).importJson(json([{ ...entry, id: "other-window" }]));
    expect(() => store.confirmImport(preview)).toThrow("offline_context_preview_stale");
    expect(createOfflineContextStore(storage).entries()[0]?.id).toBe("other-window");
  });

  it("confirms the sanitized command without applying its non-idempotent rule twice", () => {
    const store = createOfflineContextStore(new MemoryStorage());
    const preview = store.previewJson(json(), { redactCommand: (command) => command.replace("ss", "ssx") });
    expect(preview.changes[0].entry.command).toBe("ssx -lntp");
    store.confirmImport(preview);
    expect(store.entries()[0].command).toBe("ssx -lntp");
  });

  it("cannot confirm a fabricated or mutated preview", () => {
    const store = createOfflineContextStore(new MemoryStorage());
    const preview = store.previewJson(json());
    expect(() => store.confirmImport({ ...preview })).toThrow("offline_context_preview_stale");
    expect(() => { (preview.changes[0].entry as { command: string }).command = "other"; }).toThrow();
    expect(() => { (preview.changes[0].entry.triggers as string[]).push("other"); }).toThrow();
    store.confirmImport(preview);
    expect(store.entries()[0].command).toBe("ss -lntp");
  });

  it("leaves the old library active when confirmation cannot be saved", () => {
    const storage = new MemoryStorage();
    const store = createOfflineContextStore(storage);
    store.importJson(json());
    const revision = store.revision();
    const before = storage.getItem("rssh.offline-context.v1");
    const preview = store.previewJson(json([{ ...entry, command: "df -h" }]));
    storage.setItem = () => { throw new Error("quota"); };
    expect(() => store.confirmImport(preview)).toThrow("quota");
    expect(store.entries()[0].command).toBe("ss -lntp");
    expect(store.revision()).toBe(revision);
    expect(storage.getItem("rssh.offline-context.v1")).toBe(before);
  });
});


it("does not invalidate another preview of an unchanged empty library", () => {
  const store = createOfflineContextStore(new MemoryStorage());
  store.importJson(json([]));
  const revision = store.revision();
  const preview = store.previewJson(json());
  store.previewJson(json());
  expect(store.revision()).toBe(revision);
  expect(store.confirmImport(preview).added).toBe(1);
});
