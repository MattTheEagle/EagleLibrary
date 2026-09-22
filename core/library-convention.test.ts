/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import conventionRaw from "../docs/library-convention.md?raw";
import setupRaw from "./compendium-setup.ts?raw";
import copyRaw from "./copy.ts?raw";
import { SOURCE_FIELDS, PROBLEM_OUTCOMES } from "./rewrite-links";
import { MAX_CHANGES_PER_ENTRY } from "./copy";
import { MAX_REPORTED_PROBLEMS } from "./relink";
import { MAX_SPELL_LIST_PAGES } from "./spell-lists";
import { DEFAULT_MAX_CLOSURE_DOCUMENTS, MAX_DOCUMENTS_PER_PORTION } from "./closure";
import { SUBSPECIES_PATH } from "./subspecies";
import spellRaw from "./spell-lists.ts?raw";
import rewriteRaw from "./rewrite-links.ts?raw";
import uuidRaw from "./uuid.ts?raw";
import nameKeyRaw from "./name-key.ts?raw";
import protocolRaw from "./protocol.ts?raw";
import { MAX_EXISTING_PER_ENTRY, MAX_PROTOCOL_ENTRIES, MAX_PROTOCOL_LENGTH, PROTOCOL_REASONS } from "./protocol";
import readmeRaw from "../README.md?raw";
import { MAX_CONTAINER_DEPTH, MAX_DOCUMENTS_PER_COPY } from "./copy";
import { CATALOG, expectedCompendia } from "./catalog";
import { LIBRARY_ID } from "./index";
import bulkRaw from "./bulk.ts?raw";
import { DEFAULT_MAX_CONSECUTIVE_FAILURES } from "./bulk";

// docs/library-convention.md is what authors of other modules will rely on. These tests hold it against the code it
// describes: a name, a label or a count that changes on one side and not on the other fails here.

const convention = conventionRaw;
const tableRows = convention.split("\n").filter((line) => line.startsWith("| `eagle-"));

