import type { Json } from "./rewrite-links";
import { recognizeCompendium } from "./catalog";
import { nameKey } from "./name-key";
import { parsePrimary } from "./uuid";

// The marker of a subspecies (decisions N12 and N21, rule R18 of the convention): a flag of the Library on the species Item of the
// Library's copy that says which species it belongs to. dnd5e keeps subspecies as Items of their own with no link to the species.
// Pure logic on the data of a document; setting and removing a marker of an existing Item goes through Flight Control
// (`compendium.flag`, v13/module.ts).

export const FLAG_NAMESPACE = "eagle-library";
export const SUBSPECIES_KEY = "subspecies";
// The path in the data of a document (the value of `changes` when a copy is made).
export const SUBSPECIES_PATH = `flags.${FLAG_NAMESPACE}.${SUBSPECIES_KEY}`;

export interface SubspeciesMarker {
  // The name of the species the Item is a subspecies of ("Elf").
  readonly species: string;
  // "auto": made by the Library when the Item was copied; "manual": set by hand.
  readonly origin: "auto" | "manual";
}

const isRecord = (value: unknown): value is Record<string, Json> => typeof value === "object" && value !== null && !Array.isArray(value);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const capitalize = (text: string): string => (text === "" ? text : text[0]!.toUpperCase() + text.slice(1));

