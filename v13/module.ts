import { copyDocument, planCopy, type CopyDeps, type CopyOptions, type CopyResult, type PlanResult } from "../core/copy";
import { copyCompendia, planCompendia, type BulkCopyOptions, type BulkCopyResult, type BulkDeps, type BulkPlanOptions, type BulkPlanResult, type BulkSelection } from "../core/bulk";
import { readMarkerOf, removeMarker, setMarker, type MarkerDeps, type MarkerResult } from "../core/subspecies";
import { checkDocumentLinks, type LinkCheck } from "../core/relink";
import { parseProtocol, type ProtocolRead } from "../core/protocol";
import { compendiaStatus } from "../core/compendium-setup";
import { LIBRARY_ID, logLibraryReady } from "../core/index";
import { FLIGHT_CONTROL_ID, registerWithFlightControl, type ApiSource, type RegistrationLog } from "../core/flight-control";
import type { IndexedEntry } from "../core/search-window";
import { createLibraryApplicationClass } from "./library-application";
import { createCopyApplicationClass } from "./copy-application";
import { createSearchApplicationClass } from "./search-application";
import { foundryPackSource } from "./compendia";
import { foundryCopyWorld } from "./copy";
import { foundryBulkWorld } from "./bulk";
import { foundryProtocolStore, registerProtocolSetting } from "./protocol";
import { foundrySpellListStore, registerSpellListsSetting, registerSpellListsWithDnd5e } from "./spell-lists";

// What the Library puts on its module object: a way to copy one document from the console, to force a copy and to look at
// the protocol. Since milestone M14 this is the Library contract (`docs/library-convention.md`); a change to any of these
// functions is a contract change, not a casual one. The Library window (M10) and the Copy window (M11) cover the same
// ground for a Gamemaster who would rather not use the console, but are themselves outside the contract (docs, section 0).
interface EagleLibraryApi {
  copyDocument(uuid: string, options?: CopyOptions): Promise<CopyResult>;
  // The protocol of entries that were not transferred: what the setting holds, read, or why it cannot be.
  protocol(): ReturnType<typeof parseProtocol>;
  // Empties the protocol.
  clearProtocol(): Promise<{ written: boolean; detail?: string }>;
  // What became of the links of a document in an Eagle Compendium (nothing is changed).
  checkLinks(uuid: string): Promise<LinkCheck>;
  // What a copy of the document with everything it links to would do (documents, portions, what is left out); writes nothing.
  plan(uuid: string, options?: CopyOptions): Promise<PlanResult>;
  // The marker of a subspecies (rule R18) on a species Item of the Library: set by hand, removed, read.
  setSubspeciesMarker(uuid: string, species: string): Promise<MarkerResult>;
  removeSubspeciesMarker(uuid: string): Promise<MarkerResult>;
  readSubspeciesMarker(uuid: string): Promise<MarkerResult>;
  // Copies every eligible document of one, several or all non-Eagle compendia (milestone M9); a Gamemaster/Assistant only.
  copyCompendia(selection: BulkSelection, options?: BulkCopyOptions): Promise<BulkCopyResult>;
  // The same selection, without writing anything: an exact preview, dependencies shared between roots counted once.
  planCompendia(selection: BulkSelection, options?: BulkPlanOptions): Promise<BulkPlanResult>;
}

declare global {
  interface ModuleConfig {
    "eagle-library": { api: EagleLibraryApi };
  }
}

const consoleLog: RegistrationLog = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
};

// Flight Control attaches its API to its own module object while it initializes; other modules read it from "setup" on.
// The module can be missing or deactivated, so the API can be undefined (see the contract, section 1). One accessor for
// the whole file (module scope, not tied to either hook): every caller reads `game.modules` fresh, so it is always safe.
const flightControl = () => game.modules?.get(FLIGHT_CONTROL_ID)?.api;
const flightControlApi: ApiSource = flightControl;
const protocolStore = foundryProtocolStore(flightControl);
const spellListStore = foundrySpellListStore(flightControl);

