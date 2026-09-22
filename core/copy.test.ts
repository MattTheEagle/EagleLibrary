import { describe, expect, it, vi } from "vitest";
import { compendiaOf, CATALOG, expectedCompendia, type ExpectedCompendium } from "./catalog";
import {
  copyDocument,
  planCopy,
  MAX_CONTAINER_DEPTH,
  MAX_DOCUMENTS_PER_COPY,
  type ContainedEntry,
  type CopyDeps,
  type CopySource,
  type CopyWorld,
  type IndexEntry,
} from "./copy";
import type { RequestApi } from "./compendium-setup";
import { parseProtocol, type Protocol } from "./protocol";

const kind = (key: string) => CATALOG.find((entry) => entry.key === key)!;
const compendium = (key: string, version?: string): ExpectedCompendium =>
  compendiaOf(kind(key)).find((c) => c.version === version)!;

const SRC_PACK = { collection: "dnd5e.items", packageType: "system", name: "items", type: "Item" };
const uuidOf = (id: string, collection = "dnd5e.items", documentName = "Item") => `Compendium.${collection}.${documentName}.${id}`;

const item = (id: string, over: Partial<CopySource> = {}): CopySource => ({
  uuid: uuidOf(id),
  id,
  name: `Name ${id}`,
  documentName: "Item",
  subtype: "weapon",
  rules: "2014",
  primary: true,
  pack: SRC_PACK,
  ...over,
});

interface Setup {
  documents?: CopySource[];
  // The Eagle compendia that exist with their entries: name -> entries. Every compendium of the catalog that is not here does not exist.
  eagle?: Record<string, IndexEntry[]>;
  contained?: ContainedEntry[];
  gm?: boolean;
  noApi?: boolean;
  // The text of the protocol setting at the start.
  protocol?: string;
  // Writes of the protocol that fail this many times before they work (Infinity: always).
  protocolFails?: number;
  // The data of documents by UUID (a UUID that is not here has the data `{}`), the UUIDs whose data cannot be read.
  data?: Record<string, unknown>;
  noData?: string[];
  // What the world says of a link target: by "scope.pack.id"; a target that is not here is `{ installed: true, exists: true }`.
  targets?: Record<string, { installed: boolean; exists?: boolean; noArt?: boolean }>;
  // The text of the spell list setting at the start; writes of it that fail this many times.
  spellLists?: string;
  spellListFails?: number;
}

// The world and Flight Control as the contract describes compendium.import: it answers what it was given, as created.
function make(setup: Setup = {}) {
  const documents = new Map((setup.documents ?? []).map((d) => [d.uuid, d]));
  const eagle = new Map(Object.entries(setup.eagle ?? {}));
  const world: CopyWorld = {
    readDocument: vi.fn(async (uuid: string) => documents.get(uuid)),
    eagleIndex: vi.fn(async (c: ExpectedCompendium) => eagle.get(c.name)),
    contained: vi.fn(async () => setup.contained ?? []),
    readData: vi.fn(async (uuid: string) => (setup.noData?.includes(uuid) ? undefined : ((setup.data?.[uuid] ?? {}) as never))),
    libraryIds: vi.fn(async () => {
      const ids = new Map<string, { compendium: string; documentName: string }>();
      for (const compendium of expectedCompendia()) for (const entry of eagle.get(compendium.name) ?? []) ids.set(entry.id, { compendium: compendium.name, documentName: compendium.documentName });
      return ids;
    }),
    describeTarget: vi.fn(async (scope: string, pack: string, id: string) => setup.targets?.[`${scope}.${pack}.${id}`] ?? { installed: true, exists: true }),
  };
  type Wanted = string | { source: string; id?: string; name?: string; changes?: Record<string, unknown> };
  const requests: { module: string; type: string; version?: number; payload: { pack: string; sources: Wanted[] } }[] = [];
  const request = vi.fn(async (input: never) => {
    const call = input as (typeof requests)[number];
    requests.push(call);
    return {
      ok: true,
      value: {
        pack: call.payload.pack,
        created: call.payload.sources.map((wanted) => {
          const source = typeof wanted === "string" ? wanted : wanted.source;
          const id = (typeof wanted === "string" ? undefined : wanted.id) ?? source.split(".").pop()!;
          const name = (typeof wanted === "string" ? undefined : wanted.name) ?? `Name ${id}`;
          return { source, uuid: `Compendium.${call.payload.pack}.Item.${id}`, id, name };
        }),
        existed: [],
      },
    };
  });
  const api: RequestApi = { request };
  const lines: { level: string; message: string }[] = [];
  const log = { info: (message: string) => lines.push({ level: "info", message }), warn: (message: string) => lines.push({ level: "warn", message }) };
  // The protocol setting: a text; writing it needs the text that was read (the check of setting.write).
  const store = { text: setup.protocol ?? "", failures: setup.protocolFails ?? 0, writes: 0 };
  let counter = 0;
  const protocol = {
    read: vi.fn(() => store.text),
    write: vi.fn(async (previous: string, value: string) => {
      store.writes++;
      if (store.failures > 0) {
        store.failures--;
        return { ok: false as const, detail: "handler-failed: the setting changed since it was read" };
      }
      if (previous !== store.text) return { ok: false as const, detail: "handler-failed: the setting changed since it was read" };
      store.text = value;
      return { ok: true as const };
    }),
  };
  const spellStore = { text: setup.spellLists ?? "", failures: setup.spellListFails ?? 0, writes: 0 };
  const spellLists = {
    read: vi.fn(() => spellStore.text),
    write: vi.fn(async (previous: string, value: string) => {
      spellStore.writes++;
      if (spellStore.failures > 0) {
        spellStore.failures--;
        return { ok: false as const, detail: "handler-failed: the setting changed since it was read" };
      }
      if (previous !== spellStore.text) return { ok: false as const, detail: "handler-failed: the setting changed since it was read" };
      spellStore.text = value;
      return { ok: true as const };
    }),
  };
  const deps: CopyDeps = {
    world,
    api: setup.noApi ? undefined : api,
    protocol,
    spellLists,
    newId: () => `NEW${String(++counter).padStart(13, "0")}`,
    user: () => "gm-1",
    now: () => "2026-09-21T12:00:00.000Z",
    isGm: () => setup.gm !== false,
    log,
  };
  const entries = (): Protocol["entries"] => {
    const parsed = parseProtocol(store.text);
    if (!parsed.ok) throw new Error(parsed.detail);
    return parsed.protocol.entries;
  };
  return { world, request, requests, lines, deps, documents, store, protocol, entries, eagle, spellStore, spellLists };
}

const allExist = (over: Record<string, IndexEntry[]> = {}) =>
  Object.fromEntries(expectedCompendia().map((c) => [c.name, over[c.name] ?? []]));

