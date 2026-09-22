import { describe, expect, it } from "vitest";
import { linkMapFrom, type LinkEntry } from "./link-map";
import {
  PROBLEM_OUTCOMES,
  rewriteLinks,
  scanLinks,
  SOURCE_FIELDS,
  summarizeReferences,
  type Json,
  type TargetLookup,
} from "./rewrite-links";

const id = (n: string) => n.padEnd(16, "0");
const src = (n: string, pack = "items", type = "Item") => `Compendium.dnd5e.${pack}.${type}.${id(n)}`;
const lib = (n: string, pack = "eagle-feats-2014", type = "Item") => `Compendium.world.${pack}.${type}.${id(n)}`;
const legacy = (n: string, pack = "classfeatures") => `Compendium.dnd5e.${pack}.${id(n)}`;
const entry = (n: string, copy = lib(n), source = src(n)): LinkEntry => ({ source, copy, how: "copied" });
const mapOf = (...names: string[]) => linkMapFrom(names.map((n) => entry(n)));

const run = (data: unknown, map = mapOf("a", "b"), options = {}) => rewriteLinks(data as Json, map, options);
const rewrite = (data: unknown, map: ReturnType<typeof mapOf>, options = {}) => rewriteLinks(data as Json, map, options);
const scan = (data: unknown, options: { lookup?: TargetLookup } = {}) => scanLinks(data as Json, options);

describe("rewriteLinks: V1, UUIDs as the value of a field", () => {
  it("rewrites a UUID that is the whole value, in a field of a structure, in a list and in an object", () => {
    const data = { system: { advancement: { ab12: { configuration: { items: [{ uuid: src("a"), optional: false }, { uuid: src("b") }] } } } } };
    const result = run(data);
    expect(result.data).toEqual({ system: { advancement: { ab12: { configuration: { items: [{ uuid: lib("a"), optional: false }, { uuid: lib("b") }] } } } } });
    expect(result.changes.map((c) => c.path)).toEqual(["system.advancement.ab12.configuration.items.0.uuid", "system.advancement.ab12.configuration.items.1.uuid"]);
    expect(result.changes[0]).toEqual({ path: "system.advancement.ab12.configuration.items.0.uuid", from: src("a"), to: lib("a") });
  });

  it("rewrites a UUID in a field that no rule knows: the field is not asked for", () => {
    const data = { flags: { "some-module": { deep: { list: [{ target: src("a") }] } } }, oddField: src("b") };
    expect(run(data).data).toEqual({ flags: { "some-module": { deep: { list: [{ target: lib("a") }] } } }, oddField: lib("b") });
  });

  it("rewrites the origin of an effect and the fields of a table result, a set of spells and a consumption target", () => {
    const data = {
      effects: [{ _id: id("e"), origin: src("a"), changes: [{ key: "x", value: src("b") }] }],
      results: [{ documentUuid: src("a") }],
      system: { spells: [src("a"), src("b")], activities: { x1: { consumption: { targets: [{ target: src("b") }] } } } },
    };
    const out = run(data).data as any;
    expect(out.effects[0].origin).toBe(lib("a"));
    expect(out.effects[0].changes[0].value).toBe(lib("b"));
    expect(out.results[0].documentUuid).toBe(lib("a"));
    expect(out.system.spells).toEqual([lib("a"), lib("b")]);
    expect(out.system.activities.x1.consumption.targets[0].target).toBe(lib("b"));
  });

  it("rewrites the map of added items of an advancement: the id stays a key, the UUID is the value", () => {
    const data = { system: { advancement: { a1: { value: { added: { [id("k")]: src("a") } } } } } };
    expect(run(data).data).toEqual({ system: { advancement: { a1: { value: { added: { [id("k")]: lib("a") } } } } } });
  });

  it("writes the form with a type when the reference stood in the older form", () => {
    const data = { grants: [legacy("a")] };
    const result = run(data, linkMapFrom([entry("a", lib("a"), src("a", "classfeatures"))]));
    expect(result.data).toEqual({ grants: [lib("a")] });
    expect(result.references[0]).toMatchObject({ outcome: "rewritten", uuid: legacy("a"), to: lib("a") });
  });

  it("keeps what follows the main part: embedded parts and an anchor", () => {
    const data = { a: `${src("a")}.ActiveEffect.${id("e")}`, b: `${src("b")}#some-anchor`, c: `${src("a")}.Item.${id("i")}.Activity.${id("x")}#h` };
    expect(run(data).data).toEqual({ a: `${lib("a")}.ActiveEffect.${id("e")}`, b: `${lib("b")}#some-anchor`, c: `${lib("a")}.Item.${id("i")}.Activity.${id("x")}#h` });
  });
});

