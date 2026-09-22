import { RULES_VERSIONS, type RulesVersion } from "./rules-version";

// The catalog of Eagle Compendia: which kinds ("Arten") the Library keeps, what their compendia are called and how a
// compendium or a document is matched to a kind. Decision of the project lead, 2026-09-21 (dadm/m2-hd-1-output.md): one
// kind per document subtype, plus journal entries; kinds with a ruleset version get one compendium per version.
// Extending the catalog is one row here and a test; a compendium created later does not take in older entries.

// The document types of compendia that the catalog uses (a subset of CONST.COMPENDIUM_DOCUMENT_TYPES).
export type CatalogDocumentName = "Actor" | "Item" | "JournalEntry" | "RollTable";

export interface CatalogEntry {
  // Part of the compendium name: `eagle-<key>` or `eagle-<key>-<version>`.
  readonly key: string;
  readonly documentName: CatalogDocumentName;
  // The document subtype (`type`) of Items and Actors, as dnd5e stores it. Roll tables and journal entries have none.
  readonly subtype?: string;
  // Whether the kind has a ruleset version, which is so for Items, NPCs and vehicles (dnd5e stores `system.source.rules`
  // only there).
  readonly versioned: boolean;
  // The words of the label: "Eagle <title>" and, with a version, "(2014)" or "(2024)" (English, N3).
  readonly title: string;
}

const item = (key: string, subtype: string, title: string): CatalogEntry =>
  ({ key, documentName: "Item", subtype, versioned: true, title });
const actor = (key: string, subtype: string, title: string, versioned: boolean): CatalogEntry =>
  ({ key, documentName: "Actor", subtype, versioned, title });
const withoutSubtypeEntry = (key: string, documentName: CatalogDocumentName, title: string): CatalogEntry =>
  ({ key, documentName, versioned: false, title });

export const CATALOG: readonly CatalogEntry[] = Object.freeze([
  item("weapons", "weapon", "Weapons"),
  item("equipment", "equipment", "Equipment"),
  item("consumables", "consumable", "Consumables"),
  item("tools", "tool", "Tools"),
  item("loot", "loot", "Loot"),
  item("containers", "container", "Containers"),
  // dnd5e stores the subtype as "race"; its interface says "Species".
  item("species", "race", "Species"),
  item("backgrounds", "background", "Backgrounds"),
  item("classes", "class", "Classes"),
  item("subclasses", "subclass", "Subclasses"),
  item("spells", "spell", "Spells"),
  item("feats", "feat", "Feats"),
  item("facilities", "facility", "Facilities"),
  actor("npcs", "npc", "NPCs", true),
  actor("vehicles", "vehicle", "Vehicles", true),
  actor("encounters", "encounter", "Encounters", false),
  actor("groups", "group", "Groups", false),
  withoutSubtypeEntry("rolltables", "RollTable", "Roll Tables"),
  withoutSubtypeEntry("journals", "JournalEntry", "Journals"),
].map((entry) => Object.freeze(entry)));

export const COMPENDIUM_NAME_PREFIX = "eagle";

// One compendium the Library expects to exist. `version` is undefined for kinds without one.
export interface ExpectedCompendium {
  readonly name: string;
  readonly label: string;
  readonly documentName: CatalogDocumentName;
  readonly entry: CatalogEntry;
  readonly version?: RulesVersion;
}

function expectedCompendium(entry: CatalogEntry, version?: RulesVersion): ExpectedCompendium {
  const name = version ? `${COMPENDIUM_NAME_PREFIX}-${entry.key}-${version}` : `${COMPENDIUM_NAME_PREFIX}-${entry.key}`;
  const label = version ? `Eagle ${entry.title} (${version})` : `Eagle ${entry.title}`;
  return Object.freeze({ name, label, documentName: entry.documentName, entry, ...(version ? { version } : {}) });
}

const EXPECTED: readonly ExpectedCompendium[] = Object.freeze(
  CATALOG.flatMap((entry) =>
    entry.versioned ? RULES_VERSIONS.map((version) => expectedCompendium(entry, version)) : [expectedCompendium(entry)],
  ),
);

// The compendia of one kind: one per version, or the single one.
export function compendiaOf(entry: CatalogEntry): readonly ExpectedCompendium[] {
  return EXPECTED.filter((compendium) => compendium.entry === entry);
}

// All compendia the Library expects, in catalog order (34).
export function expectedCompendia(): readonly ExpectedCompendium[] {
  return EXPECTED;
}

const byName: ReadonlyMap<string, ExpectedCompendium> = new Map(EXPECTED.map((c) => [c.name, c]));

const bySubtype: ReadonlyMap<string, CatalogEntry> = new Map(
  CATALOG.filter((entry) => entry.subtype !== undefined).map((entry) => [`${entry.documentName}:${entry.subtype}`, entry]),
);
const withoutSubtype: ReadonlyMap<string, CatalogEntry> = new Map(
  CATALOG.filter((entry) => entry.subtype === undefined).map((entry) => [entry.documentName, entry]),
);

// The kind of a document, or undefined if the Library has none for it ("no-art": characters, unknown subtypes, macros,
// scenes, playlists, card stacks, adventures). Nothing is guessed: an unknown subtype has no kind.
//  - Items and Actors go by their subtype. The old Item subtype "backpack" counts as "container" (dnd5e migrates it when it
//    loads the data, but an index may still show the old value).
//  - Roll tables and journal entries have one kind each; the pages of a journal entry do not matter.
export function artForDocument(documentName: string, subtype?: string): CatalogEntry | undefined {
  const bare = withoutSubtype.get(documentName);
  if (bare) return bare;
  if (subtype === undefined) return undefined;
  const effective = documentName === "Item" && subtype === "backpack" ? "container" : subtype;
  return bySubtype.get(`${documentName}:${effective}`);
}

// What a compendium says about itself, as `game.packs` metadata gives it.
export interface CompendiumDescriptor {
  // "world", "system" or "module" (metadata.packageType).
  readonly packageType: string;
  // The name of the pack, without the package (metadata.name).
  readonly name: string;
  // The document type of the pack (metadata.type).
  readonly type: string;
}

// The Eagle Compendium a compendium is, or undefined. All three must hold: it is a world compendium, its name is exactly
// one of the expected names (no prefix match, no change of case), and its document type is that of the kind. The label is
// only a display text and plays no part: a game master can edit it, the name stays.
export function recognizeCompendium(descriptor: CompendiumDescriptor): ExpectedCompendium | undefined {
  if (descriptor.packageType !== "world") return undefined;
  const expected = byName.get(descriptor.name);
  return expected && expected.documentName === descriptor.type ? expected : undefined;
}
