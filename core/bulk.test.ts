import { describe, expect, it, vi } from "vitest";
import { compendiaOf, CATALOG, expectedCompendia, type ExpectedCompendium } from "./catalog";
import { copyCompendia, planCompendia, type BulkDeps, type BulkWorld, type CompendiumIndex } from "./bulk";
import type { CopySource, IndexEntry } from "./copy";
import { parseProtocol, type Protocol } from "./protocol";

const kind = (key: string) => CATALOG.find((entry) => entry.key === key)!;
const compendium = (key: string, version?: string): ExpectedCompendium => compendiaOf(kind(key)).find((c) => c.version === version)!;

const long = (n: string) => n.padEnd(16, "0");
const uuidOf = (id: string, collection = "dnd5e.items", documentName = "Item") => `Compendium.${collection}.${documentName}.${long(id)}`;

const item = (id: string, name: string, over: Partial<CopySource> = {}): CopySource => ({
  uuid: uuidOf(id),
  id: long(id),
  name,
  documentName: "Item",
  subtype: "weapon",
  rules: "2014",
  primary: true,
  pack: { collection: "dnd5e.items", packageType: "system", name: "items", type: "Item" },
  ...over,
});

interface Setup {
  // A source compendium: collection -> its documents (name and subtype decide whether they have a kind).
  sourceCompendia?: Record<string, { documentName: string; docs: { id: string; name: string; subtype?: string }[] }>;
  documents?: CopySource[];
  eagle?: Record<string, IndexEntry[]>;
  targets?: Record<string, { installed: boolean; exists?: boolean; noArt?: boolean }>;
  noCompendium?: string[];
}

const allExist = (over: Record<string, IndexEntry[]> = {}) => Object.fromEntries(expectedCompendia().map((c) => [c.name, over[c.name] ?? []]));

