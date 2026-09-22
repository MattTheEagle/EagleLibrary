import { describe, expect, it, vi } from "vitest";
import {
  checkDocumentLinks,
  collapseChanges,
  libraryEntries,
  linkRun,
  MAX_REPORTED_PROBLEMS,
  referencedSources,
  reportLinks,
  type LibraryIds,
  type LinkWorld,
  type RunDocument,
} from "./relink";
import type { Json, LinkChange, LinkReference, TargetInfo } from "./rewrite-links";
import { parsePrimary } from "./uuid";

const id = (n: string) => n.padEnd(16, "0");
const src = (n: string, pack = "items", type = "Item") => `Compendium.dnd5e.${pack}.${type}.${id(n)}`;
const lib = (n: string, pack = "eagle-feats-2014", type = "Item") => `Compendium.world.${pack}.${type}.${id(n)}`;
const ref = (text: string) => parsePrimary(text)!;
const change = (path: string, from = "a", to = "b"): LinkChange => ({ path, from, to });

describe("collapseChanges", () => {
  const data: Json = { system: { advancement: { ab: { configuration: { items: [{ uuid: "n1" }, { uuid: "n2" }] } } }, note: "N" }, items: [{ a: 1 }, { a: 2 }], effects: [{ origin: "E" }], name: "x" };

  it("reduces a change inside a list to the whole list and gives the value of the rewritten data", () => {
    const out = collapseChanges([change("system.advancement.ab.configuration.items.0.uuid"), change("system.advancement.ab.configuration.items.1.uuid")], data, 50);
    expect(out).toEqual({ "system.advancement.ab.configuration.items": [{ uuid: "n1" }, { uuid: "n2" }] });
  });

  it("keeps the path of a change that is not in a list, and one path for each field", () => {
    const out = collapseChanges([change("system.note"), change("name"), change("effects.0.origin")], data, 50);
    expect(out).toEqual({ "system.note": "N", name: "x", effects: [{ origin: "E" }] });
  });

  it("puts no path under another path that is there", () => {
    const out = collapseChanges([change("system.note"), change("system.advancement.ab.configuration.items.0.uuid"), change("system")], data, 50);
    expect(Object.keys(out)).toEqual(["system"]);
    const nested = collapseChanges([change("items.0.a"), change("items.1.a"), change("items")], data, 50);
    expect(Object.keys(nested)).toEqual(["items"]);
  });

  it("reduces every path to the first field when there are more paths than the limit allows", () => {
    const many: LinkChange[] = [];
    for (let i = 0; i < 6; i++) many.push(change(`system.f${i}`));
    many.push(change("effects.0.origin"), change("name"));
    const big: Json = { system: { f0: 0, f1: 1, f2: 2, f3: 3, f4: 4, f5: 5 }, effects: [{ origin: "E" }], name: "x" };
    // at the limit nothing is reduced
    expect(Object.keys(collapseChanges(many, big, 8))).toHaveLength(8);
    const reduced = collapseChanges(many, big, 5);
    expect(Object.keys(reduced).sort()).toEqual(["effects", "name", "system"]);
    expect(reduced.system).toEqual({ f0: 0, f1: 1, f2: 2, f3: 3, f4: 4, f5: 5 });
  });

  it("has no path for no change and gives null for a path that the data does not have", () => {
    expect(collapseChanges([], data, 50)).toEqual({});
    expect(collapseChanges([change("gone.deeper")], data, 50)).toEqual({ "gone.deeper": null });
  });
});

describe("referencedSources", () => {
  it("lists every UUID once for a document, in every field and text, but not the fields of origin and not the Library", () => {
    const docs: Json[] = [
      { a: src("a"), t: `@UUID[${src("b")}]{x} ${src("a")}`, _stats: { compendiumSource: src("z") }, l: lib("q"), rel: `@UUID[.${id("e")}]` },
      { c: `Compendium.dnd5e.classfeatures.${id("c")}`, d: src("a") },
    ];
    const found = referencedSources(docs);
    expect(found.map((f) => [f.pack, f.id, f.form])).toEqual([["items", id("a"), "typed"], ["items", id("b"), "typed"], ["classfeatures", id("c"), "legacy"]]);
  });

  it("finds a document once whatever the form it is written in", () => {
    const found = referencedSources([{ a: src("a", "classfeatures"), b: `Compendium.dnd5e.classfeatures.${id("a")}` }]);
    expect(found).toHaveLength(1);
  });

  it("finds nothing in a document without links", () => {
    expect(referencedSources([{ a: "plain", n: 5 }])).toEqual([]);
  });
});

