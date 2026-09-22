export const LIBRARY_ID = "eagle-library";

export function logLibraryReady(foundryVersion: string): void {
  console.log(`${LIBRARY_ID} | ready (Foundry v${foundryVersion})`);
}
