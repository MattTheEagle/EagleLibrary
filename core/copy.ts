import { artForDocument, compendiaOf, recognizeCompendium, type ExpectedCompendium } from "./catalog";
import type { RequestApi, SetupLog } from "./compendium-setup";
import { LIBRARY_ID } from "./index";
import { duplicateName, entryKey, nameKey, sameEntry } from "./name-key";
import {
  addEntry,
  EMPTY_PROTOCOL,
  openEntriesOf,
  parseProtocol,
  resolveSource,
  serializeProtocol,
  type Protocol,
  type ProtocolReason,
} from "./protocol";
import { linkRun, referencedSources, reportLinks, type LibraryDocument, type LibraryIds, type LinkWorld, type ReportedLinks, type RunDocument } from "./relink";
import type { LinkEntry } from "./link-map";
import { isLibraryPack } from "./link-map";
import type { CatalogEntry } from "./catalog";
import type { Json, LinkReference } from "./rewrite-links";
import { chooseTarget, readStoredVersion, RULES_VERSIONS, type RulesVersion } from "./rules-version";
import { spellListPagesOf, updateSpellLists, type SettingStore } from "./spell-lists";
import { DEFAULT_MAX_CLOSURE_DOCUMENTS, MAX_DOCUMENTS_PER_PORTION, portionsOf, summarizePlan, type PlanSummary } from "./closure";
import { deriveMarker, markerChange, readMarker } from "./subspecies";
import { looseKey, parsePrimary } from "./uuid";

// Copying one document from a compendium that is not an Eagle Compendium into the Eagle Compendium of its kind and version
// (rules R10 to R12 of the convention), and forcing a copy although the entry is there already. The Library reads the world directly and decides everything that has to do with its rules:
// the kind, the version, the compendium, whether the document is there already, what a container brings with it. Flight
// Control only copies the documents it is given (`compendium.import`, API 0.9.0). Nothing here touches Foundry: the world and
// Flight Control are handed in (v13/copy.ts and v13/module.ts provide them).

// The deepest a container may be nested; dnd5e stops at the same depth (PhysicalItemTemplate.MAX_DEPTH).
export const MAX_CONTAINER_DEPTH = 5;
// What one request of Flight Control takes (the container and everything in it).
export const MAX_DOCUMENTS_PER_COPY = 100;

// A document as the Library reads it.
export interface CopySource {
  readonly uuid: string;
  readonly id: string;
  readonly name: string;
  readonly documentName: string;
  // The document subtype (`type`) of an Item or Actor.
  readonly subtype?: string;
  // What `_source.system.source.rules` holds, whatever it is; the world setting is never read (R4).
  readonly rules?: unknown;
  // What `_source.system.requirements` holds, whatever it is (part of the key of an entry, R5).
  readonly requirements?: unknown;
  // The id of the container the source is in (`_source.system.container`), if it is in one.
  readonly container?: string | null;
  // A primary document, not one inside another.
  readonly primary: boolean;
  // The compendium the document is in; undefined for a document of the world.
  readonly pack?: { readonly collection: string; readonly packageType: string; readonly name: string; readonly type: string };
}

export interface IndexEntry {
  readonly id: string;
  readonly name: string;
  // What the index holds for `system.requirements`, whatever it is.
  readonly requirements?: unknown;
}

export interface ContainedEntry {
  readonly id: string;
  readonly uuid: string;
  // The id of the container the Item is in, or null.
  readonly container: string | null;
}

// What the Library needs to read from the world. Every call may throw.
export interface CopyWorld extends LinkWorld {
  // The document of a UUID; undefined when there is none.
  readDocument(uuid: string): Promise<CopySource | undefined>;
  // The entries of the world compendium of the catalog; undefined when the compendium does not exist (or has another type).
  eagleIndex(compendium: ExpectedCompendium): Promise<readonly IndexEntry[] | undefined>;
  // All Items of a compendium that are in a container, with the id of the container.
  contained(collection: string): Promise<readonly ContainedEntry[]>;
}

// Where the protocol lives (v13/protocol.ts): the text of the setting, and writing it through Flight Control.
export interface ProtocolStore {
  read(): string;
  // Writes `value` if the setting still holds `previous`; says why not otherwise.
  write(previous: string, value: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly detail: string }>;
}

// The most paths one entry of `compendium.import` takes (API 0.11.0 of Flight Control).
export const MAX_CHANGES_PER_ENTRY = 50;

export interface CopyDeps {
  readonly world: CopyWorld;
  readonly protocol: ProtocolStore;
  // The setting that holds the pages of the spell lists (v13/spell-lists.ts).
  readonly spellLists: SettingStore;
  // A new document id (16 letters and digits).
  readonly newId: () => string;
  // The id of the user and the time, for the protocol.
  readonly user: () => string;
  readonly now: () => string;
  // Flight Control's API; undefined when Flight Control is missing or not active.
  readonly api: RequestApi | undefined;
  readonly isGm: () => boolean;
  readonly log: SetupLog;
}

