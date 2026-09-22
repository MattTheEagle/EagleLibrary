import { describe, expect, it } from "vitest";
import {
  chooseTarget,
  readStoredVersion,
  RULES_VERSIONS,
  type IsPresent,
  type RulesVersion,
  type VersionState,
} from "./rules-version";

const versioned = { versioned: true };
const unversioned = { versioned: false };

// A compendium in which the given versions have the name; for a kind without a version, `undefined` stands for its only
// compendium.
const presentIn =
  (...versions: (RulesVersion | undefined)[]): IsPresent =>
  (version) =>
    versions.includes(version);

describe("readStoredVersion", () => {
  it("reads exactly the strings 2014 and 2024", () => {
    expect(readStoredVersion(versioned, "2014")).toEqual({ kind: "stored", version: "2014" });
    expect(readStoredVersion(versioned, "2024")).toEqual({ kind: "stored", version: "2024" });
  });

  it("counts every other value as not stored and keeps it for the log", () => {
    for (const raw of [undefined, null, "", "2015", "modern", "legacy", " 2014", "2024 ", "2014\n", 2014, 2024, {}, [], true]) {
      expect(readStoredVersion(versioned, raw), JSON.stringify(raw) ?? String(raw)).toEqual({ kind: "unstored", raw });
    }
  });

  it("finds no version on a kind without one, whatever is stored", () => {
    for (const raw of ["2014", "2024", "", undefined, null, "modern"]) {
      expect(readStoredVersion(unversioned, raw)).toEqual({ kind: "none" });
    }
  });

  it("has no input for the world setting rulesVersion", () => {
    // The version comes from the stored value alone; a second parameter would be a way to bring the setting back in.
    expect(readStoredVersion.length).toBe(2);
    expect(chooseTarget.length).toBe(2);
  });

  it("lists the two versions in order", () => {
    expect([...RULES_VERSIONS]).toEqual(["2014", "2024"]);
  });
});

describe("chooseTarget: a stored version", () => {
  const stored = (version: RulesVersion): VersionState => ({ kind: "stored", version });

  it("keeps the version if the name is not in it yet", () => {
    expect(chooseTarget(stored("2014"), presentIn())).toEqual({ outcome: "place", version: "2014" });
    expect(chooseTarget(stored("2024"), presentIn())).toEqual({ outcome: "place", version: "2024" });
  });

  it("keeps the version although the other version has the name", () => {
    expect(chooseTarget(stored("2024"), presentIn("2014"))).toEqual({ outcome: "place", version: "2024" });
    expect(chooseTarget(stored("2014"), presentIn("2024"))).toEqual({ outcome: "place", version: "2014" });
  });

  it("is a duplicate if the name is in that version (once per version)", () => {
    expect(chooseTarget(stored("2014"), presentIn("2014"))).toEqual({ outcome: "duplicate", versions: ["2014"] });
    expect(chooseTarget(stored("2024"), presentIn("2024"))).toEqual({ outcome: "duplicate", versions: ["2024"] });
    expect(chooseTarget(stored("2024"), presentIn("2014", "2024"))).toEqual({ outcome: "duplicate", versions: ["2024"] });
  });
});

describe("chooseTarget: no stored version (N7)", () => {
  const unstored: VersionState = { kind: "unstored", raw: undefined };

  it("puts the entry in 2014 if neither version has the name", () => {
    expect(chooseTarget(unstored, presentIn())).toEqual({ outcome: "place", version: "2014" });
  });

  it("puts the entry in 2024 if the name is in 2014 but not in 2024", () => {
    expect(chooseTarget(unstored, presentIn("2014"))).toEqual({ outcome: "place", version: "2024" });
  });

  it("puts the entry in 2014 if only 2024 has the name", () => {
    expect(chooseTarget(unstored, presentIn("2024"))).toEqual({ outcome: "place", version: "2014" });
  });

  it("is a duplicate in both versions if both have the name", () => {
    expect(chooseTarget(unstored, presentIn("2014", "2024"))).toEqual({ outcome: "duplicate", versions: ["2014", "2024"] });
  });

  it("does not depend on what was there instead of a version", () => {
    for (const raw of [null, "", "modern", 2014]) {
      expect(chooseTarget({ kind: "unstored", raw }, presentIn("2014"))).toEqual({ outcome: "place", version: "2024" });
    }
  });
});

describe("chooseTarget: a kind without a version", () => {
  it("places the entry, without a version, if the name is not in the compendium", () => {
    const placement = chooseTarget({ kind: "none" }, presentIn());
    expect(placement).toEqual({ outcome: "place" });
    expect(placement).not.toHaveProperty("version");
  });

  it("is a duplicate if the name is in the compendium", () => {
    expect(chooseTarget({ kind: "none" }, presentIn(undefined))).toEqual({ outcome: "duplicate", versions: [] });
  });

  it("asks about the compendium without a version, not about 2014 or 2024", () => {
    const asked: (RulesVersion | undefined)[] = [];
    chooseTarget({ kind: "none" }, (version) => (asked.push(version), false));
    expect(asked).toEqual([undefined]);
  });
});

describe("chooseTarget: end to end with readStoredVersion", () => {
  it("handles an entry without version in a world where 2014 has the name", () => {
    const state = readStoredVersion(versioned, undefined);
    expect(chooseTarget(state, presentIn("2014"))).toEqual({ outcome: "place", version: "2024" });
  });

  it("handles a 2024 entry in a library that has the name in 2014 only", () => {
    const state = readStoredVersion(versioned, "2024");
    expect(chooseTarget(state, presentIn("2014"))).toEqual({ outcome: "place", version: "2024" });
  });
});
