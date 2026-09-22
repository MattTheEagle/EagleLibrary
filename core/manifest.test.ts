/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import packageRaw from "../package.json?raw";
import manifestRaw from "../v13/module.json?raw";
import { FLIGHT_CONTROL_ID, FLIGHT_CONTROL_MIN_MODULE_VERSION } from "./flight-control";
import { LIBRARY_ID } from "./index";

// The manifest is what Foundry installs from, so the release files must agree with it. `npm run package` checks the
// same rules again when it builds the release.
interface Manifest {
  id: string;
  title: string;
  description: string;
  version: string;
  authors: { name: string }[];
  compatibility: { minimum: string; verified: string };
  relationships?: { requires?: { id: string; type: string; compatibility: { minimum: string } }[] };
  esmodules: string[];
  languages?: { lang: string; name: string; path: string }[];
  styles?: string[];
}

interface PackageJson {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

const manifest = JSON.parse(manifestRaw) as Manifest;
const pack = JSON.parse(packageRaw) as PackageJson;

describe("module manifest", () => {
  it("names the module and gives it a release version", () => {
    expect(manifest.id).toBe(LIBRARY_ID);
    expect(manifest.title).toBe("Eagle Library");
    expect(manifest.version).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  });

  it("loads the bundle, which is the file of the release", () => {
    expect(manifest.esmodules).toEqual(["dist/module.js"]);
  });

  it("is written for Foundry 13 only", () => {
    expect(manifest.compatibility).toEqual({ minimum: "13", verified: "13" });
  });

  it("requires Flight Control from the release that first provides the API it registers with", () => {
    // Contract, section 6.
    expect(manifest.relationships?.requires).toEqual([
      { id: FLIGHT_CONTROL_ID, type: "module", compatibility: { minimum: FLIGHT_CONTROL_MIN_MODULE_VERSION } },
    ]);
  });

  it("names no address and no download, because there is no repository", () => {
    for (const field of ["url", "bugs", "manifest", "download"]) {
      expect(manifest, field).not.toHaveProperty(field);
    }
  });

  it("names its English language file, because the module has texts since M3", () => {
    expect(manifest.languages).toEqual([{ lang: "en", name: "English", path: "lang/en.json" }]);
  });

  it("names its stylesheet, because the Library window has scoped CSS since the M10 rework", () => {
    expect(manifest.styles).toEqual(["styles/eagle-library.css"]);
  });

  it("has no placeholder text left", () => {
    expect(manifest.authors.length).toBeGreaterThan(0);
    for (const author of manifest.authors) {
      expect(author.name.trim()).not.toBe("");
      expect(author.name.toLowerCase()).not.toBe("projektleiter");
    }
    expect(manifest.description.trim()).not.toBe("");
    expect(manifest.description).not.toMatch(/in entwicklung/i);
  });
});

describe("package.json", () => {
  it("has the id and the version of the manifest", () => {
    expect(pack.name).toBe(manifest.id);
    expect(pack.version).toBe(manifest.version);
  });

  it("stays private, adds no dependency and offers the package script", () => {
    expect(pack.private).toBe(true);
    expect(pack.dependencies).toBeUndefined();
    expect(Object.keys(pack.devDependencies ?? {}).sort()).toEqual(["esbuild", "typescript", "vitest"]);
    expect(pack.scripts?.package).toBe("node v13/package.mjs");
  });
});