describe("rewriteLinks: V2, links in a text", () => {
  it("rewrites the UUID of @UUID and @Embed and keeps the label and the options", () => {
    const text = `<p>See @UUID[${src("a")}]{Fire Bolt} and @UUID[${src("b")}] and</p>@Embed[${src("a")} inline caption=false cite=true classes="x y"]`;
    const out = run({ description: { value: text } }).data as any;
    expect(out.description.value).toBe(`<p>See @UUID[${lib("a")}]{Fire Bolt} and @UUID[${lib("b")}] and</p>@Embed[${lib("a")} inline caption=false cite=true classes="x y"]`);
  });

  it("rewrites every UUID in a text and in a link with an anchor", () => {
    const text = `@UUID[${src("a")}#the-anchor]{A} ${src("b")} @UUID[${src("a")}]`;
    expect(run(text).data).toBe(`@UUID[${lib("a")}#the-anchor]{A} ${lib("b")} @UUID[${lib("a")}]`);
  });

  it("rewrites a UUID in a page of a journal and leaves the rest of the html", () => {
    const html = `<h2>Title &amp; more</h2><p>@UUID[${src("a")}#h &amp; x]{Label &lt;1&gt;}</p>`;
    expect(run({ pages: [{ text: { content: html } }] }).data).toEqual({ pages: [{ text: { content: `<h2>Title &amp; more</h2><p>@UUID[${lib("a")}#h &amp; x]{Label &lt;1&gt;}</p>` } }] });
  });
});

describe("rewriteLinks: V3, relative and local references stay", () => {
  it("does not touch a relative link, a local id, an activity reference or a container id", () => {
    const data = {
      text: `@UUID[.${id("e")}#anchor]{x} @Embed[.${id("e")}] [[/damage activity=${id("act")}]]`,
      system: { container: id("box"), advancement: { [id("adv")]: { _id: id("adv"), configuration: { hint: "x" } } } },
      effects: [{ _id: id("e") }],
    };
    const result = run(data);
    expect(result.data).toEqual(data);
    expect(result.changes).toEqual([]);
    expect(result.references).toEqual([]);
  });

  it("does not take a UUID of the world for a Compendium UUID", () => {
    const data = { a: `Item.${id("a")}`, b: `Actor.${id("a")}.Item.${id("b")}`, c: `@UUID[Item.${id("a")}]` };
    expect(run(data).changes).toEqual([]);
  });
});