function make(setup: Setup = {}) {
  const sourceCompendia = setup.sourceCompendia ?? {};
  const documents = new Map((setup.documents ?? []).map((d) => [d.uuid, d]));
  // Every document a source compendium lists is also readable and has its own (empty) data, unless a test overrides it.
  for (const [collection, { documentName, docs }] of Object.entries(sourceCompendia)) {
    for (const doc of docs) {
      const uuid = uuidOf(doc.id, collection, documentName);
      if (!documents.has(uuid)) {
        documents.set(
          uuid,
          item(doc.id, doc.name, { uuid, documentName, subtype: doc.subtype, pack: { collection, packageType: "system", name: collection.split(".")[1] ?? collection, type: documentName } }),
        );
      }
    }
  }
  const eagle = new Map(Object.entries(setup.eagle ?? {}));
  const world: BulkWorld = {
    readDocument: vi.fn(async (uuid: string) => documents.get(uuid)),
    eagleIndex: vi.fn(async (c: ExpectedCompendium) => eagle.get(c.name)),
    contained: vi.fn(async () => []),
    readData: vi.fn(async (uuid: string) => (documents.has(uuid) ? {} : undefined)),
    libraryIds: vi.fn(async () => {
      const ids = new Map<string, { compendium: string; documentName: string }>();
      for (const compendium of expectedCompendia()) for (const entry of eagle.get(compendium.name) ?? []) ids.set(entry.id, { compendium: compendium.name, documentName: compendium.documentName });
      return ids;
    }),
    describeTarget: vi.fn(async (scope: string, pack: string, id: string) => setup.targets?.[`${scope}.${pack}.${id}`] ?? { installed: true, exists: true }),
    readCompendiumIndex: vi.fn(async (collection: string): Promise<CompendiumIndex | undefined> => {
      if (setup.noCompendium?.includes(collection)) return undefined;
      const held = sourceCompendia[collection];
      if (!held) return undefined;
      return { documentName: held.documentName, entries: held.docs.map((doc) => ({ id: long(doc.id), name: doc.name, subtype: doc.subtype })) };
    }),
    listNonEaglePacks: vi.fn(async () => Object.entries(sourceCompendia).map(([collection, held]) => ({ collection, documentName: held.documentName, label: collection }))),
  };
  type Wanted = string | { source: string; id?: string; name?: string; changes?: Record<string, unknown> };
  const requests: { module: string; type: string; version?: number; payload: { pack: string; sources: Wanted[] } }[] = [];
  const request = vi.fn(async (input: never) => {
    const call = input as (typeof requests)[number];
    requests.push(call);
    // Simulates Flight Control really writing: the target Eagle Compendium's index gets the new entries, so a later
    // candidate of this same bulk run (a fresh call, reading the index anew) sees what an earlier one just wrote.
    const compendiumName = call.payload.pack.replace(/^world\./, "");
    const list = eagle.get(compendiumName) ?? [];
    const created = call.payload.sources.map((wanted) => {
      const source = typeof wanted === "string" ? wanted : wanted.source;
      const id = (typeof wanted === "string" ? undefined : wanted.id) ?? source.split(".").pop()!;
      const name = (typeof wanted === "string" ? undefined : wanted.name) ?? documents.get(source)?.name ?? `Name ${id}`;
      list.push({ id, name });
      return { source, uuid: `Compendium.${call.payload.pack}.Item.${id}`, id, name };
    });
    eagle.set(compendiumName, list);
    return { ok: true, value: { pack: call.payload.pack, created, existed: [] } };
  });
  const lines: { level: string; message: string }[] = [];
  const log = { info: (message: string) => lines.push({ level: "info", message }), warn: (message: string) => lines.push({ level: "warn", message }) };
  const store = { text: "", writes: 0 };
  const protocol = {
    read: vi.fn(() => store.text),
    write: vi.fn(async (previous: string, value: string) => {
      store.writes++;
      if (previous !== store.text) return { ok: false as const, detail: "handler-failed: the setting changed since it was read" };
      store.text = value;
      return { ok: true as const };
    }),
  };
  const spellStore = { text: "" };
  const spellLists = {
    read: vi.fn(() => spellStore.text),
    write: vi.fn(async (previous: string, value: string) => {
      if (previous !== spellStore.text) return { ok: false as const, detail: "handler-failed: the setting changed since it was read" };
      spellStore.text = value;
      return { ok: true as const };
    }),
  };
  let counter = 0;
  const deps: BulkDeps = {
    world,
    api: { request },
    protocol,
    spellLists,
    newId: () => `NEW${String(++counter).padStart(13, "0")}`,
    user: () => "gm-1",
    now: () => "2026-09-22T12:00:00.000Z",
    isGm: () => true,
    log,
  };
  const entries = (): Protocol["entries"] => {
    const parsed = parseProtocol(store.text);
    return parsed.ok ? parsed.protocol.entries : [];
  };
  return { world, requests, lines, deps, eagle, entries };
}

