import { describe, expect, it } from "vitest";
import { duplicateName, nameKey, entryKey, requirementsKey, sameEntry } from "./name-key";

const keys = (...names: string[]): ReadonlySet<string> => new Set(names.map(nameKey));

describe("nameKey", () => {
  it("does not care about case", () => {
    expect(nameKey("Longsword")).toBe(nameKey("LONGSWORD"));
    expect(nameKey("Longsword")).toBe("longsword");
  });

  it("does not care about how many spaces or what kind of white space", () => {
    const one = nameKey("Potion of Healing");
    for (const name of [
      "Potion  of   Healing",
      " Potion of Healing",
      "Potion of Healing ",
      "  Potion of Healing\n",
      "Potion\tof\nHealing",
      "Potion of Healing",
      "Potion of　Healing",
    ]) {
      expect(nameKey(name), JSON.stringify(name)).toBe(one);
    }
  });

  it("does not care whether an accent is one character or two (NFC)", () => {
    expect(nameKey("Café")).toBe(nameKey("Café"));
    expect(nameKey("CafÉ")).toBe(nameKey("Café"));
  });

  it("keeps accents apart from plain letters", () => {
    expect(nameKey("Café")).not.toBe(nameKey("Cafe"));
  });

  it("keeps typographic and straight apostrophes and quotes apart", () => {
    expect(nameKey("Wanderer’s Pack")).not.toBe(nameKey("Wanderer's Pack"));
    expect(nameKey("“Quote”")).not.toBe(nameKey('"Quote"'));
  });

  it("keeps punctuation and words apart", () => {
    expect(nameKey("Rope (50 ft.)")).not.toBe(nameKey("Rope 50 ft"));
    expect(nameKey("Hand Axe")).not.toBe(nameKey("Handaxe"));
    expect(nameKey("Longsword")).not.toBe(nameKey("Langschwert"));
  });

  it("gives an empty key for an empty name or one of white space", () => {
    expect(nameKey("")).toBe("");
    expect(nameKey(" \t  ")).toBe("");
  });

  it("is stable when applied again", () => {
    for (const name of ["  Mixed   CASE Name ", "Café", "X (Duplicate 2)"]) {
      expect(nameKey(nameKey(name))).toBe(nameKey(name));
    }
  });
});

