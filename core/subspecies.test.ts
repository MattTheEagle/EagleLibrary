import { describe, expect, it, vi } from "vitest";
import type { Json } from "./rewrite-links";
import { deriveMarker, markerChange, readMarker, readMarkerOf, removeMarker, setMarker, SUBSPECIES_PATH, type MarkerDeps } from "./subspecies";

const species = (name: string, subtype?: unknown) => ({ name, system: { type: { value: "humanoid", subtype } } }) as unknown as Json;

describe("deriveMarker: what the data say clearly", () => {
  it.each([
    ["Elf, High", "Elf"],
    ["Dwarf, Hill", "Dwarf"],
    ["  Elf ,  High ", "Elf"],
  ])("takes the part before the only comma of %j", (name, expected) => {
    expect(deriveMarker(species(name))).toEqual({ species: expected, origin: "auto" });
  });

  it.each([["Elf,"], [",High"], ["Elf, High, Wild"], [","]])("makes no marker of the name %j (empty part or more than one comma)", (name) => {
    expect(deriveMarker(species(name))).toBeUndefined();
  });

  it("takes the subtype with a capital letter when it stands in the name as a word", () => {
    expect(deriveMarker(species("High Elf", "elf"))).toEqual({ species: "Elf", origin: "auto" });
    expect(deriveMarker(species("Half-Elf", "elf"))).toEqual({ species: "Elf", origin: "auto" });
    expect(deriveMarker(species("Wood ELF", "Elf"))).toEqual({ species: "Elf", origin: "auto" });
  });

  it("makes none when the subtype is empty, is the name, is missing or does not stand in the name", () => {
    expect(deriveMarker(species("Elf", "elf"))).toBeUndefined();
    expect(deriveMarker(species("High Elf", ""))).toBeUndefined();
    expect(deriveMarker(species("High Elf", "  "))).toBeUndefined();
    expect(deriveMarker(species("High Elf", undefined))).toBeUndefined();
    expect(deriveMarker(species("Dragonborn", "elf"))).toBeUndefined();
    expect(deriveMarker(species("Elfin Bard", "elf"))).toBeUndefined();
    expect(deriveMarker(species("High Elf", 3))).toBeUndefined();
  });

  it("makes none for a name with more than one comma, even when the subtype stands in it", () => {
    expect(deriveMarker(species("Elf, High, Elf", "elf"))).toBeUndefined();
  });

  it("makes none for data that are not a document", () => {
    expect(deriveMarker(null)).toBeUndefined();
    expect(deriveMarker([])).toBeUndefined();
    expect(deriveMarker({})).toBeUndefined();
    expect(deriveMarker({ name: 4 })).toBeUndefined();
    expect(deriveMarker({ name: "High Elf" })).toBeUndefined();
  });

  it("does not take a subtype with characters that are special in a pattern for anything but text", () => {
    expect(deriveMarker(species("A (B) Elf", "(B)"))).toEqual({ species: "(B)", origin: "auto" });
    expect(deriveMarker(species("High Elf", ".*"))).toBeUndefined();
  });
});

describe("readMarker and markerChange", () => {
  it("reads a marker in the flags of the Library and nothing else", () => {
    const flags = (value: unknown) => ({ flags: { "eagle-library": { subspecies: value } } }) as unknown as Json;
    expect(readMarker(flags({ species: "Elf", origin: "manual" }))).toEqual({ species: "Elf", origin: "manual" });
    expect(readMarker(flags({ species: "Elf", origin: "auto" }))).toEqual({ species: "Elf", origin: "auto" });
    expect(readMarker(flags({ species: "Elf", origin: "other" }))).toBeUndefined();
    expect(readMarker(flags({ species: " ", origin: "auto" }))).toBeUndefined();
    expect(readMarker(flags("Elf"))).toBeUndefined();
    expect(readMarker({ flags: { other: { subspecies: { species: "Elf", origin: "auto" } } } })).toBeUndefined();
    expect(readMarker({})).toBeUndefined();
    expect(readMarker(null)).toBeUndefined();
  });

  it("gives the path and the value of the change", () => {
    expect(SUBSPECIES_PATH).toBe("flags.eagle-library.subspecies");
    expect(markerChange({ species: "Elf", origin: "auto" })).toEqual({ "flags.eagle-library.subspecies": { species: "Elf", origin: "auto" } });
  });
});