describe("copyCompendia", () => {
  it("copies every document of a compendium that has a kind, and skips the rest without a request", async () => {
    const context = make({
      sourceCompendia: { "dnd5e.items": { documentName: "Item", docs: [{ id: "a", name: "A", subtype: "weapon" }, { id: "b", name: "B", subtype: "weapon" }, { id: "c", name: "C" }] } },
      eagle: allExist(),
    });
    const result = await copyCompendia(context.deps, "dnd5e.items");
    expect(result).toMatchObject({ total: 2, copied: 2, alreadyCopied: 0, duplicates: 0, noArt: 1, failed: 0, stopped: false });
    expect(context.requests).toHaveLength(2);
    expect(context.lines.some((l) => l.level === "info" && /bulk copy: 2 roots, 2 copied/.test(l.message))).toBe(true);
  });

  it("counts a duplicate and an already-copied document as expected outcomes, not as failures", async () => {
    const context = make({
      sourceCompendia: { "dnd5e.items": { documentName: "Item", docs: [{ id: "a", name: "A", subtype: "weapon" }, { id: "b", name: "Same", subtype: "weapon" }, { id: "c", name: "Same", subtype: "weapon" }] } },
      eagle: allExist({ "eagle-weapons-2014": [{ id: long("a"), name: "A" }] }),
    });
    const result = await copyCompendia(context.deps, "dnd5e.items");
    expect(result).toMatchObject({ total: 3, copied: 1, alreadyCopied: 1, duplicates: 1, failed: 0, stopped: false });
  });

  it("stops after several failures in a row and leaves the rest of the selection for a later call", async () => {
    const docs = Array.from({ length: 8 }, (_, i) => ({ id: `x${i}`, name: `X${i}`, subtype: "weapon" }));
    const context = make({
      sourceCompendia: { "dnd5e.items": { documentName: "Item", docs } },
      eagle: {}, // no Eagle compendia exist: every candidate fails with no-target
    });
    const result = await copyCompendia(context.deps, "dnd5e.items", { maxConsecutiveFailures: 3 });
    expect(result).toMatchObject({ total: 8, copied: 0, failed: 3, stopped: true, stoppedReason: "consecutive-failures" });
    expect(result.failures).toHaveLength(3);
    expect(context.requests).toHaveLength(0);
  });

  it("resets the count of failures on a success, an already-copied or a duplicate", async () => {
    const context = make({
      sourceCompendia: {
        "dnd5e.items": {
          documentName: "Item",
          docs: [
            { id: "f1", name: "F1", subtype: "weapon" },
            { id: "ok", name: "OK", subtype: "weapon" },
            { id: "f2", name: "F2", subtype: "weapon" },
            { id: "f3", name: "F3", subtype: "weapon" },
            { id: "f4", name: "F4", subtype: "weapon" },
          ],
        },
      },
      eagle: allExist(),
    });
    // f1, f2, f3 and f4 fail because their data cannot be read; "ok" (in between) succeeds and resets the count.
    const failing = new Set(["f1", "f2", "f3", "f4"].map((n) => long(n)));
    context.world.readData = vi.fn(async (uuid: string) => (failing.has(uuid.split(".").pop()!) ? undefined : {}));
    const result = await copyCompendia(context.deps, "dnd5e.items", { maxConsecutiveFailures: 2 });
    // f1 fails (count 1), ok succeeds (count reset to 0), f2 fails (count 1), f3 fails (count 2) -> stop; f4 never attempted.
    expect(result).toMatchObject({ total: 5, copied: 1, failed: 3, stopped: true, stoppedReason: "consecutive-failures" });
    expect(context.requests).toHaveLength(1);
  });

  it("names a compendium of the selection that does not exist, and continues with the rest", async () => {
    const context = make({ sourceCompendia: { "dnd5e.items": { documentName: "Item", docs: [{ id: "a", name: "A", subtype: "weapon" }] } }, eagle: allExist() });
    const result = await copyCompendia(context.deps, ["dnd5e.items", "dnd5e.nope"]);
    expect(result.selectionErrors).toEqual([{ collection: "dnd5e.nope", detail: "the compendium does not exist" }]);
    expect(result).toMatchObject({ total: 1, copied: 1 });
  });

  it("with \"all\", copies every non-Eagle compendium the world names", async () => {
    const context = make({
      sourceCompendia: {
        "dnd5e.items": { documentName: "Item", docs: [{ id: "a", name: "A", subtype: "weapon" }] },
        "dnd5e.spells": { documentName: "Item", docs: [{ id: "s", name: "S", subtype: "spell" }] },
      },
      eagle: allExist(),
    });
    const result = await copyCompendia(context.deps, "all");
    expect(result).toMatchObject({ total: 2, copied: 2 });
    expect(context.world.listNonEaglePacks).toHaveBeenCalled();
  });

  it("refuses for a player and asks nothing", async () => {
    const context = make({ sourceCompendia: { "dnd5e.items": { documentName: "Item", docs: [{ id: "a", name: "A", subtype: "weapon" }] } }, eagle: allExist() });
    const deps = { ...context.deps, isGm: () => false };
    const result = await copyCompendia(deps, "dnd5e.items");
    expect(result).toMatchObject({ total: 1, failed: 1, copied: 0 });
    expect(context.requests).toHaveLength(0);
  });

  it("calls onProgress once per candidate, in the order they run, in addition to the console log", async () => {
    const context = make({
      sourceCompendia: { "dnd5e.items": { documentName: "Item", docs: [{ id: "a", name: "A", subtype: "weapon" }, { id: "b", name: "B", subtype: "weapon" }] } },
      eagle: allExist(),
    });
    const seen: { index: number; total: number; name: string; outcome: string }[] = [];
    const result = await copyCompendia(context.deps, "dnd5e.items", { onProgress: (info) => seen.push(info) });
    expect(result).toMatchObject({ total: 2, copied: 2 });
    expect(seen).toEqual([{ index: 1, total: 2, name: "A", outcome: "copied" }, { index: 2, total: 2, name: "B", outcome: "copied" }]);
  });

  it("stops at once when the signal is already aborted, before the first candidate", async () => {
    const context = make({ sourceCompendia: { "dnd5e.items": { documentName: "Item", docs: [{ id: "a", name: "A", subtype: "weapon" }] } }, eagle: allExist() });
    const controller = new AbortController();
    controller.abort();
    const result = await copyCompendia(context.deps, "dnd5e.items", { signal: controller.signal });
    expect(result).toMatchObject({ total: 1, copied: 0, stopped: true, stoppedReason: "aborted" });
    expect(context.requests).toHaveLength(0);
  });

  it("stops mid-run when the signal is aborted after an earlier candidate, and leaves the rest for a later call", async () => {
    const context = make({
      sourceCompendia: {
        "dnd5e.items": {
          documentName: "Item",
          docs: [{ id: "a", name: "A", subtype: "weapon" }, { id: "b", name: "B", subtype: "weapon" }, { id: "c", name: "C", subtype: "weapon" }],
        },
      },
      eagle: allExist(),
    });
    const controller = new AbortController();
    const result = await copyCompendia(context.deps, "dnd5e.items", {
      signal: controller.signal,
      onProgress: (info) => { if (info.index === 1) controller.abort(); },
    });
    expect(result).toMatchObject({ total: 3, copied: 1, stopped: true, stoppedReason: "aborted" });
    expect(context.requests).toHaveLength(1);
  });

  it("lists a successful copy that still links outside the Library, up to 50", async () => {
    const sid = (n: string) => uuidOf(n);
    const context = make({
      sourceCompendia: { "dnd5e.items": { documentName: "Item", docs: [{ id: "a", name: "A", subtype: "weapon" }] } },
      eagle: allExist(),
    });
    // "a" links to a document that is never part of this run's closure; the default `describeTarget` mock (installed,
    // exists, not noArt) makes the world call it "not-copied" — a problem, but not a failure of the copy itself.
    context.world.readData = vi.fn(async (uuid: string) => (uuid === sid("a") ? { list: [sid("lost")] } : ({} as Record<string, never>)));
    const result = await copyCompendia(context.deps, "dnd5e.items");
    expect(result).toMatchObject({ total: 1, copied: 1 });
    expect(result.linksWithGaps).toEqual([{ uuid: sid("a"), unresolved: 1 }]);
  });
});

