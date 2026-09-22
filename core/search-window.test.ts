import { describe, expect, it } from "vitest";
import { MAX_SEARCH_RESULTS, searchAll, uuidOf, type IndexedEntry } from "./search-window";

const entry = (over: Partial<IndexedEntry> = {}): IndexedEntry => ({
  id: "a".padEnd(16, "0"),
  name: "Dagger",
  compendium: "eagle-weapons-2014",
  documentName: "Item",
  label: "Weapons",
  ...over,
});

describe("searchAll", () => {
  it("gives no results for an empty or blank query", () => {
    const index = [entry()];
    expect(searchAll(index, "")).toEqual([]);
    expect(searchAll(index, "   ")).toEqual([]);
  });

  it("matches across different compendia", () => {
    const index = [
      entry({ id: "a".padEnd(16, "0"), name: "Dagger", compendium: "eagle-weapons-2014" }),
      entry({ id: "b".padEnd(16, "0"), name: "Dart", compendium: "eagle-weapons-2024", label: "Weapons" }),
      entry({ id: "c".padEnd(16, "0"), name: "Backpack", compendium: "eagle-equipment-2014", label: "Equipment" }),
    ];
    expect(searchAll(index, "da").map((e) => e.name)).toEqual(["Dagger", "Dart"]);
  });

  it("sorts the results alphabetically", () => {
    const index = [entry({ id: "a".padEnd(16, "0"), name: "Zebra Blade" }), entry({ id: "b".padEnd(16, "0"), name: "Apple Blade" })];
    expect(searchAll(index, "blade").map((e) => e.name)).toEqual(["Apple Blade", "Zebra Blade"]);
  });

  it("caps at the given limit, the default is 20", () => {
    expect(MAX_SEARCH_RESULTS).toBe(20);
    const index = Array.from({ length: 30 }, (_, i) => entry({ id: `x${i}`.padEnd(16, "0"), name: `Match ${String(i).padStart(2, "0")}` }));
    expect(searchAll(index, "match")).toHaveLength(20);
    expect(searchAll(index, "match", 5)).toHaveLength(5);
  });

  it("is case-insensitive and matches a substring anywhere", () => {
    expect(searchAll([entry({ name: "Berserker Battleaxe" })], "AXE").map((e) => e.name)).toEqual(["Berserker Battleaxe"]);
  });

  it("gives no results when nothing matches", () => {
    expect(searchAll([entry()], "xyz")).toEqual([]);
  });
});

describe("uuidOf", () => {
  it("builds the world compendium UUID of the entry", () => {
    expect(uuidOf(entry({ id: "abc".padEnd(16, "0"), compendium: "eagle-weapons-2014", documentName: "Item" }))).toBe(
      "Compendium.world.eagle-weapons-2014.Item.abc0000000000000",
    );
  });
});
