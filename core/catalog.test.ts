import { describe, expect, it } from "vitest";
import {
  artForDocument,
  CATALOG,
  compendiaOf,
  expectedCompendia,
  recognizeCompendium,
  type CatalogDocumentName,
} from "./catalog";

// The document types a compendium can have (CONST.COMPENDIUM_DOCUMENT_TYPES of Foundry v13) and the catalog types must
// be among them. Compile-time check: a catalog type that is no compendium type does not compile.
const COMPENDIUM_DOCUMENT_TYPES = [
  "Actor",
  "Adventure",
  "Cards",
  "Item",
  "JournalEntry",
  "Macro",
  "Playlist",
  "RollTable",
  "Scene",
] as const satisfies readonly foundry.CONST.COMPENDIUM_DOCUMENT_TYPES[];
const _catalogTypesAreCompendiumTypes: readonly (typeof COMPENDIUM_DOCUMENT_TYPES)[number][] = CATALOG.map(
  (entry) => entry.documentName satisfies CatalogDocumentName,
);
void _catalogTypesAreCompendiumTypes;

// The Item subtypes dnd5e 5.3.3 has in system.json, less "backpack" (an old value that dnd5e turns into "container").
// Checked against system.json once at deploy (dadm/m2-03-deploy-output.md), not here: the test has no access to dnd5e.
const DND5E_ITEM_SUBTYPES = [
  "weapon",
  "equipment",
  "consumable",
  "tool",
  "loot",
  "race",
  "background",
  "class",
  "subclass",
  "spell",
  "feat",
  "container",
  "facility",
];
const DND5E_ACTOR_SUBTYPES = ["character", "encounter", "group", "npc", "vehicle"];

