import { describe, expect, it } from "vitest";
import { countMentions, DOCUMENT_NAMES, findUuids, formatPrimary, looseKey, parsePrimary, typedKey } from "./uuid";

const ID = "aBcDeFgH12345678";
const typed = (scope = "dnd5e", pack = "items", type = "Item", id = ID) => `Compendium.${scope}.${pack}.${type}.${id}`;

describe("findUuids: the form with a type", () => {
  it("knows the nine document types of a compendium", () => {
    expect([...DOCUMENT_NAMES]).toEqual(["Item", "Actor", "JournalEntry", "RollTable", "Macro", "Scene", "Playlist", "Cards", "Adventure"]);
  });

  it("finds the main part of a UUID that is the whole text, for every document type", () => {
    for (const type of DOCUMENT_NAMES) {
      const found = findUuids(typed("dnd5e", "items", type));
      expect(found, type).toEqual([{ scope: "dnd5e", pack: "items", documentName: type, id: ID, form: "typed", start: 0, end: typed("dnd5e", "items", type).length }]);
    }
  });

  it("accepts letters, digits, hyphens and underscores in the package and the compendium", () => {
    const found = findUuids(typed("dnd-players-handbook", "equipment_2", "Item"));
    expect(found[0]).toMatchObject({ scope: "dnd-players-handbook", pack: "equipment_2", documentName: "Item" });
  });

  it("stops at the main part: embedded parts and an anchor are not read", () => {
    const text = `${typed()}.ActiveEffect.zzzzzzzzzzzzzzzz#some-anchor`;
    const found = findUuids(text);
    expect(found).toHaveLength(1);
    expect(text.slice(found[0]!.start, found[0]!.end)).toBe(typed());
  });

  it("finds a UUID in a text, in a link with a label, in an embed with options, and several in one text", () => {
    const text = `See @UUID[${typed()}]{Fireball} and @Embed[${typed("dnd5e", "spells", "Item", "bbbbbbbbbbbbbbbb")} inline caption=false] or ${typed("world", "eagle-loot-2014", "Item", "cccccccccccccccc")}.`;
    const found = findUuids(text);
    expect(found.map((f) => f.id)).toEqual([ID, "bbbbbbbbbbbbbbbb", "cccccccccccccccc"]);
    for (const f of found) expect(text.slice(f.start, f.end)).toMatch(/^Compendium\./);
  });

  it("finds it after an opening quote, bracket, equals sign and white space", () => {
    for (const before of ['"', "[", "=", " ", "(", ">", "\n"]) expect(findUuids(`${before}${typed()}`), before).toHaveLength(1);
  });
});

describe("findUuids: the older form without a type", () => {
  it("finds it and marks it legacy, without a document name", () => {
    const text = `Compendium.dnd5e.classfeatures.${ID}`;
    expect(findUuids(text)).toEqual([{ scope: "dnd5e", pack: "classfeatures", id: ID, form: "legacy", start: 0, end: text.length }]);
  });

  it("does not take the id of an embedded part for the main part, and a type name for an id", () => {
    const found = findUuids(`Compendium.dnd5e.items.Item.${ID}.Item.${ID}`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ form: "typed", id: ID });
  });
});

describe("findUuids: what is not a UUID", () => {
  it("does not find a UUID of the world, a relative one, or one with an id that is not 16 letters and digits", () => {
    for (const text of [
      `Item.${ID}`, `Actor.${ID}.Item.${ID}`, `@UUID[.${ID}]`, `Compendium.dnd5e.items.Item.short`,
      `Compendium.dnd5e.items.Item.${ID}X`, `Compendium.dnd5e.items.${ID}0`, "Compendium.dnd5e.items", "Compendium.", "",
      `Compendium.dnd5e.items.Widget.${ID}`,
    ]) {
      expect(findUuids(text), text).toEqual([]);
    }
  });

  it("does not find one inside a longer word", () => {
    expect(findUuids(`xCompendium.dnd5e.items.Item.${ID}`)).toEqual([]);
    expect(findUuids(`9Compendium.dnd5e.items.Item.${ID}`)).toEqual([]);
  });

  it("keeps the position of every match so that a text can be cut exactly", () => {
    const a = typed();
    const text = `x ${a} y ${a} z`;
    const found = findUuids(text);
    expect(found.map((f) => [f.start, f.end])).toEqual([[2, 2 + a.length], [5 + a.length, 5 + 2 * a.length]]);
  });
});

describe("parsePrimary, keys and format", () => {
  it("reads a text that is exactly one main part, and nothing else", () => {
    expect(parsePrimary(typed())).toMatchObject({ scope: "dnd5e", pack: "items", documentName: "Item", id: ID });
    expect(parsePrimary(`Compendium.dnd5e.items.${ID}`)).toMatchObject({ form: "legacy" });
    for (const text of [` ${typed()}`, `${typed()} `, `${typed()}.ActiveEffect.${ID}`, `${typed()}#a`, `${typed()}${typed()}`, "", "Item.x"]) {
      expect(parsePrimary(text), text).toBeUndefined();
    }
  });

  it("builds the typed key, the loose key and the main part", () => {
    const parsed = parsePrimary(typed())!;
    expect(typedKey(parsed)).toBe(typed());
    expect(looseKey(parsed)).toBe(`dnd5e.items.${ID}`);
    expect(typedKey(parsePrimary(`Compendium.dnd5e.items.${ID}`)!)).toBeUndefined();
    expect(looseKey(parsePrimary(`Compendium.dnd5e.items.${ID}`)!)).toBe(`dnd5e.items.${ID}`);
    expect(formatPrimary("world", "eagle-loot-2014", "Item", ID)).toBe(typed("world", "eagle-loot-2014"));
  });

  it("counts the places that start with Compendium.", () => {
    expect(countMentions(`a ${typed()} b Compendium.x`)).toBe(2);
    expect(countMentions("nothing")).toBe(0);
  });
});
