import { LIBRARY_ID } from "../core/index";
import { registerSpellLists, type SpellListsLog } from "../core/spell-lists";
import type { RequestApi } from "../core/compendium-setup";
import { foundrySettingStore } from "./protocol";

export const SPELL_LISTS_SETTING = "spell-lists";

declare global {
  interface SettingConfig {
    "eagle-library.spell-lists": string;
  }
}

// The pages of the spell lists in the Eagle Journals: a world setting that nobody edits by hand (JSON text, not shown in the
// settings window and not in the hub). Flight Control writes it (`setting.write`), every client reads it.
export function registerSpellListsSetting(): void {
  game.settings!.register(LIBRARY_ID, SPELL_LISTS_SETTING, { scope: "world", config: false, type: String, default: "" });
}

export const foundrySpellListStore = (api: () => RequestApi | undefined) => foundrySettingStore(SPELL_LISTS_SETTING, api);

// The registry of dnd5e for spell lists, as far as it is used here.
interface SpellListRegistry {
  register(uuid: string): Promise<unknown>;
}

// Registers the pages with dnd5e on this client (every client, every start). Only under dnd5e; a page that fails is logged and the
// others go on, and nothing is thrown.
export async function registerSpellListsWithDnd5e(log: SpellListsLog): Promise<void> {
  try {
    const registry = (globalThis as unknown as { dnd5e?: { registry?: { spellLists?: SpellListRegistry } } }).dnd5e?.registry?.spellLists;
    if (game.system?.id !== "dnd5e" || typeof registry?.register !== "function") return;
    const stored: unknown = (game.settings as unknown as { get(namespace: string, key: string): unknown }).get(LIBRARY_ID, SPELL_LISTS_SETTING);
    await registerSpellLists(typeof stored === "string" ? stored : "", (uuid) => registry.register(uuid), log);
  } catch (error) {
    log.warn(`eagle-library | spell lists could not be registered: ${error instanceof Error ? error.message : String(error)}`);
  }
}
