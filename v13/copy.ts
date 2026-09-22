import type { ContainedEntry, CopySource, CopyWorld, IndexEntry } from "../core/copy";
import { artForDocument, expectedCompendia, type ExpectedCompendium } from "../core/catalog";
import type { LibraryDocument } from "../core/relink";
import type { Json } from "../core/rewrite-links";

// All that is read from a document here. The type of fromUuid only takes UUIDs it can check at compile time, and the
// documents come in many classes; what is read is the same for all of them.
interface ReadableDocument {
  readonly uuid: string;
  readonly id: string | null;
  readonly name: string | null;
  readonly documentName: string;
  readonly type?: string;
  readonly isEmbedded: boolean;
  readonly pack: string | null;
  toObject?(source?: boolean): unknown;
  readonly _source?: { system?: { source?: { rules?: unknown }; requirements?: unknown; container?: unknown } };
}

// An entry of a compendium index; only what is read here.
interface IndexRecord {
  readonly _id: string;
  readonly uuid?: string;
  readonly name?: string;
  readonly system?: { container?: string | null; requirements?: unknown };
}

// The world as the Library reads it for a copy (N9: the Library reads directly, only changes go through Flight Control).
// What the index gives for a missing `system.source.rules` or the old Item subtype "backpack" is checked in a running
// Foundry (M4 live check); the document itself is read for both.
export const foundryCopyWorld: CopyWorld = {
  readDocument: async (uuid): Promise<CopySource | undefined> => {
    const document = (await foundry.utils.fromUuid(uuid as never)) as unknown as ReadableDocument | null;
    if (!document || typeof document.id !== "string") return undefined;
    const pack = document.pack ? game.packs?.get(document.pack) : undefined;
    return {
      uuid: document.uuid,
      id: document.id,
      name: document.name ?? "",
      documentName: document.documentName,
      ...(typeof document.type === "string" ? { subtype: document.type } : {}),
      // Read from the stored data, never from the prepared value or the world setting (rule R4).
      rules: document._source?.system?.source?.rules,
      requirements: document._source?.system?.requirements,
      container: typeof document._source?.system?.container === "string" && document._source.system.container !== "" ? document._source.system.container : null,
      primary: !document.isEmbedded,
      ...(pack
        ? { pack: { collection: pack.collection, packageType: pack.metadata.packageType, name: pack.metadata.name, type: pack.metadata.type } }
        : {}),
    };
  },

  eagleIndex: async (compendium: ExpectedCompendium): Promise<readonly IndexEntry[] | undefined> => {
    const pack = game.packs?.get(`world.${compendium.name}`);
    if (!pack || pack.metadata.type !== compendium.documentName) return undefined;
    const index = await pack.getIndex({ fields: ["system.requirements"] } as never);
    return [...index].map((entry) => {
      const record = entry as unknown as IndexRecord;
      return { id: record._id, name: record.name ?? "", requirements: record.system?.requirements };
    });
  },

  // The data of a document: its source as JSON.
  readData: async (uuid): Promise<Json | undefined> => {
    const document = (await foundry.utils.fromUuid(uuid as never)) as unknown as ReadableDocument | null;
    if (!document) return undefined;
    const data = typeof document.toObject === "function" ? document.toObject(true) : document._source;
    return data === undefined ? undefined : (JSON.parse(JSON.stringify(data)) as Json);
  },

  // The ids of all documents in the Eagle Compendia, and where each is.
  libraryIds: async (): Promise<ReadonlyMap<string, LibraryDocument>> => {
    const ids = new Map<string, LibraryDocument>();
    for (const compendium of expectedCompendia()) {
      const pack = game.packs?.get(`world.${compendium.name}`);
      if (!pack || pack.metadata.type !== compendium.documentName) continue;
      const index = await pack.getIndex();
      for (const entry of [...index]) ids.set((entry as unknown as IndexRecord)._id, { compendium: compendium.name, documentName: compendium.documentName });
    }
    return ids;
  },

  // What is known of a link target outside the Library: whether the compendium is in the world, whether the document is in it and
  // whether the Library has a place for its kind. "Not installed" and "not active" look alike from `game.packs`.
  describeTarget: async (scope, pack, id) => {
    const found = game.packs?.get(`${scope}.${pack}`);
    if (!found) return { installed: false };
    const index = await found.getIndex({ fields: ["type"] } as never);
    const entry = (index as unknown as { get(id: string): { type?: string } | undefined }).get(id);
    if (!entry) return { installed: true, exists: false, documentName: found.documentName };
    return { installed: true, exists: true, documentName: found.documentName, noArt: artForDocument(found.documentName, typeof entry.type === "string" ? entry.type : undefined) === undefined };
  },

  contained: async (collection): Promise<readonly ContainedEntry[]> => {
    const pack = game.packs?.get(collection);
    if (!pack) throw new Error(`the compendium ${collection} does not exist`);
    const index = await pack.getIndex({ fields: ["system.container"] } as never);
    const entries: ContainedEntry[] = [];
    for (const record of [...index] as unknown as IndexRecord[]) {
      const container = record.system?.container;
      if (typeof container !== "string" || container === "") continue;
      entries.push({ id: record._id, uuid: record.uuid ?? `Compendium.${collection}.${pack.documentName}.${record._id}`, container });
    }
    return entries;
  },
};