describe("docs/library-convention.md", () => {
  it("lists each of the 34 compendia once, with label, document type, subtype and version", () => {
    expect(tableRows).toHaveLength(34);
    const compendia = expectedCompendia();
    for (const compendium of compendia) {
      const row = tableRows.filter((line) => line.startsWith(`| \`${compendium.name}\` |`));
      expect(row, compendium.name).toHaveLength(1);
      const cells = (row[0] ?? "").split("|").map((cell) => cell.trim()).filter((cell) => cell !== "");
      expect(cells).toEqual([
        `\`${compendium.name}\``,
        compendium.label,
        compendium.documentName,
        compendium.entry.subtype ? `\`${compendium.entry.subtype}\`` : "—",
        compendium.version ?? "—",
      ]);
    }
  });

  it("names no compendium the code does not know", () => {
    // The id of the Library module is not a compendium, and the document names it (rule R9).
    const known = new Set([...expectedCompendia().map((compendium) => compendium.name), LIBRARY_ID]);
    const mentioned = [...convention.matchAll(/`(eagle-[a-z0-9-]+)`/g)].map((match) => match[1] ?? "");
    expect(mentioned.length).toBeGreaterThanOrEqual(34);
    for (const name of mentioned) expect(known.has(name), name).toBe(true);
  });

  it("states the counts of the catalog", () => {
    expect(convention).toContain(`There are ${CATALOG.length} kinds.`);
    expect(convention).toContain(`which makes ${expectedCompendia().length} compendia.`);
  });

  it("gives a source for each rule", () => {
    const rules = convention.split("\n").filter((line) => /^\| R\d+ \|/.test(line));
    expect(rules).toHaveLength(19);
    for (const rule of rules) {
      const cells = rule.split("|").map((cell) => cell.trim());
      // ["", "R1", "rule text", "source", ""]
      expect(cells[3]?.length ?? 0, cells[1]).toBeGreaterThan(10);
    }
  });

  it("marks the ruleset version and the index behaviour as unverified", () => {
    expect(convention).toContain("## 3. Unverified");
    expect(convention).toContain("no value for `system.source.rules`");
  });

  it("states the name of a forced copy the way the code builds it", () => {
    expect(convention).toContain("`X (Duplicate)` becomes `X (Duplicate 1)`");
    expect(convention).toContain("`X (Duplicate 4)` becomes `X (Duplicate 5)`");
    expect(convention).toContain("`X` becomes `X (Duplicate)`");
  });

  it("names the request that makes the compendia, and the payload, the way the code asks", () => {
    expect(setupRaw).toContain('type: "compendium.create"');
    expect(setupRaw).toContain("version: 1,");
    expect(setupRaw).toContain("payload: { type: compendium.documentName, label: compendium.label, name }");
    expect(convention).toContain("`compendium.create` (`{ type, label, name }`");
    expect(convention).toContain("as the module `eagle-library`");
    expect(convention).toContain('the button "Create missing compendia"');
  });

  it("states rule R10 (copying one document) the way the code does it", () => {
    const r10 = convention.split("\n").find((line) => line.startsWith("| R10 |")) ?? "";
    expect(r10).not.toBe("");
    expect(copyRaw).toContain('type: "compendium.import", version: 1, payload: { pack, sources }');
    expect(r10).toContain("`compendium.import` (`{ pack, sources }`");
    expect(r10).toContain(`at most ${MAX_CONTAINER_DEPTH} levels deep`);
    expect(r10).toContain(`at most ${MAX_DOCUMENTS_PER_COPY} documents in all`);
    for (const reason of ["no-art", "already-copied", "duplicate", "no-target"]) {
      expect(r10, reason).toContain(`\`${reason}\``);
      expect(copyRaw, reason).toContain(`"${reason}"`);
    }
    expect(r10).toContain("**A container brings everything in it**");
    expect(r10).toContain('`game.modules.get("eagle-library").api.copyDocument(uuid)`');
  });

  it("states rules R5, R11 and R12 the way the code does them", () => {
    const row = (name: string) => convention.split("\n").find((line) => line.startsWith(`| ${name} |`)) ?? "";
    expect(row("R5")).toContain("**The key is the pair of the name key (R7) and the requirements key**");
    expect(row("R5")).toContain("29 of the 67");
    expect(nameKeyRaw).toContain("export function requirementsKey");
    const r11 = row("R11");
    for (const reason of PROTOCOL_REASONS) expect(r11, reason).toContain(`\`${reason}\``);
    expect(r11).toContain(`At most ${MAX_PROTOCOL_ENTRIES} entries and ${MAX_PROTOCOL_LENGTH.toLocaleString("en-US")} characters`);
    expect(r11).toContain("`eagle-library.protocol`");
    expect(r11).toContain("at most " + MAX_EXISTING_PER_ENTRY + ")");
    expect(protocolRaw).toContain('PROTOCOL_STATUSES = ["open", "copied", "forced"]');
    for (const status of ["open", "copied", "forced"]) expect(r11, status).toContain(`\`${status}\``);
    const r12 = row("R12");
    expect(r12).toContain("`copyDocument(uuid, { force: true, version })`");
    expect(r12).toContain("`version-required`");
    expect(copyRaw).toContain('"version-required"');
    expect(r12).toContain("`system.container`");
  });

  it("states rule R13 (rewriting links) the way the code does it", () => {
    const r13 = convention.split("\n").find((line) => line.startsWith("| R13 |")) ?? "";
    expect(r13).not.toBe("");
    for (const field of SOURCE_FIELDS) expect(r13, field).toContain(`\`${field}\``);
    expect(r13).toContain("`effects[].origin` is rewritten");
    for (const outcome of PROBLEM_OUTCOMES) expect(r13, outcome).toContain(`\`${outcome}\``);
    for (const how of ["copied", "existing", "planned"]) expect(r13, how).toContain(`\`${how}\``);
    expect(r13).toContain("`Compendium.<package>.<compendium>.<type>.<id>`");
    expect(r13).toContain("`Compendium.<package>.<compendium>.<id>`");
    expect(uuidRaw).toContain("Compendium\\\\.(${NAME})\\\\.(${NAME})\\\\.(?:(${DOCUMENT_NAMES.join(\"|\")})\\\\.)?(${ID})");
    expect(rewriteRaw).toContain("export function rewriteLinks");
    expect(r13).toContain("a second run changes nothing");
  });

  it("states rules R14 (links when a document is copied) and R15 (spell lists) the way the code does them", () => {
    const row = (name: string) => convention.split("\n").find((line) => line.startsWith(`| ${name} |`)) ?? "";
    const r14 = row("R14");
    expect(r14).toContain(`at most ${MAX_CHANGES_PER_ENTRY} paths for an entry`);
    expect(r14).toContain(`at most ${MAX_REPORTED_PROBLEMS} \`problems\``);
    for (const word of ["`copied`", "`existing`", "`not-copied`", "`no-art`", "`package-missing`", "`target-missing`", "`compendium.import`", "`api.checkLinks(uuid)`", "the **whole list**"]) expect(r14, word).toContain(word);
    expect(copyRaw).toContain(`MAX_CHANGES_PER_ENTRY = ${MAX_CHANGES_PER_ENTRY}`);
    const r15 = row("R15");
    expect(r15).toContain("`eagle-library.spell-lists`");
    expect(r15).toContain(`at most ${MAX_SPELL_LIST_PAGES}`);
    expect(r15).toContain("`dnd5e.registry.spellLists.register(uuid)`");
    expect(r15).toContain("**A module that shows spell lists filters them to the spells of the Library.**");
    expect(r15).toContain("`spellLists: { written: false }`");
    expect(spellRaw).toContain('page.type === "spells"');
    expect(spellRaw).toContain("JournalEntryPage");
  });

  it("states rules R16 to R18 (origin, closure, subspecies) the way the code does them", () => {
    const row = (name: string) => convention.split("\n").find((line) => line.startsWith(`| ${name} |`)) ?? "";
    const r16 = row("R16");
    for (const field of ["_stats.compendiumSource", "_stats.duplicateSource", "flags.core.sourceId", "flags.dnd5e.sourceId"]) expect(r16, field).toContain(field);
    const r17 = row("R17");
    expect(r17).toContain(`at most ${MAX_DOCUMENTS_PER_PORTION} documents`);
    expect(r17).toContain(`(default ${DEFAULT_MAX_CLOSURE_DOCUMENTS.toLocaleString("en-US")})`);
    for (const word of ["`closure-too-large`", "`{ closure: false }`", "`api.plan(uuid, options)`", "`already-copied`", "`existing`"]) expect(r17, word).toContain(word);
    expect(copyRaw).toContain('"closure-too-large"');
    const r18 = row("R18");
    expect(r18).toContain(`\`${SUBSPECIES_PATH}`);
    for (const word of ["`api.setSubspeciesMarker(uuid, species)`", "`compendium.flag`", "Half-Elf"]) expect(r18, word).toContain(word);
  });

  it("states rule R19 (copying many at once) the way the code does it", () => {
    const r19 = convention.split("\n").find((line) => line.startsWith("| R19 |")) ?? "";
    expect(r19).not.toBe("");
    expect(bulkRaw).toContain("export async function copyCompendia");
    expect(bulkRaw).toContain("export async function planCompendia");
    expect(r19).toContain("`copyCompendia(selection)`");
    expect(r19).toContain("`planCompendia(selection)`");
    expect(r19).toContain(`default ${DEFAULT_MAX_CONSECUTIVE_FAILURES}`);
    expect(bulkRaw).toContain(`DEFAULT_MAX_CONSECUTIVE_FAILURES = ${DEFAULT_MAX_CONSECUTIVE_FAILURES}`);
    for (const word of ["`{ maxConsecutiveFailures }`", '`stoppedReason: "consecutive-failures"`', '`stoppedReason: "aborted"`', "`already-copied`", "`{ onProgress }`"]) {
      expect(r19, word).toContain(word);
    }
    expect(bulkRaw).toContain('stoppedReason = "consecutive-failures"');
    expect(bulkRaw).toContain('stoppedReason = "aborted"');
  });

  it("lists in the README every reason a copy can fail with, the ones of the code and no other", () => {
    const codeReasons = [...(copyRaw.match(/export type CopyFailureReason =([^;]+);/s)?.[1] ?? "").matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
    expect(codeReasons.length).toBeGreaterThan(10);
    const readmeReasons = readmeRaw.match(/\(`reason`: ([^)]+)\)/s)?.[1] ?? "";
    expect([...readmeReasons.matchAll(/`([a-z-]+)`/g)].map((m) => m[1])).toEqual(codeReasons);
    expect(readmeRaw).toContain("Änderungen an diesem Einstieg\n  sind seit M14 Vertragsänderungen");
  });
});
