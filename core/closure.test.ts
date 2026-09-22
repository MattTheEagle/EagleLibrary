import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_CLOSURE_DOCUMENTS, MAX_DOCUMENTS_PER_PORTION, portionsOf, summarizePlan, type PlanDocument } from "./closure";

const doc = (source: string, target: string, unit: number): PlanDocument => ({ source, target, unit });

describe("the limits of a copy with its dependencies", () => {
  it("has portions of at most 100 documents and a default limit of 5,000", () => {
    expect(MAX_DOCUMENTS_PER_PORTION).toBe(100);
    expect(DEFAULT_MAX_CLOSURE_DOCUMENTS).toBe(5000);
  });
});

describe("portionsOf", () => {
  it("returns no portion for no document", () => {
    expect(portionsOf([])).toEqual([]);
  });

  it("groups by target compendium in the order the compendia first appear", () => {
    const portions = portionsOf([doc("a", "x", 0), doc("b", "y", 1), doc("c", "x", 2)]);
    expect(portions.map((portion) => portion.map((d) => d.source))).toEqual([["a", "c"], ["b"]]);
  });

  it("cuts a group at the maximum and keeps the order inside it", () => {
    const documents = Array.from({ length: 7 }, (_, i) => doc(`d${i}`, "x", i));
    expect(portionsOf(documents, 3).map((portion) => portion.map((d) => d.source))).toEqual([
      ["d0", "d1", "d2"],
      ["d3", "d4", "d5"],
      ["d6"],
    ]);
  });

  it("never splits a unit: a container and its contents go into one portion", () => {
    const documents = [doc("a", "x", 0), doc("b", "x", 1), doc("box", "x", 2), doc("i1", "x", 2), doc("i2", "x", 2)];
    expect(portionsOf(documents, 3).map((portion) => portion.map((d) => d.source))).toEqual([["a", "b"], ["box", "i1", "i2"]]);
  });

  it("keeps a unit that is larger than the maximum whole, in a portion of its own", () => {
    const documents = [doc("a", "x", 0), ...["box", "i1", "i2", "i3"].map((source) => doc(source, "x", 1))];
    expect(portionsOf(documents, 3).map((portion) => portion.length)).toEqual([1, 4]);
  });

  it("never mixes compendia in a portion, and every document is in exactly one portion", () => {
    const documents = Array.from({ length: 230 }, (_, i) => doc(`d${i}`, i % 3 === 0 ? "x" : "y", i));
    const portions = portionsOf(documents);
    for (const portion of portions) {
      expect(portion.length).toBeLessThanOrEqual(100);
      expect(new Set(portion.map((d) => d.target)).size).toBe(1);
    }
    expect(portions.flat().map((d) => d.source).sort()).toEqual(documents.map((d) => d.source).sort());
  });
});

describe("summarizePlan", () => {
  it("counts the documents, the portions and the documents of each compendium", () => {
    const documents = [...Array.from({ length: 101 }, (_, i) => doc(`x${i}`, "x", i)), doc("y", "y", 200)];
    expect(summarizePlan(documents)).toEqual({ documents: 102, portions: 3, byCompendium: { x: 101, y: 1 } });
  });
});