// The marker the data of a species Item give, or undefined. Only what the data say clearly is used, nothing is guessed:
//  1. a name of the form "Species, Subspecies" with exactly one comma and both parts filled (dnd5e 2024: "Elf, High"): the
//     species is the part before the comma;
//  2. else a subtype (`system.type.subtype`) that is filled, is not the name, and stands in the name as a word ("High Elf" with
//     the subtype "elf", dnd5e 2014): the species is the subtype with a capital letter;
//  3. else none.
// The data of dnd5e 2014 give "Half-Elf" and "Half-Orc" the subtypes "elf" and "orc", so rule 2 marks them; the marker is a
// suggestion of the data and can be removed by hand (N21).
export function deriveMarker(data: Json): SubspeciesMarker | undefined {
  if (!isRecord(data) || typeof data.name !== "string") return undefined;
  const name = data.name.trim();
  const parts = name.split(",");
  if (parts.length === 2) {
    const species = parts[0]!.trim();
    const sub = parts[1]!.trim();
    return species !== "" && sub !== "" ? { species, origin: "auto" } : undefined;
  }
  if (parts.length > 2) return undefined;
  const system = data.system;
  const type = isRecord(system) ? system.type : undefined;
  const subtype = isRecord(type) && typeof type.subtype === "string" ? type.subtype.trim() : "";
  if (subtype === "" || nameKey(subtype) === nameKey(name)) return undefined;
  if (!new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(subtype)}(?![\\p{L}\\p{N}])`, "iu").test(name)) return undefined;
  return { species: capitalize(subtype), origin: "auto" };
}

// The marker in the data of a document, or undefined; a value that is not a marker is none.
export function readMarker(data: Json): SubspeciesMarker | undefined {
  if (!isRecord(data) || !isRecord(data.flags)) return undefined;
  const own = data.flags[FLAG_NAMESPACE];
  const value = isRecord(own) ? own[SUBSPECIES_KEY] : undefined;
  if (!isRecord(value) || typeof value.species !== "string" || value.species.trim() === "") return undefined;
  if (value.origin !== "auto" && value.origin !== "manual") return undefined;
  return { species: value.species, origin: value.origin };
}

// The field to set on a copy: the path and the value.
export function markerChange(marker: SubspeciesMarker): { [path: string]: Json } {
  return { [SUBSPECIES_PATH]: { species: marker.species, origin: marker.origin } };
}

// ---- Setting and removing a marker by hand (console; Flight Control writes, `compendium.flag`, API 0.12.0) ----

export type MarkerResult =
  | { readonly ok: true; readonly changed: boolean; readonly marker?: SubspeciesMarker }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

// What the operations need of the world: the data of a document, and the request to Flight Control.
export interface MarkerDeps {
  readData(uuid: string): Promise<Json | undefined>;
  request(payload: { pack: string; id: string; key: string; value: Json | null }): Promise<unknown>;
  isGm(): boolean;
}

// The pack and the id of a species Item of the Library, from its UUID (`Compendium.world.eagle-species-2024.Item.<id>`, with or
// without the type), or why it is not one.
function speciesTarget(uuid: unknown): { pack: string; id: string } | string {
  if (typeof uuid !== "string") return "the UUID must be a string";
  const parsed = parsePrimary(uuid);
  if (!parsed || parsed.scope !== "world") return "the UUID is not that of a document in a compendium of the world";
  const compendium = recognizeCompendium({ packageType: "world", name: parsed.pack, type: "Item" });
  if (!compendium || compendium.entry.key !== "species") return "the document is not in an Eagle Compendium for species";
  return { pack: `world.${parsed.pack}`, id: parsed.id };
}

async function writeMarker(deps: MarkerDeps, uuid: unknown, value: SubspeciesMarker | null): Promise<MarkerResult> {
  if (!deps.isGm()) return { ok: false, reason: "not-gm", detail: "only a Gamemaster or Assistant may set a marker" };
  const target = speciesTarget(uuid);
  if (typeof target === "string") return { ok: false, reason: "not-a-species", detail: target };
  let data: Json | undefined;
  try {
    data = await deps.readData(uuid as string);
  } catch (error) {
    return { ok: false, reason: "read-failed", detail: error instanceof Error ? error.message : String(error) };
  }
  if (data === undefined) return { ok: false, reason: "source-not-found", detail: "there is no document with this UUID" };
  let answer: unknown;
  try {
    answer = await deps.request({ ...target, key: SUBSPECIES_KEY, value: value ? { species: value.species, origin: value.origin } : null });
  } catch (error) {
    return { ok: false, reason: "request-failed", detail: error instanceof Error ? error.message : String(error) };
  }
  if (!isRecord(answer)) return { ok: false, reason: "request-failed", detail: "Flight Control did not answer with an object" };
  if (answer.ok === false) return { ok: false, reason: "request-failed", detail: `${String(answer.reason)}: ${String(answer.detail)}` };
  const changed = isRecord(answer.value) && answer.value.changed === true;
  return { ok: true, changed, ...(value ? { marker: value } : {}) };
}

// Sets the marker by hand (`origin: "manual"`); a marker that is there is replaced.
export function setMarker(deps: MarkerDeps, uuid: unknown, species: unknown): Promise<MarkerResult> {
  if (typeof species !== "string" || species.trim() === "") {
    return Promise.resolve({ ok: false, reason: "invalid-species", detail: "the species must be a non-empty string" });
  }
  return writeMarker(deps, uuid, { species: species.trim(), origin: "manual" });
}

// Removes the marker, whether the Library made it or someone set it.
export function removeMarker(deps: MarkerDeps, uuid: unknown): Promise<MarkerResult> {
  return writeMarker(deps, uuid, null);
}

// The marker of a species Item of the Library (none: `marker` is missing).
export async function readMarkerOf(deps: Pick<MarkerDeps, "readData">, uuid: unknown): Promise<MarkerResult> {
  const target = speciesTarget(uuid);
  if (typeof target === "string") return { ok: false, reason: "not-a-species", detail: target };
  let data: Json | undefined;
  try {
    data = await deps.readData(uuid as string);
  } catch (error) {
    return { ok: false, reason: "read-failed", detail: error instanceof Error ? error.message : String(error) };
  }
  if (data === undefined) return { ok: false, reason: "source-not-found", detail: "there is no document with this UUID" };
  const marker = readMarker(data);
  return { ok: true, changed: false, ...(marker ? { marker } : {}) };
}
