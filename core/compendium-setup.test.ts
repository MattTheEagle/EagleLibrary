import { describe, expect, it, vi } from "vitest";
import { expectedCompendia } from "./catalog";
import { compendiaStatus, createMissingCompendia, type PackSource, type RequestApi } from "./compendium-setup";

const ALL = expectedCompendia();
const NAMES = ALL.map((compendium) => compendium.name);

// The world as far as the Library can see it: a table from compendium name to document type.
function makeWorld(initial: Record<string, string> = {}) {
  const packs = new Map<string, string>(Object.entries(initial));
  const source: PackSource = { find: (name) => (packs.has(name) ? { type: packs.get(name)! } : undefined) };
  return { packs, source };
}

// Flight Control as the contract describes compendium.create: it looks in the same world, creates what is missing and answers
// with created: true/false; it fails when the name is taken by another document type. `fail` names requests that fail.
function makeFlightControl(world: ReturnType<typeof makeWorld>, fail: Record<string, unknown> = {}) {
  const requests: { module: string; type: string; version?: number; payload?: Record<string, string> }[] = [];
  const request = vi.fn(async (input: { module: string; type: string; version?: number; payload?: unknown }) => {
    requests.push(input as never);
    const payload = input.payload as { type: string; label: string; name: string };
    if (payload.name in fail) {
      const outcome = fail[payload.name];
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }
    const existing = world.packs.get(payload.name);
    if (existing !== undefined && existing !== payload.type) {
      return { ok: false, reason: "handler-failed", detail: `the compendium world.${payload.name} exists with the document type ${existing}, not ${payload.type}` };
    }
    world.packs.set(payload.name, payload.type);
    return {
      ok: true,
      value: {
        created: existing === undefined,
        collection: `world.${payload.name}`,
        name: payload.name,
        label: payload.label,
        type: payload.type,
        locked: false,
        ownership: { PLAYER: "OBSERVER", ASSISTANT: "OWNER" },
      },
    };
  });
  const api: RequestApi = { request };
  return { api, request, requests };
}

function recordingLog() {
  const lines: { level: "info" | "warn"; message: string }[] = [];
  return {
    lines,
    log: {
      info: (message: string) => void lines.push({ level: "info", message }),
      warn: (message: string) => void lines.push({ level: "warn", message }),
    },
  };
}

describe("compendiaStatus", () => {
  it("has all 34 compendia missing in an empty world", () => {
    const status = compendiaStatus(makeWorld().source);
    expect(status.expected).toBe(34);
    expect(status.missing.map((compendium) => compendium.name)).toEqual(NAMES);
    expect(status.present).toEqual([]);
    expect(status.conflicts).toEqual([]);
  });

  it("finds the compendia that exist with the right document type, and the ones that are missing", () => {
    const { source } = makeWorld({ "eagle-spells-2014": "Item", "eagle-npcs-2024": "Actor", "eagle-journals": "JournalEntry" });
    const status = compendiaStatus(source);
    expect(status.present.map((compendium) => compendium.name)).toEqual(["eagle-spells-2014", "eagle-npcs-2024", "eagle-journals"].sort((a, b) => NAMES.indexOf(a) - NAMES.indexOf(b)));
    expect(status.missing).toHaveLength(31);
  });

  it("reports a name that a compendium of another document type has taken, as a conflict and not as missing", () => {
    const { source } = makeWorld({ "eagle-spells-2014": "Actor" });
    const status = compendiaStatus(source);
    expect(status.conflicts).toHaveLength(1);
    expect(status.conflicts[0]).toMatchObject({ foundType: "Actor", compendium: { name: "eagle-spells-2014", documentName: "Item" } });
    expect(status.missing.map((compendium) => compendium.name)).not.toContain("eagle-spells-2014");
    expect(status.present).toEqual([]);
  });

  it("lets a source that throws throw, rather than guessing that everything is missing", () => {
    expect(() =>
      compendiaStatus({
        find: () => {
          throw new Error("game.packs is not ready");
        },
      }),
    ).toThrow("not ready");
  });
});

