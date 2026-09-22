import { describe, expect, it } from "vitest";
import { allSelected, formatProgress, kindIsVersioned, progressFraction, protocolRows, sortPacks, type PackRow } from "./copy-window";
import type { ProtocolEntry } from "./protocol";

const pack = (collection: string, label: string): PackRow => ({ collection, documentName: "Item", label });

describe("sortPacks", () => {
  it("sorts by label, locale-aware", () => {
    const packs = [pack("dnd5e.z", "Zebra"), pack("dnd5e.a", "apple"), pack("dnd5e.ae", "Ärger")];
    expect(sortPacks(packs).map((p) => p.label)).toEqual(["apple", "Ärger", "Zebra"]);
  });

  it("does not change the given array", () => {
    const packs = [pack("dnd5e.b", "B"), pack("dnd5e.a", "A")];
    const sorted = sortPacks(packs);
    expect(sorted).not.toBe(packs);
    expect(packs.map((p) => p.label)).toEqual(["B", "A"]);
  });

  it("gives an empty list for an empty list", () => {
    expect(sortPacks([])).toEqual([]);
  });
});

describe("allSelected", () => {
  it("is false for an empty list (nothing to select)", () => {
    expect(allSelected([], new Set())).toBe(false);
  });

  it("is false when at least one row is not selected", () => {
    const packs = [pack("a", "A"), pack("b", "B")];
    expect(allSelected(packs, new Set(["a"]))).toBe(false);
  });

  it("is true when every row is selected", () => {
    const packs = [pack("a", "A"), pack("b", "B")];
    expect(allSelected(packs, new Set(["a", "b"]))).toBe(true);
  });

  it("ignores a selected collection that is not among the rows", () => {
    const packs = [pack("a", "A")];
    expect(allSelected(packs, new Set(["a", "somewhere-else"]))).toBe(true);
  });
});

describe("kindIsVersioned", () => {
  it("is true for a versioned kind", () => {
    expect(kindIsVersioned("weapons")).toBe(true);
    expect(kindIsVersioned("npcs")).toBe(true);
  });

  it("is false for an unversioned kind", () => {
    expect(kindIsVersioned("encounters")).toBe(false);
    expect(kindIsVersioned("journals")).toBe(false);
  });

  it("is false for null and for an unknown kind", () => {
    expect(kindIsVersioned(null)).toBe(false);
    expect(kindIsVersioned("not-a-kind")).toBe(false);
  });
});

describe("protocolRows", () => {
  const entry = (over: Partial<ProtocolEntry>): ProtocolEntry => ({
    at: "2026-09-22T00:00:00.000Z",
    by: "gm-1",
    reason: "duplicate",
    source: "Compendium.dnd5e.items.Item.aaaaaaaaaaaaaaaa",
    name: "Dagger",
    kind: "weapons",
    version: "2014",
    target: "eagle-weapons-2014",
    existing: [],
    status: "open",
    ...over,
  });

  it("keeps only the open entries", () => {
    const entries = [entry({ status: "open" }), entry({ status: "copied" }), entry({ status: "forced" })];
    expect(protocolRows(entries)).toHaveLength(1);
  });

  it("a duplicate of a versioned kind can be forced and needs a version choice", () => {
    const rows = protocolRows([entry({ reason: "duplicate", kind: "weapons" })]);
    expect(rows[0]).toMatchObject({ canForce: true, needsVersion: true });
  });

  it("a duplicate of an unversioned kind can be forced without a version choice", () => {
    const rows = protocolRows([entry({ reason: "duplicate", kind: "journals", version: null })]);
    expect(rows[0]).toMatchObject({ canForce: true, needsVersion: false });
  });

  it("the other three reasons cannot be forced at all", () => {
    for (const reason of ["no-art", "too-many", "container-too-deep"] as const) {
      const rows = protocolRows([entry({ reason })]);
      expect(rows[0]).toMatchObject({ canForce: false, needsVersion: false });
    }
  });
});

describe("formatProgress", () => {
  it("names the step, the total and the outcome", () => {
    expect(formatProgress({ index: 3, total: 12, name: "Dagger", outcome: "copied" })).toBe("3 / 12 — Dagger (copied)");
  });
});

describe("progressFraction", () => {
  it("is the share of candidates done", () => {
    expect(progressFraction({ index: 1, total: 4, name: "x", outcome: "copied" })).toBe(0.25);
    expect(progressFraction({ index: 4, total: 4, name: "x", outcome: "copied" })).toBe(1);
  });

  it("is 1 for an empty selection (nothing left to do)", () => {
    expect(progressFraction({ index: 0, total: 0, name: "", outcome: "" })).toBe(1);
  });
});