describe("copyDocument: one document", () => {
  it("copies a document with a stored version into the compendium of its kind and version, in one request", async () => {
    const { deps, requests, lines } = make({ documents: [item("a1", { rules: "2024" })], eagle: allExist() });

    const result = await copyDocument(deps, uuidOf("a1"));

    expect(requests).toEqual([
      {
        module: "eagle-library",
        type: "compendium.import",
        version: 1,
        payload: { pack: "world.eagle-weapons-2024", sources: [uuidOf("a1")] },
      },
    ]);
    expect(result).toEqual({
      ok: true,
      pack: "world.eagle-weapons-2024",
      target: "eagle-weapons-2024",
      created: [{ source: uuidOf("a1"), uuid: "Compendium.world.eagle-weapons-2024.Item.a1", id: "a1", name: "Name a1" }],
      existed: [],
      links: { total: 0, counts: expect.any(Object), problems: [], truncated: 0 },
      map: expect.any(Object),
      closure: { documents: 1, portions: 1, byCompendium: { "eagle-weapons-2024": 1 }, dependencies: 0, skipped: { total: 0, listed: [] } },
    });
    expect(lines[0]).toEqual({ level: "info", message: `eagle-library | copy ${uuidOf("a1")} -> world.eagle-weapons-2024: 1 created, 0 existed` });
    expect(lines).toHaveLength(2);
  });

  it("goes by the stored value of the document, never by a setting of the world: 2014 stays 2014", async () => {
    const { deps, requests } = make({ documents: [item("a1", { rules: "2014" })], eagle: allExist() });
    await copyDocument(deps, uuidOf("a1"));
    expect(requests[0]!.payload.pack).toBe("world.eagle-weapons-2014");
  });

  it("puts a document without a stored version into 2014, and into 2024 if 2014 has the name and 2024 has not (N7)", async () => {
    for (const rules of [undefined, null, "", "modern", 2014, " 2014"]) {
      const first = make({ documents: [item("a1", { rules })], eagle: allExist() });
      await copyDocument(first.deps, uuidOf("a1"));
      expect(first.requests[0]!.payload.pack, String(rules)).toBe("world.eagle-weapons-2014");
    }
    const taken = make({
      documents: [item("a1", { rules: undefined, name: "Longsword" })],
      eagle: allExist({ "eagle-weapons-2014": [{ id: "zz", name: "Longsword" }] }),
    });
    await copyDocument(taken.deps, uuidOf("a1"));
    expect(taken.requests[0]!.payload.pack).toBe("world.eagle-weapons-2024");
  });

  it("compares names the way of R7: case and white space do not matter", async () => {
    const { deps, requests } = make({
      documents: [item("a1", { rules: "2014", name: "  LONG   Sword " })],
      eagle: allExist({ "eagle-weapons-2014": [{ id: "zz", name: "long sword" }] }),
    });
    const result = await copyDocument(deps, uuidOf("a1"));
    expect(result).toMatchObject({ ok: false, reason: "duplicate" });
    expect(requests).toEqual([]);
  });

  it("does not copy a duplicate: same name in the stored version, or in both versions without one", async () => {
    const stored = make({
      documents: [item("a1", { rules: "2024", name: "Dagger" })],
      eagle: allExist({ "eagle-weapons-2024": [{ id: "zz", name: "Dagger" }] }),
    });
    expect(await copyDocument(stored.deps, uuidOf("a1"))).toMatchObject({ ok: false, reason: "duplicate", detail: expect.stringContaining("eagle-weapons-2024") });

    const both = make({
      documents: [item("a1", { rules: undefined, name: "Dagger" })],
      eagle: allExist({ "eagle-weapons-2014": [{ id: "y", name: "Dagger" }], "eagle-weapons-2024": [{ id: "z", name: "dagger" }] }),
    });
    expect(await copyDocument(both.deps, uuidOf("a1"))).toMatchObject({ ok: false, reason: "duplicate" });
    expect(stored.requests).toEqual([]);
    expect(both.requests).toEqual([]);
  });

  it("does not compare with the name of another version when the version is stored", async () => {
    const { deps, requests } = make({
      documents: [item("a1", { rules: "2024", name: "Dagger" })],
      eagle: allExist({ "eagle-weapons-2014": [{ id: "y", name: "Dagger" }] }),
    });
    expect(await copyDocument(deps, uuidOf("a1"))).toMatchObject({ ok: true });
    expect(requests[0]!.payload.pack).toBe("world.eagle-weapons-2024");
  });

  it("says a document is copied already when its id is in an Eagle Compendium of its kind, in either version, and asks for nothing", async () => {
    for (const where of ["eagle-weapons-2014", "eagle-weapons-2024"]) {
      const { deps, requests } = make({
        documents: [item("a1", { rules: undefined, name: "Dagger" })],
        eagle: allExist({ [where]: [{ id: "a1", name: "Dagger" }] }),
      });
      expect(await copyDocument(deps, uuidOf("a1")), where).toMatchObject({ ok: false, reason: "already-copied", detail: expect.stringContaining(where) });
      expect(requests).toEqual([]);
    }
  });

  it("does not say already-copied for the same id in a compendium of another kind", async () => {
    const { deps } = make({ documents: [item("a1")], eagle: allExist({ "eagle-loot-2014": [{ id: "a1", name: "Other" }] }) });
    expect(await copyDocument(deps, uuidOf("a1"))).toMatchObject({ ok: true });
  });

  it("says no-target when the compendium does not exist, and names it; the other version may be missing", async () => {
    const { deps, requests } = make({ documents: [item("a1", { rules: "2014" })], eagle: { "eagle-weapons-2024": [] } });
    expect(await copyDocument(deps, uuidOf("a1"))).toMatchObject({ ok: false, reason: "no-target", detail: expect.stringContaining("eagle-weapons-2014") });
    expect(requests).toEqual([]);

    const other = make({ documents: [item("a1", { rules: "2014" })], eagle: { "eagle-weapons-2014": [] } });
    expect(await copyDocument(other.deps, uuidOf("a1"))).toMatchObject({ ok: true });
  });

  it("copies every kind without a version into its only compendium", async () => {
    const cases: [string, Partial<CopySource>, string][] = [
      ["rolltables", { documentName: "RollTable", subtype: undefined }, "eagle-rolltables"],
      ["journals", { documentName: "JournalEntry", subtype: undefined }, "eagle-journals"],
      ["encounters", { documentName: "Actor", subtype: "encounter" }, "eagle-encounters"],
      ["groups", { documentName: "Actor", subtype: "group" }, "eagle-groups"],
    ];
    for (const [, over, name] of cases) {
      const { deps, requests } = make({ documents: [item("a1", { ...over, rules: "2014" })], eagle: allExist() });
      expect(await copyDocument(deps, uuidOf("a1")), name).toMatchObject({ ok: true, target: name });
      expect(requests[0]!.payload.pack).toBe(`world.${name}`);
    }
  });

  it("refuses a duplicate in a kind without a version by name", async () => {
    const { deps } = make({
      documents: [item("a1", { documentName: "RollTable", subtype: undefined, name: "Loot Table" })],
      eagle: allExist({ "eagle-rolltables": [{ id: "z", name: "loot table" }] }),
    });
    expect(await copyDocument(deps, uuidOf("a1"))).toMatchObject({ ok: false, reason: "duplicate" });
  });

  it("copies an NPC as one document and looks for no contents; it goes by its version", async () => {
    const { deps, requests, world } = make({
      documents: [item("n1", { documentName: "Actor", subtype: "npc", rules: "2024" })],
      eagle: allExist(),
      contained: [{ id: "x", uuid: uuidOf("x"), container: "n1" }],
    });
    expect(await copyDocument(deps, uuidOf("n1"))).toMatchObject({ ok: true, target: "eagle-npcs-2024" });
    expect(requests[0]!.payload.sources).toEqual([uuidOf("n1")]);
    expect(world.contained).not.toHaveBeenCalled();
  });
});

describe("copyDocument: a document that is not copied", () => {
  it("refuses without a Gamemaster or Assistant, and without Flight Control, before reading anything", async () => {
    const player = make({ documents: [item("a1")], eagle: allExist(), gm: false });
    expect(await copyDocument(player.deps, uuidOf("a1"))).toMatchObject({ ok: false, reason: "not-gm" });
    const none = make({ documents: [item("a1")], eagle: allExist(), noApi: true });
    expect(await copyDocument(none.deps, uuidOf("a1"))).toMatchObject({ ok: false, reason: "no-flight-control" });
    for (const world of [player.world, none.world]) expect(world.readDocument).not.toHaveBeenCalled();
  });

  it("refuses a UUID that is empty or not text, and one nobody has", async () => {
    const { deps, requests } = make({ eagle: allExist() });
    for (const uuid of ["", 5 as never, undefined as never]) {
      expect(await copyDocument(deps, uuid), String(uuid)).toMatchObject({ ok: false, reason: "source-not-found" });
    }
    expect(await copyDocument(deps, uuidOf("nope"))).toMatchObject({ ok: false, reason: "source-not-found" });
    expect(requests).toEqual([]);
  });

  it("says source-not-found when reading the document throws", async () => {
    const { deps, world } = make({ eagle: allExist() });
    (world.readDocument as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("bad uuid"));
    expect(await copyDocument(deps, uuidOf("a1"))).toMatchObject({ ok: false, reason: "source-not-found", detail: expect.stringContaining("bad uuid") });
  });

  it("refuses a source inside another document, a document of the world and a document in an Eagle Compendium", async () => {
    const eagleSource = item("a1", { pack: { collection: "world.eagle-weapons-2014", packageType: "world", name: "eagle-weapons-2014", type: "Item" } });
    const cases = [item("a1", { primary: false }), item("a1", { pack: undefined }), eagleSource];
    for (const document of cases) {
      const { deps, requests } = make({ documents: [document], eagle: allExist() });
      expect(await copyDocument(deps, document.uuid)).toMatchObject({ ok: false, reason: "source-not-supported" });
      expect(requests).toEqual([]);
    }
  });

  it("does not take a world compendium that only looks like an Eagle one: same name of another document type is a source", async () => {
    const other = item("a1", { pack: { collection: "world.eagle-weapons-2014", packageType: "world", name: "eagle-weapons-2014", type: "Actor" } });
    const { deps } = make({ documents: [other], eagle: allExist() });
    expect(await copyDocument(deps, other.uuid)).toMatchObject({ ok: true });
  });

  it("has no kind for a character, an unknown subtype or a macro, and says no-art without a guess", async () => {
    const cases: Partial<CopySource>[] = [
      { documentName: "Actor", subtype: "character" },
      { subtype: "mystery" },
      { subtype: undefined },
      { documentName: "Macro", subtype: undefined },
      { documentName: "Scene", subtype: undefined },
    ];
    for (const over of cases) {
      const { deps, requests } = make({ documents: [item("a1", over)], eagle: allExist() });
      expect(await copyDocument(deps, uuidOf("a1")), JSON.stringify(over)).toMatchObject({ ok: false, reason: "no-art" });
      expect(requests).toEqual([]);
    }
  });

  it("says read-failed when an Eagle Compendium cannot be read, and asks for nothing", async () => {
    const { deps, world, requests } = make({ documents: [item("a1")], eagle: allExist() });
    (world.eagleIndex as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("index broke"));
    expect(await copyDocument(deps, uuidOf("a1"))).toMatchObject({ ok: false, reason: "read-failed", detail: expect.stringContaining("index broke") });
    expect(requests).toEqual([]);
  });
});