export type CopyFailureReason =
  | "not-gm"
  | "no-flight-control"
  | "source-not-found"
  | "source-not-supported"
  | "no-art"
  | "read-failed"
  | "already-copied"
  | "duplicate"
  | "no-target"
  | "container-too-deep"
  | "too-many"
  | "version-required"
  | "closure-too-large"
  | "request-failed"
  | "unknown-outcome";

// What was done with the protocol, when the copy touched it.
export interface ProtocolOutcome {
  readonly written: boolean;
  readonly detail?: string;
}

export interface CopyOptions {
  // Copy although the entry is there already (a duplicate): the copy is named "X (Duplicate)" and gets a new id.
  readonly force?: boolean;
  // The version a forced copy goes to (the choice of the Gamemaster); without it the stored version of the source.
  readonly version?: RulesVersion;
  // Copy the documents that the document links to as well (rule R17); `false` copies only the document (and a container's
  // contents). Default: true.
  readonly closure?: boolean;
  // The most documents a copy with its dependencies may have; over it nothing is written. Default: 5,000.
  readonly maxDocuments?: number;
}

// What was left out of a copy with its dependencies.
export interface SkippedDocument {
  readonly source: string;
  readonly reason: CopyFailureReason | "package-missing" | "target-missing";
  readonly detail: string;
}

// The plan of a copy: what would be written, without writing anything.
export interface ClosureReport extends PlanSummary {
  // The documents that are dependencies of the first one.
  readonly dependencies: number;
  // How many were left out, and the first 50 of them.
  readonly skipped: { readonly total: number; readonly listed: readonly SkippedDocument[] };
}

export interface CopiedDocument {
  readonly source: string;
  readonly uuid: string;
  readonly id: string;
  readonly name: string;
}

export type CopyResult =
  | {
      readonly ok: true;
      // The collection id of the Eagle Compendium the documents went to, and its name.
      readonly pack: string;
      readonly target: string;
      readonly created: readonly CopiedDocument[];
      readonly existed: readonly CopiedDocument[];
      // True for a forced copy.
      readonly forced?: boolean;
      readonly protocol?: ProtocolOutcome;
      // What became of every link of the documents of this copy (rule R14), and what the map of the run had to say.
      readonly links: ReportedLinks;
      readonly map: { readonly size: number; readonly conflicts: number; readonly invalid: number };
      // For journals with spell lists: whether the pages were entered in the setting.
      readonly spellLists?: ProtocolOutcome;
      // The copy with its dependencies: how many documents, in how many portions, and what was left out.
      readonly closure: ClosureReport;
    }
  | {
      readonly ok: false;
      readonly reason: CopyFailureReason;
      readonly detail: string;
      // The failure code of Flight Control, for `request-failed` and `unknown-outcome`.
      readonly code?: string;
      // What was done with the protocol, for the reasons that are protocolled.
      readonly protocol?: ProtocolOutcome;
      // For a copy with its dependencies that stopped: what is written already and what is left (asking again continues).
      readonly closure?: { readonly documents: number; readonly written: number; readonly remaining: number };
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// The Items in a container, and in the containers within it, as UUIDs in the order of the search. The search stops at the
// depth of dnd5e; an Item that is in the container after that depth makes the copy fail rather than be cut short. An id is
// visited once, so a container that contains itself ends.
function contentsOf(rootId: string, entries: readonly ContainedEntry[]): { contents: ContainedEntry[] } | { tooDeep: true } {
  const byContainer = new Map<string, ContainedEntry[]>();
  for (const entry of entries) {
    if (entry.container === null) continue;
    const list = byContainer.get(entry.container);
    if (list) list.push(entry);
    else byContainer.set(entry.container, [entry]);
  }
  const seen = new Set<string>([rootId]);
  const contents: ContainedEntry[] = [];
  let level = [rootId];
  for (let depth = 1; level.length > 0; depth++) {
    const next: string[] = [];
    for (const containerId of level) {
      for (const entry of byContainer.get(containerId) ?? []) {
        if (seen.has(entry.id)) continue;
        if (depth > MAX_CONTAINER_DEPTH) return { tooDeep: true };
        seen.add(entry.id);
        contents.push(entry);
        next.push(entry.id);
      }
    }
    level = next;
  }
  return { contents };
}

function readCopied(value: unknown): CopiedDocument[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: CopiedDocument[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const { source, uuid, id, name } = item;
    if (typeof source !== "string" || typeof uuid !== "string" || typeof id !== "string" || typeof name !== "string") return undefined;
    out.push({ source, uuid, id, name });
  }
  return out;
}

// Updates the protocol: reads it, changes it, writes it if it changed. A second try reads again (another client may have been
// faster). An unreadable text is replaced, and the log says so; it is not thrown away without a word.
async function updateProtocol(deps: CopyDeps, change: (protocol: Protocol) => Protocol): Promise<ProtocolOutcome> {
  let detail = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const text = deps.protocol.read();
    const parsed = parseProtocol(text);
    if (!parsed.ok && attempt === 1) {
      deps.log.warn(`${LIBRARY_ID} | the protocol is replaced by a new one: ${parsed.detail} (it began: ${text.slice(0, 80)})`);
    }
    const next = change(parsed.ok ? parsed.protocol : EMPTY_PROTOCOL);
    const value = serializeProtocol(next);
    if (value === text) return { written: true };
    try {
      const written = await deps.protocol.write(text, value);
      if (written.ok) return { written: true };
      detail = written.detail;
    } catch (error) {
      detail = messageOf(error);
    }
  }
  deps.log.warn(`${LIBRARY_ID} | the protocol could not be written: ${detail}`);
  return { written: false, detail };
}

