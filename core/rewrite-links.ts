import { isLibraryPack, type LinkMap, EMPTY_LINK_MAP } from "./link-map";
import { countMentions, findUuids, formatPrimary, looseKey, parsePrimary, type ParsedUuid } from "./uuid";

// Rewriting the links of a document to the copies in the Library, and checking them (milestone M6, rule R13 of the convention).
// Pure logic on JSON data: nothing here touches Foundry, and the data that is given is never changed.

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

// The fields that hold where a document came from (decision N10): they stay on the source, in a document and in the documents
// embedded in it (the path ends so, whatever stands in front of it).
export const SOURCE_FIELDS: readonly string[] = Object.freeze([
  "_stats.compendiumSource",
  "_stats.duplicateSource",
  "flags.core.sourceId",
  "flags.dnd5e.sourceId",
]);

export type LinkOutcome =
  | "rewritten" // was rewritten to the copy
  | "in-library" // points into an Eagle Compendium already
  | "kept-source" // a field of origin (N10): stays on the source
  | "not-copied" // the compendium is there, the document is not in the map (N11)
  | "no-art" // the target has no place in the Library (a character, an unknown kind)
  | "package-missing" // the package or compendium of the target is not installed
  | "target-missing" // the compendium is there, a document of that id is not
  | "unresolvable"; // an object key holds a UUID, or `Compendium.` could not be read as one

// The outcomes that a report lists: the reference does not end in an Eagle Compendium.
export const PROBLEM_OUTCOMES: readonly LinkOutcome[] = Object.freeze(["not-copied", "no-art", "package-missing", "target-missing", "unresolvable"]);

export interface LinkReference {
  // Where the reference stands: the fields joined by dots, a number for a place in a list.
  readonly path: string;
  // The main part as it stood (or the text that could not be read).
  readonly uuid: string;
  readonly outcome: LinkOutcome;
  // For `rewritten`: the main part it was rewritten to.
  readonly to?: string;
}

export interface LinkChange {
  readonly path: string;
  readonly from: string;
  readonly to: string;
}

// What the caller knows about a target that is not in the map (the world: M7 fills it from `game.packs`).
export interface TargetInfo {
  readonly installed: boolean;
  // Whether a document of that id is in the compendium (when it is installed).
  readonly exists?: boolean;
  // Whether the Library has no place for it.
  readonly noArt?: boolean;
  // The document type of the compendium (`Item`, `Actor`, …): how a link without a type is written out.
  readonly documentName?: string;
}
export type TargetLookup = (scope: string, pack: string, id: string) => TargetInfo | undefined;

export interface RewriteOptions {
  // The document that is rewritten and its copy: links of the document to itself point at the copy, whatever the map says.
  readonly self?: { readonly source: string; readonly copy: string };
  readonly lookup?: TargetLookup;
}

export interface RewriteResult {
  readonly data: Json;
  readonly changes: readonly LinkChange[];
  readonly references: readonly LinkReference[];
}

type Segment = string | number;

function isSourceField(segments: readonly Segment[]): boolean {
  const named = segments.filter((segment): segment is string => typeof segment === "string").join(".");
  return SOURCE_FIELDS.some((field) => named === field || named.endsWith(`.${field}`));
}

const pathText = (segments: readonly Segment[]): string => segments.join(".");

interface Context {
  readonly map: LinkMap;
  readonly options: RewriteOptions;
  // The document that is rewritten: the key that finds it and the main part of its copy.
  readonly self: { readonly key: string; readonly copy: string } | undefined;
  readonly references: LinkReference[];
  readonly changes: LinkChange[];
}

function classify(parsed: ParsedUuid, options: RewriteOptions): LinkOutcome {
  const info = options.lookup?.(parsed.scope, parsed.pack, parsed.id);
  if (info === undefined) return "not-copied";
  if (!info.installed) return "package-missing";
  if (info.exists === false) return "target-missing";
  if (info.noArt === true) return "no-art";
  return "not-copied";
}

