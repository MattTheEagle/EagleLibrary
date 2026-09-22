import { compendiaStatus, createMissingCompendia, type CompendiaStatus, type PackSource, type RequestApi, type SetupLog } from "../core/compendium-setup";
import type { IndexEntry } from "../core/copy";
import { expectedCompendia, type ExpectedCompendium } from "../core/catalog";
import { DEFAULT_VERSION_FILTER, filterEntries, sortEntries, tabsOf, type VersionFilter } from "../core/library-window";

const fields = foundry.applications.fields;

const VERSION_FILTERS: readonly VersionFilter[] = ["2014", "2024", "both"];
// Written out (not built from `version`) so the lang-keys check (`core/lang-keys.test.ts`), which scans the source text
// for literal "EAGLELIBRARY.*" keys, can see all three.
const FILTER_LABEL_KEY: Record<VersionFilter, string> = {
  "2014": "EAGLELIBRARY.window.filter.2014",
  "2024": "EAGLELIBRARY.window.filter.2024",
  both: "EAGLELIBRARY.window.filter.both",
};

const { ApplicationV2 } = foundry.applications.api;
type Tab = foundry.applications.api.ApplicationV2.Tab;
type ChangeTabOptions = foundry.applications.api.ApplicationV2.ChangeTabOptions;
// Foundry core template that renders the tab navigation for the tabs returned by _prepareTabs (UI guide R-04).
const NAV_TEMPLATE = "templates/generic/tab-navigation.hbs";
const TAB_GROUP = "primary";

function text(key: string, data?: Record<string, string>): string {
  const i18n = game.i18n!;
  return data ? i18n.format(key, data) : i18n.localize(key);
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, content?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  return node;
}

// What the window needs, handed in so the class can be built without arguments (the Hub's `open` calls `new
// LibraryApplication()`). Reading a compendium's index and opening a document are the same, direct reads the rest of
// the Library already uses (N9); creating missing compendia still goes through Flight Control, unchanged since M3.
export interface LibraryWindowContext {
  packSource: PackSource;
  api: () => RequestApi | undefined;
  eagleIndex(compendium: ExpectedCompendium): Promise<readonly IndexEntry[] | undefined>;
  openDocument(uuid: string): Promise<void>;
  // Opens the Copy window (milestone M11); the Gamemaster/Assistant check for it lives with the caller, the same way
  // the Hub's own `open` callback checks before ever constructing this window.
  openCopy(): void;
  notify(level: "info" | "warn" | "error", message: string): void;
  log: SetupLog;
}

