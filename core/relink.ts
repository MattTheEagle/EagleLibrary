import { entryFromProtocol, isLibraryPack, linkMapFrom, plannedEntry, type LinkEntry } from "./link-map";
import { scanLinks, rewriteLinks, summarizeReferences, type Json, type LinkChange, type LinkReference, type LinkSummary, type TargetInfo, type TargetLookup } from "./rewrite-links";
import { looseKey, parsePrimary, type ParsedUuid } from "./uuid";

// The links of the documents of one copy (milestone M7, rule R14 of the convention): the map of the run (pass 1) and the rewritten
// fields of every document, ready to be written together with it (pass 2). Pure logic; what the world knows is handed in.

// Where a document of the Library is: the name of its Eagle Compendium and the document type, by its id.
export interface LibraryDocument {
  readonly compendium: string;
  readonly documentName: string;
}
export type LibraryIds = ReadonlyMap<string, LibraryDocument>;

// What the links need to know of the world. Every call may throw.
export interface LinkWorld {
  // The ids of all documents in the Eagle Compendia.
  libraryIds(): Promise<LibraryIds>;
  // What is known of the target of a link outside the Library.
  describeTarget(scope: string, pack: string, id: string): Promise<TargetInfo | undefined>;
  // The data of a document (its source, as JSON); undefined when there is none.
  readData(uuid: string): Promise<Json | undefined>;
}

// A document that a copy writes: its source, the UUID its copy will have, and its data.
export interface RunDocument {
  readonly source: string;
  readonly copy: string;
  readonly data: Json;
}

// The part of a protocol entry that the map needs.
export interface ProtocolLink {
  readonly source: string;
  readonly reason: string;
  readonly existing: readonly string[];
}

export const MAX_REPORTED_PROBLEMS = 50;

const segmentsOf = (path: string): string[] => path.split(".");
const isPosition = (segment: string): boolean => /^\d+$/.test(segment);

function valueAt(data: Json, segments: readonly string[]): Json {
  let at: Json | undefined = data;
  for (const segment of segments) {
    if (typeof at !== "object" || at === null) return null;
    at = (at as { readonly [key: string]: Json })[segment];
  }
  return at ?? null;
}

// The fields to set on a copy for the links that changed: a path to a whole list where the change was inside a list (a place in
// a list is not a safe path for Foundry), no path under another path that is there, and the value of the rewritten data. Over
// `maxPaths` every path is reduced to the first field (`system`, `pages`, `items`).
export function collapseChanges(changes: readonly LinkChange[], rewritten: Json, maxPaths: number): { [path: string]: Json } {
  const wholeLists = (limitToFirst: boolean): string[] => {
    const paths = new Set<string>();
    for (const change of changes) {
      const segments = segmentsOf(change.path);
      const at = limitToFirst ? 1 : segments.findIndex(isPosition);
      paths.add(at >= 0 ? segments.slice(0, at).join(".") : change.path);
    }
    // No path under another one.
    const sorted = [...paths].sort((a, b) => a.length - b.length);
    const kept: string[] = [];
    for (const path of sorted) if (!kept.some((held) => path === held || path.startsWith(`${held}.`))) kept.push(path);
    return kept;
  };
  let paths = wholeLists(false);
  if (paths.length > maxPaths) paths = wholeLists(true);
  const out: { [path: string]: Json } = {};
  for (const path of paths) out[path] = valueAt(rewritten, segmentsOf(path));
  return out;
}

// The referenced documents that could be in the Library or in the protocol: every UUID that is not a field of origin, not in an
// Eagle Compendium already, once for each document.
export function referencedSources(documents: readonly Json[]): ParsedUuid[] {
  const seen = new Map<string, ParsedUuid>();
  for (const data of documents) {
    for (const reference of scanLinks(data)) {
      if (reference.outcome === "kept-source") continue;
      const parsed = parsePrimary(reference.uuid);
      if (!parsed || isLibraryPack(parsed.scope, parsed.pack)) continue;
      if (!seen.has(looseKey(parsed))) seen.set(looseKey(parsed), parsed);
    }
  }
  return [...seen.values()];
}

// The entries of the map that come from what the Library holds: a referenced document whose id is in an Eagle Compendium (of the
// same document type) is that document (`copied`); a duplicate that was skipped is the entry the protocol names (`existing`).
export function libraryEntries(referenced: readonly ParsedUuid[], ids: LibraryIds, protocol: readonly ProtocolLink[]): LinkEntry[] {
  const entries: LinkEntry[] = [];
  for (const ref of referenced) {
    const found = ids.get(ref.id);
    if (found && (!ref.documentName || ref.documentName === found.documentName)) {
      entries.push({
        source: `Compendium.${ref.scope}.${ref.pack}.${found.documentName}.${ref.id}`,
        copy: `Compendium.world.${found.compendium}.${found.documentName}.${ref.id}`,
        how: "copied",
      });
      continue;
    }
    for (const held of protocol) {
      const source = parsePrimary(held.source);
      if (!source || looseKey(source) !== looseKey(ref)) continue;
      const entry = entryFromProtocol({ source: held.source, reason: held.reason as "duplicate", existing: held.existing });
      if (entry) entries.push(entry);
      break;
    }
  }
  return entries;
}

