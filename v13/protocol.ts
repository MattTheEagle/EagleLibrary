import type { ProtocolStore } from "../core/copy";
import type { RequestApi } from "../core/compendium-setup";
import { LIBRARY_ID } from "../core/index";

export const PROTOCOL_SETTING = "protocol";

// Types game.settings for the key of the protocol (a global augmentation, the way Foundry's types ask for it).
declare global {
  interface SettingConfig {
    "eagle-library.protocol": string;
  }
}

// The protocol is a world setting that nobody edits by hand: a text with JSON, not shown in the settings window and not in
// the hub (`config: false`). Flight Control writes it (`setting.write`), everybody reads it.
export function registerProtocolSetting(): void {
  game.settings!.register(LIBRARY_ID, PROTOCOL_SETTING, { scope: "world", config: false, type: String, default: "" });
}

// A setting of the Library that Flight Control writes: read directly (N9), written through Flight Control's request
// `setting.write` with what was read (`previous`), so a change by another client in between is noticed.
export function foundrySettingStore(key: string, api: () => RequestApi | undefined): ProtocolStore {
  return {
    read: () => {
      const stored: unknown = (game.settings as unknown as { get(namespace: string, key: string): unknown }).get(LIBRARY_ID, key);
      return typeof stored === "string" ? stored : "";
    },
    write: async (previous, value) => {
      const flightControl = api();
      if (!flightControl) return { ok: false, detail: "Eagle Flight Control is missing or not active" };
      const answer = (await flightControl.request({
        module: LIBRARY_ID,
        type: "setting.write",
        version: 1,
        payload: { key, value, previous },
      })) as { ok?: unknown; reason?: unknown; detail?: unknown } | null;
      if (answer && answer.ok === true) return { ok: true };
      const reason = typeof answer?.reason === "string" ? answer.reason : "invalid-response";
      return { ok: false, detail: `${reason}: ${typeof answer?.detail === "string" ? answer.detail : "no detail"}` };
    },
  };
}

export const foundryProtocolStore = (api: () => RequestApi | undefined): ProtocolStore => foundrySettingStore(PROTOCOL_SETTING, api);
