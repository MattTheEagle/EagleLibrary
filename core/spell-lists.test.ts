import { describe, expect, it, vi } from "vitest";
import {
  addPages,
  MAX_SPELL_LIST_PAGES,
  parseSpellLists,
  registerSpellLists,
  serializeSpellLists,
  spellListPagesOf,
  updateSpellLists,
  type SettingStore,
} from "./spell-lists";

const page = (n: number) => `Compendium.world.eagle-journals.JournalEntry.${String(n).padStart(16, "0")}.JournalEntryPage.${"p".padEnd(16, "0")}`;

function makeStore(text = "", failures = 0) {
  const state = { text, failures, writes: 0 };
  const store: SettingStore = {
    read: vi.fn(() => state.text),
    write: vi.fn(async (previous, value) => {
      state.writes++;
      if (state.failures > 0) {
        state.failures--;
        return { ok: false as const, detail: "handler-failed: the setting changed since it was read" };
      }
      if (previous !== state.text) return { ok: false as const, detail: "handler-failed: the setting changed since it was read" };
      state.text = value;
      return { ok: true as const };
    }),
  };
  return { state, store };
}
const log = () => {
  const lines: { level: string; message: string }[] = [];
  return { lines, log: { info: (m: string) => lines.push({ level: "info", message: m }), warn: (m: string) => lines.push({ level: "warn", message: m }) } };
};

describe("the text of the setting", () => {
  it("reads an empty text as no pages and writes no pages as an empty text", () => {
    for (const text of ["", "  ", "\n"]) expect(parseSpellLists(text)).toEqual({ ok: true, pages: [] });
    expect(serializeSpellLists([])).toBe("");
  });

  it("gives back what it wrote", () => {
    expect(parseSpellLists(serializeSpellLists([page(1), page(2)]))).toEqual({ ok: true, pages: [page(1), page(2)] });
  });

  it("does not accept anything that is not a list of pages of version 1, and says what is wrong", () => {
    const bad = ["x", "[]", "5", "null", JSON.stringify({ version: 2, pages: [] }), JSON.stringify({ version: 1 }), JSON.stringify({ version: 1, pages: "x" }), JSON.stringify({ version: 1, pages: [5] })];
    for (const text of bad) expect(parseSpellLists(text), text).toMatchObject({ ok: false, detail: expect.any(String) });
  });
});

describe("addPages", () => {
  it("adds the pages that are not there, in order, and none twice", () => {
    expect(addPages([page(1)], [page(2), page(1), page(3), page(2)])).toEqual([page(1), page(2), page(3)]);
    expect(addPages([], [])).toEqual([]);
  });

  it("keeps at most 200 pages, the newest", () => {
    const held = Array.from({ length: MAX_SPELL_LIST_PAGES }, (_, i) => page(i));
    const out = addPages(held, [page(1000), page(1001)]);
    expect(out).toHaveLength(MAX_SPELL_LIST_PAGES);
    expect(out.slice(-2)).toEqual([page(1000), page(1001)]);
    expect(out[0]).toBe(page(2));
  });

  it("does not change what it was given", () => {
    const held = [page(1)];
    addPages(held, [page(2)]);
    expect(held).toEqual([page(1)]);
  });
});

describe("spellListPagesOf", () => {
  const journal = "Compendium.world.eagle-journals.JournalEntry.AAAAAAAAAAAAAAAA";

  it("gives the UUID, in the copy of the journal, of every page of the type spells", () => {
    const data = { pages: [{ _id: "aaaaaaaaaaaaaaaa", type: "text" }, { _id: "bbbbbbbbbbbbbbbb", type: "spells" }, { _id: "cccccccccccccccc", type: "spells" }] };
    expect(spellListPagesOf(journal, data)).toEqual([`${journal}.JournalEntryPage.bbbbbbbbbbbbbbbb`, `${journal}.JournalEntryPage.cccccccccccccccc`]);
  });

  it("gives none for a journal without such a page, a page without an id, or data that are no journal", () => {
    for (const data of [{ pages: [] }, { pages: [{ type: "spells" }] }, { pages: [{ _id: "", type: "spells" }] }, { name: "x" }, { pages: "x" }, null, "text", 5, [], { pages: [null, 5] }]) {
      expect(spellListPagesOf(journal, data as never), JSON.stringify(data)).toEqual([]);
    }
  });
});

