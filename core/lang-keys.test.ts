/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import langRaw from "../v13/lang/en.json?raw";
import manifestRaw from "../v13/module.json?raw";

// Source files that may contain localization keys (tests and declaration files excluded).
const sources = import.meta.glob(["../core/*.ts", "../v13/*.ts", "!../core/*.test.ts", "!../v13/*.d.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function flatten(value: unknown, prefix = ""): Record<string, string> {
  if (typeof value !== "object" || value === null) return { [prefix]: String(value) };
  const result: Record<string, string> = {};
  for (const [key, child] of Object.entries(value)) {
    Object.assign(result, flatten(child, prefix ? `${prefix}.${key}` : key));
  }
  return result;
}

// The placeholders of a text: {name}.
const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "").sort();

describe("localization keys", () => {
  const translations = flatten(JSON.parse(langRaw));
  const used = new Set<string>();
  for (const text of Object.values(sources)) {
    for (const match of text.matchAll(/EAGLELIBRARY(?:\.[A-Za-z0-9_]+)+/g)) used.add(match[0]);
  }

  it("has a non-empty English text for every EAGLELIBRARY.* key used in code, and the manifest points at the file", () => {
    expect(used.size, "no EAGLELIBRARY.* keys found in the sources").toBeGreaterThan(0);
    for (const key of used) expect(translations[key], `missing or empty text for ${key}`).toBeTruthy();

    const manifest = JSON.parse(manifestRaw) as { languages?: Array<{ lang: string; path: string }> };
    expect(manifest.languages).toContainEqual(expect.objectContaining({ lang: "en", path: "lang/en.json" }));
  });

  it("has no text that the code does not use", () => {
    for (const key of Object.keys(translations)) expect(used.has(key), `unused text ${key}`).toBe(true);
  });

  it("gives the placeholders that the code fills in for the texts that have them", () => {
    // Both UI files (`library-application.ts` and, since M11, `copy-application.ts`) may hold a key with a placeholder.
    const code = Object.values(sources).join("\n");
    const expected: Record<string, string[]> = {
      "EAGLELIBRARY.compendia.status": ["expected", "missing", "present"],
      "EAGLELIBRARY.compendia.conflictItem": ["expected", "found", "name"],
      "EAGLELIBRARY.compendia.done": ["created", "existed"],
      "EAGLELIBRARY.compendia.failed": ["detail", "name", "reason"],
      "EAGLELIBRARY.compendia.conflictWarning": ["count"],
      "EAGLELIBRARY.window.noMatches": ["query"],
      "EAGLELIBRARY.copy.protocolEntry": ["name", "reason"],
      "EAGLELIBRARY.copy.reportIntro": ["count"],
      "EAGLELIBRARY.copy.planSummary": ["alreadyCopied", "documents", "duplicates", "total"],
      "EAGLELIBRARY.copy.resultSummary": ["alreadyCopied", "copied", "duplicates", "failed"],
      "EAGLELIBRARY.copy.confirmTitle": ["count"],
      "EAGLELIBRARY.copy.notify.protocolReadFailed": ["detail"],
      "EAGLELIBRARY.copy.notify.forced": ["name"],
      "EAGLELIBRARY.copy.notify.forceFailed": ["detail", "reason"],
    };
    for (const [key, names] of Object.entries(expected)) {
      expect(placeholders(translations[key] ?? ""), key).toEqual(names);
      expect(code, key).toContain(key);
    }
    // the other texts have no placeholder
    for (const key of Object.keys(translations).filter((candidate) => !(candidate in expected))) {
      expect(placeholders(translations[key] ?? ""), key).toEqual([]);
    }
  });
});