// The Library window (milestone M10): one tab per Eagle Compendium that exists in the world, in catalog order (rule
// of the acceptance: a tab for every recognized compendium, none for the rest). Built like the Flight Control hub
// (UI guide R-01 to R-04, R-07): an ApplicationV2 without template files, tabs from Foundry's own navigation
// template, DOM built with element calls, never with innerHTML holding data. Only the active tab's entries are read
// when the window opens; switching to another tab reads and fills that one, once, and keeps it for as long as the
// window stays open (a Compendium with a few hundred entries, seen live in M9, would otherwise mean reading and
// building rows for all of them at once).
export function createLibraryApplicationClass(context: LibraryWindowContext) {
  const byName = new Map(expectedCompendia().map((compendium) => [compendium.name, compendium]));

  async function onOpenEntry(_event: PointerEvent, target: HTMLElement): Promise<void> {
    const uuid = target.dataset.uuid;
    if (uuid) await context.openDocument(uuid);
  }

  function onOpenCopy(): void {
    context.openCopy();
  }

  // The search field (milestone M12) filters at every keystroke; wired the same way as the checkboxes of the Copy
  // window (M11): `addEventListener`, not `data-action` (Foundry's action dispatch is for clicks, not `input`).
  function onSearchInput(this: EagleLibraryApplication, event: Event): void {
    this.setQuery((event.currentTarget as HTMLInputElement).value);
  }

  // Switches the version filter (rework 1) and rebuilds the window, the same way "Create missing compendia" already
  // does; the three filters are disjoint (a compendium has exactly one of them), so nothing is read twice.
  async function onSetFilter(this: EagleLibraryApplication, _event: PointerEvent, target: HTMLElement): Promise<void> {
    const version = target.dataset.version;
    if (version === "2014" || version === "2024" || version === "both") {
      this.setFilter(version);
      await this.render();
    }
  }

  // Foundry calls an action handler with the Application instance as `this`; a plain function (not an arrow function,
  // which the Hub avoids for the same reason) is what lets `this.render()` reach the right window.
  async function onCreateMissing(this: EagleLibraryApplication): Promise<void> {
    const report = await createMissingCompendia(context.api(), context.packSource, context.log);
    if (report.failure) {
      context.notify("error", text("EAGLELIBRARY.compendia.failed", { name: report.failure.name, reason: report.failure.reason, detail: report.failure.detail }));
    } else {
      context.notify("info", text("EAGLELIBRARY.compendia.done", { created: String(report.created.length), existed: String(report.existed.length) }));
    }
    if (report.conflicts.length > 0) {
      context.notify("warn", text("EAGLELIBRARY.compendia.conflictWarning", { count: String(report.conflicts.length) }));
    }
    await this.render();
  }

  class EagleLibraryApplication extends ApplicationV2 {
    static override DEFAULT_OPTIONS = {
      id: "eagle-library-window",
      window: { title: "EAGLELIBRARY.compendia.title", icon: "fa-solid fa-book-open", resizable: true },
      position: { width: 720, height: 600 },
      actions: { createMissing: onCreateMissing, openEntry: onOpenEntry, setFilter: onSetFilter, openCopy: onOpenCopy },
    };

    // The tabs whose entries have been read (id -> its entries, or "failed"); read once, kept for the life of the window.
    readonly #loaded = new Map<string, readonly IndexEntry[] | "failed">();
    #status: CompendiaStatus | undefined;
    #readFailed = false;
    #filter: VersionFilter = DEFAULT_VERSION_FILTER;
    // The search text (milestone M12): survives a tab switch, a version-filter switch and "Create missing compendia"
    // (the project lead's decision, u4) — every one of those calls `render()`, which reads it back into a fresh field.
    #query = "";

    // Called by the setFilter action (a plain function outside the class, see above); public so it can reach the
    // private field, the same reason `render()` is public.
    setFilter(filter: VersionFilter): void {
      this.#filter = filter;
    }

    // Called by the search field's `input` listener; rebuilds only the active tab's list from what is already cached
    // (`#loaded`), never rereads the world.
    setQuery(query: string): void {
      this.#query = query;
      const activeId = this.tabGroups[TAB_GROUP];
      if (activeId) this.#renderList(this.element, activeId);
    }

    protected override _prepareTabs(group: string): Record<string, Tab> {
      const existing = new Set((this.#status?.present ?? []).map((compendium) => compendium.name));
      const tabs = tabsOf(existing, this.#filter);
      const stored = this.tabGroups[group];
      const activeId = tabs.some((tab) => tab.id === stored) ? stored : tabs[0]?.id;
      this.tabGroups[group] = activeId as never;
      const result: Record<string, Tab> = {};
      for (const tab of tabs) {
        const active = tab.id === activeId;
        result[tab.id] = { id: tab.id, group, active, cssClass: active ? "active" : "", label: tab.label };
      }
      return result;
    }

    protected override async _renderHTML(): Promise<HTMLElement> {
      this.#loaded.clear();
      try {
        this.#status = compendiaStatus(context.packSource);
        this.#readFailed = false;
      } catch (error) {
        this.#readFailed = true;
        context.log.warn(`eagle-library | the world's compendia could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
      const root = element("div");
      root.classList.add("eagle-library-root");
      if (this.#readFailed || !this.#status) {
        root.append(element("p", text("EAGLELIBRARY.compendia.readFailed")));
        return root;
      }
      root.append(this.#renderStatus(this.#status));
      root.append(this.#renderFilter());
      root.append(this.#renderSearch());

      const tabs = this._prepareTabs(TAB_GROUP);
      const activeId = this.tabGroups[TAB_GROUP] ?? null;
      if (Object.keys(tabs).length === 0) return root;

      const nav = foundry.utils.parseHTML(await foundry.applications.handlebars.renderTemplate(NAV_TEMPLATE, { tabs }));
      if (nav instanceof HTMLElement) root.append(nav);
      else root.append(...Array.from(nav));

      for (const [id, tab] of Object.entries(tabs)) {
        const section = element("section");
        section.classList.add("tab");
        if (tab.active) section.classList.add("active");
        section.dataset.group = TAB_GROUP;
        section.dataset.tab = id;
        root.append(section);
      }
      if (activeId) await this.#fill(root, activeId);
      return root;
    }

    protected override _replaceHTML(result: HTMLElement, content: HTMLElement): void {
      content.replaceChildren(result);
    }

    override changeTab(tab: string, group: string, options?: ChangeTabOptions): void {
      super.changeTab(tab, group, options);
      if (group === TAB_GROUP) void this.#fill(this.element, tab);
    }

    // The three filter buttons (rework 1) and the entry to the Copy window (M11), in one row (Live-Check M11: the
    // project lead asked for the Copy button at the same height as the filter buttons, not its own line above them).
    #renderFilter(): HTMLElement {
      const bar = element("div");
      bar.classList.add("eagle-library-filter");
      for (const version of VERSION_FILTERS) {
        const button = element("button", text(FILTER_LABEL_KEY[version]));
        button.type = "button";
        button.dataset.action = "setFilter";
        button.dataset.version = version;
        if (version === this.#filter) button.classList.add("active");
        bar.append(button);
      }
      // Opens the Copy window (milestone M11): copying from other compendia is a separate concern from browsing what
      // is already here, so it is its own window, not another tab of this one (decision of the project lead) — but
      // its entry point sits in the same row as the filter buttons.
      const copyButton = element("button", text("EAGLELIBRARY.window.openCopy"));
      copyButton.type = "button";
      copyButton.dataset.action = "openCopy";
      bar.append(copyButton);
      return bar;
    }

    // The search field (milestone M12): filters the active tab's list only (the project lead's decision, u1) — no
    // label, a placeholder says what it does, the same minimal-toolbar approach as the filter row above it.
    #renderSearch(): HTMLElement {
      const row = element("div");
      row.classList.add("eagle-library-search");
      const input = fields.createTextInput({ name: "eagle-library-search", value: this.#query });
      input.placeholder = text("EAGLELIBRARY.window.searchPlaceholder");
      input.addEventListener("input", (event) => onSearchInput.call(this, event));
      row.append(input);
      return row;
    }

    // Nothing to say when every compendium already exists: the line only ever named a state that needed no action
    // (rework 2, Live-Check I, F-M10-4). A missing compendium still gets the count and the button below.
    #renderStatus(status: CompendiaStatus): HTMLElement {
      const block = element("div");
      if (status.missing.length > 0) {
        block.append(
          element(
            "p",
            text("EAGLELIBRARY.compendia.status", {
              present: String(status.present.length),
              expected: String(status.expected),
              missing: String(status.missing.length),
            }),
          ),
        );
      }
      if (status.conflicts.length > 0) {
        block.append(element("p", text("EAGLELIBRARY.compendia.conflicts")));
        const list = element("ul");
        for (const { compendium, foundType } of status.conflicts) {
          list.append(element("li", text("EAGLELIBRARY.compendia.conflictItem", { name: compendium.name, found: foundType, expected: compendium.documentName })));
        }
        block.append(list);
      }
      if (status.missing.length > 0) {
        const button = element("button", text("EAGLELIBRARY.compendia.create"));
        button.type = "button";
        button.dataset.action = "createMissing";
        block.append(button);
      }
      return block;
    }

    // Reads a tab's index, once — a later call for the same tab reads nothing again — and shows it. Split from
    // building the list (milestone M12): a search over an already-read tab must be able to rebuild its list without
    // reading the world a second time (AC-M10-05 still holds: `context.eagleIndex` runs at most once per tab).
    async #fill(root: HTMLElement | null, tabId: string): Promise<void> {
      if (!root) return;
      if (!this.#loaded.has(tabId)) {
        const compendium = byName.get(tabId);
        if (!compendium) return;
        let entries: readonly IndexEntry[] | "failed";
        try {
          entries = (await context.eagleIndex(compendium)) ?? [];
        } catch (error) {
          entries = "failed";
          context.log.warn(`eagle-library | ${tabId} could not be read: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.#loaded.set(tabId, entries);
      }
      this.#renderList(root, tabId);
    }

    // Builds one tab's section from what is already cached, filtered by the current search text (milestone M12).
    // Called the first time a tab is read, on every keystroke of the search field, and every time the tab becomes
    // active again (a search from an earlier visit still applies, rule u4) — never reads the world.
    #renderList(root: HTMLElement, tabId: string): void {
      const section = root.querySelector<HTMLElement>(`section[data-tab="${tabId}"]`);
      const compendium = byName.get(tabId);
      const cached = this.#loaded.get(tabId);
      if (!section || !compendium || cached === undefined) return;
      section.replaceChildren();
      if (cached === "failed") {
        section.append(element("p", text("EAGLELIBRARY.compendia.readFailed")));
        return;
      }
      if (cached.length === 0) {
        section.append(element("p", text("EAGLELIBRARY.window.noEntries")));
        return;
      }
      const filtered = filterEntries(cached, this.#query);
      if (filtered.length === 0) {
        section.append(element("p", text("EAGLELIBRARY.window.noMatches", { query: this.#query.trim() })));
        return;
      }
      const list = element("ul");
      for (const entry of sortEntries(filtered)) {
        const item = element("li");
        const button = element("button", entry.name);
        button.type = "button";
        button.dataset.action = "openEntry";
        button.dataset.uuid = `Compendium.world.${compendium.name}.${compendium.documentName}.${entry.id}`;
        item.append(button);
        list.append(item);
      }
      section.append(list);
    }
  }

  return EagleLibraryApplication;
}
