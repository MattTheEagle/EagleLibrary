import { CATALOG } from "./catalog";
import type { BulkProgressInfo } from "./bulk";
import type { ProtocolEntry } from "./protocol";

// The pure part of the Copy window (milestone M11): sorting and selecting the compendium list, which protocol entries
// get shown and whether each can be forced, and formatting a progress step. Nothing here touches Foundry;
// `v13/copy-application.ts` provides the rest (the `ApplicationV2` window, reading the world, running `copyCompendia`/
// `planCompendia`, opening a document).

// One row of the selection list, as `BulkWorld.listNonEaglePacks()` gives it.
export interface PackRow {
  readonly collection: string;
  readonly documentName: string;
  readonly label: string;
}

// The rows, alphabetically by label (Unicode, locale-aware) — the same rule as every other list in the Library
// (`core/library-window.ts#sortEntries`). The label, not the collection id, is what a Gamemaster reads.
export function sortPacks(packs: readonly PackRow[]): readonly PackRow[] {
  return [...packs].sort((a, b) => a.label.localeCompare(b.label));
}

// Whether "Select all" should show as checked: there is at least one row, and every one of them is selected.
export function allSelected(packs: readonly PackRow[], selected: ReadonlySet<string>): boolean {
  return packs.length > 0 && packs.every((pack) => selected.has(pack.collection));
}

const VERSIONED_KINDS: ReadonlySet<string> = new Set(CATALOG.filter((entry) => entry.versioned).map((entry) => entry.key));

// Whether a kind (`entry.kind` of a protocol entry, e.g. "weapons") has a ruleset version, per the catalog — independent
// of whether this one entry happens to carry a stored version. `null` (no kind, should not normally happen for an open
// entry) counts as not versioned.
export function kindIsVersioned(kind: string | null): boolean {
  return kind !== null && VERSIONED_KINDS.has(kind);
}

// One line of the protocol view: only the entries still open (not yet copied or forced), each knowing whether "Force"
// applies to it at all (Apply section H: only a `duplicate`, never the other three reasons — forcing only lifts the
// uniqueness check) and, if it does, whether forcing it needs a version choice from the Gamemaster first.
export interface ProtocolRow {
  readonly entry: ProtocolEntry;
  readonly canForce: boolean;
  readonly needsVersion: boolean;
}

export function protocolRows(entries: readonly ProtocolEntry[]): readonly ProtocolRow[] {
  return entries
    .filter((entry) => entry.status === "open")
    .map((entry) => {
      const canForce = entry.reason === "duplicate";
      return { entry, canForce, needsVersion: canForce && kindIsVersioned(entry.kind) };
    });
}

// A step of a running bulk operation, as text for the progress notification (Discover f9).
export function formatProgress(info: BulkProgressInfo): string {
  return `${info.index} / ${info.total} — ${info.name} (${info.outcome})`;
}

// The fraction (0 to 1) `ui.notifications`'s progress bar wants (`pct`); `total === 0` (an empty selection) counts as done.
export function progressFraction(info: BulkProgressInfo): number {
  return info.total > 0 ? info.index / info.total : 1;
}