describe("libraryEntries", () => {
  const ids: LibraryIds = new Map([
    [id("a"), { compendium: "eagle-feats-2014", documentName: "Item" }],
    [id("j"), { compendium: "eagle-journals", documentName: "JournalEntry" }],
  ]);

  it("maps a referenced document to the document of the same id in the Library, and writes the type it was found with", () => {
    const entries = libraryEntries([ref(src("a")), ref(src("j", "content", "JournalEntry"))], ids, []);
    expect(entries).toEqual([
      { source: src("a"), copy: lib("a"), how: "copied" },
      { source: src("j", "content", "JournalEntry"), copy: lib("j", "eagle-journals", "JournalEntry"), how: "copied" },
    ]);
  });

  it("finds a document referenced in the older form, without the type, and gives it the type of what was found", () => {
    const entries = libraryEntries([ref(`Compendium.dnd5e.classfeatures.${id("a")}`)], ids, []);
    expect(entries).toEqual([{ source: src("a", "classfeatures"), copy: lib("a"), how: "copied" }]);
  });

  it("does not take a document of another type for the same id", () => {
    expect(libraryEntries([ref(src("a", "items", "Actor"))], ids, [])).toEqual([]);
  });

  it("uses the protocol for a duplicate that was skipped, the first entry that carries the key, also for the older form", () => {
    const protocol = [{ source: src("d", "classfeatures"), reason: "duplicate", existing: [lib("x"), lib("y")] }];
    expect(libraryEntries([ref(src("d", "classfeatures"))], ids, protocol)).toEqual([{ source: src("d", "classfeatures"), copy: lib("x"), how: "existing" }]);
    expect(libraryEntries([ref(`Compendium.dnd5e.classfeatures.${id("d")}`)], ids, protocol)).toHaveLength(1);
  });

  it("does not use a protocol entry that is no duplicate, or has nothing that carries the key, or is another document", () => {
    const protocol = [
      { source: src("d"), reason: "no-art", existing: [lib("x")] },
      { source: src("e"), reason: "duplicate", existing: [] },
      { source: src("f"), reason: "duplicate", existing: [lib("x")] },
    ];
    expect(libraryEntries([ref(src("d")), ref(src("e")), ref(src("g"))], ids, protocol)).toEqual([]);
  });

  it("prefers the document that is in the Library to the protocol", () => {
    const protocol = [{ source: src("a"), reason: "duplicate", existing: [lib("x")] }];
    expect(libraryEntries([ref(src("a"))], ids, protocol)[0]?.how).toBe("copied");
  });
});

function makeWorld(over: { ids?: LibraryIds; targets?: Record<string, TargetInfo | undefined>; data?: Record<string, Json> } = {}) {
  const world: LinkWorld = {
    libraryIds: vi.fn(async () => over.ids ?? new Map()),
    describeTarget: vi.fn(async (scope, pack, i) => over.targets?.[`${scope}.${pack}.${i}`]),
    readData: vi.fn(async (uuid) => over.data?.[uuid]),
  };
  return world;
}
const doc = (n: string, data: Json, copy = lib(n, "eagle-weapons-2014")): RunDocument => ({ source: src(n), copy, data });