describe("planCompendia", () => {
  it("counts a dependency shared by two roots of the selection once, and matches a following real run", async () => {
    const sid = (n: string) => uuidOf(n);
    const dep = item("dep", "Shared Feature", { uuid: sid("dep") });
    const a = item("a", "A", { uuid: sid("a") });
    const b = item("b", "B", { uuid: sid("b") });
    const link = `@UUID[${sid("dep")}]{x}`;
    const documents = [dep, a, b];
    const data: Record<string, unknown> = { [sid("a")]: { text: link }, [sid("b")]: { text: link } };
    const context = make({
      sourceCompendia: { "dnd5e.items": { documentName: "Item", docs: [{ id: "a", name: "A", subtype: "weapon" }, { id: "b", name: "B", subtype: "weapon" }] } },
      documents,
      eagle: allExist(),
    });
    // Override readData to return the linking text for a and b.
    context.world.readData = vi.fn(async (uuid: string) => (data[uuid] as never) ?? (documents.some((d) => d.uuid === uuid) ? {} : undefined));

    const planned = await planCompendia(context.deps, "dnd5e.items");
    expect(planned).toMatchObject({ total: 2, documents: 3 }); // a, b and the one shared dependency, not two

    const real = await copyCompendia(context.deps, "dnd5e.items");
    expect(real).toMatchObject({ total: 2, copied: 2 });
    // The shared dependency and both roots: three documents, and only three creation entries across all requests.
    const created = context.requests.flatMap((r) => r.payload.sources.length);
    expect(created.reduce((a, b) => a + b, 0)).toBe(planned.documents);
  });

  it("does not write anything and lists already-copied and duplicate candidates apart from failures", async () => {
    const context = make({
      sourceCompendia: { "dnd5e.items": { documentName: "Item", docs: [{ id: "a", name: "A", subtype: "weapon" }, { id: "b", name: "Same", subtype: "weapon" }, { id: "c", name: "Same", subtype: "weapon" }] } },
      eagle: allExist({ "eagle-weapons-2014": [{ id: long("a"), name: "A" }] }),
    });
    const planned = await planCompendia(context.deps, "dnd5e.items");
    expect(planned).toMatchObject({ total: 3, alreadyCopied: 1, duplicates: 1, failed: 0 });
    expect(context.requests).toHaveLength(0);
  });

  it("lists failures such as a missing target compendium, up to 50", async () => {
    const context = make({
      sourceCompendia: { "dnd5e.items": { documentName: "Item", docs: [{ id: "a", name: "A", subtype: "weapon" }] } },
      eagle: {},
    });
    const planned = await planCompendia(context.deps, "dnd5e.items");
    expect(planned.failed).toBe(1);
    expect(planned.failures[0]).toMatchObject({ uuid: uuidOf("a"), result: { reason: "no-target" } });
  });

  it("calls onProgress once per candidate, in addition to the console log", async () => {
    const context = make({
      sourceCompendia: { "dnd5e.items": { documentName: "Item", docs: [{ id: "a", name: "A", subtype: "weapon" }, { id: "b", name: "B", subtype: "weapon" }] } },
      eagle: allExist(),
    });
    const seen: { index: number; total: number; name: string; outcome: string }[] = [];
    const planned = await planCompendia(context.deps, "dnd5e.items", { onProgress: (info) => seen.push(info) });
    expect(planned).toMatchObject({ total: 2, documents: 2 });
    expect(seen).toEqual([{ index: 1, total: 2, name: "A", outcome: "planned" }, { index: 2, total: 2, name: "B", outcome: "planned" }]);
  });

  it("stops early when the signal is aborted, and says so without pretending the totals are complete", async () => {
    const context = make({
      sourceCompendia: {
        "dnd5e.items": { documentName: "Item", docs: [{ id: "a", name: "A", subtype: "weapon" }, { id: "b", name: "B", subtype: "weapon" }, { id: "c", name: "C", subtype: "weapon" }] },
      },
      eagle: allExist(),
    });
    const controller = new AbortController();
    const planned = await planCompendia(context.deps, "dnd5e.items", {
      signal: controller.signal,
      onProgress: (info) => { if (info.index === 1) controller.abort(); },
    });
    expect(planned).toMatchObject({ total: 3, documents: 1, stopped: true, stoppedReason: "aborted" });
  });

  it("does not stop and has no stopped/stoppedReason field when nothing aborts it", async () => {
    const context = make({ sourceCompendia: { "dnd5e.items": { documentName: "Item", docs: [{ id: "a", name: "A", subtype: "weapon" }] } }, eagle: allExist() });
    const planned = await planCompendia(context.deps, "dnd5e.items");
    expect(planned).not.toHaveProperty("stopped");
    expect(planned).not.toHaveProperty("stoppedReason");
  });
});

