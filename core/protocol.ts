// The protocol of entries that were not transferred (Q5 a): what the Library keeps in its world setting `eagle-library.protocol`.
// Pure logic on the text of the setting; reading and writing the setting is v13/protocol.ts.

export const PROTOCOL_VERSION = 1;
// At most this many entries are kept; the oldest go first (the done ones before the open ones) and `dropped` counts them.
export const MAX_PROTOCOL_ENTRIES = 500;
// Flight Control takes a setting text of at most 262,144 characters; the Library stays well below.
export const MAX_PROTOCOL_LENGTH = 250_000;
export const MAX_EXISTING_PER_ENTRY = 5;
const MAX_NAME_LENGTH = 200;

// What is written to the protocol: the outcomes the rules or limits of the Library refuse (decision of the project lead,
// 2026-09-21). Technical failures and repeated copies are not.
export const PROTOCOL_REASONS = ["duplicate", "no-art", "too-many", "container-too-deep"] as const;
export type ProtocolReason = (typeof PROTOCOL_REASONS)[number];
export const PROTOCOL_STATUSES = ["open", "copied", "forced"] as const;
export type ProtocolStatus = (typeof PROTOCOL_STATUSES)[number];

export interface ProtocolEntry {
  readonly at: string;
  readonly by: string;
  readonly reason: ProtocolReason;
  readonly source: string;
  readonly name: string;
  // The key of the kind (`weapons`), or null when there is none.
  readonly kind: string | null;
  // The version the entry was to go to, or null.
  readonly version: string | null;
  // The name of the target compendium, or null.
  readonly target: string | null;
  // For a duplicate: UUIDs of the entries that carry the key already (at most MAX_EXISTING_PER_ENTRY).
  readonly existing: readonly string[];
  readonly status: ProtocolStatus;
  // The UUID of the copy, for `copied` and `forced`.
  readonly copy?: string;
}

export interface Protocol {
  readonly version: typeof PROTOCOL_VERSION;
  // How many entries were dropped because of the limit.
  readonly dropped: number;
  readonly entries: readonly ProtocolEntry[];
}

export const EMPTY_PROTOCOL: Protocol = Object.freeze({ version: PROTOCOL_VERSION, dropped: 0, entries: Object.freeze([]) as readonly ProtocolEntry[] });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === "string";
const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";

function readEntry(value: unknown): ProtocolEntry | undefined {
  if (!isRecord(value)) return undefined;
  const { at, by, reason, source, name, kind, version, target, existing, status, copy } = value;
  if (!isText(at) || !isText(by) || !isText(source) || !isText(name)) return undefined;
  if (!(PROTOCOL_REASONS as readonly unknown[]).includes(reason) || !(PROTOCOL_STATUSES as readonly unknown[]).includes(status)) return undefined;
  if (!isTextOrNull(kind) || !isTextOrNull(version) || !isTextOrNull(target)) return undefined;
  if (!Array.isArray(existing) || !existing.every(isText)) return undefined;
  if (copy !== undefined && !isText(copy)) return undefined;
  return {
    at, by, source, name, kind, version, target,
    reason: reason as ProtocolReason,
    status: status as ProtocolStatus,
    existing: existing as string[],
    ...(copy === undefined ? {} : { copy }),
  };
}

export type ProtocolRead = { readonly ok: true; readonly protocol: Protocol } | { readonly ok: false; readonly detail: string };

// Reads the text of the setting. An empty text is an empty protocol. Anything that is not a protocol of this version is
// not accepted (never half-read).
export function parseProtocol(text: string): ProtocolRead {
  if (text.trim() === "") return { ok: true, protocol: EMPTY_PROTOCOL };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, detail: "the protocol is not JSON" };
  }
  if (!isRecord(data) || data.version !== PROTOCOL_VERSION) return { ok: false, detail: "the protocol is not of version 1" };
  const { dropped, entries } = data;
  if (typeof dropped !== "number" || !Number.isInteger(dropped) || dropped < 0 || !Array.isArray(entries)) {
    return { ok: false, detail: "the protocol has no valid dropped count or entries" };
  }
  const read: ProtocolEntry[] = [];
  for (const entry of entries) {
    const checked = readEntry(entry);
    if (!checked) return { ok: false, detail: "the protocol has an entry that is not valid" };
    read.push(checked);
  }
  return { ok: true, protocol: { version: PROTOCOL_VERSION, dropped, entries: read } };
}

export function serializeProtocol(protocol: Protocol): string {
  return protocol.entries.length === 0 && protocol.dropped === 0 ? "" : JSON.stringify(protocol);
}

// Keeps the protocol within its limits: too many entries or too long a text drop the oldest done entry, else the oldest.
function limit(protocol: Protocol): Protocol {
  let entries = [...protocol.entries];
  let dropped = protocol.dropped;
  const tooBig = () => entries.length > MAX_PROTOCOL_ENTRIES || JSON.stringify({ version: PROTOCOL_VERSION, dropped, entries }).length > MAX_PROTOCOL_LENGTH;
  while (entries.length > 0 && tooBig()) {
    const done = entries.findIndex((entry) => entry.status !== "open");
    entries.splice(done >= 0 ? done : 0, 1);
    dropped++;
  }
  return { version: PROTOCOL_VERSION, dropped, entries };
}

export interface NewEntry {
  readonly at: string;
  readonly by: string;
  readonly reason: ProtocolReason;
  readonly source: string;
  readonly name: string;
  readonly kind: string | null;
  readonly version: string | null;
  readonly target: string | null;
  readonly existing: readonly string[];
}

// Adds an entry. An entry with the same source and the same reason is updated (time, user, and what it says), not added
// again, and is open again.
export function addEntry(protocol: Protocol, entry: NewEntry): Protocol {
  const fresh: ProtocolEntry = {
    ...entry,
    name: entry.name.slice(0, MAX_NAME_LENGTH),
    existing: entry.existing.slice(0, MAX_EXISTING_PER_ENTRY),
    status: "open",
  };
  const index = protocol.entries.findIndex((held) => held.source === entry.source && held.reason === entry.reason);
  const entries = [...protocol.entries];
  if (index >= 0) entries[index] = fresh;
  else entries.push(fresh);
  return limit({ ...protocol, entries });
}

// The open entries of a source: the source was copied after all.
export function openEntriesOf(protocol: Protocol, source: string): readonly ProtocolEntry[] {
  return protocol.entries.filter((entry) => entry.source === source && entry.status === "open");
}

// Marks the open entries of a source as done: copied normally, or forced.
export function resolveSource(protocol: Protocol, source: string, status: "copied" | "forced", copy: string): Protocol {
  return {
    ...protocol,
    entries: protocol.entries.map((entry) => (entry.source === source && entry.status === "open" ? { ...entry, status, copy } : entry)),
  };
}
