import type { CopyResult } from "./copy";
import { expectedCompendia } from "./catalog";
import type { ProtocolEntry } from "./protocol";
import { looseKey, parsePrimary, typedKey, type ParsedUuid } from "./uuid";

// The map from the documents that were copied to their copies (milestone M6, rule R13 of the convention): what the rewriting of
// links looks up. Built from values (the results of the copying, the protocol, a plan), never from Foundry objects.

export type LinkHow =
  // The result of a copy (a copy with the id of its source, or one that was there already).
  | "copied"
  // A duplicate that was not copied: the entry that carries the key already.
  | "existing"
  // A plan (the target of a copy that is not made yet).
  | "planned";

export interface LinkEntry {
  // The main part of the source, in the form with a type.
  readonly source: string;
  // The main part of the copy, in the form with a type, in an Eagle Compendium.
  readonly copy: string;
  readonly how: LinkHow;
}

export interface LinkMap {
  readonly size: number;
  readonly entries: readonly LinkEntry[];
  // Two entries for one source with different copies: the first is kept, the second is named here.
  readonly conflicts: readonly { readonly source: string; readonly kept: string; readonly ignored: string }[];
  // Entries that were not taken in, with the reason.
  readonly invalid: readonly { readonly entry: LinkEntry; readonly detail: string }[];
  // The entry for a reference, whatever its form.
  lookup(parsed: Pick<ParsedUuid, "scope" | "pack" | "id" | "documentName">): LinkEntry | undefined;
}

const LIBRARY_PACKS: ReadonlySet<string> = new Set(expectedCompendia().map((compendium) => compendium.name));

// Whether a compendium of a UUID is an Eagle Compendium: a world compendium with a name of the catalog.
export function isLibraryPack(scope: string, pack: string): boolean {
  return scope === "world" && LIBRARY_PACKS.has(pack);
}

function check(entry: LinkEntry): string | undefined {
  const source = parsePrimary(entry.source);
  const copy = parsePrimary(entry.copy);
  if (!source || !source.documentName) return "the source is not the main part of a UUID with a type";
  if (!copy || !copy.documentName) return "the copy is not the main part of a UUID with a type";
  if (isLibraryPack(source.scope, source.pack)) return "the source is in an Eagle Compendium already";
  if (!isLibraryPack(copy.scope, copy.pack)) return "the copy is not in an Eagle Compendium";
  if (source.documentName !== copy.documentName) return "the source and the copy are not of the same document type";
  return undefined;
}

// Builds the map. It never throws: a wrong entry is named in `invalid`, a second entry for a source in `conflicts`.
export function linkMapFrom(entries: readonly LinkEntry[]): LinkMap {
  const bySource = new Map<string, LinkEntry>();
  const byLoose = new Map<string, LinkEntry>();
  const conflicts: { source: string; kept: string; ignored: string }[] = [];
  const invalid: { entry: LinkEntry; detail: string }[] = [];
  for (const entry of entries) {
    const problem = check(entry);
    if (problem) {
      invalid.push({ entry, detail: problem });
      continue;
    }
    const source = parsePrimary(entry.source)!;
    const key = typedKey(source)!;
    const held = bySource.get(key);
    if (held) {
      if (held.copy !== entry.copy) conflicts.push({ source: entry.source, kept: held.copy, ignored: entry.copy });
      continue;
    }
    bySource.set(key, entry);
    byLoose.set(looseKey(source), entry);
  }
  const taken = [...bySource.values()];
  const map: LinkMap = {
    size: taken.length,
    entries: Object.freeze(taken),
    conflicts: Object.freeze(conflicts),
    invalid: Object.freeze(invalid),
    lookup: (parsed) =>
      parsed.documentName
        ? bySource.get(`Compendium.${parsed.scope}.${parsed.pack}.${parsed.documentName}.${parsed.id}`)
        : byLoose.get(looseKey(parsed)),
  };
  return Object.freeze(map);
}

export const EMPTY_LINK_MAP: LinkMap = linkMapFrom([]);

// The entries of the result of a copy: each document that was made or was there already, source to copy. A forced copy has no
// entry: what other documents point at is the entry that carries the key, and the forced copy is only the target of the
// links of the document to itself (`self` of the rewriting).
export function entriesFromCopyResult(result: CopyResult): LinkEntry[] {
  if (!result.ok || result.forced === true) return [];
  return [...result.created, ...result.existed].map((copied) => ({ source: copied.source, copy: copied.uuid, how: "copied" as const }));
}

// The entry of a duplicate that was not copied: its source to the first entry of the protocol that carries the key.
export function entryFromProtocol(entry: Pick<ProtocolEntry, "source" | "reason" | "existing">): LinkEntry | undefined {
  const existing = entry.reason === "duplicate" ? entry.existing[0] : undefined;
  return existing ? { source: entry.source, copy: existing, how: "existing" } : undefined;
}

// The entry of a copy that is planned: the UUID it will have.
export function plannedEntry(source: string, copy: string): LinkEntry {
  return { source, copy, how: "planned" };
}