export interface LinkRun {
  // For each document, in the order given: the fields to set on its copy so that its links point at the Library.
  readonly changes: readonly { readonly [path: string]: Json }[];
  readonly references: readonly LinkReference[];
  readonly map: { readonly size: number; readonly conflicts: number; readonly invalid: number };
}

// Pass 1 and 2 for the documents of one copy. Reads the world only when a document has a link that the run itself does not cover.
export async function linkRun(
  world: Pick<LinkWorld, "libraryIds" | "describeTarget">,
  documents: readonly RunDocument[],
  protocol: readonly ProtocolLink[],
  maxPaths: number,
  // Entries for documents of the same run that are not among `documents` (other portions of a closure, duplicates that stand for
  // an entry that is there or planned): their targets stand already.
  alsoPlanned: readonly LinkEntry[] = [],
): Promise<LinkRun> {
  const planned = documents.map((document) => plannedEntry(document.source, document.copy));
  const referenced = referencedSources(documents.map((document) => document.data));
  const own = new Set(
    [...documents.map((document) => document.source), ...alsoPlanned.map((entry) => entry.source)].map((source) =>
      looseKey(parsePrimary(source) ?? { scope: "", pack: "", id: source }),
    ),
  );
  const outside = referenced.filter((ref) => !own.has(looseKey(ref)));

  const derived = outside.length > 0 ? libraryEntries(outside, await world.libraryIds(), protocol) : [];
  const map = linkMapFrom([...planned, ...alsoPlanned, ...derived]);

  // What is known of the targets that no entry covers, asked once for each.
  const infos = new Map<string, TargetInfo | undefined>();
  for (const ref of outside) {
    if (map.lookup(ref)) continue;
    try {
      infos.set(looseKey(ref), await world.describeTarget(ref.scope, ref.pack, ref.id));
    } catch {
      infos.set(looseKey(ref), undefined);
    }
  }
  const lookup: TargetLookup = (scope, pack, id) => infos.get(`${scope}.${pack}.${id}`);

  const changes: { [path: string]: Json }[] = [];
  const references: LinkReference[] = [];
  for (const document of documents) {
    const result = rewriteLinks(document.data, map, { self: { source: document.source, copy: document.copy }, lookup });
    changes.push(collapseChanges(result.changes, result.data, maxPaths));
    references.push(...result.references);
  }
  return { changes, references, map: { size: map.size, conflicts: map.conflicts.length, invalid: map.invalid.length } };
}

export interface ReportedLinks {
  readonly total: number;
  readonly counts: LinkSummary["counts"];
  // At most MAX_REPORTED_PROBLEMS of the references that do not end in an Eagle Compendium.
  readonly problems: readonly LinkReference[];
  // How many problems are not in the list.
  readonly truncated: number;
}

export function reportLinks(references: readonly LinkReference[]): ReportedLinks {
  const summary = summarizeReferences(references);
  return {
    total: summary.total,
    counts: summary.counts,
    problems: summary.problems.slice(0, MAX_REPORTED_PROBLEMS),
    truncated: Math.max(0, summary.problems.length - MAX_REPORTED_PROBLEMS),
  };
}

export type LinkCheck =
  | { readonly ok: true; readonly links: ReportedLinks }
  | { readonly ok: false; readonly reason: "not-in-library" | "not-found" | "read-failed"; readonly detail: string };

// The report for a document of the Library, without changing anything.
export async function checkDocumentLinks(world: LinkWorld, uuid: string): Promise<LinkCheck> {
  const parsed = typeof uuid === "string" ? parsePrimary(uuid) : undefined;
  if (!parsed || !isLibraryPack(parsed.scope, parsed.pack)) {
    return { ok: false, reason: "not-in-library", detail: "the UUID must be the main part of a document in an Eagle Compendium" };
  }
  let data: Json | undefined;
  try {
    data = await world.readData(uuid);
  } catch (error) {
    return { ok: false, reason: "read-failed", detail: error instanceof Error ? error.message : String(error) };
  }
  if (data === undefined) return { ok: false, reason: "not-found", detail: "there is no document with this UUID" };
  const infos = new Map<string, TargetInfo | undefined>();
  for (const ref of referencedSources([data])) {
    try {
      infos.set(looseKey(ref), await world.describeTarget(ref.scope, ref.pack, ref.id));
    } catch {
      infos.set(looseKey(ref), undefined);
    }
  }
  const references = scanLinks(data, { lookup: (scope, pack, id) => infos.get(`${scope}.${pack}.${id}`) });
  return { ok: true, links: reportLinks(references) };
}
