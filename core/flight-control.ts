import { LIBRARY_ID } from "./index";

// Eagle Flight Control as the Library sees it: its module id, the API version the Library was written against, and the first
// Flight Control release that provides that API (contract, sections 5 and 6). Before 1.0.0 the API is tied to its minor
// version, so a change of Flight Control's API changes REQUIRED_API_VERSION in the same milestone.
// Raised to 0.14.0/0.8.0 as a compatibility-only patch (version 0.1.2), outside any milestone of this phase: Eagle
// Homebrew's milestone M6 added the request type `document.update` to Flight Control, which the Library does not use,
// but which raised the API's minor version — and before 1.0.0 Flight Control accepts a registration only when the
// requested and the provided minor version are exactly equal (see isApiCompatible in Flight Control's core/api-version.ts).
// Without this patch the Library would fail to register with any Flight Control from 0.8.0 on. Same pattern as the
// 0.1.1 patch from milestone M2; no rule of this contract changed.
export const FLIGHT_CONTROL_ID = "eagle-flight-control";
export const REQUIRED_API_VERSION = "0.14.0";
export const FLIGHT_CONTROL_MIN_MODULE_VERSION = "0.8.0";

// The part of Flight Control's API that registration needs. Flight Control types its parameters as unknown; the Library
// passes the shape the contract describes.
export interface RegistrationApi {
  registerModule(descriptor: { id: string; apiVersion: string; open?: () => void | Promise<void> }): unknown;
}

// Where the API comes from. In Foundry it is game.modules.get("eagle-flight-control")?.api (see v13/module.ts).
export type ApiSource = () => RegistrationApi | undefined;

export interface RegistrationLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface RegisteredModule {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly apiVersion: string;
}

export type RegistrationOutcome =
  | { readonly status: "registered"; readonly module: RegisteredModule }
  // Flight Control is not installed or not active, so there is no API.
  | { readonly status: "missing" }
  // `reason` is a failure code of the contract, or "threw" / "invalid-response" for what the contract does not describe.
  | { readonly status: "rejected"; readonly reason: string; readonly detail: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Registers the Library with Flight Control, once. It never throws: whatever Flight Control does or answers becomes an
// outcome and a line in the log. Nothing in the Library depends on the outcome yet, so a failure switches nothing off.
// `open` opens the Library's interface; Flight Control shows it as the Open button of the Library's tab in the hub.
export function registerWithFlightControl(
  source: ApiSource,
  log: RegistrationLog,
  open?: () => void | Promise<void>,
): RegistrationOutcome {
  const rejected = (reason: string, detail: string): RegistrationOutcome => {
    log.warn(`${LIBRARY_ID} | registerModule result: rejected (${reason}): ${detail}`);
    return { status: "rejected", reason, detail };
  };

  let api: RegistrationApi | undefined;
  try {
    api = source();
  } catch (error) {
    return rejected("threw", messageOf(error));
  }
  if (!api) {
    log.warn(`${LIBRARY_ID} | Eagle Flight Control is missing or not active; the Library cannot register`);
    return { status: "missing" };
  }
  if (typeof api.registerModule !== "function") {
    return rejected("invalid-response", "the API has no registerModule function");
  }

  let result: unknown;
  try {
    result = api.registerModule(open ? { id: LIBRARY_ID, apiVersion: REQUIRED_API_VERSION, open } : { id: LIBRARY_ID, apiVersion: REQUIRED_API_VERSION });
  } catch (error) {
    return rejected("threw", messageOf(error));
  }

  if (!isRecord(result)) return rejected("invalid-response", "registerModule did not return an object");

  if (result.ok === true) {
    const module = result.module;
    if (
      isRecord(module) &&
      typeof module.id === "string" &&
      typeof module.title === "string" &&
      typeof module.version === "string" &&
      typeof module.apiVersion === "string"
    ) {
      const registered: RegisteredModule = {
        id: module.id,
        title: module.title,
        version: module.version,
        apiVersion: module.apiVersion,
      };
      log.info(`${LIBRARY_ID} | registerModule result: ok (${registered.title} ${registered.version}, API ${registered.apiVersion})`);
      return { status: "registered", module: registered };
    }
    return rejected("invalid-response", "registerModule reported success without the module data");
  }

  // Any failure code counts as a failure, also one that a later contract version adds.
  if (result.ok === false && typeof result.reason === "string") {
    return rejected(result.reason, typeof result.detail === "string" ? result.detail : "no detail");
  }
  return rejected("invalid-response", "registerModule returned an unknown shape");
}