describe("rewriteLinks: V4, the fields of origin stay on the source (N10)", () => {
  it("keeps the four fields, at the top and in embedded documents, also in the older form", () => {
    const data = {
      _stats: { compendiumSource: src("a"), duplicateSource: legacy("a", "items") },
      flags: { core: { sourceId: src("a") }, dnd5e: { sourceId: src("b") } },
      items: [{ _stats: { compendiumSource: src("a") }, flags: { dnd5e: { sourceId: src("b") } }, effects: [{ _stats: { compendiumSource: src("a") } }] }],
    };
    const result = run(data);
    expect(result.data).toEqual(data);
    expect(result.changes).toEqual([]);
    expect(result.references.every((r) => r.outcome === "kept-source")).toBe(true);
    expect(result.references).toHaveLength(7);
  });

  it("names exactly the four fields", () => {
    expect([...SOURCE_FIELDS]).toEqual(["_stats.compendiumSource", "_stats.duplicateSource", "flags.core.sourceId", "flags.dnd5e.sourceId"]);
  });

  it("does rewrite a field that only looks like one: another key, another flag, a sourceId elsewhere", () => {
    const data = { flags: { dnd5e: { other: src("a") }, "my-module": { sourceId: src("a") } }, _stats: { modifiedTime: src("a") }, sourceId: src("b"), compendiumSource: src("b") };
    const out = run(data).data as any;
    expect(out.flags.dnd5e.other).toBe(lib("a"));
    expect(out.flags["my-module"].sourceId).toBe(lib("a"));
    expect(out._stats.modifiedTime).toBe(lib("a"));
    expect(out.sourceId).toBe(lib("b"));
    expect(out.compendiumSource).toBe(lib("b"));
  });

  it("rewrites the origin of an effect next to a field of origin in the same document", () => {
    const data = { effects: [{ origin: src("a"), _stats: { compendiumSource: src("a") } }] };
    const out = run(data).data as any;
    expect(out.effects[0].origin).toBe(lib("a"));
    expect(out.effects[0]._stats.compendiumSource).toBe(src("a"));
  });

  it("does not report text in a field of origin that starts with Compendium. and is not a UUID: it stays as it stands", () => {
    const data = { _stats: { compendiumSource: "Compendium.srd.items.Item.short" }, other: "Compendium.srd.items.Item.short" };
    const result = run(data);
    expect(result.data).toEqual(data);
    expect(result.references.map((r) => [r.path, r.outcome])).toEqual([["other", "unresolvable"]]);
  });

  it("keeps a field of origin that holds text with more than a UUID", () => {
    const data = { _stats: { compendiumSource: `x ${src("a")} y` } };
    expect(run(data).data).toEqual(data);
  });
});

describe("rewriteLinks: V8 and the targets that are not in the map", () => {
  const info: Record<string, ReturnType<TargetLookup>> = {
    "dnd5e.items": { installed: true, exists: true },
    "dnd-monster-manual.actors": { installed: false },
    "dnd5e.heroes": { installed: true, exists: true, noArt: true },
    "dnd5e.spells": { installed: true, exists: false },
  };
  const lookup: TargetLookup = (scope, pack) => info[`${scope}.${pack}`];

  it("leaves the reference as it is and says why", () => {
    const data = {
      notCopied: src("z"),
      package: `Compendium.dnd-monster-manual.actors.Actor.${id("m")}`,
      character: src("h", "heroes", "Actor"),
      gone: src("g", "spells"),
    };
    const result = run(data, mapOf("a"), { lookup });
    expect(result.data).toEqual(data);
    expect(result.references.map((r) => [r.path, r.outcome])).toEqual([
      ["notCopied", "not-copied"], ["package", "package-missing"], ["character", "no-art"], ["gone", "target-missing"],
    ]);
  });

  it("calls every target that is not in the map not-copied when nobody says more", () => {
    expect(run({ x: src("z") }).references[0]).toMatchObject({ outcome: "not-copied" });
    expect(run({ x: src("z") }, mapOf("a"), { lookup: () => undefined }).references[0]).toMatchObject({ outcome: "not-copied" });
  });

  it("uses the map before it asks the lookup", () => {
    let asked = 0;
    const result = run({ x: src("a") }, mapOf("a"), { lookup: () => { asked++; return { installed: false }; } });
    expect(result.references[0]).toMatchObject({ outcome: "rewritten" });
    expect(asked).toBe(0);
  });

  it("does not change a reference that points into the Library already", () => {
    const data = { x: lib("q"), y: `@UUID[${lib("q", "eagle-journals", "JournalEntry")}]` };
    const result = run(data, mapOf("a"));
    expect(result.data).toEqual(data);
    expect(result.references.map((r) => r.outcome)).toEqual(["in-library", "in-library"]);
  });
});