// What a decision says about where a refusal is protocolled.
interface Where {
  readonly kind: string | null;
  readonly version: string | null;
  readonly target: string | null;
  readonly existing: readonly string[];
}

// The decision for one document: copy it (where, with what), or leave it out (why; for a duplicate the entry that carries the key).
type Decision =
  | {
      readonly kind: "copy";
      readonly source: CopySource;
      readonly art: CatalogEntry;
      readonly target: ExpectedCompendium;
      readonly forced: boolean;
      readonly contents: ContainedEntry[];
    }
  | {
      readonly kind: "skip";
      readonly reason: CopyFailureReason;
      readonly detail: string;
      readonly protocolReason?: ProtocolReason;
      readonly where?: Where;
      readonly source?: CopySource;
      // For a duplicate: the entry that carries the key (the first of them).
      readonly existing?: string;
    };

// What a run of copying knows: the indexes of the Eagle Compendia (read once; documents the run plans are added, so a later
// document with the same key is a duplicate of the earlier one) and what the world says, read once for each question.
interface Run {
  readonly deps: CopyDeps;
  readonly world: CopyWorld;
  readonly indexes: Map<string, IndexEntry[] | undefined>;
  readonly loaded: Set<string>;
}

// A world that remembers its answers for the length of one run.
function cachedWorld(world: CopyWorld): CopyWorld {
  let ids: Promise<Awaited<ReturnType<CopyWorld["libraryIds"]>>> | undefined;
  const targets = new Map<string, ReturnType<CopyWorld["describeTarget"]>>();
  const containers = new Map<string, ReturnType<CopyWorld["contained"]>>();
  return {
    ...world,
    readDocument: (uuid) => world.readDocument(uuid),
    eagleIndex: (compendium) => world.eagleIndex(compendium),
    readData: (uuid) => world.readData(uuid),
    libraryIds: () => (ids ??= world.libraryIds()),
    describeTarget: (scope, pack, id) => {
      const key = `${scope}.${pack}.${id}`;
      let held = targets.get(key);
      if (!held) targets.set(key, (held = world.describeTarget(scope, pack, id)));
      return held;
    },
    contained: (collection) => {
      let held = containers.get(collection);
      if (!held) containers.set(collection, (held = world.contained(collection)));
      return held;
    },
  };
}

async function loadIndexes(run: Run, compendia: readonly ExpectedCompendium[]): Promise<void> {
  for (const compendium of compendia) {
    if (run.loaded.has(compendium.name)) continue;
    const entries = await run.world.eagleIndex(compendium);
    run.indexes.set(compendium.name, entries === undefined ? undefined : [...entries]);
    run.loaded.add(compendium.name);
  }
}