describe("copyCompendia: the safety valve counts and resets precisely", () => {
  it("uses 5 as the default (undocumented option omitted)", async () => {
    const docs = Array.from({ length: 6 }, (_, i) => ({ id: `x${i}`, name: `X${i}`, subtype: "weapon" }));
    const context = make({ sourceCompendia: { "dnd5e.items": { documentName: "Item", docs } }, eagle: {} });
    const result = await copyCompendia(context.deps, "dnd5e.items");
    expect(result).toMatchObject({ total: 6, failed: 5, stopped: true });
  });

  it("resets the count on an already-copied document and on a duplicate, not only on a success", async () => {
    const failing = new Set(["f1", "f2", "f3", "f4"].map((n) => long(n)));
    const context = make({
      sourceCompendia: {
        "dnd5e.items": {
          documentName: "Item",
          docs: [
            { id: "f1", name: "F1", subtype: "weapon" },
            { id: "ok", name: "OK", subtype: "weapon" },
            { id: "f2", name: "F2", subtype: "weapon" },
            { id: "dup", name: "X", subtype: "weapon" },
            { id: "f3", name: "F3", subtype: "weapon" },
            { id: "f4", name: "F4", subtype: "weapon" },
          ],
        },
      },
      eagle: allExist({ "eagle-weapons-2014": [{ id: long("ok"), name: "OK" }, { id: long("existing"), name: "X" }] }),
    });
    context.world.readData = vi.fn(async (uuid: string) => (failing.has(uuid.split(".").pop()!) ? undefined : {}));
    const result = await copyCompendia(context.deps, "dnd5e.items", { maxConsecutiveFailures: 2 });
    // f1 fails (1), ok already-copied (reset), f2 fails (1), dup is a duplicate (reset), f3 fails (1), f4 fails (2) -> stop.
    expect(result).toMatchObject({ total: 6, alreadyCopied: 1, duplicates: 1, failed: 4, copied: 0, stopped: true });
  });
});

