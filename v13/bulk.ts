import type { BulkWorld, CompendiumIndex } from "../core/bulk";
import { recognizeCompendium } from "../core/catalog";
import { foundryCopyWorld } from "./copy";

interface IndexRecord {
  readonly _id: string;
  readonly name?: string;
  readonly type?: string;
}

// The two things `foundryCopyWorld` does not need: the index of a compendium the Library does not own, and the list of
// compendia of the world that are not Eagle Compendia. Both are pure reads (N9); no request to Flight Control.
export const foundryBulkWorld: BulkWorld = {
  ...foundryCopyWorld,

  readCompendiumIndex: async (collection): Promise<CompendiumIndex | undefined> => {
    const pack = game.packs?.get(collection);
    if (!pack) return undefined;
    const index = await pack.getIndex({ fields: ["type"] } as never);
    const entries = [...index].map((record) => {
      const held = record as unknown as IndexRecord;
      return { id: held._id, name: held.name ?? "", ...(typeof held.type === "string" ? { subtype: held.type } : {}) };
    });
    return { documentName: pack.documentName, entries };
  },

  listNonEaglePacks: async () => {
    const packs = game.packs ? [...game.packs] : [];
    return packs
      .filter((pack) => !recognizeCompendium({ packageType: pack.metadata.packageType, name: pack.metadata.name, type: pack.metadata.type }))
      .map((pack) => ({ collection: pack.collection, documentName: pack.documentName, label: pack.metadata.label }));
  },
};
