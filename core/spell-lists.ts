import type { Json } from "./rewrite-links";

// The spell lists of the Library (milestone M7, rule R15 of the convention): the pages of the Eagle Journals that are spell lists,
// kept in a world setting so that every client can register them with dnd5e at every start without loading the journals.
// Pure logic on the text of the setting; reading and writing the setting and calling dnd5e is v13/spell-lists.ts.

export const SPELL_LISTS_VERSION = 1;
export const MAX_SPELL_LIST_PAGES = 200;

// The setting as text; writing it goes through Flight Control (`setting.write`) with what was read.
export interface SettingStore {
  read(): string;
  write(previous: string, value: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly detail: string }>;
}

export interface SpellListsLog {
  info(message: string): void;
  warn(message: string): void;
}

export type SpellListsRead = { readonly ok: true; readonly pages: readonly string[] } | { readonly ok: false; readonly detail: string };

export function parseSpellLists(text: string): SpellListsRead {
  if (text.trim() === "") return { ok: true, pages: [] };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, detail: "the spell lists are not JSON" };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { ok: false, detail: "the spell lists are not an object" };
  const { version, pages } = data as Record<string, unknown>;
  if (version !== SPELL_LISTS_VERSION) return { ok: false, detail: "the spell lists are not of version 1" };
  if (!Array.isArray(pages) || !pages.every((page) => typeof page === "string")) return { ok: false, detail: "the spell lists have no list of pages" };
  return { ok: true, pages: pages as string[] };
}

export function serializeSpellLists(pages: readonly string[]): string {
  return pages.length === 0 ? "" : JSON.stringify({ version: SPELL_LISTS_VERSION, pages });
}

// Adds pages that are not there yet; over the limit the oldest go.
export function addPages(held: readonly string[], add: readonly string[]): string[] {
  const pages = [...held];
  for (const page of add) if (!pages.includes(page)) pages.push(page);
  return pages.length > MAX_SPELL_LIST_PAGES ? pages.slice(pages.length - MAX_SPELL_LIST_PAGES) : pages;
}

const isRecord = (value: unknown): value is Record<string, Json> => typeof value === "object" && value !== null && !Array.isArray(value);

// The UUIDs, in the copy of a journal, of the pages of it that are spell lists.
export function spellListPagesOf(journalCopy: string, data: Json): string[] {
  if (!isRecord(data) || !Array.isArray(data.pages)) return [];
  const pages: string[] = [];
  for (const page of data.pages as readonly Json[]) {
    if (isRecord(page) && page.type === "spells" && typeof page._id === "string" && page._id !== "") pages.push(`${journalCopy}.JournalEntryPage.${page._id}`);
  }
  return pages;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Adds pages to the setting: reads, adds, writes with what was read; a second try reads again. A text that cannot be read is
// replaced, and the log says so. Never throws.
export async function updateSpellLists(store: SettingStore, log: SpellListsLog, add: readonly string[]): Promise<{ written: boolean; detail?: string }> {
  let detail = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    let text = "";
    try {
      text = store.read();
    } catch (error) {
      return { written: false, detail: messageOf(error) };
    }
    const parsed = parseSpellLists(text);
    if (!parsed.ok && attempt === 1) log.warn(`eagle-library | the spell lists are replaced by new ones: ${parsed.detail} (they began: ${text.slice(0, 80)})`);
    const value = serializeSpellLists(addPages(parsed.ok ? parsed.pages : [], add));
    if (value === text) return { written: true };
    try {
      const written = await store.write(text, value);
      if (written.ok) return { written: true };
      detail = written.detail;
    } catch (error) {
      detail = messageOf(error);
    }
  }
  log.warn(`eagle-library | the spell lists could not be written: ${detail}`);
  return { written: false, detail };
}

export interface RegisterReport {
  readonly registered: number;
  readonly failed: readonly { readonly page: string; readonly detail: string }[];
}

// Registers every page with dnd5e (`register` is the registry's function). A page that fails is named and the others go on;
// nothing is thrown, so that a start is never disturbed.
export async function registerSpellLists(text: string, register: (page: string) => Promise<unknown>, log: SpellListsLog): Promise<RegisterReport> {
  const parsed = parseSpellLists(text);
  if (!parsed.ok) {
    log.warn(`eagle-library | the spell lists cannot be read: ${parsed.detail}`);
    return { registered: 0, failed: [] };
  }
  const failed: { page: string; detail: string }[] = [];
  let registered = 0;
  for (const page of parsed.pages) {
    try {
      await register(page);
      registered++;
    } catch (error) {
      failed.push({ page, detail: messageOf(error) });
      log.warn(`eagle-library | spell list ${page} could not be registered: ${messageOf(error)}`);
    }
  }
  if (parsed.pages.length > 0) log.info(`eagle-library | spell lists: ${registered} registered, ${failed.length} failed`);
  return { registered, failed };
}
