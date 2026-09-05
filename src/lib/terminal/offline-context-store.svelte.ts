import {
  OFFLINE_CONTEXT_FORMAT,
  OFFLINE_CONTEXT_VERSION,
  parseOfflineContextJson,
  type OfflineContextEntry,
  type OfflineContextParseOptions,
} from "./offline-context-schema.ts";

export const OFFLINE_CONTEXT_STORAGE_KEY = "rssh.offline-context.v1";

export interface OfflineContextStats {
  readonly total: number;
  readonly hostSpecific: number;
  readonly global: number;
}

export interface OfflineContextImportResult {
  readonly added: number;
  readonly updated: number;
  readonly total: number;
}

export interface OfflineContextImportPreview {
  readonly result: OfflineContextImportResult;
  readonly changes: readonly {
    readonly entry: OfflineContextEntry;
    readonly previous?: OfflineContextEntry;
  }[];
}

export class OfflineContextPreviewError extends Error {
  constructor(readonly code: "stale" | "changed") {
    super(`offline_context_preview_${code}`);
    this.name = "OfflineContextPreviewError";
  }
}

function frozenEntry(entry: OfflineContextEntry): OfflineContextEntry {
  return Object.freeze({
    ...entry,
    scope: Object.freeze({ ...entry.scope }),
    triggers: Object.freeze([...entry.triggers]),
  });
}

export interface OfflineContextStore {
  entries(): readonly OfflineContextEntry[];
  revision(): number;
  stats(): OfflineContextStats;
  importJson(raw: string, options?: OfflineContextParseOptions): OfflineContextImportResult;
  previewJson(raw: string, options?: OfflineContextParseOptions): OfflineContextImportPreview;
  confirmImport(preview: OfflineContextImportPreview): OfflineContextImportResult;
  clear(): void;
  reload(): void;
}

function browserStorage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return typeof localStorage.getItem === "function"
      && typeof localStorage.setItem === "function"
      && typeof localStorage.removeItem === "function"
      ? localStorage
      : null;
  } catch {
    return null;
  }
}

function artifactJson(entries: readonly OfflineContextEntry[]): string {
  return JSON.stringify({
    format: OFFLINE_CONTEXT_FORMAT,
    version: OFFLINE_CONTEXT_VERSION,
    entries,
  });
}

export function createOfflineContextStore(
  storage: Storage | null = browserStorage(),
): OfflineContextStore {
  let current = $state<OfflineContextEntry[]>([]);
  let currentRevision = $state(0);
  let lastStored: string | null = null;
  // Review tokens belong to this store; UI edits cannot change the approved payload.
  const reviews = new WeakMap<OfflineContextImportPreview, {
    revision: number;
    stored: string | null;
    merged: readonly OfflineContextEntry[];
  }>();

  const reload = (): void => {
    const raw = storage?.getItem(OFFLINE_CONTEXT_STORAGE_KEY) ?? null;
    lastStored = raw;
    if (!raw) {
      current = [];
      currentRevision++;
      return;
    }
    try {
      current = [...parseOfflineContextJson(raw).entries];
    } catch {
      // Persisted data is never trusted blindly; keep the store empty while
      // leaving the raw value available for a future compatible parser.
      current = [];
    }
    currentRevision++;
  };

  const persist = (entries: readonly OfflineContextEntry[]): void => {
    const canonical = artifactJson(entries);
    // Re-validate the merged artifact so the combined store cannot exceed the
    // same schema limits as a single import.
    const validated = parseOfflineContextJson(canonical);
    if (storage) storage.setItem(OFFLINE_CONTEXT_STORAGE_KEY, artifactJson(validated.entries));
    lastStored = storage ? artifactJson(validated.entries) : null;
    current = [...validated.entries];
    currentRevision++;
  };

  reload();

  const store: OfflineContextStore = {
    entries() {
      return current;
    },

    revision() {
      return currentRevision;
    },

    stats() {
      const hostSpecific = current.filter((item) => item.scope.host !== undefined).length;
      return {
        total: current.length,
        hostSpecific,
        global: current.length - hostSpecific,
      };
    },

    importJson(raw, options) {
      return store.confirmImport(store.previewJson(raw, options));
    },

    previewJson(raw, options) {
      // Reload first so counts and replacements reflect other windows too.
      const stored = storage?.getItem(OFFLINE_CONTEXT_STORAGE_KEY) ?? null;
      if (storage && stored !== lastStored) reload();
      const parsed = parseOfflineContextJson(raw, options);
      const imported = new Map(parsed.entries.map((item) => [item.id, item]));
      const previous = new Map(current.map((item) => [item.id, item]));
      const merged = new Map(previous);
      for (const [id, item] of imported) merged.set(id, item);
      const validated = parseOfflineContextJson(artifactJson([...merged.values()]));
      const updated = [...imported.keys()].filter((id) => previous.has(id)).length;
      const preview = Object.freeze({
        result: Object.freeze({ added: imported.size - updated, updated, total: merged.size }),
        changes: Object.freeze([...imported.values()].map((item) => Object.freeze({
          entry: frozenEntry(item),
          previous: previous.has(item.id) ? frozenEntry(previous.get(item.id)!) : undefined,
        }))),
      });
      reviews.set(preview, {
        revision: currentRevision, stored,
        merged: validated.entries,
      });
      return preview;
    },

    confirmImport(preview) {
      const review = reviews.get(preview);
      if (!review || review.revision !== currentRevision
        || (storage && storage.getItem(OFFLINE_CONTEXT_STORAGE_KEY) !== review.stored)) {
        throw new OfflineContextPreviewError("stale");
      }
      persist(review.merged);
      reviews.delete(preview);
      return preview.result;
    },

    clear() {
      if (storage) storage.removeItem(OFFLINE_CONTEXT_STORAGE_KEY);
      lastStored = null;
      current = [];
      currentRevision++;
    },

    reload,
  };
  return store;
}

export const offlineContextStore = createOfflineContextStore();
