import type { PackSource } from "../core/compendium-setup";

// The world's compendia as the Library reads them (directly, N9): the document type of the world compendium of a name.
// Used by the Library window (`v13/library-application.ts`, milestone M10) to know what exists and what is missing.
export const foundryPackSource: PackSource = {
  find: (name) => {
    const pack = game.packs?.get(`world.${name}`);
    return pack ? { type: pack.metadata.type } : undefined;
  },
};