describe("createMissingCompendia", () => {
  it("creates all 34 compendia of the catalog in an empty world, one request each, in catalog order", async () => {
    const world = makeWorld();
    const flight = makeFlightControl(world);
    const { log } = recordingLog();

    const report = await createMissingCompendia(flight.api, world.source, log);

    expect(report).toEqual({ expected: 34, present: 0, created: NAMES, existed: [], conflicts: [], remaining: 0 });
    expect(flight.request).toHaveBeenCalledTimes(34);
    expect([...world.packs.keys()]).toEqual(NAMES);
    for (const compendium of ALL) expect(world.packs.get(compendium.name), compendium.name).toBe(compendium.documentName);
  });

  it("asks with the id of the Library, the type and version of the request, and the type, label and name of the compendium", async () => {
    const world = makeWorld();
    const flight = makeFlightControl(world);
    await createMissingCompendia(flight.api, world.source, recordingLog().log);

    for (const [index, compendium] of ALL.entries()) {
      expect(flight.requests[index]).toEqual({
        module: "eagle-library",
        type: "compendium.create",
        version: 1,
        payload: { type: compendium.documentName, label: compendium.label, name: compendium.name },
      });
    }
    expect(flight.requests[0]?.payload).toEqual({ type: "Item", label: "Eagle Weapons (2014)", name: "eagle-weapons-2014" });
  });

  it("creates nothing twice: a second run asks for nothing", async () => {
    const world = makeWorld();
    const flight = makeFlightControl(world);
    await createMissingCompendia(flight.api, world.source, recordingLog().log);
    flight.request.mockClear();

    const second = await createMissingCompendia(flight.api, world.source, recordingLog().log);

    expect(flight.request).not.toHaveBeenCalled();
    expect(second).toEqual({ expected: 34, present: 34, created: [], existed: [], conflicts: [], remaining: 0 });
    expect(world.packs.size).toBe(34);
  });

  it("asks only for the compendia that are missing when some exist", async () => {
    const world = makeWorld({ "eagle-spells-2014": "Item", "eagle-journals": "JournalEntry" });
    const flight = makeFlightControl(world);

    const report = await createMissingCompendia(flight.api, world.source, recordingLog().log);

    expect(report.present).toBe(2);
    expect(report.created).toHaveLength(32);
    expect(flight.requests.map((request) => request.payload?.name)).not.toContain("eagle-spells-2014");
    expect(flight.requests.map((request) => request.payload?.name)).not.toContain("eagle-journals");
    expect(world.packs.size).toBe(34);
  });

  it("counts a compendium that Flight Control found although the Library thought it missing as existed", async () => {
    const world = makeWorld();
    const flight = makeFlightControl(world);
    // Somebody makes the compendium after the Library has looked: the source does not see it, Flight Control does.
    const seenBefore = new Set<string>();
    const source: PackSource = { find: (name) => (seenBefore.has(name) ? undefined : world.source.find(name)) };
    world.packs.set("eagle-loot-2014", "Item");
    seenBefore.add("eagle-loot-2014");

    const report = await createMissingCompendia(flight.api, source, recordingLog().log);

    expect(report.existed).toEqual(["eagle-loot-2014"]);
    expect(report.created).toHaveLength(33);
    expect(report.failure).toBeUndefined();
  });

  it("reports a name taken by another document type, does not ask for it and makes the others", async () => {
    const world = makeWorld({ "eagle-spells-2014": "Actor" });
    const flight = makeFlightControl(world);
    const { lines, log } = recordingLog();

    const report = await createMissingCompendia(flight.api, world.source, log);

    expect(report.conflicts).toHaveLength(1);
    expect(report.created).toHaveLength(33);
    expect(report.failure).toBeUndefined();
    expect(flight.requests.map((request) => request.payload?.name)).not.toContain("eagle-spells-2014");
    expect(world.packs.get("eagle-spells-2014")).toBe("Actor");
    expect(lines.filter((line) => line.level === "warn")).toEqual([
      {
        level: "warn",
        message:
          "eagle-library | compendium eagle-spells-2014: the name is taken by a compendium of the document type Actor (expected Item); not touched",
      },
    ]);
  });

  it("stops at the first failure, says where and how many were not asked for, and continues on the next run", async () => {
    const world = makeWorld();
    const failure = { ok: false, reason: "handler-failed", detail: "Foundry refused" };
    const flight = makeFlightControl(world, { "eagle-tools-2014": failure });
    const { lines, log } = recordingLog();

    const first = await createMissingCompendia(flight.api, world.source, log);

    const stopAt = NAMES.indexOf("eagle-tools-2014");
    expect(first.created).toEqual(NAMES.slice(0, stopAt));
    expect(first.failure).toEqual({ name: "eagle-tools-2014", reason: "handler-failed", detail: "Foundry refused" });
    expect(first.remaining).toBe(34 - stopAt - 1);
    expect(flight.request).toHaveBeenCalledTimes(stopAt + 1);
    expect(lines.at(-2)).toEqual({ level: "warn", message: "eagle-library | compendium eagle-tools-2014: failed (handler-failed): Foundry refused" });
    expect(lines.at(-1)?.message).toContain(`stopped at eagle-tools-2014 (${34 - stopAt - 1} not asked for)`);

    // the fault is gone: the next run makes the rest and nothing twice
    const second = await createMissingCompendia(makeFlightControl(world).api, world.source, recordingLog().log);
    expect(second.present).toBe(stopAt);
    expect(second.created).toEqual(NAMES.slice(stopAt));
    expect(second.failure).toBeUndefined();
    expect(world.packs.size).toBe(34);
  });

  it("stops at a refusal of Flight Control, for every failure code, and passes the code on", async () => {
    for (const reason of ["not-registered", "unknown-request", "unsupported-version", "invalid-payload", "no-gm", "relay-timeout", "relay-failed", "not-permitted", "internal-error", "some-new-code"]) {
      const world = makeWorld();
      const flight = makeFlightControl(world, { "eagle-weapons-2014": { ok: false, reason, detail: `detail of ${reason}` } });
      const report = await createMissingCompendia(flight.api, world.source, recordingLog().log);
      expect(report.failure, reason).toEqual({ name: "eagle-weapons-2014", reason, detail: `detail of ${reason}` });
      expect(report.created, reason).toEqual([]);
      expect(report.remaining, reason).toBe(33);
      expect(flight.request, reason).toHaveBeenCalledTimes(1);
    }
  });

  it("turns a request that throws or rejects into a failure instead of throwing", async () => {
    const world = makeWorld();
    const flight = makeFlightControl(world, { "eagle-weapons-2014": new Error("channel closed") });
    const report = await createMissingCompendia(flight.api, world.source, recordingLog().log);
    expect(report.failure).toEqual({ name: "eagle-weapons-2014", reason: "threw", detail: "channel closed" });

    const throwing: RequestApi = {
      request: () => {
        throw new Error("no such function");
      },
    };
    const again = await createMissingCompendia(throwing, makeWorld().source, recordingLog().log);
    expect(again.failure).toMatchObject({ reason: "threw", detail: "no such function" });
  });

  it("does not trust an answer that is not what the contract describes", async () => {
    const good = { ok: true, value: { created: true, collection: "world.eagle-weapons-2014", type: "Item" } };
    const answers: [string, unknown][] = [
      ["undefined", undefined],
      ["text", "created"],
      ["array", []],
      ["no ok", { value: good.value }],
      ["ok true without value", { ok: true }],
      ["value not an object", { ok: true, value: "created" }],
      ["created not a boolean", { ok: true, value: { ...good.value, created: "yes" } }],
      ["another collection", { ok: true, value: { ...good.value, collection: "world.eagle-weapons-2024" } }],
      ["another document type", { ok: true, value: { ...good.value, type: "Actor" } }],
      ["a failure without reason", { ok: false }],
    ];
    for (const [name, answer] of answers) {
      const world = makeWorld();
      const flight = makeFlightControl(world, { "eagle-weapons-2014": answer });
      const report = await createMissingCompendia(flight.api, world.source, recordingLog().log);
      expect(report.failure?.reason, name).toBe("invalid-response");
      expect(report.created, name).toEqual([]);
    }
  });

  it("reports a missing Flight Control as a failure at the first compendium, without asking anything", async () => {
    const world = makeWorld();
    const { lines, log } = recordingLog();
    const report = await createMissingCompendia(undefined, world.source, log);
    expect(report.failure).toEqual({ name: "eagle-weapons-2014", reason: "missing", detail: "Eagle Flight Control is missing or not active" });
    expect(report.remaining).toBe(33);
    expect(lines[0]?.level).toBe("warn");
  });

  it("asks nothing and needs no Flight Control when nothing is missing", async () => {
    const world = makeWorld(Object.fromEntries(ALL.map((compendium) => [compendium.name, compendium.documentName])));
    const report = await createMissingCompendia(undefined, world.source, recordingLog().log);
    expect(report).toEqual({ expected: 34, present: 34, created: [], existed: [], conflicts: [], remaining: 0 });
  });

  it("reports a world that cannot be read as a failure and asks for nothing", async () => {
    const flight = makeFlightControl(makeWorld());
    const report = await createMissingCompendia(
      flight.api,
      {
        find: () => {
          throw new Error("game.packs is not ready");
        },
      },
      recordingLog().log,
    );
    expect(report.failure).toMatchObject({ reason: "threw", detail: "the world's compendia could not be read: game.packs is not ready" });
    expect(report.remaining).toBe(34);
    expect(flight.request).not.toHaveBeenCalled();
  });

  it("logs one line for each compendium it made and one summary line", async () => {
    const world = makeWorld({ "eagle-spells-2014": "Item" });
    const { lines, log } = recordingLog();
    await createMissingCompendia(makeFlightControl(world).api, world.source, log);

    expect(lines.filter((line) => /: created$/.test(line.message))).toHaveLength(33);
    expect(lines[0]).toEqual({ level: "info", message: "eagle-library | compendium eagle-weapons-2014: created" });
    expect(lines.at(-1)).toEqual({
      level: "info",
      message: "eagle-library | compendia: 34 expected, 1 there before, 33 created, 0 existed, 0 in conflict",
    });
  });

  it("asks one after the other, never two at once", async () => {
    const world = makeWorld();
    let running = 0;
    let most = 0;
    const api: RequestApi = {
      request: async (input) => {
        running += 1;
        most = Math.max(most, running);
        await Promise.resolve();
        const flight = makeFlightControl(world);
        const answer = await flight.api.request(input);
        running -= 1;
        return answer;
      },
    };
    await createMissingCompendia(api, world.source, recordingLog().log);
    expect(most).toBe(1);
    expect(world.packs.size).toBe(34);
  });
});
