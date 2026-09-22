// Types of the API of Eagle Flight Control, copied verbatim from its API contract (section 1, API 0.12.0).
// Flight Control's code is not shared with the Library; this copy is how the Library knows the shape of
// game.modules.get("eagle-flight-control")?.api. Update it together with REQUIRED_API_VERSION in core/flight-control.ts whenever
// Flight Control changes its API.
type RegistrationFailure =
  | "invalid-descriptor"
  | "invalid-api-version"
  | "unknown-module"
  | "inactive-module"
  | "already-registered"
  | "incompatible-api-version"
  | "internal-error";

type RegistrationResult =
  | {
      readonly ok: true;
      readonly module: {
        readonly id: string;
        readonly title: string;
        readonly version: string;
        readonly apiVersion: string;
      };
    }
  | { readonly ok: false; readonly reason: RegistrationFailure; readonly detail: string };

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

type RequestFailure =
  | "invalid-request"
  | "not-registered"
  | "unknown-request"
  | "unsupported-version"
  | "invalid-payload"
  | "handler-failed"
  | "internal-error"
  | "no-gm"
  | "relay-timeout"
  | "relay-failed"
  | "not-permitted";

type RequestResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly reason: RequestFailure; readonly detail: string };

type RightsLevel = "denied" | "own" | "all";

type RightsResult =
  | { readonly ok: true; readonly value: { readonly level: RightsLevel } }
  | {
      readonly ok: false;
      readonly reason: "invalid-request" | "not-registered" | "internal-error";
      readonly detail: string;
    };

type SystemStatus = "tested" | "same-line" | "untested" | "other-system" | "unknown";

type SystemInfoResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly id: string | null;
        readonly version: string | null;
        readonly status: SystemStatus;
        readonly testedVersions: readonly string[];
      };
    }
  | { readonly ok: false; readonly reason: "internal-error"; readonly detail: string };

interface EagleFlightControlApi {
  readonly version: string;
  registerModule(descriptor: {
    id: string;
    apiVersion: string;
    open?: () => void | Promise<void>;
  }): RegistrationResult;
  request(request: {
    module: string;
    type: string;
    version?: number;
    payload?: JsonValue;
  }): Promise<RequestResult>;
  getRights(moduleId: string): RightsResult;
  getSystemInfo(): SystemInfoResult;
}

declare global {
  interface ModuleConfig {
    "eagle-flight-control": { api: EagleFlightControlApi };
  }
}

// Makes this file a module, which `declare global` needs.
export {};