// Decides for one document (steps 2 to 8 of the rules R10 to R12): the kind, the version, whether it is there already, whether its
// key is there (a duplicate), the target and, for a container, what comes with it. Reads the world; writes nothing.
async function decide(run: Run, uuid: string, options: { force: boolean; version?: RulesVersion; root: boolean }): Promise<Decision> {
  const { world } = run;
  const skip = (reason: CopyFailureReason, detail: string, more: Partial<Extract<Decision, { kind: "skip" }>> = {}): Decision => ({ kind: "skip", reason, detail, ...more });

  let source: CopySource | undefined;
  try {
    source = await world.readDocument(uuid);
  } catch (error) {
    return skip("source-not-found", `the source could not be read: ${messageOf(error)}`);
  }
  if (!source) return skip("source-not-found", "there is no document with this UUID");
  if (!source.primary) return skip("source-not-supported", "the source lives inside another document; only a primary document is copied");
  if (!source.pack) return skip("source-not-supported", "the source is a document of the world; only a document of a compendium is copied");
  if (recognizeCompendium({ packageType: source.pack.packageType, name: source.pack.name, type: source.pack.type })) {
    return skip("source-not-supported", `the source is in an Eagle Compendium (${source.pack.collection}) already`);
  }

  const kind = artForDocument(source.documentName, source.subtype);
  if (!kind) {
    return skip("no-art", `no kind for ${source.documentName}${source.subtype ? ` of the subtype ${source.subtype}` : ""}; it is not copied`, {
      source,
      protocolReason: "no-art",
      where: { kind: null, version: null, target: null, existing: [] },
    });
  }
  const state = readStoredVersion(kind, source.rules);
  const compendia = compendiaOf(kind);
  try {
    await loadIndexes(run, compendia);
  } catch (error) {
    return skip("read-failed", `an Eagle Compendium could not be read: ${messageOf(error)}`);
  }
  for (const compendium of compendia) {
    if (run.indexes.get(compendium.name)?.some((entry) => entry.id === source.id)) {
      return skip("already-copied", `the document is in ${compendium.name} already (same id)`, { source });
    }
  }

  const key = entryKey(source.name, source.requirements);
  const compendiumOf = (version: RulesVersion | undefined) => compendia.find((compendium) => compendium.version === version);
  const carriers = (version: RulesVersion | undefined) =>
    (run.indexes.get(compendiumOf(version)!.name) ?? []).filter((entry) => sameEntry(entryKey(entry.name, entry.requirements), key));
  const placement = chooseTarget(state, (version) => carriers(version).length > 0);
  const uuidOfEntry = (compendium: ExpectedCompendium, entry: IndexEntry) => `Compendium.world.${compendium.name}.${compendium.documentName}.${entry.id}`;

  let target: ExpectedCompendium | undefined;
  let forced = false;
  if (placement.outcome === "duplicate") {
    const versions: (RulesVersion | undefined)[] = placement.versions.length > 0 ? [...placement.versions] : [undefined];
    const existing = versions.flatMap((version) => carriers(version).map((entry) => uuidOfEntry(compendiumOf(version)!, entry)));
    const where = versions.map((version) => compendiumOf(version)?.name).join(", ");
    if (!(options.root && options.force)) {
      return skip("duplicate", `the name "${source.name}" is in ${where} already`, {
        source,
        protocolReason: "duplicate",
        where: { kind: kind.key, version: state.kind === "stored" ? state.version : null, target: compendiumOf(versions[0])?.name ?? null, existing },
        ...(existing[0] ? { existing: existing[0] } : {}),
      });
    }
    let version: RulesVersion | undefined;
    if (kind.versioned) {
      version = options.version ?? (state.kind === "stored" ? state.version : undefined);
      if (!version) return skip("version-required", "the version of a forced copy must be given: 2014 or 2024");
    }
    target = compendiumOf(version);
    forced = true;
  } else {
    target = compendiumOf(placement.version);
  }
  if (!target || run.indexes.get(target.name) === undefined) {
    return skip("no-target", `the Eagle Compendium ${target?.name ?? "of this kind"} does not exist in this world; create the compendia first`, { source });
  }

  let contents: ContainedEntry[] = [];
  if (kind.key === "containers") {
    let found: { contents: ContainedEntry[] } | { tooDeep: true };
    try {
      found = contentsOf(source.id, await world.contained(source.pack.collection));
    } catch (error) {
      return skip("read-failed", `the contents of the container could not be read: ${messageOf(error)}`);
    }
    const where: Where = { kind: kind.key, version: target.version ?? null, target: target.name, existing: [] };
    if ("tooDeep" in found) {
      return skip("container-too-deep", `the container holds Items nested deeper than ${MAX_CONTAINER_DEPTH} levels`, { source, protocolReason: "container-too-deep", where });
    }
    contents = found.contents;
    if (contents.length + 1 > MAX_DOCUMENTS_PER_COPY) {
      return skip("too-many", `the container and its contents are ${contents.length + 1} documents; one copy takes at most ${MAX_DOCUMENTS_PER_COPY}`, { source, protocolReason: "too-many", where });
    }
  }
  return { kind: "copy", source, art: kind, target, forced, contents };
}

// A document of the plan.
interface Planned extends RunDocument {
  readonly target: string;
  readonly unit: number;
  readonly targetEntry: ExpectedCompendium;
  readonly art: CatalogEntry;
  readonly id: string;
  readonly name?: string;
  // What `system.container` becomes: null, or the id of the new container (undefined: leave it).
  readonly container?: string | null;
  readonly forced: boolean;
  readonly dependency: boolean;
}

interface Prepared {
  readonly run: Run;
  readonly plan: Planned[];
  readonly skipped: SkippedDocument[];
  // The entries of the protocol to add: what the rules or limits refused (the first document and its dependencies).
  readonly refusals: Array<{ reason: ProtocolReason; source: CopySource; where: Where }>;
  // What stands for a document that was left out as a duplicate: its source and the entry that carries the key.
  readonly standIns: LinkEntry[];
  readonly root: Extract<Decision, { kind: "copy" }>;
}

