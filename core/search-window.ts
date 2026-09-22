import { matchesQuery, sortEntries } from "./library-window";
import type { IndexEntry } from "./copy";

// The pure part of the cross-compendium search overlay (milestone M13): what one entry of the whole-Library index
// carries, and which entries a query matches. Nothing here touches Foundry; `v13/search-application.ts` provides the
// rest (the frameless `ApplicationV2`, building the index, opening a document, dragging one out).

// One entry of the index, together with which Eagle Compendium it came from (`core/copy.ts#IndexEntry` on its own
// only carries `id`/`name`/`requirements` — not enough to say where an entry lives or to build its UUID).
export interface IndexedEntry extends IndexEntry {
  readonly compendium: string;
  readonly documentName: string;
  // The bare name of the kind (e.g. "Weapons"), the same rule M10's tabs already use: no "Eagle", no version.
  readonly label: string;
}

export const MAX_SEARCH_RESULTS = 20;

// The entries across every compendium of `index` whose name matches `query` (the same rule as M12's `matchesQuery`),
// alphabetically, capped at `limit`. An empty or blank query gives no results at all (Apply section I, A2): a quick
// search over an index of thousands of entries would not be useful to scroll through unfiltered.
export function searchAll(index: readonly IndexedEntry[], query: string, limit = MAX_SEARCH_RESULTS): readonly IndexedEntry[] {
  if (query.trim() === "") return [];
  const matches = index.filter((entry) => matchesQuery(entry.name, query));
  return sortEntries(matches).slice(0, limit);
}

// The UUID of an indexed entry's own Library copy (the same form M10's entry buttons already build).
export function uuidOf(entry: IndexedEntry): string {
  return `Compendium.world.${entry.compendium}.${entry.documentName}.${entry.id}`;
}