describe("copyDocument: a container brings its contents", () => {
  const box = (over: Partial<CopySource> = {}) => item("box", { subtype: "container", rules: "2014", name: "Explorer's Pack", ...over });
  const inside = (id: string, container: string): ContainedEntry => ({ id, uuid: uuidOf(id), container });

  it("sends the container and everything in it in one request, into the compendium of the container", async () => {
    const { deps, requests } = make({
      documents: [box()],
      eagle: allExist(),
      contained: [inside("t1", "box"), inside("t2", "box"), inside("other", "elsewhere")],
    });

    const result = await copyDocument(deps, uuidOf("box"));

    expect(requests).toHaveLength(1);
    expect(requests[0]!.payload).toEqual({ pack: "world.eagle-containers-2014", sources: [uuidOf("box"), uuidOf("t1"), uuidOf("t2")] });
    expect(result).toMatchObject({ ok: true, target: "eagle-containers-2014" });
    expect((result as unknown as { created: unknown[] }).created).toHaveLength(3);
  });

  it("reads the contents from the compendium of the source", async () => {
    const { deps, world } = make({ documents: [box()], eagle: allExist() });
    await copyDocument(deps, uuidOf("box"));
    expect(world.contained).toHaveBeenCalledWith("dnd5e.items");
  });

  it("takes the version from the container only, and the name check applies to the container only", async () => {
    const { deps, requests } = make({
      documents: [box({ rules: "2024" })],
      // the contents' names are in other compendia and even in the same one: they are not checked
      eagle: allExist({ "eagle-containers-2024": [{ id: "zz", name: "Torch" }] }),
      contained: [inside("t1", "box")],
    });
    expect(await copyDocument(deps, uuidOf("box"))).toMatchObject({ ok: true });
    expect(requests[0]!.payload.pack).toBe("world.eagle-containers-2024");
  });

  it("takes containers within a container and their contents, in the order of the levels", async () => {
    const { deps, requests } = make({
      documents: [box()],
      eagle: allExist(),
      contained: [inside("c2", "c1"), inside("c1", "box"), inside("i1", "c2"), inside("i0", "box")],
    });
    await copyDocument(deps, uuidOf("box"));
    expect(requests[0]!.payload.sources).toEqual([uuidOf("box"), uuidOf("c1"), uuidOf("i0"), uuidOf("c2"), uuidOf("i1")]);
  });

  it("goes as deep as dnd5e allows, and fails one level deeper without asking for anything", async () => {
    const chain = (levels: number) =>
      Array.from({ length: levels }, (_, i) => inside(`l${i + 1}`, i === 0 ? "box" : `l${i}`));
    const ok = make({ documents: [box()], eagle: allExist(), contained: chain(MAX_CONTAINER_DEPTH) });
    expect(await copyDocument(ok.deps, uuidOf("box"))).toMatchObject({ ok: true });
    expect(ok.requests[0]!.payload.sources).toHaveLength(1 + MAX_CONTAINER_DEPTH);

    const deep = make({ documents: [box()], eagle: allExist(), contained: chain(MAX_CONTAINER_DEPTH + 1) });
    expect(await copyDocument(deep.deps, uuidOf("box"))).toMatchObject({ ok: false, reason: "container-too-deep" });
    expect(deep.requests).toEqual([]);
  });

  it("ends when a container holds itself, and takes every document once", async () => {
    const { deps, requests } = make({
      documents: [box()],
      eagle: allExist(),
      contained: [inside("a", "box"), inside("box", "a"), inside("a", "a")],
    });
    expect(await copyDocument(deps, uuidOf("box"))).toMatchObject({ ok: true });
    expect(requests[0]!.payload.sources).toEqual([uuidOf("box"), uuidOf("a")]);
  });

  it("takes at most as many documents as one request of Flight Control does", async () => {
    const many = (count: number) => Array.from({ length: count }, (_, i) => inside(`i${i}`, "box"));
    const fits = make({ documents: [box()], eagle: allExist(), contained: many(MAX_DOCUMENTS_PER_COPY - 1) });
    expect(await copyDocument(fits.deps, uuidOf("box"))).toMatchObject({ ok: true });
    expect(fits.requests[0]!.payload.sources).toHaveLength(MAX_DOCUMENTS_PER_COPY);

    const tooMany = make({ documents: [box()], eagle: allExist(), contained: many(MAX_DOCUMENTS_PER_COPY) });
    expect(await copyDocument(tooMany.deps, uuidOf("box"))).toMatchObject({ ok: false, reason: "too-many" });
    expect(tooMany.requests).toEqual([]);
  });

  it("treats the old subtype backpack as a container", async () => {
    const { deps, world } = make({ documents: [box({ subtype: "backpack" })], eagle: allExist() });
    expect(await copyDocument(deps, uuidOf("box"))).toMatchObject({ ok: true, target: "eagle-containers-2014" });
    expect(world.contained).toHaveBeenCalled();
  });

  it("looks for no contents in a kind that is not a container", async () => {
    const { deps, world } = make({ documents: [item("a1")], eagle: allExist() });
    await copyDocument(deps, uuidOf("a1"));
    expect(world.contained).not.toHaveBeenCalled();
  });

  it("says read-failed when the contents cannot be read", async () => {
    const { deps, world, requests } = make({ documents: [box()], eagle: allExist() });
    (world.contained as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("no pack"));
    expect(await copyDocument(deps, uuidOf("box"))).toMatchObject({ ok: false, reason: "read-failed" });
    expect(requests).toEqual([]);
  });

  it("does not look at contents that are not in this container", async () => {
    const { deps, requests } = make({ documents: [box()], eagle: allExist(), contained: [inside("x", "other")] });
    await copyDocument(deps, uuidOf("box"));
    expect(requests[0]!.payload.sources).toEqual([uuidOf("box")]);
  });
});