// Steps 1 to 8 for the document and, unless `options.closure` is false, for everything it links to (rule R17): the plan of the
// copy. Nothing is written. Fails with the result of the first document when it cannot be copied.
// What several successive calls of `prepare` (milestone M9, `core/bulk.ts`) share, so that a later call sees what an earlier one
// planned (nothing is written; a virtual state only): the same index of every Eagle Compendium touched so far (the same map, so
// a later call's "already planned" and "duplicate" checks see it automatically, exactly as within one call) and the same map of
// ids the Library already holds (fed by the caller with every id the earlier calls have planned, seeded once from `libraryIds`).
export interface SharedPrepareState {
  readonly indexes: Map<string, IndexEntry[] | undefined>;
  readonly loaded: Set<string>;
  readonly ids: Map<string, LibraryDocument>;
}

export async function prepare(
  deps: CopyDeps,
  uuid: string,
  options: CopyOptions,
  shared?: SharedPrepareState,
): Promise<{ ok: true; prepared: Prepared } | { ok: false; result: CopyResult; refusal?: { reason: ProtocolReason; source: CopySource; where: Where } }> {
  const fail = (reason: CopyFailureReason, detail: string, more: { code?: string; protocol?: ProtocolOutcome; closure?: { documents: number; written: number; remaining: number } } = {}): { ok: false; result: CopyResult } => {
    deps.log.warn(`${LIBRARY_ID} | copy ${uuid}: not copied (${reason}): ${detail}`);
    return { ok: false, result: { ok: false, reason, detail, ...(more.code === undefined ? {} : { code: more.code }), ...(more.protocol ? { protocol: more.protocol } : {}), ...(more.closure ? { closure: more.closure } : {}) } };
  };
  const world = cachedWorld(deps.world);
  const run: Run = { deps, world, indexes: shared?.indexes ?? new Map(), loaded: shared?.loaded ?? new Set() };
  const force = options.force === true;

  const rootDecision = await decide(run, uuid, { force, ...(options.version ? { version: options.version } : {}), root: true });
  if (rootDecision.kind === "skip") {
    if (rootDecision.protocolReason && rootDecision.source && rootDecision.where) {
      return { ...fail(rootDecision.reason, rootDecision.detail), refusal: { reason: rootDecision.protocolReason, source: rootDecision.source, where: rootDecision.where } };
    }
    return fail(rootDecision.reason, rootDecision.detail);
  }

  const max = options.maxDocuments ?? DEFAULT_MAX_CLOSURE_DOCUMENTS;
  const plan: Planned[] = [];
  const skipped: SkippedDocument[] = [];
  const refusals: Prepared["refusals"] = [];
  const standIns: LinkEntry[] = [];
  const seen = new Set<string>();
  const markSeen = (parsed: { scope: string; pack: string; id: string } | undefined) => {
    if (parsed) seen.add(looseKey(parsed));
  };
  // The data still to be searched for links: what is in the plan and what the Library has from an earlier run.
  const queue: Json[] = [];
  let unit = 0;

  // Puts a document (and its contents) in the plan, with its data, and makes it visible to the duplicate check of later documents.
  const addUnit = async (decision: Extract<Decision, { kind: "copy" }>, dependency: boolean): Promise<string | undefined> => {
    const { source, target, contents, forced } = decision;
    const takenIds = new Set((run.indexes.get(target.name) ?? []).map((entry) => entry.id));
    const freshId = () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const id = deps.newId();
        if (!takenIds.has(id)) return id;
      }
      return deps.newId();
    };
    const ids = new Map<string, string>([[source.id, forced ? freshId() : source.id]]);
    for (const entry of contents) ids.set(entry.id, forced ? freshId() : entry.id);
    const name = forced ? duplicateName(source.name, new Set((run.indexes.get(target.name) ?? []).map((entry) => nameKey(entry.name)))) : undefined;
    const thisUnit = unit++;
    const docs: { uuid: string; id: string; name?: string; container?: string | null }[] = [
      { uuid: source.uuid, id: ids.get(source.id)!, ...(name !== undefined ? { name } : {}), ...(source.container ? { container: null } : {}) },
      ...contents.map((entry) => ({ uuid: entry.uuid, id: ids.get(entry.id)!, container: (forced ? ids.get(entry.container ?? "") : undefined) ?? undefined })),
    ];
    // Read all data before anything is planned, so that a unit is in the plan whole or not at all.
    const read: Json[] = [];
    for (const doc of docs) {
      const data = await world.readData(doc.uuid);
      if (data === undefined) return `the data of ${doc.uuid} could not be read`;
      read.push(data);
    }
    docs.forEach((doc, index) => {
      const content = index > 0;
      const entry = content ? contents[index - 1]! : undefined;
      plan.push({
        source: doc.uuid,
        copy: `Compendium.world.${target.name}.${target.documentName}.${doc.id}`,
        data: read[index]!,
        target: target.name,
        unit: thisUnit,
        targetEntry: target,
        art: decision.art,
        id: doc.id,
        ...(doc.name !== undefined ? { name: doc.name } : {}),
        ...(content ? (forced ? { container: ids.get(entry!.container ?? "") ?? null } : {}) : doc.container !== undefined ? { container: doc.container } : {}),
        forced,
        dependency,
      });
      markSeen(parsePrimary(doc.uuid));
      queue.push(read[index]!);
    });
    (run.indexes.get(target.name) ?? []).push({ id: ids.get(source.id)!, name: name ?? source.name, requirements: source.requirements });
    return undefined;
  };

  markSeen(parsePrimary(rootDecision.source.uuid));
  const rootProblem = await addUnit(rootDecision, false);
  if (rootProblem) return fail("read-failed", rootProblem);

  if (options.closure !== false) {
    let ids: Awaited<ReturnType<CopyWorld["libraryIds"]>> | undefined = shared?.ids;
    let cursor = 0;
    // What is in the Library already is searched too, through its source, so that a run that was stopped is finished by asking again
    // (the links of such a document were written when the first run planned them; what they point at may not be written yet).
    const searchSource = async (typed: string): Promise<void> => {
      try {
        const data = await world.readData(typed);
        if (data !== undefined) queue.push(data);
      } catch {
        // A source that cannot be read is not searched.
      }
    };
    try {
      while (cursor < queue.length) {
        const data = queue[cursor++]!;
        for (const ref of referencedSources([data])) {
          if (seen.has(looseKey(ref))) continue;
          seen.add(looseKey(ref));
          // Already in the Library (the same id and document type): not a dependency, the links go to it.
          ids ??= await world.libraryIds();
          const held = ids.get(ref.id);
          if (held && (!ref.documentName || held.documentName === ref.documentName)) {
            await searchSource(`Compendium.${ref.scope}.${ref.pack}.${held.documentName}.${ref.id}`);
            continue;
          }
          const info = await world.describeTarget(ref.scope, ref.pack, ref.id);
          const label = `Compendium.${ref.scope}.${ref.pack}.${ref.documentName ?? "?"}.${ref.id}`;
          if (!info || !info.installed) {
            skipped.push({ source: label, reason: "package-missing", detail: "the package or compendium of the target is not installed" });
            continue;
          }
          if (info.exists === false) {
            skipped.push({ source: label, reason: "target-missing", detail: "the compendium has no document with this id" });
            continue;
          }
          if (info.noArt === true) {
            skipped.push({ source: label, reason: "no-art", detail: "the Library has no place for this kind of document" });
            continue;
          }
          const documentName = info.documentName ?? ref.documentName;
          if (!documentName) {
            skipped.push({ source: label, reason: "source-not-found", detail: "the document type of the target is not known" });
            continue;
          }
          const typed = `Compendium.${ref.scope}.${ref.pack}.${documentName}.${ref.id}`;
          const decision = await decide(run, typed, { force: false, root: false });
          if (decision.kind === "skip") {
            if (decision.reason !== "already-copied") skipped.push({ source: typed, reason: decision.reason, detail: decision.detail });
            if (decision.reason === "duplicate" && decision.existing) standIns.push({ source: typed, copy: decision.existing, how: "existing" });
            // A rule or a limit refused it: it goes to the protocol (a document without a kind is only reported).
            if (decision.protocolReason && decision.protocolReason !== "no-art" && decision.source && decision.where) {
              refusals.push({ reason: decision.protocolReason, source: decision.source, where: decision.where });
            }
            continue;
          }
          const problem = await addUnit(decision, true);
          if (problem) {
            skipped.push({ source: typed, reason: "read-failed", detail: problem });
            continue;
          }
          if (plan.length > max) {
            return fail("closure-too-large", `the copy and its dependencies are more than ${max} documents (${plan.length} so far); nothing was written. Give a higher limit with { maxDocuments } or copy without the dependencies with { closure: false }`);
          }
        }
      }
    } catch (error) {
      return fail("read-failed", `the dependencies could not be found: ${messageOf(error)}`);
    }
  }
  return { ok: true, prepared: { run, plan, skipped, refusals, standIns, root: rootDecision } };
}

