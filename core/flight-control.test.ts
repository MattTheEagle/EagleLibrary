import { describe, expect, it } from "vitest";
import {
  FLIGHT_CONTROL_ID,
  FLIGHT_CONTROL_MIN_MODULE_VERSION,
  REQUIRED_API_VERSION,
  registerWithFlightControl,
  type RegistrationApi,
} from "./flight-control";
import { LIBRARY_ID } from "./index";

// The failure codes of registerModule as the contract lists them (section 2).
const FAILURE_CODES = [
  "invalid-descriptor",
  "invalid-api-version",
  "unknown-module",
  "inactive-module",
  "already-registered",
  "incompatible-api-version",
  "internal-error",
] as const;

const OK_RESULT = {
  ok: true,
  module: { id: LIBRARY_ID, title: "Eagle Library", version: "0.0.6", apiVersion: "0.14.0" },
};

function recordingLog() {
  const lines: { level: "info" | "warn"; message: string }[] = [];
  const log = {
    info: (message: string) => void lines.push({ level: "info", message }),
    warn: (message: string) => void lines.push({ level: "warn", message }),
  };
  return { lines, log };
}

// An API that answers with `result` and remembers what it was called with.
function apiAnswering(result: unknown) {
  const calls: unknown[] = [];
  const api: RegistrationApi = {
    registerModule: (descriptor) => {
      calls.push(descriptor);
      return result;
    },
  };
  return { api, calls };
}

describe("registerWithFlightControl", () => {
  it("reports a missing Flight Control without throwing", () => {
    const { lines, log } = recordingLog();
    expect(registerWithFlightControl(() => undefined, log)).toEqual({ status: "missing" });
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("warn");
    expect(lines[0].message).toContain("missing or not active");
  });

  it("registers once, with exactly the id and the API version, and without an open function", () => {
    const { api, calls } = apiAnswering(OK_RESULT);
    registerWithFlightControl(() => api, recordingLog().log);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toStrictEqual({ id: LIBRARY_ID, apiVersion: REQUIRED_API_VERSION });
    expect(Object.keys(calls[0] as object)).toEqual(["id", "apiVersion"]);
  });

  it("hands the open function to Flight Control when there is one, next to the id and the API version", () => {
    const { api, calls } = apiAnswering(OK_RESULT);
    const open = () => undefined;
    registerWithFlightControl(() => api, recordingLog().log, open);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toStrictEqual({ id: LIBRARY_ID, apiVersion: REQUIRED_API_VERSION, open });
    expect((calls[0] as { open: unknown }).open).toBe(open);
  });

  it("reports a successful registration with the module data and logs it", () => {
    const { lines, log } = recordingLog();
    const outcome = registerWithFlightControl(() => apiAnswering(OK_RESULT).api, log);
    expect(outcome).toEqual({ status: "registered", module: OK_RESULT.module });
    expect(lines).toEqual([
      { level: "info", message: "eagle-library | registerModule result: ok (Eagle Library 0.0.6, API 0.14.0)" },
    ]);
  });

  it.each(FAILURE_CODES)("rejects with the failure code %s and says so in the log", (code) => {
    const { lines, log } = recordingLog();
    const answer = { ok: false, reason: code, detail: `detail of ${code}` };
    expect(registerWithFlightControl(() => apiAnswering(answer).api, log)).toEqual({
      status: "rejected",
      reason: code,
      detail: `detail of ${code}`,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("warn");
    expect(lines[0].message).toContain(`(${code})`);
    expect(lines[0].message).toContain(`detail of ${code}`);
  });

  it("treats a failure code that a later contract adds as a failure", () => {
    const answer = { ok: false, reason: "some-future-code", detail: "new" };
    expect(registerWithFlightControl(() => apiAnswering(answer).api, recordingLog().log)).toEqual({
      status: "rejected",
      reason: "some-future-code",
      detail: "new",
    });
  });

  it("names a missing detail instead of leaving it out", () => {
    const answer = { ok: false, reason: "internal-error" };
    expect(registerWithFlightControl(() => apiAnswering(answer).api, recordingLog().log)).toEqual({
      status: "rejected",
      reason: "internal-error",
      detail: "no detail",
    });
  });

  it("catches a registerModule that throws", () => {
    const { lines, log } = recordingLog();
    const api: RegistrationApi = {
      registerModule: () => {
        throw new Error("boom");
      },
    };
    expect(registerWithFlightControl(() => api, log)).toEqual({ status: "rejected", reason: "threw", detail: "boom" });
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("warn");
  });

  it("catches a source that throws", () => {
    const outcome = registerWithFlightControl(() => {
      throw new Error("no game yet");
    }, recordingLog().log);
    expect(outcome).toEqual({ status: "rejected", reason: "threw", detail: "no game yet" });
  });

  it("rejects an API that has no registerModule function", () => {
    const outcome = registerWithFlightControl(() => ({}) as unknown as RegistrationApi, recordingLog().log);
    expect(outcome).toMatchObject({ status: "rejected", reason: "invalid-response" });
  });

  it.each([undefined, null, "ok", 42, ["ok"]])("rejects an answer that is not an object (%j)", (answer) => {
    const outcome = registerWithFlightControl(() => apiAnswering(answer).api, recordingLog().log);
    expect(outcome).toMatchObject({ status: "rejected", reason: "invalid-response" });
  });

  it.each([{ ok: true }, { ok: true, module: { id: 1 } }, { ok: true, module: { id: "a", title: "b", version: "c" } }])(
    "rejects a success without the complete module data (%j)",
    (answer) => {
      const outcome = registerWithFlightControl(() => apiAnswering(answer).api, recordingLog().log);
      expect(outcome).toMatchObject({ status: "rejected", reason: "invalid-response" });
    },
  );

  it.each([{ ok: "yes" }, { ok: false }, { reason: "unknown-module" }])("rejects an answer of an unknown shape (%j)", (answer) => {
    const outcome = registerWithFlightControl(() => apiAnswering(answer).api, recordingLog().log);
    expect(outcome).toMatchObject({ status: "rejected", reason: "invalid-response" });
  });
});

describe("the version pairing with Flight Control", () => {
  it("asks for the API version that the first Flight Control release with it provides", () => {
    // Contract, section 6: module version 0.8.0 is the first one with API 0.14.0 (`document.update`), a
    // compatibility-only patch (Library 0.1.2) from Eagle Homebrew's milestone M6, the same pattern as the 0.1.1
    // patch from milestone M2; no rule of this contract changed.
    expect(FLIGHT_CONTROL_ID).toBe("eagle-flight-control");
    expect(REQUIRED_API_VERSION).toBe("0.14.0");
    expect(FLIGHT_CONTROL_MIN_MODULE_VERSION).toBe("0.8.0");
  });
});
