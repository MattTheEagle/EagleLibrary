import { describe, expect, it } from "vitest";
import {
  addEntry,
  EMPTY_PROTOCOL,
  MAX_EXISTING_PER_ENTRY,
  MAX_PROTOCOL_ENTRIES,
  MAX_PROTOCOL_LENGTH,
  openEntriesOf,
  parseProtocol,
  PROTOCOL_REASONS,
  resolveSource,
  serializeProtocol,
  type NewEntry,
  type Protocol,
} from "./protocol";

const entry = (over: Partial<NewEntry> = {}): NewEntry => ({
  at: "2026-09-21T12:00:00.000Z",
  by: "gm-1",
  reason: "duplicate",
  source: "Compendium.dnd5e.items.Item.a1",
  name: "Dagger",
  kind: "weapons",
  version: "2024",
  target: "eagle-weapons-2024",
  existing: ["Compendium.world.eagle-weapons-2024.Item.zz"],
  ...over,
});

const ok = (text: string): Protocol => {
  const parsed = parseProtocol(text);
  if (!parsed.ok) throw new Error(parsed.detail);
  return parsed.protocol;
};

describe("the protocol: reasons", () => {
  it("has the four outcomes of the rules and limits, and no technical failure", () => {
    expect([...PROTOCOL_REASONS]).toEqual(["duplicate", "no-art", "too-many", "container-too-deep"]);
  });
});

describe("the protocol: reading and writing the text", () => {
  it("reads an empty text as an empty protocol, and writes an empty protocol as an empty text", () => {
    for (const text of ["", "   ", "\n"]) expect(parseProtocol(text)).toEqual({ ok: true, protocol: EMPTY_PROTOCOL });
    expect(serializeProtocol(EMPTY_PROTOCOL)).toBe("");
  });

  it("gives back what it wrote", () => {
    const protocol = addEntry(addEntry(EMPTY_PROTOCOL, entry()), entry({ source: "b2", reason: "no-art", kind: null, version: null, target: null, existing: [] }));
    expect(ok(serializeProtocol(protocol))).toEqual(protocol);
  });

  it("keeps a protocol that only has a count of dropped entries", () => {
    const text = serializeProtocol({ version: 1, dropped: 3, entries: [] });
    expect(text).not.toBe("");
    expect(ok(text)).toEqual({ version: 1, dropped: 3, entries: [] });
  });

  it("does not accept text that is not JSON, not of version 1, or shaped wrongly, and says what is wrong", () => {
    const good = JSON.parse(serializeProtocol(addEntry(EMPTY_PROTOCOL, entry())));
    const bad: unknown[] = [
      "not json", "[]", "5", "null", { version: 2, dropped: 0, entries: [] }, { version: 1, dropped: -1, entries: [] },
      { version: 1, dropped: 1.5, entries: [] }, { version: 1, dropped: "0", entries: [] }, { version: 1, dropped: 0 },
      { version: 1, dropped: 0, entries: "x" },
      { ...good, entries: [{ ...good.entries[0], reason: "read-failed" }] },
      { ...good, entries: [{ ...good.entries[0], status: "done" }] },
      { ...good, entries: [{ ...good.entries[0], existing: "x" }] },
      { ...good, entries: [{ ...good.entries[0], existing: [5] }] },
      { ...good, entries: [{ ...good.entries[0], kind: 5 }] },
      { ...good, entries: [{ ...good.entries[0], copy: 5 }] },
      { ...good, entries: [{ ...good.entries[0], at: undefined }] },
      { ...good, entries: [null] },
    ];
    for (const value of bad) {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      expect(parseProtocol(text), text.slice(0, 50)).toMatchObject({ ok: false, detail: expect.any(String) });
    }
  });
});