export const reportOf = (prepared: Prepared): ClosureReport => ({
  ...summarizePlan(prepared.plan.map((doc) => ({ source: doc.source, target: doc.target, unit: doc.unit }))),
  dependencies: prepared.plan.filter((doc) => doc.dependency).length,
  skipped: { total: prepared.skipped.length, listed: prepared.skipped.slice(0, MAX_LISTED_SKIPPED) },
});

const MAX_LISTED_SKIPPED = 50;

// What a copy with its dependencies would do, without writing anything (the Gamemaster's dry run).
export type PlanResult = { readonly ok: true; readonly plan: ClosureReport; readonly root: { readonly source: string; readonly target: string } } | Extract<CopyResult, { ok: false }>;

export async function planCopy(deps: CopyDeps, uuid: string, options: CopyOptions = {}): Promise<PlanResult> {
  if (!deps.isGm()) return { ok: false, reason: "not-gm", detail: "only a Gamemaster or Assistant may copy documents" };
  if (typeof uuid !== "string" || uuid === "") return { ok: false, reason: "source-not-found", detail: "the UUID of the source must be a non-empty string" };
  const prepared = await prepare(deps, uuid, options);
  if (!prepared.ok) return prepared.result as Extract<CopyResult, { ok: false }>;
  return { ok: true, plan: reportOf(prepared.prepared), root: { source: prepared.prepared.plan[0]!.source, target: prepared.prepared.plan[0]!.target } };
}

