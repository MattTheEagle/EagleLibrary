// How the Library compares names (Q6 a: an entry is "the same" if its name is the same in the same Eagle Compendium and the
// same version) and how it names a copy that is forced in although the name exists (N8).

// The comparison key of a name: Unicode NFC, every run of white space (as JavaScript's \s: space, tab, line breaks,
// no-break space and the other Unicode spaces) as one space, no space at either end, lower case. Accents, typographic
// against straight apostrophes and quotes, punctuation and language are not touched: they would merge entries that are
// different, and the plan asks only for case and spaces (M2 apply, section 5).
export function nameKey(name: string): string {
  return name.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();
}

// A name that already ends in "(Duplicate)" or "(Duplicate n)". Numbers stop at nine digits so that counting up is safe.
const DUPLICATE_SUFFIX = /^(.*) \(Duplicate(?: (\d{1,9}))?\)$/su;

// The name of a forced copy. `takenKeys` holds the name keys already in the target (Eagle Compendium and version).
//  - "X" becomes "X (Duplicate)", and if that is taken "X (Duplicate 2)", "X (Duplicate 3)" and so on (N8).
//  - A name that carries the suffix already is not shortened and not extended: the number counts up. "X (Duplicate)"
//    becomes "X (Duplicate 1)", "X (Duplicate 4)" becomes "X (Duplicate 5)". (Rule of the project lead, 2026-09-21.)
// Either way the result is the first free name, and it always ends because `takenKeys` is finite.
export function duplicateName(original: string, takenKeys: ReadonlySet<string>): string {
  const suffixed = DUPLICATE_SUFFIX.exec(original);
  if (!suffixed) {
    const first = `${original} (Duplicate)`;
    return takenKeys.has(nameKey(first)) ? firstFreeNumbered(original, 2, takenKeys) : first;
  }
  const stem = suffixed[1] ?? original;
  const next = suffixed[2] === undefined ? 1 : Number(suffixed[2]) + 1;
  return firstFreeNumbered(stem, Math.max(next, 1), takenKeys);
}

function firstFreeNumbered(stem: string, start: number, takenKeys: ReadonlySet<string>): string {
  for (let number = start; ; number += 1) {
    const candidate = `${stem} (Duplicate ${number})`;
    if (!takenKeys.has(nameKey(candidate))) return candidate;
  }
}

// The key of a "requirements" text (dnd5e's `system.requirements` of a feat, such as "Wizard 1"): the same as a name key,
// and the empty text for anything that is not text (the field is missing, null or not a string). Kinds without the field
// have the empty key.
export function requirementsKey(value: unknown): string {
  return typeof value === "string" ? nameKey(value) : "";
}

// What makes an entry "the same" (rule R5, as decided by the project lead on 2026-09-21, `m5-hd-1-output.md`): the name key
// and the requirements key, both.
export interface EntryKey {
  readonly name: string;
  readonly requirements: string;
}

export function entryKey(name: string, requirements: unknown): EntryKey {
  return { name: nameKey(name), requirements: requirementsKey(requirements) };
}

export const sameEntry = (a: EntryKey, b: EntryKey): boolean => a.name === b.name && a.requirements === b.requirements;