describe("rewriteLinks: links of a document to itself, duplicates that were forced or skipped", () => {
  it("points a link of a forced copy to itself at the copy and links to the source of other documents at the entry that carries the key", () => {
    // the map: the source is the entry that carries the key ("main"); the forced copy has another id
    const main = lib("main");
    const forced = lib("newid");
    const map = linkMapFrom([{ source: src("a"), copy: main, how: "existing" }, entry("b")]);
    const data = { effects: [{ origin: src("a") }], text: `@UUID[${src("a")}]`, other: src("b") };
    const own = rewrite(data, map, { self: { source: src("a"), copy: forced } });
    expect((own.data as any).effects[0].origin).toBe(forced);
    expect((own.data as any).text).toBe(`@UUID[${forced}]`);
    expect((own.data as any).other).toBe(lib("b"));
    // another document that points at the source
    const foreign = rewrite({ x: src("a") }, map);
    expect((foreign.data as any).x).toBe(main);
  });

  it("takes self for the embedded parts and for the older form of the document", () => {
    const data = { a: `${src("a")}.ActiveEffect.${id("e")}`, b: legacy("a", "items") };
    const out = rewrite(data, mapOf(), { self: { source: src("a"), copy: lib("a2") } }).data as any;
    expect(out.a).toBe(`${lib("a2")}.ActiveEffect.${id("e")}`);
    expect(out.b).toBe(lib("a2"));
  });

  it("points a link to a skipped duplicate at the entry that exists", () => {
    const map = linkMapFrom([{ source: src("dup"), copy: lib("held"), how: "existing" }]);
    expect((rewrite({ grant: [src("dup")] }, map).data as any).grant).toEqual([lib("held")]);
  });

  it("ignores a self whose UUIDs are not main parts with a type", () => {
    const data = { x: src("a") };
    expect(rewrite(data, mapOf(), { self: { source: "nonsense", copy: lib("a") } }).changes).toEqual([]);
    expect(rewrite(data, mapOf(), { self: { source: src("a"), copy: "nonsense" } }).changes).toEqual([]);
  });
});