describe("copyDocument: the answer of Flight Control", () => {
  const setup = () => make({ documents: [item("a1")], eagle: allExist() });
  const answer = (context: ReturnType<typeof make>, value: unknown) => (context.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(value);

  it("passes on documents that existed already", async () => {
    const context = setup();
    answer(context, {
      ok: true,
      value: {
        pack: "world.eagle-weapons-2014",
        created: [],
        existed: [{ source: uuidOf("a1"), uuid: "Compendium.world.eagle-weapons-2014.Item.a1", id: "a1", name: "Name a1" }],
      },
    });
    expect(await copyDocument(context.deps, uuidOf("a1"))).toMatchObject({ ok: true, created: [], existed: [{ id: "a1" }] });
  });

  it("names a refusal with its code and text as request-failed", async () => {
    const context = setup();
    answer(context, { ok: false, reason: "not-permitted", detail: "this request may only be made by a Gamemaster or Assistant" });
    expect(await copyDocument(context.deps, uuidOf("a1"))).toEqual({
      ok: false,
      reason: "request-failed",
      code: "not-permitted",
      detail: "not-permitted: this request may only be made by a Gamemaster or Assistant",
    });
  });

  it("says the outcome is unknown after relay-timeout, and that asking again is safe", async () => {
    const context = setup();
    answer(context, { ok: false, reason: "relay-timeout", detail: "the Gamemaster did not answer in time" });
    const result = await copyDocument(context.deps, uuidOf("a1"));
    expect(result).toMatchObject({ ok: false, reason: "unknown-outcome", code: "relay-timeout" });
    expect((result as unknown as { detail: string }).detail).toContain("asking again is safe");
  });

  it("says request-failed when Flight Control throws", async () => {
    const context = setup();
    (context.request as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    expect(await copyDocument(context.deps, uuidOf("a1"))).toMatchObject({ ok: false, reason: "request-failed", detail: expect.stringContaining("boom") });
  });

  it("reads anything that is not the shape of the contract as a failure, never as a copy", async () => {
    const good = { source: uuidOf("a1"), uuid: "u", id: "a1", name: "n" };
    const answers: unknown[] = [
      undefined, null, "ok", [], { ok: "yes" }, { ok: true }, { ok: true, value: null }, { ok: true, value: [] },
      { ok: true, value: { pack: "world.other", created: [], existed: [] } },
      { ok: true, value: { pack: "world.eagle-weapons-2014", created: "x", existed: [] } },
      { ok: true, value: { pack: "world.eagle-weapons-2014", created: [], existed: null } },
      { ok: true, value: { pack: "world.eagle-weapons-2014", created: [{ ...good, id: 5 }], existed: [] } },
      { ok: true, value: { pack: "world.eagle-weapons-2014", created: [null], existed: [] } },
      { ok: false, reason: 5, detail: {} },
    ];
    for (const value of answers) {
      const context = setup();
      answer(context, value);
      const result = await copyDocument(context.deps, uuidOf("a1"));
      expect(result, JSON.stringify(value)).toMatchObject({ ok: false, reason: "request-failed" });
    }
  });

  it("logs every failure as a warning with its reason, and never throws", async () => {
    const context = make({ documents: [item("a1", { documentName: "Macro", subtype: undefined })], eagle: allExist() });
    await copyDocument(context.deps, uuidOf("a1"));
    expect(context.lines).toEqual([{ level: "warn", message: expect.stringContaining("(no-art)") }]);
  });
});

describe("copyDocument: the key of an entry is its name and its requirements (R5)", () => {
  const feat = (id: string, name: string, requirements: unknown, over: Partial<CopySource> = {}) =>
    item(id, { subtype: "feat", name, requirements, rules: "2024", ...over });
  const held = (id: string, name: string, requirements?: unknown): IndexEntry => ({ id, name, requirements });

  it("takes the same name with another requirement as another entry, and copies it", async () => {
    const { deps, requests } = make({
      documents: [feat("a1", "Spellcasting", "Bard")],
      eagle: allExist({ "eagle-feats-2024": [held("zz", "Spellcasting", "Wizard 1")] }),
    });
    expect(await copyDocument(deps, uuidOf("a1"))).toMatchObject({ ok: true, target: "eagle-feats-2024" });
    expect(requests).toHaveLength(1);
  });

  it("takes the same name and the same requirement as a duplicate, whatever the case and the white space", async () => {
    const { deps, requests } = make({
      documents: [feat("a1", "Spellcasting", "  WIZARD   1 ")],
      eagle: allExist({ "eagle-feats-2024": [held("zz", "spellcasting", "wizard 1")] }),
    });
    expect(await copyDocument(deps, uuidOf("a1"))).toMatchObject({ ok: false, reason: "duplicate" });
    expect(requests).toEqual([]);
  });

  it("counts a missing, empty, null and not-text requirement as the empty key, on both sides", async () => {
    for (const mine of [undefined, null, "", "   ", 5, {}]) {
      for (const theirs of [undefined, null, "", 0]) {
        const { deps } = make({
          documents: [feat("a1", "Extra Attack", mine)],
          eagle: allExist({ "eagle-feats-2024": [held("zz", "Extra Attack", theirs)] }),
        });
        expect(await copyDocument(deps, uuidOf("a1")), `${String(mine)} / ${String(theirs)}`).toMatchObject({ ok: false, reason: "duplicate" });
      }
    }
  });

  it("does not take an entry with a requirement for one without, or the other way round", async () => {
    for (const [mine, theirs] of [["Bard", undefined], [undefined, "Bard"]] as const) {
      const { deps } = make({
        documents: [feat("a1", "Extra Attack", mine)],
        eagle: allExist({ "eagle-feats-2024": [held("zz", "Extra Attack", theirs)] }),
      });
      expect(await copyDocument(deps, uuidOf("a1")), `${String(mine)} / ${String(theirs)}`).toMatchObject({ ok: true });
    }
  });

  it("leaves kinds without the field as they were: the name alone decides", async () => {
    const { deps } = make({
      documents: [item("a1", { name: "Dagger", requirements: "x", rules: "2014" })],
      eagle: allExist({ "eagle-weapons-2014": [held("zz", "Dagger")] }),
    });
    // a source that carries a requirement text on a kind that has none still has that key: it is another entry
    expect(await copyDocument(deps, uuidOf("a1"))).toMatchObject({ ok: true });
    const plain = make({ documents: [item("a1", { name: "Dagger", rules: "2014" })], eagle: allExist({ "eagle-weapons-2014": [held("zz", "Dagger")] }) });
    expect(await copyDocument(plain.deps, uuidOf("a1"))).toMatchObject({ ok: false, reason: "duplicate" });
  });

  it("applies the pair to the choice of the version (N7): the requirement in 2014 does not block 2024", async () => {
    const { deps, requests } = make({
      documents: [feat("a1", "Spellcasting", "Bard", { rules: undefined })],
      eagle: allExist({ "eagle-feats-2014": [held("zz", "Spellcasting", "Bard")], "eagle-feats-2024": [held("yy", "Spellcasting", "Cleric")] }),
    });
    await copyDocument(deps, uuidOf("a1"));
    expect(requests[0]!.payload.pack).toBe("world.eagle-feats-2024");
  });

  it("names the entries that carry the key in the protocol, at most five, with their UUIDs", async () => {
    const same = Array.from({ length: 7 }, (_, i) => held(`e${i}`, "Epic Boon"));
    const { deps, entries } = make({ documents: [feat("a1", "Epic Boon", undefined)], eagle: allExist({ "eagle-feats-2024": same }) });
    await copyDocument(deps, uuidOf("a1"));
    expect(entries()[0]!.existing).toEqual([0, 1, 2, 3, 4].map((i) => `Compendium.world.eagle-feats-2024.Item.e${i}`));
  });
});

describe("copyDocument: the protocol of what was not transferred", () => {
  it("writes an entry for a duplicate, with what a Gamemaster needs to decide", async () => {
    const { deps, entries } = make({
      documents: [item("a1", { name: "Dagger", rules: "2024" })],
      eagle: allExist({ "eagle-weapons-2024": [{ id: "zz", name: "Dagger" }] }),
    });
    const result = await copyDocument(deps, uuidOf("a1"));
    expect(result).toMatchObject({ ok: false, reason: "duplicate", protocol: { written: true } });
    expect(entries()).toEqual([
      {
        at: "2026-09-21T12:00:00.000Z",
        by: "gm-1",
        reason: "duplicate",
        source: uuidOf("a1"),
        name: "Dagger",
        kind: "weapons",
        version: "2024",
        target: "eagle-weapons-2024",
        existing: ["Compendium.world.eagle-weapons-2024.Item.zz"],
        status: "open",
      },
    ]);
  });

  it("writes an entry for a document with no kind, and for a container that is too deep or has too many documents", async () => {
    const macro = make({ documents: [item("m1", { documentName: "Macro", subtype: undefined })], eagle: allExist() });
    expect(await copyDocument(macro.deps, uuidOf("m1"))).toMatchObject({ reason: "no-art", protocol: { written: true } });
    expect(macro.entries()[0]).toMatchObject({ reason: "no-art", kind: null, version: null, target: null, existing: [] });

    const box = (id: string) => item(id, { subtype: "container", rules: "2014", name: "Pack" });
    const chain = Array.from({ length: MAX_CONTAINER_DEPTH + 1 }, (_, i) => ({ id: `l${i + 1}`, uuid: uuidOf(`l${i + 1}`), container: i === 0 ? "box" : `l${i}` }));
    const deep = make({ documents: [box("box")], eagle: allExist(), contained: chain });
    expect(await copyDocument(deep.deps, uuidOf("box"))).toMatchObject({ reason: "container-too-deep", protocol: { written: true } });
    expect(deep.entries()[0]).toMatchObject({ reason: "container-too-deep", kind: "containers", target: "eagle-containers-2014" });

    const many = Array.from({ length: MAX_DOCUMENTS_PER_COPY }, (_, i) => ({ id: `i${i}`, uuid: uuidOf(`i${i}`), container: "box" }));
    const big = make({ documents: [box("box")], eagle: allExist(), contained: many });
    expect(await copyDocument(big.deps, uuidOf("box"))).toMatchObject({ reason: "too-many", protocol: { written: true } });
    expect(big.entries()[0]).toMatchObject({ reason: "too-many" });
  });

  it("writes nothing for a technical failure, a repeat, a missing compendium, a source that cannot be used, or a refusal of the user", async () => {
    const cases: Array<[string, Setup, string]> = [
      ["already-copied", { documents: [item("a1")], eagle: allExist({ "eagle-weapons-2014": [{ id: "a1", name: "x" }] }) }, uuidOf("a1")],
      ["no-target", { documents: [item("a1")], eagle: {} }, uuidOf("a1")],
      ["source-not-found", { eagle: allExist() }, uuidOf("none")],
      ["source-not-supported", { documents: [item("a1", { primary: false })], eagle: allExist() }, uuidOf("a1")],
      ["not-gm", { documents: [item("a1")], eagle: allExist(), gm: false }, uuidOf("a1")],
      ["no-flight-control", { documents: [item("a1")], eagle: allExist(), noApi: true }, uuidOf("a1")],
    ];
    for (const [reason, setup, uuid] of cases) {
      const context = make(setup);
      expect(await copyDocument(context.deps, uuid), reason).toMatchObject({ ok: false, reason });
      expect(context.protocol.write, reason).not.toHaveBeenCalled();
      expect(context.store.text, reason).toBe("");
    }
    const failing = make({ documents: [item("a1")], eagle: allExist() });
    (failing.request as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    expect(await copyDocument(failing.deps, uuidOf("a1"))).toMatchObject({ reason: "request-failed" });
    expect(failing.store.text).toBe("");
    const unreadable = make({ documents: [item("a1")], eagle: allExist() });
    (unreadable.world.eagleIndex as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("x"));
    expect(await copyDocument(unreadable.deps, uuidOf("a1"))).toMatchObject({ reason: "read-failed" });
    expect(unreadable.store.text).toBe("");
  });

  it("updates the entry of the same source and reason instead of adding another", async () => {
    const { deps, entries } = make({
      documents: [item("a1", { name: "Dagger", rules: "2024" })],
      eagle: allExist({ "eagle-weapons-2024": [{ id: "zz", name: "Dagger" }] }),
    });
    await copyDocument(deps, uuidOf("a1"));
    await copyDocument(deps, uuidOf("a1"));
    expect(entries()).toHaveLength(1);
  });

  it("marks the open entries of a source as copied when it is copied after all", async () => {
    const context = make({ documents: [item("a1", { name: "Dagger", rules: "2024" })], eagle: allExist({ "eagle-weapons-2024": [{ id: "zz", name: "Dagger" }] }) });
    await copyDocument(context.deps, uuidOf("a1"));
    // the name was freed in the meantime
    context.eagle.set("eagle-weapons-2024", []);
    const result = await copyDocument(context.deps, uuidOf("a1"));
    expect(result).toMatchObject({ ok: true, protocol: { written: true } });
    expect(context.entries()[0]).toMatchObject({ status: "copied", copy: "Compendium.world.eagle-weapons-2024.Item.a1" });
  });

  it("does not write the protocol after a copy when the source has no open entry", async () => {
    const context = make({ documents: [item("a1")], eagle: allExist() });
    const result = await copyDocument(context.deps, uuidOf("a1"));
    expect(result).toMatchObject({ ok: true });
    expect(result).not.toHaveProperty("protocol");
    expect(context.protocol.write).not.toHaveBeenCalled();
  });

  it("tries a second time when the first write fails, and says so when both fail; the refusal stays a refusal", async () => {
    const world = { documents: [item("a1", { name: "Dagger", rules: "2024" })], eagle: allExist({ "eagle-weapons-2024": [{ id: "zz", name: "Dagger" }] }) };
    const once = make({ ...world, protocolFails: 1 });
    expect(await copyDocument(once.deps, uuidOf("a1"))).toMatchObject({ reason: "duplicate", protocol: { written: true } });
    expect(once.store.writes).toBe(2);
    const both = make({ ...world, protocolFails: Infinity });
    const result = await copyDocument(both.deps, uuidOf("a1"));
    expect(result).toMatchObject({ ok: false, reason: "duplicate", protocol: { written: false, detail: expect.stringContaining("changed since it was read") } });
    expect(both.store.writes).toBe(2);
    expect(both.lines.some((line) => line.level === "warn" && line.message.includes("the protocol could not be written"))).toBe(true);
  });

  it("replaces a protocol that cannot be read, and the log says so with its beginning", async () => {
    const { deps, entries, lines } = make({
      documents: [item("a1", { name: "Dagger", rules: "2024" })],
      eagle: allExist({ "eagle-weapons-2024": [{ id: "zz", name: "Dagger" }] }),
      protocol: "this is not a protocol",
    });
    expect(await copyDocument(deps, uuidOf("a1"))).toMatchObject({ protocol: { written: true } });
    expect(entries()).toHaveLength(1);
    expect(lines.find((line) => line.message.includes("replaced by a new one"))?.message).toContain("this is not a protocol");
  });

  it("reads the setting when it throws as a failed write, not as a failed copy", async () => {
    const context = make({ documents: [item("a1", { name: "Dagger", rules: "2024" })], eagle: allExist({ "eagle-weapons-2024": [{ id: "zz", name: "Dagger" }] }) });
    (context.protocol.write as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no setting"));
    expect(await copyDocument(context.deps, uuidOf("a1"))).toMatchObject({ ok: false, reason: "duplicate", protocol: { written: false, detail: "no setting" } });
  });
});

describe("copyDocument: forcing a copy", () => {
  const taken = (over: Record<string, IndexEntry[]> = {}) => allExist({ "eagle-weapons-2014": [{ id: "zz", name: "Dagger" }], ...over });
  const dagger = (over: Partial<CopySource> = {}) => item("d1", { name: "Dagger", rules: "2014", ...over });

  it("copies a duplicate as 'Name (Duplicate)' with a new id and the same document data, in one request", async () => {
    const { deps, requests } = make({ documents: [dagger()], eagle: taken() });
    const result = await copyDocument(deps, uuidOf("d1"), { force: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.payload).toEqual({
      pack: "world.eagle-weapons-2014",
      sources: [{ source: uuidOf("d1"), id: "NEW0000000000001", name: "Dagger (Duplicate)" }],
    });
    expect(result).toMatchObject({ ok: true, forced: true, target: "eagle-weapons-2014" });
  });

  it("numbers on: '(Duplicate)' taken gives '(Duplicate 2)', and a name with the suffix counts up", async () => {
    const two = make({ documents: [dagger()], eagle: taken({ "eagle-weapons-2014": [{ id: "zz", name: "Dagger" }, { id: "yy", name: "dagger (duplicate)" }] }) });
    await copyDocument(two.deps, uuidOf("d1"), { force: true });
    expect((two.requests[0]!.payload.sources[0] as { name: string }).name).toBe("Dagger (Duplicate 2)");
    const suffixed = make({
      documents: [dagger({ name: "Dagger (Duplicate)" })],
      eagle: taken({ "eagle-weapons-2014": [{ id: "zz", name: "Dagger (Duplicate)" }] }),
    });
    await copyDocument(suffixed.deps, uuidOf("d1"), { force: true });
    expect((suffixed.requests[0]!.payload.sources[0] as unknown as { name: string }).name).toBe("Dagger (Duplicate 1)");
  });

  it("takes the name of the copy from the names in the compendium, whatever their requirements", async () => {
    const { deps, requests } = make({
      documents: [item("f1", { subtype: "feat", name: "Spellcasting", requirements: "Bard", rules: "2024" })],
      eagle: allExist({ "eagle-feats-2024": [{ id: "a", name: "Spellcasting", requirements: "Bard" }, { id: "b", name: "Spellcasting (Duplicate)", requirements: "Cleric" }] }),
    });
    await copyDocument(deps, uuidOf("f1"), { force: true });
    expect((requests[0]!.payload.sources[0] as unknown as { name: string }).name).toBe("Spellcasting (Duplicate 2)");
  });

  it("lets the Gamemaster choose the version, also against the stored one, and falls back to the stored version", async () => {
    const chosen = make({ documents: [dagger()], eagle: taken() });
    await copyDocument(chosen.deps, uuidOf("d1"), { force: true, version: "2024" });
    expect(chosen.requests[0]!.payload.pack).toBe("world.eagle-weapons-2024");
    const stored = make({ documents: [dagger()], eagle: taken() });
    await copyDocument(stored.deps, uuidOf("d1"), { force: true });
    expect(stored.requests[0]!.payload.pack).toBe("world.eagle-weapons-2014");
  });

  it("asks for the version when none is stored and none is given, and writes nothing and protocols nothing", async () => {
    const both = allExist({ "eagle-weapons-2014": [{ id: "y", name: "Dagger" }], "eagle-weapons-2024": [{ id: "z", name: "Dagger" }] });
    const { deps, requests, store } = make({ documents: [dagger({ rules: undefined })], eagle: both });
    expect(await copyDocument(deps, uuidOf("d1"), { force: true })).toMatchObject({ ok: false, reason: "version-required" });
    expect(requests).toEqual([]);
    expect(store.text).toBe("");
    expect(await copyDocument(deps, uuidOf("d1"), { force: true, version: "2014" })).toMatchObject({ ok: true, target: "eagle-weapons-2014" });
  });

  it("refuses a version that is not 2014 or 2024", async () => {
    const { deps, requests } = make({ documents: [dagger()], eagle: taken() });
    for (const version of ["2015", "modern", 2014, null] as never[]) {
      expect(await copyDocument(deps, uuidOf("d1"), { force: true, version }), String(version)).toMatchObject({ ok: false, reason: "version-required" });
    }
    expect(requests).toEqual([]);
  });

  it("ignores a version for a kind that has none", async () => {
    const { deps, requests } = make({
      documents: [item("r1", { documentName: "RollTable", subtype: undefined, name: "Loot" })],
      eagle: allExist({ "eagle-rolltables": [{ id: "zz", name: "Loot" }] }),
    });
    const result = await copyDocument(deps, uuidOf("r1"), { force: true, version: "2024" });
    expect(result).toMatchObject({ ok: true, target: "eagle-rolltables" });
    expect(requests[0]!.payload.sources[0]).toMatchObject({ name: "Loot (Duplicate)" });
  });

  it("does not force anything that is not a duplicate: a refusal stays a refusal, a normal copy stays normal", async () => {
    const cases: Array<[string, Setup, string]> = [
      ["already-copied", { documents: [dagger()], eagle: allExist({ "eagle-weapons-2014": [{ id: "d1", name: "x" }] }) }, "already-copied"],
      ["no-art", { documents: [dagger({ subtype: "mystery" })], eagle: taken() }, "no-art"],
      ["no-target", { documents: [dagger()], eagle: {} }, "no-target"],
    ];
    for (const [label, setup, reason] of cases) {
      const context = make(setup);
      expect(await copyDocument(context.deps, uuidOf("d1"), { force: true }), label).toMatchObject({ ok: false, reason });
      expect(context.requests, label).toEqual([]);
    }
    const normal = make({ documents: [dagger({ name: "Sword" })], eagle: taken() });
    const result = await copyDocument(normal.deps, uuidOf("d1"), { force: true });
    expect(result).toMatchObject({ ok: true });
    expect(result).not.toHaveProperty("forced");
    expect(normal.requests[0]!.payload.sources).toEqual([uuidOf("d1")]);
  });

  it("marks the open protocol entry as forced, with the UUID of the copy", async () => {
    const context = make({ documents: [dagger()], eagle: taken() });
    await copyDocument(context.deps, uuidOf("d1"));
    expect(context.entries()[0]).toMatchObject({ status: "open" });
    const result = await copyDocument(context.deps, uuidOf("d1"), { force: true });
    expect(result).toMatchObject({ ok: true, forced: true, protocol: { written: true } });
    expect(context.entries()[0]).toMatchObject({ status: "forced", copy: "Compendium.world.eagle-weapons-2014.Item.NEW0000000000001" });
  });

  it("forces a container with new ids for the container and for everything in it, and points every content at its new container", async () => {
    const box = item("box", { subtype: "container", rules: "2014", name: "Explorer's Pack" });
    const inside = (id: string, container: string): ContainedEntry => ({ id, uuid: uuidOf(id), container });
    const context = make({
      documents: [box],
      eagle: allExist({ "eagle-containers-2014": [{ id: "zz", name: "Explorer's Pack" }] }),
      contained: [inside("t1", "box"), inside("bag", "box"), inside("coin", "bag")],
    });
    await copyDocument(context.deps, uuidOf("box"), { force: true });
    expect(context.requests[0]!.payload).toEqual({
      pack: "world.eagle-containers-2014",
      sources: [
        { source: uuidOf("box"), id: "NEW0000000000001", name: "Explorer's Pack (Duplicate)" },
        { source: uuidOf("t1"), id: "NEW0000000000002", changes: { "system.container": "NEW0000000000001" } },
        { source: uuidOf("bag"), id: "NEW0000000000003", changes: { "system.container": "NEW0000000000001" } },
        { source: uuidOf("coin"), id: "NEW0000000000004", changes: { "system.container": "NEW0000000000003" } },
      ],
    });
  });

  it("forces an NPC as one document with a new id and name; its embedded Items are not touched", async () => {
    const { deps, requests } = make({
      documents: [item("n1", { documentName: "Actor", subtype: "npc", name: "Goblin", rules: "2024" })],
      eagle: allExist({ "eagle-npcs-2024": [{ id: "zz", name: "Goblin" }] }),
    });
    await copyDocument(deps, uuidOf("n1"), { force: true });
    expect(requests[0]!.payload.sources).toEqual([{ source: uuidOf("n1"), id: "NEW0000000000001", name: "Goblin (Duplicate)" }]);
  });

  it("does not give a new id that a compendium holds already", async () => {
    const context = make({ documents: [dagger()], eagle: taken({ "eagle-weapons-2014": [{ id: "zz", name: "Dagger" }, { id: "NEW0000000000001", name: "Other" }] }) });
    await copyDocument(context.deps, uuidOf("d1"), { force: true });
    expect((context.requests[0]!.payload.sources[0] as unknown as { id: string }).id).toBe("NEW0000000000002");
  });
});

describe("copyDocument: a source that lies in a container of its own compendium", () => {
  it("clears the container of a single Item, whose container is not in the target", async () => {
    const torch = item("t1", { subtype: "consumable", name: "Torch", container: "box0000000000000", rules: "2014" });
    const { deps, requests } = make({ documents: [torch], eagle: allExist() });
    await copyDocument(deps, uuidOf("t1"));
    expect(requests[0]!.payload.sources).toEqual([{ source: uuidOf("t1"), changes: { "system.container": null } }]);
  });

  it("leaves the field alone in a source that is in no container", async () => {
    const { deps, requests } = make({ documents: [item("a1", { container: null })], eagle: allExist() });
    await copyDocument(deps, uuidOf("a1"));
    expect(requests[0]!.payload.sources).toEqual([uuidOf("a1")]);
  });

  it("clears the container of a container that lies in another one, but not of its contents", async () => {
    const bag = item("bag", { subtype: "container", name: "Bag", container: "box", rules: "2014" });
    const { deps, requests } = make({
      documents: [bag],
      eagle: allExist(),
      contained: [{ id: "coin", uuid: uuidOf("coin"), container: "bag" }],
    });
    await copyDocument(deps, uuidOf("bag"));
    expect(requests[0]!.payload.sources).toEqual([{ source: uuidOf("bag"), changes: { "system.container": null } }, uuidOf("coin")]);
  });
});


// The links of the documents of a copy (rule R14): ids of 16 letters and digits, as the real ones are.
describe("copyDocument: the links are rewritten when the document is written", () => {
  const long = (n: string) => n.padEnd(16, "0");
  const sid = (n: string) => `Compendium.dnd5e.items.Item.${long(n)}`;
  const lid = (n: string, pack = "eagle-weapons-2014") => `Compendium.world.${pack}.Item.${long(n)}`;
  const doc = (n: string, over: Partial<CopySource> = {}): CopySource => item(long(n), { uuid: sid(n), id: long(n), name: `Name ${n}`, ...over });
  const entryOf = (context: ReturnType<typeof make>, index = 0) => context.requests[0]!.payload.sources[index];

  it("sends a document without links as a UUID, as before", async () => {
    const context = make({ documents: [doc("a")], eagle: allExist(), data: { [sid("a")]: { name: "x", system: { note: "no links" } } } });
    await copyDocument(context.deps, sid("a"));
    expect(entryOf(context)).toBe(sid("a"));
  });

  it("rewrites a link to a document that is in the Library already (the same id) in the entry of the same request", async () => {
    const data = { name: "Class", system: { advancement: { ab: { configuration: { items: [{ uuid: sid("f1") }, { uuid: sid("f2") }] } } } } };
    const context = make({
      documents: [doc("cls", { subtype: "class" })],
      eagle: allExist({ "eagle-feats-2014": [{ id: long("f1"), name: "Feature 1" }] }),
      data: { [sid("cls")]: data },
    });
    const result = await copyDocument(context.deps, sid("cls"));
    expect(result).toMatchObject({ ok: true });
    expect(context.requests).toHaveLength(1);
    expect(entryOf(context)).toEqual({
      source: sid("cls"),
      changes: {
        "system.advancement.ab.configuration.items": [{ uuid: lid("f1", "eagle-feats-2014") }, { uuid: sid("f2") }],
      },
    });
  });

  it("writes the changes as whole lists, never as a place in a list", async () => {
    const data = { name: "N", items: [{ _id: "i1", system: { d: `@UUID[${sid("t")}]{x}` } }], effects: [{ origin: sid("a") }] };
    const context = make({
      documents: [doc("a", { documentName: "Actor", subtype: "npc", uuid: `Compendium.dnd5e.items.Actor.${long("a")}` })],
      eagle: allExist({ "eagle-weapons-2014": [{ id: long("t"), name: "T" }] }),
      data: { [`Compendium.dnd5e.items.Actor.${long("a")}`]: data },
    });
    await copyDocument(context.deps, `Compendium.dnd5e.items.Actor.${long("a")}`);
    const entry = entryOf(context) as { changes: Record<string, unknown> };
    expect(Object.keys(entry.changes).sort()).toEqual(["effects", "items"]);
    expect(entry.changes.effects).toEqual([{ origin: `Compendium.world.eagle-npcs-2014.Actor.${long("a")}` }].map((e) => ({ origin: e.origin.replace("eagle-npcs-2014", "eagle-npcs-2014") })));
  });

  it("points a link of the document to itself at its own copy and keeps the fields of origin", async () => {
    const data = { name: "N", effects: [{ origin: sid("a") }], _stats: { compendiumSource: sid("zz") } };
    const context = make({ documents: [doc("a")], eagle: allExist(), data: { [sid("a")]: data } });
    await copyDocument(context.deps, sid("a"));
    expect(entryOf(context)).toEqual({ source: sid("a"), changes: { effects: [{ origin: lid("a") }] } });
  });

  it("points the links between a container and its contents at their copies, into the compendium of the container", async () => {
    const box = doc("box", { subtype: "container", name: "Pack" });
    const inside = (n: string, container: string): ContainedEntry => ({ id: long(n), uuid: sid(n), container: long(container) });
    const context = make({
      documents: [box],
      eagle: allExist(),
      contained: [inside("t1", "box")],
      data: { [sid("box")]: { name: "Pack", system: { note: `@UUID[${sid("t1")}]` } }, [sid("t1")]: { name: "Torch", system: { note: `@UUID[${sid("box")}]` } } },
    });
    await copyDocument(context.deps, sid("box"));
    expect(entryOf(context, 0)).toEqual({ source: sid("box"), changes: { "system.note": `@UUID[${lid("t1", "eagle-containers-2014")}]` } });
    expect(entryOf(context, 1)).toEqual({ source: sid("t1"), changes: { "system.note": `@UUID[${lid("box", "eagle-containers-2014")}]` } });
  });

  it("in a forced copy points the links of the copy to itself at the copy and links of others at the entry that carries the key", async () => {
    const dagger = doc("d", { name: "Dagger", rules: "2014" });
    const context = make({
      documents: [dagger],
      eagle: allExist({ "eagle-weapons-2014": [{ id: long("held"), name: "Dagger" }] }),
      data: { [sid("d")]: { name: "Dagger", effects: [{ origin: sid("d") }], system: { see: sid("other") } } },
    });
    await copyDocument(context.deps, sid("d"), { force: true });
    const entry = entryOf(context) as { id: string; changes: Record<string, unknown> };
    expect(entry.changes.effects).toEqual([{ origin: lid(entry.id) }]);
    expect(entry.id).toBe("NEW0000000000001");
  });

  it("sets the container field after the links (the order of the fields is the order they are set in)", async () => {
    const torch = doc("t", { subtype: "consumable", container: long("box") });
    const context = make({ documents: [torch], eagle: allExist(), data: { [sid("t")]: { system: { container: long("box"), note: `@UUID[${sid("t")}]` } } } });
    await copyDocument(context.deps, sid("t"));
    const entry = entryOf(context) as { changes: Record<string, unknown> };
    expect(Object.keys(entry.changes)).toEqual(["system.note", "system.container"]);
    expect(entry.changes["system.container"]).toBeNull();
  });

  it("uses the entry of the protocol for a duplicate that was skipped, and leaves a link that nothing covers", async () => {
    const protocol = JSON.stringify({
      version: 1,
      dropped: 0,
      entries: [{ at: "t", by: "u", reason: "duplicate", source: sid("dup"), name: "Dup", kind: "feats", version: "2014", target: "eagle-feats-2014", existing: [lid("held", "eagle-feats-2014")], status: "open" }],
    });
    const context = make({ documents: [doc("a")], eagle: allExist(), protocol, data: { [sid("a")]: { list: [sid("dup"), sid("lost")] } } });
    await copyDocument(context.deps, sid("a"));
    expect(entryOf(context)).toEqual({ source: sid("a"), changes: { list: [lid("held", "eagle-feats-2014"), sid("lost")] } });
  });

  it("reports every link that does not end in the Library, with the reason the world gives", async () => {
    const data = { list: [sid("lost"), `Compendium.dnd-monster-manual.actors.Actor.${long("m")}`, `Compendium.dnd5e.heroes.Actor.${long("h")}`, `Compendium.dnd5e.spells.Item.${long("s")}`] };
    const context = make({
      documents: [doc("a")],
      eagle: allExist(),
      data: { [sid("a")]: data },
      targets: {
        [`dnd-monster-manual.actors.${long("m")}`]: { installed: false },
        [`dnd5e.heroes.${long("h")}`]: { installed: true, exists: true, noArt: true },
        [`dnd5e.spells.${long("s")}`]: { installed: true, exists: false },
      },
    });
    const result = await copyDocument(context.deps, sid("a"));
    expect(result).toMatchObject({ ok: true });
    const links = (result as unknown as { links: { total: number; counts: Record<string, number>; problems: { outcome: string }[]; truncated: number } }).links;
    expect(links.total).toBe(4);
    expect(links.problems.map((p) => p.outcome)).toEqual(["not-copied", "package-missing", "no-art", "target-missing"]);
    expect(links.truncated).toBe(0);
    expect(context.lines.some((line) => line.level === "info" && /links of .*: 0 rewritten, 0 in the Library, 0 of origin, 4 not in the Library/.test(line.message))).toBe(true);
  });

  it("names at most 50 problems and says how many are left out", async () => {
    const many = Array.from({ length: 60 }, (_, i) => sid(`x${i}`));
    const context = make({ documents: [doc("a")], eagle: allExist(), data: { [sid("a")]: { many } } });
    const result = (await copyDocument(context.deps, sid("a"))) as unknown as { links: { total: number; problems: unknown[]; truncated: number } };
    expect(result.links.total).toBe(60);
    expect(result.links.problems).toHaveLength(50);
    expect(result.links.truncated).toBe(10);
  });

  it("does not read the Library or the world for a document with no link outside the run", async () => {
    const context = make({ documents: [doc("a")], eagle: allExist(), data: { [sid("a")]: { effects: [{ origin: sid("a") }], text: "plain" } } });
    await copyDocument(context.deps, sid("a"));
    expect(context.world.libraryIds).not.toHaveBeenCalled();
    expect(context.world.describeTarget).not.toHaveBeenCalled();
  });

  it("asks for nothing and writes nothing when the data of a document cannot be read", async () => {
    const context = make({ documents: [doc("a")], eagle: allExist(), noData: [sid("a")] });
    expect(await copyDocument(context.deps, sid("a"))).toMatchObject({ ok: false, reason: "read-failed" });
    expect(context.requests).toEqual([]);
    const throwing = make({ documents: [doc("a")], eagle: allExist(), data: { [sid("a")]: { l: sid("x") } } });
    (throwing.world.libraryIds as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("no index"));
    expect(await copyDocument(throwing.deps, sid("a"))).toMatchObject({ ok: false, reason: "read-failed", detail: expect.stringContaining("no index") });
    expect(throwing.requests).toEqual([]);
  });

  it("asks the world once for each target, whatever the number of links", async () => {
    const data = { a: [sid("lost"), sid("lost")], b: `@UUID[${sid("lost")}]` };
    const context = make({ documents: [doc("a")], eagle: allExist(), data: { [sid("a")]: data } });
    await copyDocument(context.deps, sid("a"));
    expect(context.world.describeTarget).toHaveBeenCalledTimes(1);
  });

  it("takes fewer changes than the limit of Flight Control: a document with many fields keeps its container field within the limit", async () => {
    // 80 links to documents that the Library has: 80 paths under `system`, more than one entry takes
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 80; i++) wide[`f${i}`] = [sid(`t${i}`)];
    const held = Array.from({ length: 80 }, (_, i) => ({ id: long(`t${i}`), name: `T${i}` }));
    const context = make({
      documents: [doc("a", { container: long("box"), subtype: "consumable" })],
      eagle: allExist({ "eagle-consumables-2014": held }),
      data: { [sid("a")]: { system: wide } },
    });
    await copyDocument(context.deps, sid("a"));
    const entry = entryOf(context) as { changes: Record<string, unknown> };
    expect(Object.keys(entry.changes)).toEqual(["system", "system.container"]);
  });
});

describe("copyDocument: a journal brings its spell lists", () => {
  const long = (n: string) => n.padEnd(16, "0");
  const jid = (n: string) => `Compendium.dnd5e.content24.JournalEntry.${long(n)}`;
  const journal = (n: string) => item(long(n), { uuid: jid(n), id: long(n), documentName: "JournalEntry", subtype: undefined, name: `Journal ${n}`, rules: undefined });
  const pages = (types: string[]) => ({ name: "J", pages: types.map((type, i) => ({ _id: `page${i}`.padEnd(16, "0"), type })) });

  it("enters the pages of type spells in the setting, in the copy of the journal", async () => {
    const context = make({ documents: [journal("j")], eagle: allExist(), data: { [jid("j")]: pages(["text", "spells", "spells"]) } });
    const result = await copyDocument(context.deps, jid("j"));
    expect(result).toMatchObject({ ok: true, spellLists: { written: true } });
    const stored = JSON.parse(context.spellStore.text);
    expect(stored).toEqual({
      version: 1,
      pages: [`Compendium.world.eagle-journals.JournalEntry.${long("j")}.JournalEntryPage.${"page1".padEnd(16, "0")}`, `Compendium.world.eagle-journals.JournalEntry.${long("j")}.JournalEntryPage.${"page2".padEnd(16, "0")}`],
    });
  });

  it("does not touch the setting for a journal without spell lists, or for another kind", async () => {
    const plain = make({ documents: [journal("j")], eagle: allExist(), data: { [jid("j")]: pages(["text"]) } });
    const result = await copyDocument(plain.deps, jid("j"));
    expect(result).not.toHaveProperty("spellLists");
    expect(plain.spellLists.write).not.toHaveBeenCalled();
    const weapon = make({ documents: [item(long("w"), { uuid: `Compendium.dnd5e.items.Item.${long("w")}`, id: long("w") })], eagle: allExist(), data: { [`Compendium.dnd5e.items.Item.${long("w")}`]: { pages: [{ _id: "x", type: "spells" }] } } });
    await copyDocument(weapon.deps, `Compendium.dnd5e.items.Item.${long("w")}`);
    expect(weapon.spellLists.write).not.toHaveBeenCalled();
  });

  it("names the copy under a new id when the journal is forced", async () => {
    const context = make({
      documents: [journal("j")],
      eagle: allExist({ "eagle-journals": [{ id: "zz", name: "Journal j" }] }),
      data: { [jid("j")]: pages(["spells"]) },
    });
    await copyDocument(context.deps, jid("j"), { force: true });
    const stored = JSON.parse(context.spellStore.text) as { pages: string[] };
    expect(stored.pages[0]).toMatch(/^Compendium\.world\.eagle-journals\.JournalEntry\.NEW0000000000001\.JournalEntryPage\./);
  });

  it("says when the setting could not be written, and the copy still counts", async () => {
    const context = make({ documents: [journal("j")], eagle: allExist(), data: { [jid("j")]: pages(["spells"]) }, spellListFails: Infinity });
    expect(await copyDocument(context.deps, jid("j"))).toMatchObject({ ok: true, spellLists: { written: false, detail: expect.stringContaining("changed since it was read") } });
  });
});

describe("copyDocument: everything a document links to is copied too (R17)", () => {
  const long = (n: string) => n.padEnd(16, "0");
  const sid = (n: string) => `Compendium.dnd5e.items.Item.${long(n)}`;
  const lid = (n: string, pack = "eagle-weapons-2014") => `Compendium.world.${pack}.Item.${long(n)}`;
  const doc = (n: string, over: Partial<CopySource> = {}): CopySource => item(long(n), { uuid: sid(n), id: long(n), name: `Name ${n}`, ...over });
  const link = (n: string) => `@UUID[${sid(n)}]{x}`;
  const sourcesOf = (context: ReturnType<typeof make>, index: number) => context.requests[index]!.payload.sources.map((s) => (typeof s === "string" ? s : s.source));
  const changesOf = (context: ReturnType<typeof make>, request: number, source: string) => {
    const found = context.requests[request]!.payload.sources.find((s) => (typeof s === "string" ? s : s.source) === source);
    return typeof found === "object" ? found.changes : undefined;
  };

  it("copies a linked document in the same run and points the link at its copy", async () => {
    const context = make({ documents: [doc("a"), doc("b")], eagle: allExist(), data: { [sid("a")]: { text: link("b") }, [sid("b")]: { text: "plain" } } });
    const result = await copyDocument(context.deps, sid("a"));
    expect(result).toMatchObject({ ok: true, closure: { documents: 2, dependencies: 1, portions: 1 } });
    expect(sourcesOf(context, 0)).toEqual([sid("b"), sid("a")].sort((x, y) => sourcesOf(context, 0).indexOf(x) - sourcesOf(context, 0).indexOf(y)));
    expect(sourcesOf(context, 0).sort()).toEqual([sid("a"), sid("b")]);
    expect(changesOf(context, 0, sid("a"))).toEqual({ text: `@UUID[${lid("b")}]{x}` });
  });

  it("follows the links of the linked documents too, and ends where documents link to each other", async () => {
    const context = make({
      documents: [doc("a"), doc("b"), doc("c")],
      eagle: allExist(),
      data: { [sid("a")]: { text: link("b") }, [sid("b")]: { text: link("c") + link("a") }, [sid("c")]: { text: link("a") } },
    });
    const result = await copyDocument(context.deps, sid("a"));
    expect(result).toMatchObject({ ok: true, closure: { documents: 3, dependencies: 2 } });
    expect(context.requests).toHaveLength(1);
    expect(changesOf(context, 0, sid("c"))).toEqual({ text: `@UUID[${lid("a")}]{x}` });
    expect(changesOf(context, 0, sid("b"))).toEqual({ text: `@UUID[${lid("c")}]{x}@UUID[${lid("a")}]{x}` });
  });

  it("writes one request for each target compendium and the portion of the first document last", async () => {
    const context = make({
      documents: [doc("a"), doc("b", { subtype: "feat" }), doc("c")],
      eagle: allExist(),
      data: { [sid("a")]: { text: link("b") + link("c") } },
    });
    await copyDocument(context.deps, sid("a"));
    expect(context.requests.map((request) => request.payload.pack)).toEqual(["world.eagle-feats-2014", "world.eagle-weapons-2014"]);
    expect(sourcesOf(context, 1)).toEqual([sid("a"), sid("c")]);
    expect(changesOf(context, 1, sid("a"))).toEqual({ text: `@UUID[${lid("b", "eagle-feats-2014")}]{x}@UUID[${lid("c")}]{x}` });
  });

  it("does not copy again what the Library has (the same id) and points the link at it", async () => {
    const context = make({
      documents: [doc("a"), doc("b")],
      eagle: allExist({ "eagle-weapons-2014": [{ id: long("b"), name: "Name b" }] }),
      data: { [sid("a")]: { text: link("b") } },
    });
    const result = await copyDocument(context.deps, sid("a"));
    expect(result).toMatchObject({ ok: true, closure: { documents: 1, dependencies: 0 } });
    expect(sourcesOf(context, 0)).toEqual([sid("a")]);
    expect(changesOf(context, 0, sid("a"))).toEqual({ text: `@UUID[${lid("b")}]{x}` });
  });

  it("does not copy a linked duplicate, links to the entry that carries the key, reports it and enters it in the protocol", async () => {
    const context = make({
      documents: [doc("a"), doc("b", { name: "Shared" })],
      eagle: allExist({ "eagle-weapons-2014": [{ id: long("e"), name: "Shared" }] }),
      data: { [sid("a")]: { text: link("b") } },
    });
    const result = (await copyDocument(context.deps, sid("a"))) as unknown as { ok: true; closure: { dependencies: number; skipped: { total: number; listed: { source: string; reason: string }[] } } };
    expect(result.closure.dependencies).toBe(0);
    expect(result.closure.skipped.listed).toEqual([{ source: sid("b"), reason: "duplicate", detail: expect.any(String) }]);
    expect(changesOf(context, 0, sid("a"))).toEqual({ text: `@UUID[${lid("e")}]{x}` });
    expect(context.entries().map((entry) => [entry.reason, entry.source])).toEqual([["duplicate", sid("b")]]);
  });

  it("treats two documents of the run with the same name as duplicates of each other: the second links to the first", async () => {
    const context = make({
      documents: [doc("a"), doc("b", { name: "Twin" }), doc("c", { name: "Twin" })],
      eagle: allExist(),
      data: { [sid("a")]: { text: link("b") + link("c") } },
    });
    const result = await copyDocument(context.deps, sid("a"));
    expect(result).toMatchObject({ ok: true, closure: { documents: 2, dependencies: 1 } });
    expect(changesOf(context, 0, sid("a"))).toEqual({ text: `@UUID[${lid("b")}]{x}@UUID[${lid("b")}]{x}` });
  });

  it("only reports what has no kind, and what is not installed or not there; nothing of that is protocolled", async () => {
    const context = make({
      documents: [doc("a")],
      eagle: allExist(),
      data: { [sid("a")]: { text: link("n") + link("p") + link("t") } },
      targets: {
        [`dnd5e.items.${long("n")}`]: { installed: true, exists: true, noArt: true },
        [`dnd5e.items.${long("p")}`]: { installed: false },
        [`dnd5e.items.${long("t")}`]: { installed: true, exists: false },
      },
    });
    const result = (await copyDocument(context.deps, sid("a"))) as unknown as { closure: { skipped: { listed: { reason: string }[] } } };
    expect(result.closure.skipped.listed.map((entry) => entry.reason)).toEqual(["no-art", "package-missing", "target-missing"]);
    expect(context.store.text).toBe("");
  });

  it("copies only the document with `closure: false`", async () => {
    const context = make({ documents: [doc("a"), doc("b")], eagle: allExist(), data: { [sid("a")]: { text: link("b") } } });
    const result = await copyDocument(context.deps, sid("a"), { closure: false });
    expect(result).toMatchObject({ ok: true, closure: { documents: 1, dependencies: 0 } });
    expect(sourcesOf(context, 0)).toEqual([sid("a")]);
    expect(context.requests).toHaveLength(1);
  });

  it("writes nothing and says closure-too-large when the run is over the limit", async () => {
    const context = make({ documents: [doc("a"), doc("b"), doc("c")], eagle: allExist(), data: { [sid("a")]: { text: link("b") + link("c") } } });
    const result = await copyDocument(context.deps, sid("a"), { maxDocuments: 2 });
    expect(result).toMatchObject({ ok: false, reason: "closure-too-large" });
    expect(context.requests).toHaveLength(0);
    const fits = await copyDocument(context.deps, sid("a"), { maxDocuments: 3 });
    expect(fits).toMatchObject({ ok: true });
  });

  it("forces only the first document; a linked duplicate stays a duplicate", async () => {
    const context = make({
      documents: [doc("a", { name: "Same" }), doc("b", { name: "Other" })],
      eagle: allExist({ "eagle-weapons-2014": [{ id: long("e"), name: "Same" }, { id: long("f"), name: "Other" }] }),
      data: { [sid("a")]: { text: link("b") } },
    });
    const result = await copyDocument(context.deps, sid("a"), { force: true, version: "2014" });
    expect(result).toMatchObject({ ok: true, forced: true, closure: { documents: 1 } });
    expect(changesOf(context, 0, sid("a"))).toEqual({ text: `@UUID[${lid("f")}]{x}` });
  });

  it("writes in portions of at most 100 documents to one compendium, logs the progress, and the first document is in the last one", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `d${String(i).padStart(3, "0")}`);
    const context = make({
      documents: [doc("a"), ...ids.map((n) => doc(n))],
      eagle: allExist(),
      data: { [sid("a")]: { text: ids.map(link).join("") } },
    });
    const result = await copyDocument(context.deps, sid("a"));
    expect(result).toMatchObject({ ok: true, closure: { documents: 151, portions: 2, dependencies: 150 } });
    expect(context.requests.map((request) => request.payload.sources.length)).toEqual([51, 100]);
    expect(sourcesOf(context, 1)).toContain(sid("a"));
    expect(sourcesOf(context, 0)).not.toContain(sid("a"));
    const progress = context.lines.filter((line) => /closure of .*: portion \d of \d/.test(line.message)).map((line) => line.message.replace(/.*portion/, "portion"));
    expect(progress).toEqual(["portion 1 of 2 (eagle-weapons-2014, 51 documents)", "portion 2 of 2 (eagle-weapons-2014, 100 documents)"]);
  });

  it("stops at the first portion that fails, says what is written, and asking again finishes without writing anything twice", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `d${String(i).padStart(3, "0")}`);
    const context = make({
      documents: [doc("a"), ...ids.map((n) => doc(n))],
      eagle: allExist(),
      data: { [sid("a")]: { text: ids.map(link).join("") } },
    });
    const good = context.request.getMockImplementation()!;
    context.request.mockImplementationOnce(good as never);
    context.request.mockImplementationOnce((async () => ({ ok: false, reason: "handler-failed", detail: "boom" })) as never);
    const first = await copyDocument(context.deps, sid("a"));
    expect(first).toMatchObject({ ok: false, reason: "request-failed", code: "handler-failed", closure: { documents: 151, written: 51, remaining: 100 } });
    // What the first request wrote is in the Library now.
    const written = new Set(sourcesOf(context, 0));
    const compendiumName = "eagle-weapons-2014";
    context.eagle.set(compendiumName, [...written].map((source) => ({ id: source.split(".").pop()!, name: `Name ${source.split(".").pop()}` })));
    const second = await copyDocument(context.deps, sid("a"));
    expect(second).toMatchObject({ ok: true, closure: { documents: 100 } });
    const again = context.requests.slice(1).flatMap((request) => request.payload.sources.map((s) => (typeof s === "string" ? s : s.source)));
    expect(again).toHaveLength(100);
    expect(again.filter((source) => written.has(source))).toEqual([]);
    expect(again).toContain(sid("a"));
  });

  it("finds a document that a stopped run has not written yet, through the source of a document that is written", async () => {
    // b is in the Library (an earlier run wrote it), c, which b links to, is not: a second run copies c.
    const context = make({
      documents: [doc("a"), doc("b"), doc("c")],
      eagle: allExist({ "eagle-weapons-2014": [{ id: long("b"), name: "Name b" }] }),
      data: { [sid("a")]: { text: link("b") }, [sid("b")]: { text: link("c") } },
    });
    const result = await copyDocument(context.deps, sid("a"));
    expect(result).toMatchObject({ ok: true, closure: { documents: 2, dependencies: 1 } });
    expect(sourcesOf(context, 0).sort()).toEqual([sid("a"), sid("c")]);
  });

  it("leaves a document out of the run, but not the run, when its data cannot be read", async () => {
    const context = make({ documents: [doc("a"), doc("b")], eagle: allExist(), data: { [sid("a")]: { text: link("b") } }, noData: [sid("b")] });
    const result = (await copyDocument(context.deps, sid("a"))) as unknown as { ok: boolean; closure: { skipped: { listed: { reason: string }[] } } };
    expect(result.ok).toBe(true);
    expect(result.closure.skipped.listed.map((entry) => entry.reason)).toEqual(["read-failed"]);
    expect(sourcesOf(context, 0)).toEqual([sid("a")]);
  });

  it("copies a linked container with its contents as one unit", async () => {
    const box = doc("box", { subtype: "container" });
    const inner = doc("in", { uuid: sid("in") });
    const context = make({
      documents: [doc("a"), box, inner],
      eagle: allExist(),
      contained: [{ id: long("in"), uuid: sid("in"), container: long("box") }],
      data: { [sid("a")]: { text: link("box") } },
    });
    const result = await copyDocument(context.deps, sid("a"));
    expect(result).toMatchObject({ ok: true, closure: { documents: 3, dependencies: 2 } });
    expect(context.requests.map((request) => request.payload.pack)).toEqual(["world.eagle-containers-2014", "world.eagle-weapons-2014"]);
    expect(sourcesOf(context, 0)).toEqual([sid("box"), sid("in")]);
  });

  it("does not ask the world about a linked document that the Library has", async () => {
    const context = make({
      documents: [doc("a"), doc("b")],
      eagle: allExist({ "eagle-weapons-2014": [{ id: long("b"), name: "Name b" }] }),
      data: { [sid("a")]: { text: link("b") } },
    });
    await copyDocument(context.deps, sid("a"));
    expect(context.world.describeTarget).not.toHaveBeenCalled();
    expect(context.world.readDocument).not.toHaveBeenCalledWith(sid("b"));
  });

  it("reports a linked document of no kind that the world could not tell beforehand, and does not protocol it", async () => {
    const context = make({ documents: [doc("a"), doc("h", { documentName: "Actor", subtype: "character", uuid: `Compendium.dnd5e.items.Actor.${long("h")}` })], eagle: allExist(), data: { [sid("a")]: { text: `@UUID[Compendium.dnd5e.items.Actor.${long("h")}]{x}` } } });
    const result = (await copyDocument(context.deps, sid("a"))) as unknown as { ok: boolean; closure: { skipped: { listed: { reason: string }[] } } };
    expect(result.ok).toBe(true);
    expect(result.closure.skipped.listed.map((entry) => entry.reason)).toEqual(["no-art"]);
    expect(context.store.text).toBe("");
  });

  it("names at most 50 documents that were left out and says how many there are", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `g${String(i).padStart(3, "0")}`);
    const targets = Object.fromEntries(ids.map((n) => [`dnd5e.items.${long(n)}`, { installed: false }]));
    const context = make({ documents: [doc("a")], eagle: allExist(), data: { [sid("a")]: { text: ids.map(link).join("") } }, targets });
    const result = (await copyDocument(context.deps, sid("a"))) as unknown as { closure: { skipped: { total: number; listed: unknown[] } } };
    expect(result.closure.skipped.total).toBe(60);
    expect(result.closure.skipped.listed).toHaveLength(50);
  });

  it("says what is written also when Flight Control throws, and nothing of it for a run of one portion", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `d${String(i).padStart(3, "0")}`);
    const many = make({ documents: [doc("a"), ...ids.map((n) => doc(n))], eagle: allExist(), data: { [sid("a")]: { text: ids.map(link).join("") } } });
    const good = many.request.getMockImplementation()!;
    many.request.mockImplementationOnce(good as never);
    many.request.mockImplementationOnce((async () => { throw new Error("gone"); }) as never);
    expect(await copyDocument(many.deps, sid("a"))).toMatchObject({ ok: false, reason: "request-failed", closure: { documents: 151, written: 51, remaining: 100 } });
    const one = make({ documents: [doc("a")], eagle: allExist() });
    one.request.mockImplementationOnce((async () => { throw new Error("gone"); }) as never);
    expect(await copyDocument(one.deps, sid("a"))).not.toHaveProperty("closure");
  });

  it("shows the plan without writing anything", async () => {
    const context = make({ documents: [doc("a"), doc("b")], eagle: allExist(), data: { [sid("a")]: { text: link("b") } } });
    const result = await planCopy(context.deps, sid("a"));
    expect(result).toMatchObject({ ok: true, plan: { documents: 2, dependencies: 1, portions: 1, byCompendium: { "eagle-weapons-2014": 2 } } });
    expect(context.requests).toHaveLength(0);
    expect(context.protocol.write).not.toHaveBeenCalled();
    expect(await planCopy(context.deps, sid("zz"))).toMatchObject({ ok: false, reason: "source-not-found" });
    expect(await planCopy(make({ gm: false }).deps, sid("a"))).toMatchObject({ ok: false, reason: "not-gm" });
  });
});