describe("the protocol: adding an entry", () => {
  it("adds an open entry with the fields it was given", () => {
    const protocol = addEntry(EMPTY_PROTOCOL, entry());
    expect(protocol.entries).toEqual([{ ...entry(), status: "open" }]);
    expect(protocol.dropped).toBe(0);
  });

  it("changes nothing in the protocol it was given", () => {
    const before = addEntry(EMPTY_PROTOCOL, entry());
    const snapshot = JSON.stringify(before);
    addEntry(before, entry({ source: "other" }));
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("updates the entry of the same source and reason and makes it open again; another reason or source is another entry", () => {
    let protocol = addEntry(EMPTY_PROTOCOL, entry());
    protocol = resolveSource(protocol, "Compendium.dnd5e.items.Item.a1", "copied", "u");
    protocol = addEntry(protocol, entry({ at: "later", by: "as-1", existing: [] }));
    expect(protocol.entries).toHaveLength(1);
    expect(protocol.entries[0]).toMatchObject({ at: "later", by: "as-1", existing: [], status: "open" });
    expect(protocol.entries[0]).not.toHaveProperty("copy");
    expect(addEntry(protocol, entry({ reason: "too-many" })).entries).toHaveLength(2);
    expect(addEntry(protocol, entry({ source: "b2" })).entries).toHaveLength(2);
  });

  it("keeps the name and the list of existing entries short", () => {
    const existing = Array.from({ length: 9 }, (_, i) => `u${i}`);
    const added = addEntry(EMPTY_PROTOCOL, entry({ name: "x".repeat(500), existing })).entries[0]!;
    expect(added.name).toHaveLength(200);
    expect(added.existing).toEqual(existing.slice(0, MAX_EXISTING_PER_ENTRY));
  });
});

describe("the protocol: the limits", () => {
  const fill = (count: number, protocol: Protocol = EMPTY_PROTOCOL): Protocol => {
    let held = protocol;
    for (let i = 0; i < count; i++) held = addEntry(held, entry({ source: `s${i}` }));
    return held;
  };

  it("keeps at most 500 entries, drops the oldest and counts what it dropped", () => {
    const protocol = fill(MAX_PROTOCOL_ENTRIES + 3);
    expect(protocol.entries).toHaveLength(MAX_PROTOCOL_ENTRIES);
    expect(protocol.dropped).toBe(3);
    expect(protocol.entries[0]!.source).toBe("s3");
    expect(protocol.entries.at(-1)!.source).toBe(`s${MAX_PROTOCOL_ENTRIES + 2}`);
  });

  it("drops a done entry before an open one, even if it is younger", () => {
    let protocol = fill(MAX_PROTOCOL_ENTRIES);
    protocol = resolveSource(protocol, "s10", "forced", "u");
    protocol = addEntry(protocol, entry({ source: "new" }));
    expect(protocol.entries).toHaveLength(MAX_PROTOCOL_ENTRIES);
    expect(protocol.entries.some((held) => held.source === "s10")).toBe(false);
    expect(protocol.entries[0]!.source).toBe("s0");
    expect(protocol.dropped).toBe(1);
  });

  it("keeps the text below the limit of the setting, whatever the entries hold, and keeps the newest", () => {
    let protocol = EMPTY_PROTOCOL;
    const long = (i: number) => entry({ source: `s${i}`, name: "n".repeat(200), existing: Array.from({ length: 5 }, (_, j) => `Compendium.world.eagle-feats-2024.Item.${"x".repeat(150)}${j}`) });
    for (let i = 0; i < 400; i++) protocol = addEntry(protocol, long(i));
    expect(serializeProtocol(protocol).length).toBeLessThanOrEqual(MAX_PROTOCOL_LENGTH);
    expect(protocol.dropped).toBeGreaterThan(0);
    expect(protocol.entries.at(-1)!.source).toBe("s399");
    expect(protocol.entries.length + protocol.dropped).toBe(400);
  });

  it("an update of an entry does not count as a drop", () => {
    const protocol = addEntry(fill(MAX_PROTOCOL_ENTRIES), entry({ source: "s5", at: "again" }));
    expect(protocol.entries).toHaveLength(MAX_PROTOCOL_ENTRIES);
    expect(protocol.dropped).toBe(0);
  });
});

describe("the protocol: done entries", () => {
  it("lists the open entries of a source, and marks them as copied or forced with the UUID of the copy", () => {
    let protocol = addEntry(addEntry(EMPTY_PROTOCOL, entry()), entry({ source: "b2" }));
    expect(openEntriesOf(protocol, "Compendium.dnd5e.items.Item.a1")).toHaveLength(1);
    protocol = resolveSource(protocol, "Compendium.dnd5e.items.Item.a1", "forced", "Compendium.world.x.Item.n1");
    expect(protocol.entries[0]).toMatchObject({ status: "forced", copy: "Compendium.world.x.Item.n1" });
    expect(protocol.entries[1]).toMatchObject({ status: "open" });
    expect(openEntriesOf(protocol, "Compendium.dnd5e.items.Item.a1")).toEqual([]);
    expect(resolveSource(protocol, "Compendium.dnd5e.items.Item.a1", "copied", "other").entries[0]).toMatchObject({ status: "forced", copy: "Compendium.world.x.Item.n1" });
  });
});
