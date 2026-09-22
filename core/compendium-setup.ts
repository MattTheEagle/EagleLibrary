import { expectedCompendia, type ExpectedCompendium } from "./catalog";
import { LIBRARY_ID } from "./index";

// Creating the Eagle Compendia of the catalog (M2) in the world, through Flight Control (`compendium.create`, API 0.8.0 and later).
// The Library reads the world directly (which compendia exist) and only asks for what is missing; Flight Control looks
// again on the Gamemaster's client, so asking twice is safe. Nothing here touches Foundry: the world and Flight Control
// are handed in (v13/compendia.ts and v13/module.ts provide them).

// What the Library needs to know about the world's compendia: the document type of the world compendium of a name.
export interface PackSource {
  find(name: string): { readonly type: string } | undefined;
}

// The `request` of Flight Control's API. The Library passes the shapes of the contract and reads the answer as data.
export interface RequestApi {
  request(request: { module: string; type: string; version?: number; payload?: unknown }): Promise<unknown>;
}

export interface SetupLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface CompendiaStatus {
  readonly expected: number;
  // The catalog's compendia that exist with the right document type.
  readonly present: readonly ExpectedCompendium[];
  // The ones that do not exist.
  readonly missing: readonly ExpectedCompendium[];
  // The ones whose name a compendium of another document type has taken. Not touched, only reported.
  readonly conflicts: readonly { readonly compendium: ExpectedCompendium; readonly foundType: string }[];
}

// Which of the 34 compendia are there. Reads the world; a source that throws throws here, because a guess ("missing")
// could ask for a compendium that exists.
export function compendiaStatus(source: PackSource): CompendiaStatus {
  const present: ExpectedCompendium[] = [];
  const missing: ExpectedCompendium[] = [];
  const conflicts: { compendium: ExpectedCompendium; foundType: string }[] = [];
  const expected = expectedCompendia();
  for (const compendium of expected) {
    const found = source.find(compendium.name);
    if (!found) missing.push(compendium);
    else if (found.type === compendium.documentName) present.push(compendium);
    else conflicts.push({ compendium, foundType: found.type });
  }
  return { expected: expected.length, present, missing, conflicts };
}

export interface CreationFailure {
  // The compendium that was being made.
  readonly name: string;
  // A failure code of Flight Control's contract, or "missing" (no Flight Control), "threw" or "invalid-response".
  readonly reason: string;
  readonly detail: string;
}

export interface CreationReport {
  readonly expected: number;
  // There before this run.
  readonly present: number;
  // Made by this run.
  readonly created: readonly string[];
  // Missing for the Library, but Flight Control found them (someone made them in between, or an earlier answer was lost).
  readonly existed: readonly string[];
  readonly conflicts: CompendiaStatus["conflicts"];
  // Where it stopped, if it did. Asking again continues from there.
  readonly failure?: CreationFailure;
  // Not asked for because of the failure.
  readonly remaining: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type Answer =
  | { readonly kind: "made"; readonly created: boolean }
  | { readonly kind: "failed"; readonly reason: string; readonly detail: string };

// Reads the answer to one request. Anything that is not what the contract describes is a failure, never a guess.
function readAnswer(answer: unknown, compendium: ExpectedCompendium): Answer {
  const invalid = (detail: string): Answer => ({ kind: "failed", reason: "invalid-response", detail });
  if (!isRecord(answer)) return invalid("Flight Control did not answer with an object");
  if (answer.ok === false) {
    const reason = typeof answer.reason === "string" ? answer.reason : "invalid-response";
    return { kind: "failed", reason, detail: typeof answer.detail === "string" ? answer.detail : "no detail" };
  }
  const value = answer.value;
  if (answer.ok !== true || !isRecord(value)) return invalid("Flight Control answered with an unknown shape");
  if (typeof value.created !== "boolean") return invalid("the answer has no created flag");
  if (value.collection !== `world.${compendium.name}` || value.type !== compendium.documentName) {
    return invalid(`the answer describes another compendium than ${compendium.name}`);
  }
  return { kind: "made", created: value.created };
}

// Makes the missing compendia, one request each, in catalog order. It stops at the first failure and says how far it got;
// a later run continues, because what exists is left alone. A name taken by a compendium of another document type is
// reported and not asked for. It never throws.
export async function createMissingCompendia(
  api: RequestApi | undefined,
  source: PackSource,
  log: SetupLog,
): Promise<CreationReport> {
  let status: CompendiaStatus;
  try {
    status = compendiaStatus(source);
  } catch (error) {
    const expected = expectedCompendia().length;
    const failure = { name: "", reason: "threw", detail: `the world's compendia could not be read: ${messageOf(error)}` };
    log.warn(`${LIBRARY_ID} | ${failure.detail}`);
    return { expected, present: 0, created: [], existed: [], conflicts: [], failure, remaining: expected };
  }

  for (const { compendium, foundType } of status.conflicts) {
    log.warn(
      `${LIBRARY_ID} | compendium ${compendium.name}: the name is taken by a compendium of the document type ${foundType} ` +
        `(expected ${compendium.documentName}); not touched`,
    );
  }

  const created: string[] = [];
  const existed: string[] = [];
  let failure: CreationFailure | undefined;

  for (const compendium of status.missing) {
    const { name } = compendium;
    const fail = (reason: string, detail: string): void => {
      failure = { name, reason, detail };
      log.warn(`${LIBRARY_ID} | compendium ${name}: failed (${reason}): ${detail}`);
    };

    if (!api) {
      fail("missing", "Eagle Flight Control is missing or not active");
      break;
    }
    let answer: unknown;
    try {
      answer = await api.request({
        module: LIBRARY_ID,
        type: "compendium.create",
        version: 1,
        payload: { type: compendium.documentName, label: compendium.label, name },
      });
    } catch (error) {
      fail("threw", messageOf(error));
      break;
    }
    const read = readAnswer(answer, compendium);
    if (read.kind === "failed") {
      fail(read.reason, read.detail);
      break;
    }
    (read.created ? created : existed).push(name);
    log.info(`${LIBRARY_ID} | compendium ${name}: ${read.created ? "created" : "existed"}`);
  }

  const done = created.length + existed.length;
  const remaining = failure ? status.missing.length - done - 1 : 0;
  const report: CreationReport = {
    expected: status.expected,
    present: status.present.length,
    created,
    existed,
    conflicts: status.conflicts,
    ...(failure ? { failure } : {}),
    remaining,
  };
  log.info(
    `${LIBRARY_ID} | compendia: ${report.expected} expected, ${report.present} there before, ${created.length} created, ` +
      `${existed.length} existed, ${status.conflicts.length} in conflict` +
      (failure ? `, stopped at ${(failure as CreationFailure).name} (${remaining} not asked for)` : ""),
  );
  return report;
}