// Copies one document with everything it links to (rule R17), and a container with its contents, into the Eagle Compendia that
// fit. Everything is decided before anything is written; every failure before the first request means nothing was asked for, and
// every result says why. What the rules or limits of the Library refuse goes to the protocol. With `force`, a duplicate is copied
// anyway under the name "X (Duplicate)" and a new id (the first document only). The documents are written in portions of at most
// 100 to one compendium each, every document once, with its links rewritten; a failure stops the run and asking again continues.
// It never throws.
export async function copyDocument(deps: CopyDeps, uuid: string, options: CopyOptions = {}): Promise<CopyResult> {
  const { api, log } = deps;
  const fail = (reason: CopyFailureReason, detail: string, more: { code?: string; protocol?: ProtocolOutcome; closure?: { documents: number; written: number; remaining: number } } = {}): CopyResult => {
    log.warn(`${LIBRARY_ID} | copy ${uuid}: not copied (${reason}): ${detail}`);
    return { ok: false, reason, detail, ...(more.code === undefined ? {} : { code: more.code }), ...(more.protocol ? { protocol: more.protocol } : {}), ...(more.closure ? { closure: more.closure } : {}) };
  };

  if (!deps.isGm()) return fail("not-gm", "only a Gamemaster or Assistant may copy documents");
  if (!api) return fail("no-flight-control", "Eagle Flight Control is missing or not active");
  if (typeof uuid !== "string" || uuid === "") return fail("source-not-found", "the UUID of the source must be a non-empty string");
  if (options.version !== undefined && !(RULES_VERSIONS as readonly unknown[]).includes(options.version)) {
    return fail("version-required", `the version must be one of ${RULES_VERSIONS.join(", ")}`);
  }

  const prepared = await prepare(deps, uuid, options);
  if (!prepared.ok) {
    // What the rules or limits of the Library refuse for the first document goes to the protocol.
    const refusal = prepared.refusal;
    if (refusal) {
      const entry = { at: deps.now(), by: deps.user(), reason: refusal.reason, source: refusal.source.uuid, name: refusal.source.name, ...refusal.where };
      const protocol = await updateProtocol(deps, (held) => addEntry(held, entry));
      const result = prepared.result as Extract<CopyResult, { ok: false }>;
      return { ...result, protocol };
    }
    return prepared.result;
  }
  const { run, plan, skipped, refusals, standIns } = prepared.prepared;
  const world = run.world;
  const root = plan[0]!;
  const forced = root.forced;
  const protocolHeld = parseProtocol(deps.protocol.read());
  const protocolEntries = protocolHeld.ok ? protocolHeld.protocol.entries : [];

  // Pass 1: the map of the whole run stands before anything is written. Pass 2 writes the documents in portions.
  const allPlanned: LinkEntry[] = [
    ...plan.map((doc) => ({ source: doc.source, copy: doc.copy, how: "planned" as const })),
    ...standIns,
  ];
  // The portion with the first document is written last: as long as it is not there, asking again does the whole run (R17).
  const cut = portionsOf(plan);
  const rootAt = cut.findIndex((portion) => portion.includes(root));
  const portions = [...cut.slice(0, rootAt), ...cut.slice(rootAt + 1), cut[rootAt]!];
  const total = plan.length;
  const created: CopiedDocument[] = [];
  const existed: CopiedDocument[] = [];
  const references: LinkReference[] = [];
  let mapInfo = { size: 0, conflicts: 0, invalid: 0 };
  let written = 0;
  const progressOf = () => (portions.length > 1 ? { closure: { documents: total, written, remaining: total - written } } : {});

  for (let index = 0; index < portions.length; index++) {
    const portion = portions[index]!;
    const target = portion[0]!.targetEntry;
    const pack = `world.${target.name}`;
    const inPortion = new Set(portion.map((doc) => doc.source));
    const also = allPlanned.filter((entry) => !inPortion.has(entry.source));
    let run2: Awaited<ReturnType<typeof linkRun>>;
    try {
      run2 = await linkRun(world, portion, protocolEntries, MAX_CHANGES_PER_ENTRY - 2, also);
    } catch (error) {
      return fail("read-failed", `the links of the documents could not be prepared: ${messageOf(error)}`, progressOf());
    }
    mapInfo = { size: mapInfo.size + run2.map.size, conflicts: mapInfo.conflicts + run2.map.conflicts, invalid: mapInfo.invalid + run2.map.invalid };
    references.push(...run2.references);
    const sources: (string | Record<string, unknown>)[] = portion.map((doc, i) => {
      // The links first, then the container field and the marker, so that a field inside a rewritten field is set last.
      const changes: Record<string, unknown> = { ...run2.changes[i] };
      if (doc.container !== undefined) changes["system.container"] = doc.container;
      if (doc.art.key === "species") {
        const marker = readMarker(doc.data) ? undefined : deriveMarker(doc.data);
        if (marker) Object.assign(changes, markerChange(marker));
      }
      const changed = Object.keys(changes).length > 0;
      if (!doc.forced && !changed) return doc.source;
      return {
        source: doc.source,
        ...(doc.forced ? { id: doc.id } : {}),
        ...(doc.name !== undefined ? { name: doc.name } : {}),
        ...(changed ? { changes } : {}),
      };
    });
    if (portions.length > 1 || total > 1) {
      log.info(`${LIBRARY_ID} | closure of ${uuid}: portion ${index + 1} of ${portions.length} (${target.name}, ${portion.length} documents)`);
    }
    let answer: unknown;
    try {
      answer = await api.request({ module: LIBRARY_ID, type: "compendium.import", version: 1, payload: { pack, sources } });
    } catch (error) {
      return fail("request-failed", `Flight Control threw: ${messageOf(error)}`, progressOf());
    }
    const stopped = portions.length > 1 ? { closure: { documents: total, written, remaining: total - written } } : {};
    if (!isRecord(answer)) return fail("request-failed", "Flight Control did not answer with an object", { code: "invalid-response", ...stopped });
    if (answer.ok === false) {
      const code = typeof answer.reason === "string" ? answer.reason : "invalid-response";
      const detail = typeof answer.detail === "string" ? answer.detail : "no detail";
      if (code === "relay-timeout") return fail("unknown-outcome", `${detail}. Whether the copy was made is not known; asking again is safe`, { code, ...stopped });
      return fail("request-failed", `${code}: ${detail}`, { code, ...stopped });
    }
    const value = answer.value;
    const made = isRecord(value) ? readCopied(value.created) : undefined;
    const there = isRecord(value) ? readCopied(value.existed) : undefined;
    if (answer.ok !== true || !isRecord(value) || value.pack !== pack || !made || !there) {
      return fail("request-failed", "Flight Control answered with an unknown shape", { code: "invalid-response", ...stopped });
    }
    created.push(...made);
    existed.push(...there);
    written += portion.length;
  }

  log.info(`${LIBRARY_ID} | copy ${uuid} -> world.${root.target}: ${created.length} created, ${existed.length} existed${forced ? " (forced)" : ""}`);
  const links = reportLinks(references);
  log.info(
    `${LIBRARY_ID} | links of ${uuid}: ${links.counts.rewritten} rewritten, ${links.counts["in-library"]} in the Library, ` +
      `${links.counts["kept-source"]} of origin, ${links.total - links.counts.rewritten - links.counts["in-library"] - links.counts["kept-source"]} not in the Library`,
  );

  // The protocol, once for the whole run: what was refused is added, and the open entries of the sources that were copied are done.
  const copiedSources = new Set([...created, ...existed].map((copied) => copied.source));
  const copyOfSource = new Map([...created, ...existed].map((copied) => [copied.source, copied.uuid]));
  let holds = false;
  try {
    const parsed = parseProtocol(deps.protocol.read());
    holds = parsed.ok && [...copiedSources].some((source) => openEntriesOf(parsed.protocol, source).length > 0);
  } catch {
    holds = false;
  }
  let protocol: ProtocolOutcome | undefined;
  if (holds || refusals.length > 0) {
    protocol = await updateProtocol(deps, (held) => {
      let next = held;
      for (const refusal of refusals) {
        next = addEntry(next, { at: deps.now(), by: deps.user(), reason: refusal.reason, source: refusal.source.uuid, name: refusal.source.name, ...refusal.where });
      }
      for (const source of copiedSources) next = resolveSource(next, source, source === root.source && forced ? "forced" : "copied", copyOfSource.get(source)!);
      return next;
    });
  }

  // Journals bring their spell lists: the pages are entered once so that every client can register them with dnd5e.
  let spellLists: ProtocolOutcome | undefined;
  const pages = plan.filter((doc) => doc.art.key === "journals").flatMap((doc) => spellListPagesOf(doc.copy, doc.data));
  if (pages.length > 0) spellLists = await updateSpellLists(deps.spellLists, log, pages);

  const report = reportOf(prepared.prepared);
  if (report.dependencies > 0 || skipped.length > 0) {
    log.info(`${LIBRARY_ID} | closure of ${uuid}: ${report.documents} documents (${report.dependencies} dependencies) in ${report.portions} portions, ${skipped.length} left out`);
  }
  return {
    ok: true,
    pack: `world.${root.target}`,
    target: root.target,
    created,
    existed,
    links,
    map: mapInfo,
    closure: report,
    ...(forced ? { forced: true } : {}),
    ...(protocol ? { protocol } : {}),
    ...(spellLists ? { spellLists } : {}),
  };
}