describe("setting, removing and reading a marker by hand", () => {
  const UUID = "Compendium.world.eagle-species-2024.Item.abcdefghijklmnop";
  const make = (over: Partial<MarkerDeps> = {}, data: unknown = { name: "Elf, High" }) => {
    const request = vi.fn(async () => ({ ok: true, value: { changed: true } }));
    const deps: MarkerDeps = { readData: vi.fn(async () => data as never), request, isGm: () => true, ...over };
    return { deps, request };
  };

  it("sets a manual marker through the request of Flight Control", async () => {
    const { deps, request } = make();
    expect(await setMarker(deps, UUID, " Elf ")).toEqual({ ok: true, changed: true, marker: { species: "Elf", origin: "manual" } });
    expect(request).toHaveBeenCalledWith({ pack: "world.eagle-species-2024", id: "abcdefghijklmnop", key: "subspecies", value: { species: "Elf", origin: "manual" } });
  });

  it("removes a marker with the value null", async () => {
    const { deps, request } = make();
    expect(await removeMarker(deps, UUID)).toEqual({ ok: true, changed: true });
    expect(request).toHaveBeenCalledWith({ pack: "world.eagle-species-2024", id: "abcdefghijklmnop", key: "subspecies", value: null });
  });

  it("accepts a UUID without the document type and refuses everything that is not a species of the Library", async () => {
    const { deps, request } = make();
    expect(await setMarker(deps, "Compendium.world.eagle-species-2014.abcdefghijklmnop", "Elf")).toMatchObject({ ok: true });
    for (const bad of ["Compendium.dnd5e.races.Item.abcdefghijklmnop", "Compendium.world.eagle-weapons-2014.Item.abcdefghijklmnop", "Compendium.world.x.Item.abcdefghijklmnop", "nonsense", 7]) {
      expect(await setMarker(deps, bad, "Elf")).toMatchObject({ ok: false, reason: "not-a-species" });
      expect(await removeMarker(deps, bad)).toMatchObject({ ok: false, reason: "not-a-species" });
    }
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("refuses an empty species, a player, a missing document and an unreadable one; nothing is asked", async () => {
    const { deps, request } = make();
    for (const bad of ["", "  ", 3, undefined]) expect(await setMarker(deps, UUID, bad)).toMatchObject({ ok: false, reason: "invalid-species" });
    expect(await setMarker(make({ isGm: () => false }).deps, UUID, "Elf")).toMatchObject({ ok: false, reason: "not-gm" });
    expect(await setMarker(make({ readData: async () => undefined }).deps, UUID, "Elf")).toMatchObject({ ok: false, reason: "source-not-found" });
    expect(await setMarker(make({ readData: async () => Promise.reject(new Error("no")) }).deps, UUID, "Elf")).toMatchObject({ ok: false, reason: "read-failed", detail: "no" });
    expect(request).not.toHaveBeenCalled();
    expect(deps).toBeDefined();
  });

  it("says why the request failed, never throws, and reports an unchanged flag as not changed", async () => {
    expect(await setMarker(make({ request: async () => ({ ok: false, reason: "not-permitted", detail: "no" }) }).deps, UUID, "Elf")).toEqual({ ok: false, reason: "request-failed", detail: "not-permitted: no" });
    expect(await setMarker(make({ request: async () => Promise.reject(new Error("gone")) }).deps, UUID, "Elf")).toEqual({ ok: false, reason: "request-failed", detail: "gone" });
    expect(await setMarker(make({ request: async () => "x" }).deps, UUID, "Elf")).toMatchObject({ ok: false, reason: "request-failed" });
    expect(await setMarker(make({ request: async () => ({ ok: true, value: { changed: false } }) }).deps, UUID, "Elf")).toMatchObject({ ok: true, changed: false });
  });

  it("reads the marker of a species of the Library, and its absence", async () => {
    const withMarker = make({}, { flags: { "eagle-library": { subspecies: { species: "Elf", origin: "auto" } } } });
    expect(await readMarkerOf(withMarker.deps, UUID)).toEqual({ ok: true, changed: false, marker: { species: "Elf", origin: "auto" } });
    expect(await readMarkerOf(make().deps, UUID)).toEqual({ ok: true, changed: false });
    expect(await readMarkerOf(make().deps, "Compendium.dnd5e.items.Item.abcdefghijklmnop")).toMatchObject({ ok: false, reason: "not-a-species" });
    expect(await readMarkerOf(make({ readData: async () => undefined }).deps, UUID)).toMatchObject({ ok: false, reason: "source-not-found" });
  });
});