function rewriteText(text: string, segments: readonly Segment[], context: Context): string {
  const found = findUuids(text);
  const path = pathText(segments);
  const excluded = isSourceField(segments);
  let out = "";
  let last = 0;
  for (const parsed of found) {
    const main = text.slice(parsed.start, parsed.end);
    let outcome: LinkOutcome;
    let to: string | undefined;
    if (excluded) {
      outcome = "kept-source";
    } else if (context.self && looseKey(parsed) === context.self.key) {
      to = context.self.copy;
      outcome = "rewritten";
    } else {
      const entry = context.map.lookup(parsed);
      if (entry) {
        to = entry.copy;
        outcome = "rewritten";
      } else if (isLibraryPack(parsed.scope, parsed.pack)) {
        outcome = "in-library";
      } else {
        outcome = classify(parsed, context.options);
      }
    }
    if (outcome === "rewritten" && to !== undefined && to !== main) {
      out += text.slice(last, parsed.start) + to;
      last = parsed.end;
      context.references.push({ path, uuid: main, outcome, to });
    } else {
      context.references.push({ path, uuid: main, outcome: outcome === "rewritten" ? "in-library" : outcome });
    }
  }
  out += text.slice(last);
  // A place that starts with `Compendium.` and was not read as a UUID (not in a field of origin: what stands there stays, N10).
  const unread = excluded ? 0 : countMentions(text) - found.length;
  for (let i = 0; i < unread; i++) {
    const at = nthUnreadStart(text, found, i);
    context.references.push({ path, uuid: text.slice(at, at + 80), outcome: "unresolvable" });
  }
  if (out !== text) context.changes.push({ path, from: text, to: out });
  return out;
}

// The start of the n-th `Compendium.` in a text that is not inside a UUID that was read.
function nthUnreadStart(text: string, found: readonly ParsedUuid[], n: number): number {
  let seen = 0;
  for (let at = text.indexOf("Compendium."); at >= 0; at = text.indexOf("Compendium.", at + 1)) {
    if (found.some((parsed) => at >= parsed.start && at < parsed.end)) continue;
    if (seen++ === n) return at;
  }
  return 0;
}

function walk(value: Json, segments: readonly Segment[], context: Context): Json {
  if (typeof value === "string") return value.includes("Compendium.") ? rewriteText(value, segments, context) : value;
  if (Array.isArray(value)) return value.map((item, index) => walk(item as Json, [...segments, index], context));
  if (typeof value === "object" && value !== null) {
    const out: { [key: string]: Json } = {};
    for (const [key, item] of Object.entries(value as { readonly [key: string]: Json })) {
      if (key.includes("Compendium.")) {
        context.references.push({ path: pathText([...segments, key]).slice(0, 200), uuid: key.slice(0, 80), outcome: "unresolvable" });
      }
      out[key] = walk(item, [...segments, key], context);
    }
    return out;
  }
  return value;
}

// Rewrites every Compendium UUID in the data, in every field and in every text, that the map (or `self`) knows, and says what
// became of every reference. Only the main part of a UUID is changed, always into the form with a type (also an older one); what
// follows it stays as it is. The fields of origin (N10) stay. A reference to something in an Eagle Compendium is left as it is,
// so a second run changes nothing. It never throws and never changes what it is given.
export function rewriteLinks(data: Json, map: LinkMap = EMPTY_LINK_MAP, options: RewriteOptions = {}): RewriteResult {
  const self = options.self ? parsePrimary(options.self.source) : undefined;
  const selfCopy = options.self ? parsePrimary(options.self.copy) : undefined;
  const context: Context = {
    map,
    options,
    self:
      self?.documentName && selfCopy?.documentName
        ? { key: looseKey(self), copy: formatPrimary(selfCopy.scope, selfCopy.pack, selfCopy.documentName, selfCopy.id) }
        : undefined,
    references: [],
    changes: [],
  };
  const rewritten = walk(data, [], context);
  return { data: rewritten, changes: context.changes, references: context.references };
}

// Reads the links of a document without changing them: the report of what does not end in an Eagle Compendium.
export function scanLinks(data: Json, options: Pick<RewriteOptions, "lookup"> = {}): readonly LinkReference[] {
  return rewriteLinks(data, EMPTY_LINK_MAP, options).references;
}

export interface LinkSummary {
  readonly total: number;
  readonly counts: Readonly<Record<LinkOutcome, number>>;
  // The references that do not end in an Eagle Compendium.
  readonly problems: readonly LinkReference[];
}

export function summarizeReferences(references: readonly LinkReference[]): LinkSummary {
  const counts: Record<LinkOutcome, number> = {
    rewritten: 0, "in-library": 0, "kept-source": 0, "not-copied": 0, "no-art": 0, "package-missing": 0, "target-missing": 0, unresolvable: 0,
  };
  for (const reference of references) counts[reference.outcome]++;
  return { total: references.length, counts, problems: references.filter((reference) => PROBLEM_OUTCOMES.includes(reference.outcome)) };
}
