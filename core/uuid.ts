// Compendium UUIDs as they stand in the data of documents: what is one, where it is, and how the main part is built (milestone M6,
// rule R13 of the convention). Pure text logic, nothing here touches Foundry.
//
// A main part is `Compendium.<package>.<compendium>.<type>.<id>` (the form Foundry v13 builds) or the older form without the type,
// `Compendium.<package>.<compendium>.<id>` (2,016 references in dnd5e 5.3.3). What follows the main part (embedded parts such
// as `.ActiveEffect.<id>`, an anchor `#...`) is never read and never changed. UUIDs of the world (`Item.<id>`) and relative ones
// (`.<id>`) are not Compendium UUIDs and are not found.

export const DOCUMENT_NAMES = ["Item", "Actor", "JournalEntry", "RollTable", "Macro", "Scene", "Playlist", "Cards", "Adventure"] as const;

export interface ParsedUuid {
  readonly scope: string;
  readonly pack: string;
  // Undefined for the older form.
  readonly documentName?: string;
  readonly id: string;
  readonly form: "typed" | "legacy";
  // Where the main part stands in the text: [start, end).
  readonly start: number;
  readonly end: number;
}

const NAME = "[A-Za-z0-9_-]+";
const ID = "[A-Za-z0-9]{16}";
// Not part of a longer word (a letter or digit in front), and the id is not the start of something longer.
const PATTERN = `(?<![A-Za-z0-9])Compendium\\.(${NAME})\\.(${NAME})\\.(?:(${DOCUMENT_NAMES.join("|")})\\.)?(${ID})(?![A-Za-z0-9])`;

// All main parts of Compendium UUIDs in a text, in order.
export function findUuids(text: string): ParsedUuid[] {
  const found: ParsedUuid[] = [];
  for (const match of text.matchAll(new RegExp(PATTERN, "g"))) {
    const [whole, scope, pack, documentName, id] = match as unknown as [string, string, string, string | undefined, string];
    const start = match.index ?? 0;
    found.push({
      scope, pack, id, start, end: start + whole.length,
      form: documentName ? "typed" : "legacy",
      ...(documentName ? { documentName } : {}),
    });
  }
  return found;
}

// A text that is exactly one main part, nothing before and nothing after; undefined otherwise.
export function parsePrimary(text: string): ParsedUuid | undefined {
  const found = findUuids(text);
  const only = found.length === 1 ? found[0] : undefined;
  return only && only.start === 0 && only.end === text.length ? only : undefined;
}

// The key of a document that has a type: `Compendium.<package>.<compendium>.<type>.<id>`. The older form has none.
export function typedKey(parsed: ParsedUuid): string | undefined {
  return parsed.documentName ? `Compendium.${parsed.scope}.${parsed.pack}.${parsed.documentName}.${parsed.id}` : undefined;
}

// The key that finds a document whatever the form: `<package>.<compendium>.<id>`.
export function looseKey(parsed: Pick<ParsedUuid, "scope" | "pack" | "id">): string {
  return `${parsed.scope}.${parsed.pack}.${parsed.id}`;
}

// The main part in the form with a type, as Foundry builds it.
export function formatPrimary(scope: string, pack: string, documentName: string, id: string): string {
  return `Compendium.${scope}.${pack}.${documentName}.${id}`;
}

// How many places in a text start with `Compendium.` (a UUID that could not be read is one of them).
export function countMentions(text: string): number {
  let count = 0;
  for (let at = text.indexOf("Compendium."); at >= 0; at = text.indexOf("Compendium.", at + 1)) count++;
  return count;
}