describe("the catalog", () => {
  it("has 19 kinds, 15 of them with a ruleset version, and 34 compendia", () => {
    expect(CATALOG).toHaveLength(19);
    expect(CATALOG.filter((entry) => entry.versioned)).toHaveLength(15);
    expect(expectedCompendia()).toHaveLength(34);
  });

  it("has unique keys, names and labels", () => {
    const compendia = expectedCompendia();
    for (const values of [
      CATALOG.map((entry) => entry.key),
      compendia.map((compendium) => compendium.name),
      compendia.map((compendium) => compendium.label),
    ]) {
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it("names compendia with lower case letters, digits and hyphens only, and no period", () => {
    for (const { name } of expectedCompendia()) expect(name).toMatch(/^eagle(-[a-z0-9]+)+$/);
  });

  it("uses document types a compendium can have", () => {
    for (const entry of CATALOG) expect(COMPENDIUM_DOCUMENT_TYPES).toContain(entry.documentName);
  });

  it("has a ruleset version for Items, NPCs and vehicles, and for nothing else", () => {
    for (const entry of CATALOG) {
      const carriesVersion = entry.documentName === "Item" || entry.subtype === "npc" || entry.subtype === "vehicle";
      expect(entry.versioned, entry.key).toBe(carriesVersion);
    }
  });

  it("covers exactly the 13 effective Item subtypes of dnd5e, and the Actor subtypes but the character", () => {
    const items = CATALOG.filter((entry) => entry.documentName === "Item").map((entry) => entry.subtype);
    expect([...items].sort()).toEqual([...DND5E_ITEM_SUBTYPES].sort());
    const actors = CATALOG.filter((entry) => entry.documentName === "Actor").map((entry) => entry.subtype);
    expect([...actors].sort()).toEqual(DND5E_ACTOR_SUBTYPES.filter((subtype) => subtype !== "character").sort());
  });

  it("has one compendium per version for a versioned kind and one compendium for the others", () => {
    for (const entry of CATALOG) {
      const compendia = compendiaOf(entry);
      expect(compendia.map((compendium) => compendium.version)).toEqual(entry.versioned ? ["2014", "2024"] : [undefined]);
    }
  });

  it("builds names and labels from key, title and version", () => {
    const byName = new Map(expectedCompendia().map((compendium) => [compendium.name, compendium]));
    expect(byName.get("eagle-species-2024")).toMatchObject({
      label: "Eagle Species (2024)",
      documentName: "Item",
      version: "2024",
    });
    expect(byName.get("eagle-npcs-2014")?.label).toBe("Eagle NPCs (2014)");
    expect(byName.get("eagle-journals")).toMatchObject({ label: "Eagle Journals", documentName: "JournalEntry" });
    expect(byName.get("eagle-journals")).not.toHaveProperty("version");
  });

  it("is frozen", () => {
    expect(Object.isFrozen(CATALOG)).toBe(true);
    for (const entry of CATALOG) expect(Object.isFrozen(entry)).toBe(true);
  });
});

describe("artForDocument", () => {
  it("gives every Item subtype of the catalog its kind", () => {
    for (const subtype of DND5E_ITEM_SUBTYPES) {
      const entry = artForDocument("Item", subtype);
      expect(entry, subtype).toBeDefined();
      expect(entry).toMatchObject({ documentName: "Item", subtype });
    }
  });

  it("names the kinds the way dnd5e's interface does", () => {
    expect(artForDocument("Item", "race")?.key).toBe("species");
    expect(artForDocument("Item", "feat")?.key).toBe("feats");
    expect(artForDocument("Item", "spell")?.key).toBe("spells");
  });

  it("counts the old Item subtype backpack as container", () => {
    expect(artForDocument("Item", "backpack")?.key).toBe("containers");
  });

  it("gives NPCs, vehicles, encounters and groups their kinds, and the character none", () => {
    expect(artForDocument("Actor", "npc")?.key).toBe("npcs");
    expect(artForDocument("Actor", "vehicle")?.key).toBe("vehicles");
    expect(artForDocument("Actor", "encounter")?.key).toBe("encounters");
    expect(artForDocument("Actor", "group")?.key).toBe("groups");
    expect(artForDocument("Actor", "character")).toBeUndefined();
  });

  it("gives roll tables and journal entries one kind each, whatever the subtype", () => {
    expect(artForDocument("RollTable")?.key).toBe("rolltables");
    expect(artForDocument("JournalEntry")?.key).toBe("journals");
    expect(artForDocument("JournalEntry", "class")?.key).toBe("journals");
    expect(artForDocument("RollTable", "anything")?.key).toBe("rolltables");
  });

  it("gives no kind to the document types the Library does not keep", () => {
    for (const documentName of ["Adventure", "Cards", "Macro", "Playlist", "Scene"]) {
      expect(artForDocument(documentName), documentName).toBeUndefined();
      expect(artForDocument(documentName, "npc"), documentName).toBeUndefined();
    }
  });

  it("guesses nothing for unknown subtypes and unknown document types", () => {
    expect(artForDocument("Item", "gizmo")).toBeUndefined();
    expect(artForDocument("Item")).toBeUndefined();
    expect(artForDocument("Item", "base")).toBeUndefined();
    expect(artForDocument("Actor", "gizmo")).toBeUndefined();
    expect(artForDocument("Actor")).toBeUndefined();
    expect(artForDocument("Widget", "npc")).toBeUndefined();
    expect(artForDocument("", "")).toBeUndefined();
  });

  it("does not take an Actor subtype for an Item subtype or the other way round", () => {
    expect(artForDocument("Item", "npc")).toBeUndefined();
    expect(artForDocument("Actor", "weapon")).toBeUndefined();
  });

  it("does not take inherited object keys for subtypes", () => {
    expect(artForDocument("Item", "__proto__")).toBeUndefined();
    expect(artForDocument("Item", "constructor")).toBeUndefined();
  });
});

describe("recognizeCompendium", () => {
  it("recognizes each of the 34 compendia with its kind and version", () => {
    for (const expected of expectedCompendia()) {
      const found = recognizeCompendium({ packageType: "world", name: expected.name, type: expected.documentName });
      expect(found, expected.name).toBe(expected);
      expect(found?.version).toBe(expected.version);
    }
  });

  it("does not recognize a compendium of the wrong document type", () => {
    expect(recognizeCompendium({ packageType: "world", name: "eagle-spells-2014", type: "Actor" })).toBeUndefined();
    expect(recognizeCompendium({ packageType: "world", name: "eagle-npcs-2024", type: "Item" })).toBeUndefined();
    expect(recognizeCompendium({ packageType: "world", name: "eagle-journals", type: "RollTable" })).toBeUndefined();
  });

  it("does not recognize a compendium of a system or a module", () => {
    for (const packageType of ["system", "module", "", "World"]) {
      expect(
        recognizeCompendium({ packageType, name: "eagle-spells-2014", type: "Item" }),
        JSON.stringify(packageType),
      ).toBeUndefined();
    }
  });

  it("does not recognize near misses of a name", () => {
    for (const name of [
      "eagle-spells",
      "eagle-spells-2015",
      "eagle-spells-2014-",
      "Eagle-Spells-2014",
      "eagle-Spells-2014",
      "eagle-spells-2014 ",
      " eagle-spells-2014",
      "eagle-spells-2014-copy",
      "eagle-spell-2014",
      "eagle-journals-2014",
      "eagle-encounters-2024",
      "eagle-rolltables-2014",
      "eagle",
      "eagle-",
      "spells-2014",
      "world.eagle-spells-2014",
      "eagle_spells_2014",
      "",
    ]) {
      expect(recognizeCompendium({ packageType: "world", name, type: "Item" }), JSON.stringify(name)).toBeUndefined();
    }
  });

  it("does not take inherited object keys for names", () => {
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(recognizeCompendium({ packageType: "world", name, type: "Item" }), name).toBeUndefined();
    }
  });

  it("does not look at the label", () => {
    const descriptor = { packageType: "world", name: "eagle-spells-2014", type: "Item", label: "My own spells" };
    expect(recognizeCompendium(descriptor)?.name).toBe("eagle-spells-2014");
    const unrelated = { packageType: "world", name: "my-spells", type: "Item", label: "Eagle Spells (2014)" };
    expect(recognizeCompendium(unrelated)).toBeUndefined();
  });
});
