export type NextCommandFeedbackOutcome = "accepted" | "dismissed";

export interface NextCommandFeedbackStats {
  accepted: number;
  dismissed: number;
}

const STORAGE_KEY = "rssh.next-command.feedback.v1";
const MAX_ENTRIES = 128;

function storage(): Storage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

function normalize(value: unknown): Record<string, NextCommandFeedbackStats> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, NextCommandFeedbackStats> = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^local-[0-9a-f]+$/.test(id) || !raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const accepted = Number.isFinite(item.accepted) ? Math.max(0, Math.floor(Number(item.accepted))) : 0;
    const dismissed = Number.isFinite(item.dismissed) ? Math.max(0, Math.floor(Number(item.dismissed))) : 0;
    if (accepted === 0 && dismissed === 0) continue;
    out[id] = {accepted, dismissed};
  }
  return out;
}

export function loadNextCommandFeedback(): Readonly<Record<string, NextCommandFeedbackStats>> {
  const store = storage();
  if (!store) return {};
  try {
    return normalize(JSON.parse(store.getItem(STORAGE_KEY) ?? "{}"));
  } catch {
    return {};
  }
}

export function recordNextCommandFeedback(id: string, outcome: NextCommandFeedbackOutcome): void {
  if (!/^local-[0-9a-f]+$/.test(id)) return;
  const store = storage();
  if (!store) return;
  const current = normalize(loadNextCommandFeedback());
  const stats = current[id] ?? {accepted: 0, dismissed: 0};
  stats[outcome] += 1;
  current[id] = stats;

  const entries = Object.entries(current)
    .sort((a, b) => (b[1].accepted + b[1].dismissed) - (a[1].accepted + a[1].dismissed))
    .slice(0, MAX_ENTRIES);
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // localStorage can be full or disabled; feedback is best-effort and must
    // never affect terminal input or the SSH session.
  }
}
