import { describe, expect, it } from "vitest";
import { expectedCompendia } from "./catalog";
import { DEFAULT_VERSION_FILTER, filterEntries, matchesQuery, sortEntries, tabsOf } from "./library-window";

describe("tabsOf", () => {
  it("gives no tab when nothing exists", () => {
    expect(tabsOf(new Set(), "2014")).toEqual([]);
  });

  it("gives a tab for every existing compendium of the given version, none for the rest", () => {
    const all = expectedCompendia();
    const weapons2014 = all.find((c) => c.name === "eagle-weapons-2014")!;
    const weapons2024 = all.find((c) => c.name === "eagle-weapons-2024")!;
    const some = new Set([weapons2014.name, weapons2024.name]);
    const tabs = tabsOf(some, "2014");
    expect(tabs.map((tab) => tab.id)).toEqual([weapons2014.name]);
    expect(tabs[0]).toEqual({ id: weapons2014.name, label: "Weapons", documentName: weapons2014.documentName });
  });

  it("labels a tab with the bare name of the kind: no 'Eagle', no version", () => {
    const all = expectedCompendia();
    const npcs2024 = all.find((c) => c.name === "eagle-npcs-2024")!;
    expect(tabsOf(new Set([npcs2024.name]), "2024")[0]?.label).toBe("NPCs");
  });

  it("keeps the order of the catalog, not the order of the given set", () => {
    const all = expectedCompendia();
    const weapons2014 = all.find((c) => c.name === "eagle-weapons-2014")!;
    const equipment2014 = all.find((c) => c.name === "eagle-equipment-2014")!;
    const reversed = new Set([equipment2014.name, weapons2014.name]);
    expect(tabsOf(reversed, "2014").map((tab) => tab.id)).toEqual([weapons2014.name, equipment2014.name]);
  });

  it("gives 15 tabs for 2014 and for 2024 when everything exists (15 versioned kinds each)", () => {
    const all = expectedCompendia();
    const existing = new Set(all.map((c) => c.name));
    expect(tabsOf(existing, "2014")).toHaveLength(15);
    expect(tabsOf(existing, "2024")).toHaveLength(15);
  });

  it("gives the 4 unversioned tabs for 'both' when everything exists", () => {
    const all = expectedCompendia();
    const existing = new Set(all.map((c) => c.name));
    const tabs = tabsOf(existing, "both");
    expect(tabs.map((tab) => tab.label)).toEqual(["Encounters", "Groups", "Roll Tables", "Journals"]);
  });

  it("never gives the same tab for two different filters (the three groups are disjoint)", () => {
    const all = expectedCompendia();
    const existing = new Set(all.map((c) => c.name));
    const ids2014 = new Set(tabsOf(existing, "2014").map((t) => t.id));
    const ids2024 = new Set(tabsOf(existing, "2024").map((t) => t.id));
    const idsBoth = new Set(tabsOf(existing, "both").map((t) => t.id));
    for (const id of ids2014) {
      expect(ids2024.has(id)).toBe(false);
      expect(idsBoth.has(id)).toBe(false);
    }
    for (const id of ids2024) expect(idsBoth.has(id)).toBe(false);
  });

  it("ignores a name that is not an Eagle Compendium", () => {
    expect(tabsOf(new Set(["world.something-else"]), "2014")).toEqual([]);
  });
});

describe("DEFAULT_VERSION_FILTER", () => {
  it("is 2014", () => {
    expect(DEFAULT_VERSION_FILTER).toBe("2014");
  });
});

describe("sortEntries", () => {
  it("sorts by name, locale-aware", () => {
    const entries = [{ name: "Zebra" }, { name: "apple" }, { name: "Ärger" }, { name: "Banana" }];
    expect(sortEntries(entries).map((e) => e.name)).toEqual(["apple", "Ärger", "Banana", "Zebra"]);
  });

  it("does not change the given array", () => {
    const entries = [{ name: "B" }, { name: "A" }];
    const sorted = sortEntries(entries);
    expect(sorted).not.toBe(entries);
    expect(entries.map((e) => e.name)).toEqual(["B", "A"]);
  });

  it("gives an empty list for an empty list", () => {
    expect(sortEntries([])).toEqual([]);
  });

  it("keeps extra fields of an entry", () => {
    const entries = [{ name: "B", id: "2" }, { name: "A", id: "1" }];
    expect(sortEntries(entries)).toEqual([{ name: "A", id: "1" }, { name: "B", id: "2" }]);
  });
});

describe("matchesQuery", () => {
  it("matches a substring anywhere in the name", () => {
    expect(matchesQuery("Berserker Battleaxe", "axe")).toBe(true);
    expect(matchesQuery("Berserker Battleaxe", "erse")).toBe(true);
    expect(matchesQuery("Berserker Battleaxe", "Battle")).toBe(true);
  });

  it("ignores case, Unicode-aware", () => {
    expect(matchesQuery("Ärger", "ärger")).toBe(true);
    expect(matchesQuery("ärger", "ÄRGER")).toBe(true);
    expect(matchesQuery("Dagger", "DAG")).toBe(true);
  });

  it("does not match when the substring is not there", () => {
    expect(matchesQuery("Dagger", "sword")).toBe(false);
  });

  it("an empty or blank query matches everything", () => {
    expect(matchesQuery("Dagger", "")).toBe(true);
    expect(matchesQuery("Dagger", "   ")).toBe(true);
  });
});

describe("filterEntries", () => {
  it("keeps only the entries whose name matches", () => {
    const entries = [{ name: "Dagger" }, { name: "Battleaxe" }, { name: "Dart" }];
    expect(filterEntries(entries, "da").map((e) => e.name)).toEqual(["Dagger", "Dart"]);
  });

  it("keeps everything for an empty query", () => {
    const entries = [{ name: "Dagger" }, { name: "Battleaxe" }];
    expect(filterEntries(entries, "")).toEqual(entries);
  });

  it("gives an empty list when nothing matches", () => {
    expect(filterEntries([{ name: "Dagger" }], "xyz")).toEqual([]);
  });

  it("does not change the given array", () => {
    const entries = [{ name: "Dagger" }, { name: "Battleaxe" }];
    const filtered = filterEntries(entries, "d");
    expect(filtered).not.toBe(entries);
    expect(entries).toHaveLength(2);
  });

  it("keeps extra fields of an entry", () => {
    expect(filterEntries([{ name: "Dagger", id: "1" }], "dag")).toEqual([{ name: "Dagger", id: "1" }]);
  });
});
