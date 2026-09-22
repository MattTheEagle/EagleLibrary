import { expectedCompendia } from "./catalog";
import type { CatalogDocumentName } from "./catalog";
import type { RulesVersion } from "./rules-version";

// The pure part of the Library window (milestone M10, rework 1): which Eagle Compendia get a tab, in what order, with
// which label, and in what order the entries of one tab are shown. Nothing here touches Foundry; `v13/library-application.ts`
// provides the rest (the ApplicationV2 window itself, reading the world, opening a document).

export interface TabInfo {
  readonly id: string;
  readonly label: string;
  readonly documentName: CatalogDocumentName;
}

// The three groups the version filter splits the catalog into (rework 1, `m10-06-apply-rework1-output.md`): a stored
// ruleset version, or "both" for the four kinds that have none (Encounters, Groups, Roll Tables, Journals). The name
// "both" is the project lead's own choice: it never mixes 2014 and 2024, it only ever means "neither".
export type VersionFilter = RulesVersion | "both";

// The filter a freshly opened window starts with (the project lead's choice, 2026-09-22).
export const DEFAULT_VERSION_FILTER: VersionFilter = "2014";

// One tab for every Eagle Compendium that exists in the world (`existing`, by its name) and matches `filter`, in the
// order of the catalog — which already groups related kinds and their versions next to each other. A Compendium the
// Gamemaster has not created yet gets no tab (rule of the acceptance: "a tab for every recognized Eagle Compendium").
// The label is the bare name of the kind (e.g. "Weapons", "NPCs"), never "Eagle" and never the version: the Library
// only ever holds Eagle Compendia, and the filter already says the version.
export function tabsOf(existing: ReadonlySet<string>, filter: VersionFilter): readonly TabInfo[] {
  return expectedCompendia()
    .filter((compendium) => existing.has(compendium.name))
    .filter((compendium) => (filter === "both" ? compendium.version === undefined : compendium.version === filter))
    .map((compendium) => ({ id: compendium.name, label: compendium.entry.title, documentName: compendium.documentName }));
}

// The entries of one tab, alphabetically by name (Unicode, locale-aware; case and accents do not change the order).
export function sortEntries<T extends { readonly name: string }>(entries: readonly T[]): readonly T[] {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}

// Milestone M12: whether `name` matches a search `query` — case-insensitive (`toLocaleLowerCase`, the same Unicode-aware
// casing `sortEntries` already relies on), a substring anywhere in the name. An empty or blank query matches everything.
export function matchesQuery(name: string, query: string): boolean {
  const trimmed = query.trim();
  return trimmed === "" || name.toLocaleLowerCase().includes(trimmed.toLocaleLowerCase());
}

// The entries of one tab that match `query`, in the order given (the caller still sorts, as it already does for the
// unfiltered list); does not change the given array.
export function filterEntries<T extends { readonly name: string }>(entries: readonly T[], query: string): readonly T[] {
  return entries.filter((entry) => matchesQuery(entry.name, query));
}