// The dependencies every bulk operation needs (`core/bulk.ts`, `core/copy.ts`), built fresh on every call so a change of
// Flight Control's availability or the active user is always current. Shared by the console API, the Library window's
// "Create missing compendia" (through `createMissingCompendia`, unrelated to this) and the Copy window (M11).
const bulkDeps = (): BulkDeps => ({
  world: foundryBulkWorld,
  api: flightControl(),
  protocol: protocolStore,
  spellLists: spellListStore,
  newId: () => foundry.utils.randomID(),
  user: () => game.user?.id ?? "",
  now: () => new Date().toISOString(),
  isGm: () => game.user?.isGM === true,
  log: consoleLog,
});

async function clearProtocol(): Promise<{ written: boolean; detail?: string }> {
  try {
    const text = protocolStore.read();
    const written = await protocolStore.write(text, "");
    return written.ok ? { written: true } : { written: false, detail: written.detail };
  } catch (error) {
    return { written: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function readProtocol(): ProtocolRead {
  return parseProtocol(protocolStore.read());
}

// Opens the Foundry sheet of a document by its UUID; every window (Library, M10; Copy, M11; the search overlay, M13)
// opens an entry the same way.
async function openDocumentSheet(uuid: string): Promise<void> {
  const document = (await foundry.utils.fromUuid(uuid as never)) as unknown as { sheet?: { render(force: boolean): unknown } } | null;
  document?.sheet?.render(true);
}

// The search overlay's index (milestone M13): every entry of every Eagle Compendium that already exists, read once
// (`foundryCopyWorld.eagleIndex`, unchanged since M4/M10) and cached for the session — built on the first use of the
// search, not at `ready`, so a session that never opens it never pays for it (Apply section C).
let searchIndex: Promise<readonly IndexedEntry[]> | undefined;
async function buildSearchIndex(): Promise<readonly IndexedEntry[]> {
  const status = compendiaStatus(foundryPackSource);
  const entries: IndexedEntry[] = [];
  for (const compendium of status.present) {
    try {
      const index = await foundryCopyWorld.eagleIndex(compendium);
      for (const entry of index ?? []) {
        entries.push({ ...entry, compendium: compendium.name, documentName: compendium.documentName, label: compendium.entry.title });
      }
    } catch (error) {
      consoleLog.warn(`eagle-library | ${compendium.name} could not be read for the search index: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return entries;
}
function cachedSearchIndex(): Promise<readonly IndexedEntry[]> {
  searchIndex ??= buildSearchIndex();
  return searchIndex;
}

// The search overlay's currently open instance, if any — only so a second press of the shortcut can close it instead
// of opening a duplicate (Apply section E); assigned once the class exists ("setup"), read by the keybinding
// registered here ("init", the only time Foundry accepts a registration, Discover f1). By the time a real keypress
// can happen the boot is long finished, so the class is always there.
let SearchApplication: ReturnType<typeof createSearchApplicationClass> | undefined;
let openSearch: InstanceType<NonNullable<typeof SearchApplication>> | undefined;

Hooks.once("init", () => {
  logLibraryReady("13");
  registerProtocolSetting();
  registerSpellListsSetting();
  // "A hotkey for everyone" (convention N9): not `restricted`, works for every role. Ctrl+L: a modifier combination
  // collides less than a bare letter (many are already canvas tools, Discover f1/f2), "L" for "Library"; editable,
  // so the project lead can rebind it, and Foundry's own control config warns about a collision on its own.
  game.keybindings!.register(LIBRARY_ID, "search", {
    name: "EAGLELIBRARY.search.keybindingName",
    hint: "EAGLELIBRARY.search.keybindingHint",
    editable: [{ key: "KeyL", modifiers: ["CONTROL"] }],
    restricted: false,
    onDown: () => {
      if (openSearch?.rendered) {
        void openSearch.close();
        return;
      }
      if (!SearchApplication) return;
      openSearch = new SearchApplication();
      void openSearch.render(true);
    },
  });
  const module = game.modules?.get(LIBRARY_ID);
  if (module) {
    const markers = (): MarkerDeps => ({
      readData: foundryCopyWorld.readData,
      request: async (payload) => {
        const api = flightControl();
        if (!api) throw new Error("Eagle Flight Control is missing or not active");
        return api.request({ module: LIBRARY_ID, type: "compendium.flag", version: 1, payload });
      },
      isGm: () => game.user?.isGM === true,
    });
    module.api = Object.freeze({
      copyDocument: (uuid: string, options?: CopyOptions) => copyDocument(bulkDeps(), uuid, options),
      protocol: readProtocol,
      checkLinks: (uuid: string) => checkDocumentLinks(foundryCopyWorld, uuid),
      plan: (uuid: string, options?: CopyOptions) => planCopy(bulkDeps(), uuid, options),
      setSubspeciesMarker: (uuid: string, species: string) => setMarker(markers(), uuid, species),
      removeSubspeciesMarker: (uuid: string) => removeMarker(markers(), uuid),
      readSubspeciesMarker: (uuid: string) => readMarkerOf(markers(), uuid),
      copyCompendia: (selection: BulkSelection, options?: BulkCopyOptions) => copyCompendia(bulkDeps(), selection, options),
      planCompendia: (selection: BulkSelection, options?: BulkPlanOptions) => planCompendia(bulkDeps(), selection, options),
      clearProtocol,
    });
  }
});

Hooks.once("setup", () => {
  // The cross-compendium search overlay (milestone M13); the keybinding registered in "init" opens it, from anywhere
  // in Foundry. No Gamemaster/Assistant guard — the shortcut is for every role (Apply section H).
  SearchApplication = createSearchApplicationClass({
    index: cachedSearchIndex,
    openDocument: openDocumentSheet,
    log: consoleLog,
  });

  // The window that copies from other compendia (milestone M11); opened from a button of the Library window, not from
  // its own hub entry (that would need a second `open` per module, which the contract does not offer).
  const CopyApplication = createCopyApplicationClass({
    listPacks: () => foundryBulkWorld.listNonEaglePacks(),
    plan: (selection, options) => planCompendia(bulkDeps(), selection, options),
    copy: (selection, options) => copyCompendia(bulkDeps(), selection, options),
    protocolOf: readProtocol,
    clearProtocol,
    force: (uuid, options) => copyDocument(bulkDeps(), uuid, options),
    openDocument: openDocumentSheet,
    notify: (level, message) => ui.notifications?.[level]?.(message),
  });

  // The Open button of the Library's tab in the hub opens the Library window (milestone M10).
  const LibraryApplication = createLibraryApplicationClass({
    packSource: foundryPackSource,
    api: flightControl,
    eagleIndex: foundryCopyWorld.eagleIndex,
    openDocument: openDocumentSheet,
    openCopy: () => {
      // The window is not for players (same decision as the Library window itself); checked again here regardless of
      // whether the button that led to it was already hidden for one.
      if (game.user?.isGM !== true) {
        ui.notifications?.warn(game.i18n!.localize("EAGLELIBRARY.compendia.notGm"));
        return;
      }
      new CopyApplication().render(true);
    },
    notify: (level, message) => ui.notifications?.[level]?.(message),
    log: consoleLog,
  });
  registerWithFlightControl(flightControlApi, consoleLog, () => {
    // The Hub is expected to show "Open" only for a Gamemaster or Assistant; checked again here regardless (M10 decision:
    // the window is not for players), the same way the compendia dialog it replaces always checked for itself.
    if (game.user?.isGM !== true) {
      ui.notifications?.warn(game.i18n!.localize("EAGLELIBRARY.compendia.notGm"));
      return;
    }
    new LibraryApplication().render(true);
  });
});

// Every client registers the spell lists of the Library with dnd5e at every start (the registry lives in the memory of the client).
Hooks.once("ready", () => {
  void registerSpellListsWithDnd5e(consoleLog);
});