describe("rewriteLinks: the report and the rules of the function", () => {
  it("reports every reference with its path, the main part as it stood and, for a rewritten one, where it went", () => {
    const result = run({ list: [{ uuid: src("a") }], text: `@UUID[${src("z")}]` });
    expect(result.references).toEqual([
      { path: "list.0.uuid", uuid: src("a"), outcome: "rewritten", to: lib("a") },
      { path: "text", uuid: src("z"), outcome: "not-copied" },
    ]);
  });

  it("names a UUID as an object key and text that starts with Compendium. and is not a UUID as unresolvable, and does not change them", () => {
    const data = { [src("a")]: "value", note: "see Compendium.dnd5e.items.Item.tooshort", other: "Compendium.", fine: src("a") };
    const result = run(data);
    const bad = result.references.filter((r) => r.outcome === "unresolvable");
    expect(bad.map((r) => r.path)).toEqual([src("a"), "note", "other"]);
    expect(Object.keys(result.data as object)).toEqual(Object.keys(data));
    expect((result.data as any).note).toBe(data.note);
    expect((result.data as any).fine).toBe(lib("a"));
  });

  it("does not change what it was given, and gives back new objects", () => {
    const data = { a: { list: [src("a"), { b: src("b") }] }, keep: 1 };
    const before = JSON.stringify(data);
    const result = run(data);
    expect(JSON.stringify(data)).toBe(before);
    expect(result.data).not.toBe(data);
    expect((result.data as any).a).not.toBe(data.a);
  });

  it("changes nothing in a second run over its own result", () => {
    const data = { a: src("a"), t: `@Embed[${src("b")} inline]`, g: legacy("a"), _stats: { compendiumSource: src("a") } };
    const map = linkMapFrom([entry("a"), entry("b"), entry("a", lib("a"), src("a", "classfeatures"))]);
    const first = rewrite(data, map);
    expect(first.changes.length).toBeGreaterThan(0);
    const second = rewrite(first.data, map);
    expect(second.changes).toEqual([]);
    expect(second.data).toEqual(first.data);
  });

  it("passes numbers, booleans, null and text without a UUID through unchanged", () => {
    const data = { n: 5, b: true, z: null, s: "plain text", list: [1, "x", null, false], empty: {}, nested: { emptyList: [] } };
    const result = run(data);
    expect(result.data).toEqual(data);
    expect(result.references).toEqual([]);
  });

  it("scans without changing and with the same references", () => {
    const data = { a: src("a"), b: `Compendium.dnd-monster-manual.actors.Actor.${id("m")}`, c: lib("q"), _stats: { compendiumSource: src("a") } };
    const lookup: TargetLookup = (scope) => (scope === "dnd-monster-manual" ? { installed: false } : { installed: true, exists: true });
    const references = scan(data, { lookup });
    expect(references.map((r) => r.outcome)).toEqual(["not-copied", "package-missing", "in-library", "kept-source"]);
  });

  it("summarizes: counts by outcome, and the problems are the references that do not end in an Eagle Compendium", () => {
    const references = scan(
      { a: src("a"), b: lib("b"), c: `Compendium.x.y.Item.${id("c")}`, d: "Compendium.", _stats: { compendiumSource: src("a") } },
      { lookup: (scope) => (scope === "x" ? { installed: false } : { installed: true, exists: true }) },
    );
    const summary = summarizeReferences(references);
    expect(summary.total).toBe(5);
    expect(summary.counts).toMatchObject({ "not-copied": 1, "in-library": 1, "package-missing": 1, unresolvable: 1, "kept-source": 1, rewritten: 0 });
    expect(summary.problems.map((p) => p.outcome)).toEqual(["not-copied", "package-missing", "unresolvable"]);
    expect([...PROBLEM_OUTCOMES]).toEqual(["not-copied", "no-art", "package-missing", "target-missing", "unresolvable"]);
    expect(summary.problems.every((p) => PROBLEM_OUTCOMES.includes(p.outcome))).toBe(true);
  });

  it("works on a whole document made of the forms of dnd5e: an item of a class with grants, a text and effects", () => {
    const map = linkMapFrom([
      entry("f1", lib("f1"), src("f1", "classfeatures")),
      entry("f2", lib("f2"), src("f2", "classfeatures")),
      entry("sp", lib("sp", "eagle-spells-2014"), src("sp", "spells")),
    ]);
    const doc = {
      _id: id("cls"), name: "Class", type: "class",
      system: {
        advancement: {
          a1: { type: "ItemGrant", configuration: { items: [{ uuid: legacy("f1"), optional: false }, { uuid: src("f2", "classfeatures") }] } },
          a2: { type: "ItemChoice", configuration: { pool: [{ uuid: src("sp", "spells", "Item") }] } },
        },
        description: { value: `<p>@UUID[${src("f1", "classfeatures")}]{Feature} and @UUID[.${id("e1")}]{x}</p>` },
      },
      effects: [{ _id: id("e1"), origin: src("f1", "classfeatures") }],
      _stats: { compendiumSource: src("cls", "classes") },
    };
    const result = rewrite(doc, map, { lookup: () => ({ installed: true, exists: true }) });
    const out = result.data as any;
    expect(out.system.advancement.a1.configuration.items.map((i: any) => i.uuid)).toEqual([lib("f1"), lib("f2")]);
    expect(out.system.advancement.a2.configuration.pool[0].uuid).toBe(lib("sp", "eagle-spells-2014"));
    expect(out.system.description.value).toBe(`<p>@UUID[${lib("f1")}]{Feature} and @UUID[.${id("e1")}]{x}</p>`);
    expect(out.effects[0].origin).toBe(lib("f1"));
    expect(out._stats.compendiumSource).toBe(src("cls", "classes"));
    expect(summarizeReferences(result.references).problems).toEqual([]);
    expect(result.changes).toHaveLength(5);
  });
});