describe("linkRun", () => {
  it("points the links between the documents of the run at their planned copies, without reading the world", async () => {
    const world = makeWorld();
    const run = await linkRun(world, [doc("a", { x: src("b") }), doc("b", { y: `@UUID[${src("a")}]` })], [], 50);
    expect(run.changes).toEqual([{ x: lib("b", "eagle-weapons-2014") }, { y: `@UUID[${lib("a", "eagle-weapons-2014")}]` }]);
    expect(world.libraryIds).not.toHaveBeenCalled();
    expect(world.describeTarget).not.toHaveBeenCalled();
    expect(run.map).toEqual({ size: 2, conflicts: 0, invalid: 0 });
  });

  it("points a link at a document that another portion of the run writes, without reading the world", async () => {
    const world = makeWorld();
    const other = { source: src("b"), copy: lib("b", "eagle-feats-2014"), how: "planned" as const };
    const run = await linkRun(world, [doc("a", { x: src("b") })], [], 50, [other]);
    expect(run.changes).toEqual([{ x: lib("b", "eagle-feats-2014") }]);
    expect(world.libraryIds).not.toHaveBeenCalled();
    expect(world.describeTarget).not.toHaveBeenCalled();
  });

  it("points a link of a document to itself at its own copy, in a forced copy the one with the new id", async () => {
    const run = await linkRun(makeWorld(), [{ source: src("a"), copy: lib("NEWID", "eagle-weapons-2014"), data: { effects: [{ origin: src("a") }] } }], [], 50);
    expect(run.changes[0]).toEqual({ effects: [{ origin: lib("NEWID", "eagle-weapons-2014") }] });
  });

  it("takes what the run covers before what the Library holds", async () => {
    const ids: LibraryIds = new Map([[id("b"), { compendium: "eagle-feats-2014", documentName: "Item" }]]);
    const run = await linkRun(makeWorld({ ids }), [doc("a", { x: src("b") }), doc("b", {})], [], 50);
    expect(run.changes[0]).toEqual({ x: lib("b", "eagle-weapons-2014") });
    expect(run.map.conflicts).toBe(0);
  });

  it("finds a link to a document that is in the Library and asks the world about what is not covered, once for each target", async () => {
    const ids: LibraryIds = new Map([[id("f"), { compendium: "eagle-feats-2014", documentName: "Item" }]]);
    const world = makeWorld({ ids, targets: { [`dnd5e.items.${id("lost")}`]: { installed: true, exists: false } } });
    const run = await linkRun(world, [doc("a", { a: [src("f"), src("lost")], b: src("lost") })], [], 50);
    expect(run.changes[0]).toEqual({ a: [lib("f"), src("lost")] });
    expect(world.describeTarget).toHaveBeenCalledTimes(1);
    expect(run.references.map((r) => r.outcome)).toEqual(["rewritten", "target-missing", "target-missing"]);
  });

  it("treats a target that the world cannot describe, or whose description fails, as not copied", async () => {
    const world = makeWorld();
    (world.describeTarget as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("no"));
    const run = await linkRun(world, [doc("a", { a: src("x"), b: src("y") })], [], 50);
    expect(run.references.map((r) => r.outcome)).toEqual(["not-copied", "not-copied"]);
  });

  it("leaves the fields of origin alone", async () => {
    const run = await linkRun(makeWorld(), [doc("a", { _stats: { compendiumSource: src("a") }, flags: { dnd5e: { sourceId: src("b") } } })], [], 50);
    expect(run.changes[0]).toEqual({});
    expect(run.references.every((r) => r.outcome === "kept-source")).toBe(true);
  });

  it("gives one set of changes for each document, in the order given, empty for a document without links", async () => {
    const run = await linkRun(makeWorld(), [doc("a", { n: 1 }), doc("b", { x: src("a") }), doc("c", "plain")], [], 50);
    expect(run.changes).toEqual([{}, { x: lib("a", "eagle-weapons-2014") }, {}]);
  });

  it("gives the map of the run: entries and what was wrong with entries", async () => {
    const run = await linkRun(makeWorld(), [{ source: "nonsense", copy: lib("a"), data: {} }], [], 50);
    expect(run.map).toEqual({ size: 0, conflicts: 0, invalid: 1 });
  });
});

describe("reportLinks", () => {
  const references = (n: number): LinkReference[] => Array.from({ length: n }, (_, i) => ({ path: `p${i}`, uuid: src(`x${i}`), outcome: "not-copied" as const }));

  it("counts every outcome and lists the problems, at most 50, and says how many are left out", () => {
    const mixed: LinkReference[] = [...references(3), { path: "q", uuid: src("r"), outcome: "rewritten", to: lib("r") }, { path: "k", uuid: src("k"), outcome: "kept-source" }];
    const report = reportLinks(mixed);
    expect(report.total).toBe(5);
    expect(report.counts).toMatchObject({ "not-copied": 3, rewritten: 1, "kept-source": 1 });
    expect(report.problems).toHaveLength(3);
    expect(report.truncated).toBe(0);
    const big = reportLinks(references(MAX_REPORTED_PROBLEMS + 7));
    expect(big.problems).toHaveLength(MAX_REPORTED_PROBLEMS);
    expect(big.truncated).toBe(7);
    expect(big.problems[0]?.path).toBe("p0");
  });

  it("is empty for no references", () => {
    expect(reportLinks([])).toMatchObject({ total: 0, problems: [], truncated: 0 });
  });
});

describe("checkDocumentLinks", () => {
  const inLibrary = lib("d", "eagle-feats-2014");

  it("reports the links of a document in an Eagle Compendium without changing anything", async () => {
    const world = makeWorld({
      data: { [inLibrary]: { a: src("s1"), b: lib("q"), c: `Compendium.dnd-monster-manual.actors.Actor.${id("m")}`, _stats: { compendiumSource: src("o") } } },
      targets: { [`dnd-monster-manual.actors.${id("m")}`]: { installed: false } },
    });
    const check = await checkDocumentLinks(world, inLibrary);
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.links.counts).toMatchObject({ "not-copied": 1, "in-library": 1, "package-missing": 1, "kept-source": 1 });
      expect(check.links.problems.map((p) => p.path)).toEqual(["a", "c"]);
    }
  });

  it("says why it cannot: a UUID that is not the main part of a document in an Eagle Compendium, a document that is not there, a read that fails", async () => {
    const world = makeWorld();
    for (const uuid of [src("a"), "nonsense", "", `${inLibrary}.ActiveEffect.${id("e")}`, 5 as never]) {
      expect(await checkDocumentLinks(world, uuid), String(uuid)).toMatchObject({ ok: false, reason: "not-in-library" });
    }
    expect(await checkDocumentLinks(world, inLibrary)).toMatchObject({ ok: false, reason: "not-found" });
    (world.readData as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    expect(await checkDocumentLinks(world, inLibrary)).toMatchObject({ ok: false, reason: "read-failed", detail: "boom" });
  });
});