describe("copyDocument: the marker of a subspecies (R18)", () => {
  const long = (n: string) => n.padEnd(16, "0");
  const sid = (n: string) => `Compendium.dnd5e.items.Item.${long(n)}`;
  const species = (n: string, name: string): CopySource => item(long(n), { uuid: sid(n), id: long(n), name, subtype: "race", rules: "2024" });
  const entry = (context: ReturnType<typeof make>) => context.requests[0]!.payload.sources[0] as { changes?: Record<string, unknown> } | string;

  it("sets the marker of a name with one comma, in the same request", async () => {
    const context = make({ documents: [species("s", "Elf, High")], eagle: allExist(), data: { [sid("s")]: { name: "Elf, High", system: { type: { subtype: "" } } } } });
    await copyDocument(context.deps, sid("s"));
    expect(entry(context)).toEqual({ source: sid("s"), changes: { "flags.eagle-library.subspecies": { species: "Elf", origin: "auto" } } });
  });

  it("sets the marker of a subtype that stands in the name, and none for a plain species", async () => {
    const sub = make({ documents: [species("s", "High Elf")], eagle: allExist(), data: { [sid("s")]: { name: "High Elf", system: { type: { subtype: "elf" } } } } });
    await copyDocument(sub.deps, sid("s"));
    expect(entry(sub)).toMatchObject({ changes: { "flags.eagle-library.subspecies": { species: "Elf", origin: "auto" } } });
    const plain = make({ documents: [species("s", "Elf")], eagle: allExist(), data: { [sid("s")]: { name: "Elf", system: { type: { subtype: "" } } } } });
    await copyDocument(plain.deps, sid("s"));
    expect(entry(plain)).toBe(sid("s"));
  });

  it("keeps a marker the source has, and sets none on another kind", async () => {
    const own = { flags: { "eagle-library": { subspecies: { species: "Human", origin: "manual" } } }, name: "Elf, High" };
    const kept = make({ documents: [species("s", "Elf, High")], eagle: allExist(), data: { [sid("s")]: own } });
    await copyDocument(kept.deps, sid("s"));
    expect(entry(kept)).toBe(sid("s"));
    const weapon = make({ documents: [item(long("w"), { uuid: sid("w"), id: long("w"), name: "Elf, High" })], eagle: allExist(), data: { [sid("w")]: { name: "Elf, High" } } });
    await copyDocument(weapon.deps, sid("w"));
    expect(entry(weapon)).toBe(sid("w"));
  });

  it("marks a linked species too, after the links of its data", async () => {
    const text = { name: "Elf, High", text: `@UUID[${sid("t")}]{x}` };
    const context = make({ documents: [item(long("a"), { uuid: sid("a"), id: long("a") }), species("s", "Elf, High"), item(long("t"), { uuid: sid("t"), id: long("t") })], eagle: allExist(), data: { [sid("a")]: { text: `@UUID[${sid("s")}]{x}` }, [sid("s")]: text } });
    await copyDocument(context.deps, sid("a"));
    const raceRequest = context.requests.find((request) => request.payload.pack === "world.eagle-species-2024")!;
    const changes = (raceRequest.payload.sources[0] as { changes: Record<string, unknown> }).changes;
    expect(Object.keys(changes).sort()).toEqual(["flags.eagle-library.subspecies", "text"]);
  });
});