describe("duplicateName", () => {
  it("adds (Duplicate) to a name (N8)", () => {
    expect(duplicateName("Longsword", keys("Longsword"))).toBe("Longsword (Duplicate)");
    expect(duplicateName("Longsword", keys())).toBe("Longsword (Duplicate)");
  });

  it("numbers further duplicates from 2 (N8)", () => {
    expect(duplicateName("Longsword", keys("Longsword", "Longsword (Duplicate)"))).toBe("Longsword (Duplicate 2)");
    expect(duplicateName("Longsword", keys("Longsword (Duplicate)", "Longsword (Duplicate 2)"))).toBe(
      "Longsword (Duplicate 3)",
    );
  });

  it("fills a gap in the numbering", () => {
    expect(duplicateName("X", keys("X (Duplicate)", "X (Duplicate 3)"))).toBe("X (Duplicate 2)");
  });

  it("finds a name taken in another case or with other spacing", () => {
    expect(duplicateName("Longsword", keys("LONGSWORD (DUPLICATE)"))).toBe("Longsword (Duplicate 2)");
    expect(duplicateName("Longsword", keys("Longsword  (Duplicate)"))).toBe("Longsword (Duplicate 2)");
  });

  it("keeps the original name as it is, apart from the suffix", () => {
    expect(duplicateName("Wanderer’s  Pack", keys())).toBe("Wanderer’s  Pack (Duplicate)");
    expect(duplicateName("ALL CAPS", keys())).toBe("ALL CAPS (Duplicate)");
  });

  it("counts a name that ends in (Duplicate) up from 1", () => {
    expect(duplicateName("X (Duplicate)", keys("X", "X (Duplicate)"))).toBe("X (Duplicate 1)");
  });

  it("counts a name that ends in (Duplicate n) up from n + 1", () => {
    expect(duplicateName("X (Duplicate 1)", keys("X (Duplicate 1)"))).toBe("X (Duplicate 2)");
    expect(duplicateName("X (Duplicate 4)", keys("X (Duplicate 4)"))).toBe("X (Duplicate 5)");
  });

  it("takes the next free number after a name that ends in the suffix", () => {
    expect(duplicateName("X (Duplicate)", keys("X (Duplicate 1)", "X (Duplicate 2)"))).toBe("X (Duplicate 3)");
    expect(duplicateName("X (Duplicate 4)", keys("X (Duplicate 5)", "X (Duplicate 6)"))).toBe("X (Duplicate 7)");
  });

  it("does not shorten or extend a name that ends in the suffix", () => {
    for (const result of [
      duplicateName("X (Duplicate)", keys()),
      duplicateName("X (Duplicate 3)", keys()),
    ]) {
      expect(result).not.toMatch(/\(Duplicate( \d+)?\) \(Duplicate/);
      expect(result.startsWith("X (Duplicate ")).toBe(true);
    }
  });

  it("looks only at a suffix at the end of the name", () => {
    expect(duplicateName("X (Duplicate) Y", keys())).toBe("X (Duplicate) Y (Duplicate)");
    expect(duplicateName("(Duplicate)", keys())).toBe("(Duplicate) (Duplicate)");
    expect(duplicateName("X (duplicate)", keys())).toBe("X (duplicate) (Duplicate)");
    expect(duplicateName("X (Duplicate 1.5)", keys())).toBe("X (Duplicate 1.5) (Duplicate)");
  });

  it("counts up from the stem when the stem carries a suffix of its own", () => {
    expect(duplicateName("X (Duplicate) (Duplicate 2)", keys())).toBe("X (Duplicate) (Duplicate 3)");
  });

  it("does not run forever on a very large number", () => {
    const name = duplicateName("X (Duplicate 99999999999999999999)", keys());
    expect(name).toBe("X (Duplicate 99999999999999999999) (Duplicate)");
  });

  it("always ends with a name that is free", () => {
    const taken = new Set<string>();
    for (let count = 0; count < 25; count += 1) {
      const name = duplicateName("Sword", taken);
      expect(taken.has(nameKey(name))).toBe(false);
      taken.add(nameKey(name));
    }
    expect(taken.size).toBe(25);
  });
});

describe("requirementsKey and entryKey (R5: name and requirements)", () => {
  it("treats a requirements text like a name: case, white space and the Unicode form do not matter", () => {
    expect(requirementsKey("  WIZARD \t 1 ")).toBe("wizard 1");
    expect(requirementsKey("Café")).toBe(requirementsKey("Café"));
  });

  it("does not change what a name key does not change: accents, quotes, punctuation", () => {
    expect(requirementsKey("Bard 1")).not.toBe(requirementsKey("Bard"));
    expect(requirementsKey("Wizard’s")).not.toBe(requirementsKey("Wizard's"));
  });

  it("is the empty key for anything that is not text", () => {
    for (const value of [undefined, null, 5, true, {}, [], ["Bard"]]) expect(requirementsKey(value), String(value)).toBe("");
    expect(requirementsKey("")).toBe("");
    expect(requirementsKey("   ")).toBe("");
  });

  it("builds the key of an entry from both, and compares both", () => {
    expect(entryKey("Spellcasting ", "Wizard 1")).toEqual({ name: "spellcasting", requirements: "wizard 1" });
    expect(sameEntry(entryKey("Spellcasting", "Wizard 1"), entryKey(" spellcasting", "WIZARD  1"))).toBe(true);
    expect(sameEntry(entryKey("Spellcasting", "Wizard 1"), entryKey("Spellcasting", "Bard 1"))).toBe(false);
    expect(sameEntry(entryKey("Spellcasting", "Wizard 1"), entryKey("Spellcasting", undefined))).toBe(false);
    expect(sameEntry(entryKey("Spellcasting", undefined), entryKey("Spellcasting", null))).toBe(true);
    expect(sameEntry(entryKey("Spellcasting", "x"), entryKey("Casting", "x"))).toBe(false);
  });
});
