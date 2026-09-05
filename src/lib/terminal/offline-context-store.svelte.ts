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

export interface OfflineContextStore {
  entries(): readonly OfflineContextEntry[];
  revision(): number;
  stats(): OfflineContextStats;
  importJson(raw: string, options?: OfflineContextParseOptions): OfflineContextImportResult;
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

  const reload = (): void => {
    const raw = storage?.getItem(OFFLINE_CONTEXT_STORAGE_KEY);
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
    current = [...validated.entries];
    currentRevision++;
  };

  reload();

  return {
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
      const parsed = parseOfflineContextJson(raw, options);
      const previousIds = new Set(current.map((item) => item.id));
      const importedIds = new Set(parsed.entries.map((item) => item.id));
      const merged = new Map(current.map((item) => [item.id, item]));
      for (const item of parsed.entries) merged.set(item.id, item);
      persist([...merged.values()]);
      let updated = 0;
      for (const id of importedIds) if (previousIds.has(id)) updated++;
      return {
        added: importedIds.size - updated,
        updated,
        total: current.length,
      };
    },

    clear() {
      if (storage) storage.removeItem(OFFLINE_CONTEXT_STORAGE_KEY);
      current = [];
      currentRevision++;
    },

    reload,
  };
}

export const offlineContextStore = createOfflineContextStore();
