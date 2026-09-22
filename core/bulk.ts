import { artForDocument } from "./catalog";
import { LIBRARY_ID } from "./index";
import type { LibraryDocument } from "./relink";
import { copyDocument, planCopy, prepare, reportOf, type CopyDeps, type CopyOptions, type CopyResult, type CopyWorld, type IndexEntry, type PlanResult } from "./copy";
import { formatPrimary } from "./uuid";

// Copying or planning many documents of one or more compendia at once (milestone M9, rule R17 unchanged): every eligible
// document of the chosen compendia is copied on its own, with its own closure, exactly as `copyDocument` already does for one
// document. Nothing new is written by Flight Control; no new request type. Pure orchestration over the existing, repeatable
// operation (M5/M8): a stopped or partial run finishes by asking again with the same selection.

// A compendium the Library does not own, as far as a bulk copy needs to read it.
export interface CompendiumIndexEntry {
  readonly id: string;
  readonly name: string;
  // The document subtype (`type`), as the index gives it; undefined for kinds without one (journals, roll tables).
  readonly subtype?: string;
}

export interface CompendiumIndex {
  readonly documentName: string;
  readonly entries: readonly CompendiumIndexEntry[];
}

// What a bulk copy needs from the world beyond `CopyWorld`: reading a compendium the Library does not own (any compendium
// the world has, to find its documents), and finding every compendium of the world that is not an Eagle Compendium.
export interface BulkWorld extends CopyWorld {
  // The index of the compendium named by its collection id (`<package>.<name>`); undefined if there is no such compendium.
  readCompendiumIndex(collection: string): Promise<CompendiumIndex | undefined>;
  // Every compendium of the world that is not an Eagle Compendium (system, module or world, alike). `label` is the name
  // Foundry shows for it (a Gamemaster may have renamed it; the collection id, not the label, is what everything else
  // here keys on).
  listNonEaglePacks(): Promise<readonly { readonly collection: string; readonly documentName: string; readonly label: string }[]>;
}

export interface BulkDeps extends CopyDeps {
  readonly world: BulkWorld;
}

// Which compendia a bulk operation covers: every non-Eagle compendium of the world, one compendium, or a list of them.
export type BulkSelection = "all" | string | readonly string[];

export interface SelectionError {
  readonly collection: string;
  readonly detail: string;
}

// One step of a bulk run, for a caller that wants to show it (milestone M11): the candidate just finished, its place in
// the whole run and what became of it (the same text `log.info` already gets, split into fields instead of one string).
export interface BulkProgressInfo {
  readonly index: number;
  readonly total: number;
  readonly name: string;
  readonly outcome: string;
}

// Additive: a caller may watch a run (`onProgress`, called once per candidate, in addition to `log.info`, never instead of
// it) and stop it early (`signal`, the standard `AbortController`/`AbortSignal`, checked before every candidate). Neither
// changes a call that does not pass them.
export interface BulkProgressOptions {
  readonly onProgress?: (info: BulkProgressInfo) => void;
  readonly signal?: AbortSignal;
}

const MAX_LISTED_FAILURES = 50;
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;

function collectionsOf(world: BulkWorld, selection: BulkSelection): Promise<readonly string[]> | readonly string[] {
  if (selection === "all") return world.listNonEaglePacks().then((packs) => packs.map((pack) => pack.collection));
  return typeof selection === "string" ? [selection] : selection;
}

function splitCollection(collection: string): { readonly scope: string; readonly pack: string } {
  const at = collection.indexOf(".");
  return at < 0 ? { scope: collection, pack: "" } : { scope: collection.slice(0, at), pack: collection.slice(at + 1) };
}

// A candidate root: a document of a chosen compendium that has a kind (rule R2) and is not yet excluded.
interface Candidate {
  readonly collection: string;
  readonly uuid: string;
  readonly name: string;
}

