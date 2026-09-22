import { describe, expect, it } from "vitest";
import type { CopyResult } from "./copy";
import { entriesFromCopyResult, entryFromProtocol, isLibraryPack, linkMapFrom, plannedEntry, EMPTY_LINK_MAP, type LinkEntry } from "./link-map";
import { parsePrimary } from "./uuid";

const id = (n: string) => n.padEnd(16, "0");
const src = (n: string, pack = "items", type = "Item") => `Compendium.dnd5e.${pack}.${type}.${id(n)}`;
const lib = (n: string, pack = "eagle-weapons-2014", type = "Item") => `Compendium.world.${pack}.${type}.${id(n)}`;
const entry = (n: string, how: LinkEntry["how"] = "copied", over: Partial<LinkEntry> = {}): LinkEntry => ({ source: src(n), copy: lib(n), how, ...over });
const at = (text: string) => parsePrimary(text)!;

describe("isLibraryPack", () => {
  it("is true for a world compendium with a name of the catalog and for nothing else", () => {
    expect(isLibraryPack("world", "eagle-weapons-2014")).toBe(true);
    expect(isLibraryPack("world", "eagle-journals")).toBe(true);
    for (const [scope, pack] of [["dnd5e", "eagle-weapons-2014"], ["world", "eagle-weapons"], ["world", "items"], ["world", "eagle-weapons-2015"], ["module", "eagle-loot-2014"]]) {
      expect(isLibraryPack(scope!, pack!), `${scope}.${pack}`).toBe(false);
    }
  });
});

describe("linkMapFrom", () => {
  it("looks up a source by a UUID in the form with a type", () => {
    const map = linkMapFrom([entry("a"), entry("b")]);
    expect(map.size).toBe(2);
    expect(map.lookup(at(src("a")))).toEqual(entry("a"));
    expect(map.lookup(at(src("b")))?.copy).toBe(lib("b"));
    expect(map.lookup(at(src("c")))).toBeUndefined();
  });

  it("looks up a source by a UUID in the older form, without the type", () => {
    const map = linkMapFrom([entry("a")]);
    expect(map.lookup(at(`Compendium.dnd5e.items.${id("a")}`))).toEqual(entry("a"));
    expect(map.lookup(at(`Compendium.dnd5e.spells.${id("a")}`))).toBeUndefined();
  });

  it("does not take a UUID with a type for another type of the same id, and not one of another compendium", () => {
    const map = linkMapFrom([entry("a")]);
    expect(map.lookup(at(src("a", "items", "Actor")))).toBeUndefined();
    expect(map.lookup(at(src("a", "spells")))).toBeUndefined();
  });

  it("keeps the first entry for a source and names the second as a conflict, not when the copy is the same", () => {
    const map = linkMapFrom([entry("a"), { ...entry("a"), copy: lib("a", "eagle-weapons-2024") }, entry("a")]);
    expect(map.size).toBe(1);
    expect(map.lookup(at(src("a")))?.copy).toBe(lib("a"));
    expect(map.conflicts).toEqual([{ source: src("a"), kept: lib("a"), ignored: lib("a", "eagle-weapons-2024") }]);
  });

  it("names entries that are not right and does not take them in", () => {
    const bad: LinkEntry[] = [
      { source: "nonsense", copy: lib("a"), how: "copied" },
      { source: src("a"), copy: "nonsense", how: "copied" },
      { source: `Compendium.dnd5e.items.${id("a")}`, copy: lib("a"), how: "copied" }, // no type
      { source: src("a"), copy: src("a", "items2"), how: "copied" }, // the copy is not in the Library
      { source: lib("a"), copy: lib("a", "eagle-weapons-2024"), how: "copied" }, // the source is in the Library
      { source: src("a", "items", "Actor"), copy: lib("a"), how: "copied" }, // another document type
      { source: `${src("a")}.ActiveEffect.${id("e")}`, copy: lib("a"), how: "copied" }, // not a main part
    ];
    const map = linkMapFrom(bad);
    expect(map.size).toBe(0);
    expect(map.invalid).toHaveLength(bad.length);
    for (const item of map.invalid) expect(item.detail).toEqual(expect.any(String));
    expect(map.invalid.map((item) => item.detail)).toEqual([
      "the source is not the main part of a UUID with a type",
      "the copy is not the main part of a UUID with a type",
      "the source is not the main part of a UUID with a type",
      "the copy is not in an Eagle Compendium",
      "the source is in an Eagle Compendium already",
      "the source and the copy are not of the same document type",
      "the source is not the main part of a UUID with a type",
    ]);
  });

  it("is frozen, never throws and is empty for no entries", () => {
    const map = linkMapFrom([entry("a")]);
    expect(Object.isFrozen(map)).toBe(true);
    expect(Object.isFrozen(map.entries)).toBe(true);
    expect(EMPTY_LINK_MAP.size).toBe(0);
    expect(EMPTY_LINK_MAP.lookup(at(src("a")))).toBeUndefined();
  });
});

describe("the entries of a copy", () => {
  const copied = (n: string, target = lib(n)) => ({ source: src(n), uuid: target, id: id(n), name: `Name ${n}` });
  const ok = (over: Record<string, unknown> = {}): CopyResult =>
    ({ ok: true, pack: "world.eagle-weapons-2014", target: "eagle-weapons-2014", created: [copied("a")], existed: [copied("b")], ...over }) as unknown as CopyResult;

  it("takes every document that was made or was there already, a container with its contents", () => {
    const entries = entriesFromCopyResult(ok({ created: [copied("box", lib("box", "eagle-containers-2014")), copied("t1", lib("t1", "eagle-containers-2014"))] }));
    expect(entries.map((e) => [e.source, e.copy, e.how])).toEqual([
      [src("box"), lib("box", "eagle-containers-2014"), "copied"],
      [src("t1"), lib("t1", "eagle-containers-2014"), "copied"],
      [src("b"), lib("b"), "copied"],
    ]);
  });

  it("has no entry for a forced copy, for a refusal, or for nothing that was made", () => {
    expect(entriesFromCopyResult(ok({ forced: true }))).toEqual([]);
    expect(entriesFromCopyResult({ ok: false, reason: "duplicate", detail: "x" })).toEqual([]);
    expect(entriesFromCopyResult(ok({ created: [], existed: [] }))).toEqual([]);
  });

  it("maps a duplicate that was not copied to the first entry that carries the key", () => {
    const protocol = { source: src("a"), reason: "duplicate" as const, existing: [lib("x"), lib("y")] };
    expect(entryFromProtocol(protocol)).toEqual({ source: src("a"), copy: lib("x"), how: "existing" });
    expect(entryFromProtocol({ ...protocol, existing: [] })).toBeUndefined();
    expect(entryFromProtocol({ ...protocol, reason: "no-art" })).toBeUndefined();
  });

  it("builds an entry for a plan", () => {
    expect(plannedEntry(src("a"), lib("a"))).toEqual({ source: src("a"), copy: lib("a"), how: "planned" });
  });
});
