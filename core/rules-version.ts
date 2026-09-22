// The ruleset version of an entry (2014 or 2024) and where a copied entry goes because of it.
//
// The only source of the version is the value stored on the document, `system.source.rules`, as a compendium index or the
// raw document data gives it. The world setting `rulesVersion` of dnd5e is deliberately not an input of anything here: it
// is only the initial value of a field nobody has stored yet, so reading it would tell 2014 and 2024 apart wrongly
// (M2 discover, v1 and v3).

export const RULES_VERSIONS = ["2014", "2024"] as const;
export type RulesVersion = (typeof RULES_VERSIONS)[number];

export type VersionState =
  // The kind has no ruleset version (encounters, groups, roll tables, journals); a stored value is ignored.
  | { readonly kind: "none" }
  | { readonly kind: "stored"; readonly version: RulesVersion }
  // Nothing usable is stored: the field is absent, null, empty or anything but exactly "2014" or "2024". `raw` is what was
  // there, for the log.
  | { readonly kind: "unstored"; readonly raw: unknown };

// Reads the version of an entry of `kind` from the value stored in `system.source.rules`. There is no cleaning up: a value
// is a version or it is not. "N7: if neither 2014 nor 2024 is stored" covers unknown values as well as missing ones.
export function readStoredVersion(kind: { readonly versioned: boolean }, stored: unknown): VersionState {
  if (!kind.versioned) return { kind: "none" };
  const version = RULES_VERSIONS.find((candidate) => candidate === stored);
  return version ? { kind: "stored", version } : { kind: "unstored", raw: stored };
}

// Whether the name key of the entry (see name-key.ts) is already in the Eagle Compendium of this kind and version.
// `version` is undefined for kinds without a version. The caller answers it from the compendium index.
export type IsPresent = (version: RulesVersion | undefined) => boolean;

export type Placement =
  | { readonly outcome: "place"; readonly version?: RulesVersion }
  // The entry is not copied; the versions listed are where the name exists already (empty for kinds without a version).
  | { readonly outcome: "duplicate"; readonly versions: readonly RulesVersion[] };

// Decides the Eagle Compendium version of an entry.
//  - A stored version is kept, and the entry is a duplicate if that version has the name (Q6 a: once per version).
//  - Without a stored version (N7): 2014; if 2014 has the name already but 2024 has not, then 2024; if both have it, a
//    duplicate. "Has the name already" means in the Library's compendium of that version, not in the source.
//  - Kinds without a version have one compendium: the entry goes there unless the name is in it.
// Choosing a version for a forced copy of a duplicate is left to the game master (N7); this function does not do it.
export function chooseTarget(state: VersionState, isPresent: IsPresent): Placement {
  switch (state.kind) {
    case "none":
      return isPresent(undefined) ? { outcome: "duplicate", versions: [] } : { outcome: "place" };
    case "stored":
      return isPresent(state.version)
        ? { outcome: "duplicate", versions: [state.version] }
        : { outcome: "place", version: state.version };
    case "unstored":
      if (!isPresent("2014")) return { outcome: "place", version: "2014" };
      if (!isPresent("2024")) return { outcome: "place", version: "2024" };
      return { outcome: "duplicate", versions: ["2014", "2024"] };
  }
}