describe("updateSpellLists", () => {
  it("adds pages to the setting, writing what it read", async () => {
    const { state, store } = makeStore(serializeSpellLists([page(1)]));
    expect(await updateSpellLists(store, log().log, [page(2)])).toEqual({ written: true });
    expect(parseSpellLists(state.text)).toEqual({ ok: true, pages: [page(1), page(2)] });
    expect(store.write).toHaveBeenCalledWith(serializeSpellLists([page(1)]), serializeSpellLists([page(1), page(2)]));
  });

  it("writes nothing when the pages are there already", async () => {
    const { store } = makeStore(serializeSpellLists([page(1)]));
    expect(await updateSpellLists(store, log().log, [page(1)])).toEqual({ written: true });
    expect(store.write).not.toHaveBeenCalled();
  });

  it("tries a second time after a failed write, and says so when both fail", async () => {
    const once = makeStore("", 1);
    expect(await updateSpellLists(once.store, log().log, [page(1)])).toEqual({ written: true });
    expect(once.state.writes).toBe(2);
    const both = makeStore("", Infinity);
    const l = log();
    expect(await updateSpellLists(both.store, l.log, [page(1)])).toMatchObject({ written: false, detail: expect.stringContaining("changed since it was read") });
    expect(both.state.writes).toBe(2);
    expect(l.lines.some((line) => line.level === "warn" && line.message.includes("could not be written"))).toBe(true);
  });

  it("replaces text that cannot be read, and the log says so with its beginning", async () => {
    const { state, store } = makeStore("this is not a list");
    const l = log();
    expect(await updateSpellLists(store, l.log, [page(1)])).toEqual({ written: true });
    expect(parseSpellLists(state.text)).toEqual({ ok: true, pages: [page(1)] });
    expect(l.lines.find((line) => line.message.includes("replaced by new ones"))?.message).toContain("this is not a list");
  });

  it("never throws: a read or a write that throws is a failed write", async () => {
    const reading: SettingStore = { read: () => { throw new Error("no setting"); }, write: async () => ({ ok: true }) };
    expect(await updateSpellLists(reading, log().log, [page(1)])).toEqual({ written: false, detail: "no setting" });
    const writing: SettingStore = { read: () => "", write: async () => { throw new Error("no write"); } };
    expect(await updateSpellLists(writing, log().log, [page(1)])).toMatchObject({ written: false, detail: "no write" });
  });
});

describe("registerSpellLists", () => {
  it("registers every page with the registry, in order, and says how many", async () => {
    const register = vi.fn(async () => undefined);
    const l = log();
    expect(await registerSpellLists(serializeSpellLists([page(1), page(2)]), register, l.log)).toEqual({ registered: 2, failed: [] });
    expect(register.mock.calls.map((call) => (call as unknown[])[0])).toEqual([page(1), page(2)]);
    expect(l.lines).toEqual([{ level: "info", message: "eagle-library | spell lists: 2 registered, 0 failed" }]);
  });

  it("names a page that fails and goes on with the others, and throws nothing", async () => {
    const register = vi.fn(async (uuid: string) => {
      if (uuid === page(2)) throw new Error("Journal entry page could not be found");
    });
    const l = log();
    const report = await registerSpellLists(serializeSpellLists([page(1), page(2), page(3)]), register, l.log);
    expect(report).toEqual({ registered: 2, failed: [{ page: page(2), detail: "Journal entry page could not be found" }] });
    expect(register).toHaveBeenCalledTimes(3);
    expect(l.lines.filter((line) => line.level === "warn")).toHaveLength(1);
    expect(l.lines.at(-1)?.message).toBe("eagle-library | spell lists: 2 registered, 1 failed");
  });

  it("does nothing and says nothing for an empty setting, and warns about one that cannot be read", async () => {
    const register = vi.fn(async () => undefined);
    const empty = log();
    expect(await registerSpellLists("", register, empty.log)).toEqual({ registered: 0, failed: [] });
    expect(empty.lines).toEqual([]);
    const broken = log();
    expect(await registerSpellLists("garbage", register, broken.log)).toEqual({ registered: 0, failed: [] });
    expect(broken.lines[0]).toMatchObject({ level: "warn" });
    expect(register).not.toHaveBeenCalled();
  });

  it("names a failure whatever is thrown", async () => {
    const report = await registerSpellLists(serializeSpellLists([page(1)]), async () => { throw "text"; }, log().log);
    expect(report.failed[0]?.detail).toBe("text");
  });
});