describe("copyCompendia: options reach copyDocument", () => {
  it("forces a duplicate when { force: true } is given", async () => {
    const context = make({
      sourceCompendia: { "dnd5e.items": { documentName: "Item", docs: [{ id: "a", name: "Same", subtype: "weapon" }] } },
      eagle: allExist({ "eagle-weapons-2014": [{ id: long("existing"), name: "Same" }] }),
    });
    const result = await copyCompendia(context.deps, "dnd5e.items", { force: true, version: "2014" });
    expect(result).toMatchObject({ total: 1, copied: 1, duplicates: 0, failed: 0 });
  });
});

describe("copyCompendia: at most 50 failures are listed", () => {
  it("lists 50 of 60 failures and still counts all 60", async () => {
    const docs = Array.from({ length: 60 }, (_, i) => ({ id: `y${i}`, name: `Y${i}`, subtype: "weapon" }));
    const context = make({ sourceCompendia: { "dnd5e.items": { documentName: "Item", docs } }, eagle: {} });
    const result = await copyCompendia(context.deps, "dnd5e.items", { maxConsecutiveFailures: 1000 });
    expect(result).toMatchObject({ total: 60, failed: 60, stopped: false });
    expect(result.failures).toHaveLength(50);
  });
});

describe("planCompendia: the shared state avoids repeated work, not only repeated counting", () => {
  it("does not ask the world about a dependency a second time once an earlier candidate has planned it", async () => {
    const sid = (n: string) => uuidOf(n);
    const dep = item("dep", "Shared", { uuid: sid("dep") });
    const a = item("a", "A", { uuid: sid("a") });
    const b = item("b", "B", { uuid: sid("b") });
    const link = `@UUID[${sid("dep")}]{x}`;
    const context = make({
      sourceCompendia: { "dnd5e.items": { documentName: "Item", docs: [{ id: "a", name: "A", subtype: "weapon" }, { id: "b", name: "B", subtype: "weapon" }] } },
      documents: [dep, a, b],
      eagle: allExist(),
    });
    const data: Record<string, unknown> = { [sid("a")]: { text: link }, [sid("b")]: { text: link } };
    context.world.readData = vi.fn(async (uuid: string) => (data[uuid] as never) ?? (uuid === sid("dep") ? {} : undefined));
    const planned = await planCompendia(context.deps, "dnd5e.items");
    expect(planned).toMatchObject({ total: 2, documents: 3 });
    expect(context.world.describeTarget).toHaveBeenCalledTimes(1);
  });

  it("does not ask the world about a dependency that is already in the Library when the run starts", async () => {
    const sid = (n: string) => uuidOf(n);
    const dep = item("dep", "Shared", { uuid: sid("dep") });
    const a = item("a", "A", { uuid: sid("a") });
    const context = make({
      sourceCompendia: { "dnd5e.items": { documentName: "Item", docs: [{ id: "a", name: "A", subtype: "weapon" }] } },
      documents: [dep, a],
      eagle: allExist({ "eagle-weapons-2014": [{ id: long("dep"), name: "Shared" }] }),
    });
    context.world.readData = vi.fn(async (uuid: string) => (uuid === sid("a") ? { text: `@UUID[${sid("dep")}]{x}` } : undefined));
    const planned = await planCompendia(context.deps, "dnd5e.items");
    expect(planned).toMatchObject({ total: 1, documents: 1 });
    expect(context.world.describeTarget).not.toHaveBeenCalled();
  });
});