// Reads every chosen compendium once and keeps only the documents that have a kind (R2); the rest is counted as `noArt`
// without ever being read in full or offered to `copyDocument`/`prepare`.
async function candidatesOf(world: BulkWorld, selection: BulkSelection): Promise<{ candidates: readonly Candidate[]; noArt: number; selectionErrors: readonly SelectionError[] }> {
  const collections = await collectionsOf(world, selection);
  const candidates: Candidate[] = [];
  const selectionErrors: SelectionError[] = [];
  let noArt = 0;
  for (const collection of collections) {
    let index: CompendiumIndex | undefined;
    try {
      index = await world.readCompendiumIndex(collection);
    } catch (error) {
      selectionErrors.push({ collection, detail: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (!index) {
      selectionErrors.push({ collection, detail: "the compendium does not exist" });
      continue;
    }
    const { scope, pack } = splitCollection(collection);
    for (const entry of index.entries) {
      if (!artForDocument(index.documentName, entry.subtype)) {
        noArt++;
        continue;
      }
      candidates.push({ collection, name: entry.name, uuid: formatPrimary(scope, pack, index.documentName, entry.id) });
    }
  }
  return { candidates, noArt, selectionErrors };
}

export interface BulkCopyOutcome {
  readonly uuid: string;
  readonly result: Extract<CopyResult, { readonly ok: false }>;
}

// A successful copy whose document (or one of its dependencies) still has a link that does not end in an Eagle Compendium
// (milestone M11's audit report); `unresolved` counts every such link, including any past the 50 `problems` a single
// `ReportedLinks` lists.
export interface BulkLinkGap {
  readonly uuid: string;
  readonly unresolved: number;
}

export interface BulkCopyOptions extends CopyOptions, BulkProgressOptions {
  // How many failures in a row stop the whole run (a Gamemaster-facing safety valve, not a per-document limit). Default 5.
  readonly maxConsecutiveFailures?: number;
}

export interface BulkCopyResult {
  readonly total: number;
  readonly copied: number;
  readonly alreadyCopied: number;
  readonly duplicates: number;
  // Excluded before any attempt (rule R2): not counted in `total`.
  readonly noArt: number;
  readonly failed: number;
  readonly stopped: boolean;
  readonly stoppedReason?: "consecutive-failures" | "aborted";
  // The first 50 failures, with their reason and detail.
  readonly failures: readonly BulkCopyOutcome[];
  // The first 50 successful copies (root or dependency) that still link outside the Library.
  readonly linksWithGaps: readonly BulkLinkGap[];
  readonly selectionErrors: readonly SelectionError[];
}

// Copies every eligible document of the chosen compendia, one after another, each with its own closure (unchanged
// `copyDocument`). `already-copied` and `duplicate` are expected outcomes (protocolled or resumable already) and never count
// against the safety valve; anything else does. After `maxConsecutiveFailures` failures in a row, or when `options.signal`
// is already aborted before a candidate starts, the run stops; the rest of the selection is left for a later call with the
// same selection (a document already copied is found again by its id).
export async function copyCompendia(deps: BulkDeps, selection: BulkSelection, options: BulkCopyOptions = {}): Promise<BulkCopyResult> {
  const { log } = deps;
  const maxFailures = options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  const { candidates, noArt, selectionErrors } = await candidatesOf(deps.world, selection);

  let copied = 0;
  let alreadyCopied = 0;
  let duplicates = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  let stopped = false;
  let stoppedReason: "consecutive-failures" | "aborted" | undefined;
  const failures: BulkCopyOutcome[] = [];
  const linksWithGaps: BulkLinkGap[] = [];

  for (let i = 0; i < candidates.length; i++) {
    if (options.signal?.aborted) {
      stopped = true;
      stoppedReason = "aborted";
      log.warn(`${LIBRARY_ID} | bulk copy: aborted; ${candidates.length - i} document(s) not attempted`);
      break;
    }
    const candidate = candidates[i]!;
    const result = await copyDocument(deps, candidate.uuid, options);
    let outcome: string;
    if (result.ok) {
      copied++;
      consecutiveFailures = 0;
      outcome = "copied";
      const unresolved = result.links.problems.length + result.links.truncated;
      if (unresolved > 0 && linksWithGaps.length < MAX_LISTED_FAILURES) linksWithGaps.push({ uuid: candidate.uuid, unresolved });
    } else if (result.reason === "already-copied") {
      alreadyCopied++;
      consecutiveFailures = 0;
      outcome = "already-copied";
    } else if (result.reason === "duplicate") {
      duplicates++;
      consecutiveFailures = 0;
      outcome = "duplicate";
    } else {
      failed++;
      consecutiveFailures++;
      if (failures.length < MAX_LISTED_FAILURES) failures.push({ uuid: candidate.uuid, result });
      outcome = `${result.reason}: ${result.detail}`;
    }
    log.info(`${LIBRARY_ID} | bulk copy of ${candidate.collection}: root ${i + 1} of ${candidates.length} (${candidate.name}) -> ${outcome}`);
    options.onProgress?.({ index: i + 1, total: candidates.length, name: candidate.name, outcome });
    if (consecutiveFailures >= maxFailures) {
      stopped = true;
      stoppedReason = "consecutive-failures";
      log.warn(`${LIBRARY_ID} | bulk copy: stopped after ${consecutiveFailures} failures in a row; ${candidates.length - i - 1} document(s) not attempted`);
      break;
    }
  }
  log.info(
    `${LIBRARY_ID} | bulk copy: ${candidates.length} roots, ${copied} copied, ${alreadyCopied} already, ${duplicates} duplicate, ${failed} failed, ${noArt} skipped (no-art)`,
  );
  return {
    total: candidates.length,
    copied,
    alreadyCopied,
    duplicates,
    noArt,
    failed,
    stopped,
    ...(stoppedReason ? { stoppedReason } : {}),
    failures,
    linksWithGaps,
    selectionErrors,
  };
}

export interface BulkPlanOutcome {
  readonly uuid: string;
  readonly result: Extract<PlanResult, { readonly ok: false }>;
}

export interface BulkPlanResult {
  readonly total: number;
  // The documents a run would copy, without counting a dependency more than once even when several roots of the
  // selection share it (a virtual state kept only for the length of this call; nothing is written).
  readonly documents: number;
  readonly byCompendium: Readonly<Record<string, number>>;
  readonly alreadyCopied: number;
  readonly duplicates: number;
  readonly noArt: number;
  readonly failed: number;
  readonly failures: readonly BulkPlanOutcome[];
  readonly selectionErrors: readonly SelectionError[];
  // True when `options.signal` was already aborted before every candidate was planned; the totals above are then only
  // for the candidates planned so far, not the whole selection.
  readonly stopped?: boolean;
  readonly stoppedReason?: "aborted";
}

export type BulkPlanOptions = CopyOptions & BulkProgressOptions;

// The same selection as `copyCompendia`, without writing anything: an exact preview, including dependencies shared between
// several roots of the selection (counted once). Every candidate is planned with the same, growing virtual state (the plans
// and the library ids already known), so a dependency planned for one root is found as "already planned" by a later one.
// Like `copyCompendia`, `options.signal` (checked before every candidate) stops the preview early; asking again with the
// same selection plans it from the start (nothing was written, so there is nothing to resume).
export async function planCompendia(deps: BulkDeps, selection: BulkSelection, options: BulkPlanOptions = {}): Promise<BulkPlanResult> {
  const { candidates, noArt, selectionErrors } = await candidatesOf(deps.world, selection);

  const shared = { indexes: new Map<string, IndexEntry[] | undefined>(), loaded: new Set<string>(), ids: new Map<string, LibraryDocument>() };
  try {
    for (const [id, held] of await deps.world.libraryIds()) shared.ids.set(id, held);
  } catch {
    // Without a library index the plan continues; every candidate will read it itself and report the same failure.
  }

  let documents = 0;
  let alreadyCopied = 0;
  let duplicates = 0;
  let failed = 0;
  let stopped = false;
  const byCompendium: Record<string, number> = {};
  const failures: BulkPlanOutcome[] = [];

  for (let i = 0; i < candidates.length; i++) {
    if (options.signal?.aborted) {
      stopped = true;
      break;
    }
    const candidate = candidates[i]!;
    const outcome = await prepare(deps, candidate.uuid, options, shared);
    let progressOutcome: string;
    if (!outcome.ok) {
      const result = outcome.result as Extract<PlanResult, { readonly ok: false }>;
      if (result.reason === "already-copied") {
        alreadyCopied++;
        progressOutcome = "already-copied";
      } else if (result.reason === "duplicate") {
        duplicates++;
        progressOutcome = "duplicate";
      } else {
        failed++;
        if (failures.length < MAX_LISTED_FAILURES) failures.push({ uuid: candidate.uuid, result });
        progressOutcome = `${result.reason}: ${result.detail}`;
      }
    } else {
      const report = reportOf(outcome.prepared);
      documents += report.documents;
      for (const [name, count] of Object.entries(report.byCompendium)) byCompendium[name] = (byCompendium[name] ?? 0) + count;
      // Feeds the virtual state: a document this candidate would create is "already there" for every candidate that follows.
      for (const planned of outcome.prepared.plan) {
        shared.ids.set(planned.id, { compendium: planned.target, documentName: planned.targetEntry.documentName });
      }
      progressOutcome = "planned";
    }
    options.onProgress?.({ index: i + 1, total: candidates.length, name: candidate.name, outcome: progressOutcome });
  }
  return {
    total: candidates.length,
    documents,
    byCompendium,
    alreadyCopied,
    duplicates,
    noArt,
    failed,
    failures,
    selectionErrors,
    ...(stopped ? { stopped: true, stoppedReason: "aborted" as const } : {}),
  };
}
