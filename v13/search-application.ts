import { searchAll, uuidOf, type IndexedEntry } from "../core/search-window";
import type { SetupLog } from "../core/compendium-setup";

const fields = foundry.applications.fields;

function text(key: string, data?: Record<string, string>): string {
  const i18n = game.i18n!;
  return data ? i18n.format(key, data) : i18n.localize(key);
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, content?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  return node;
}

// What the overlay needs, handed in so the class can be built without arguments (the keybinding callback in
// `v13/module.ts` calls `new SearchApplication()`). The index itself is built and cached outside this window (Apply
// section C/J): a fresh overlay instance every open (the same choice M11's Copy window already made, R3 there) would
// otherwise mean reading every Eagle Compendium again on every keystroke of the shortcut.
export interface SearchWindowContext {
  index(): Promise<readonly IndexedEntry[]>;
  openDocument(uuid: string): Promise<void>;
  log: SetupLog;
}

// Sets the native Foundry drag data (milestone M13, Discover f5): `{ type, uuid }` is the minimal form
// `ClientDocument#toDragData` produces for a UUID, and a synchronous object built from what the index already holds
// (no `fromUuid` needed) — `dataTransfer.setData` must run synchronously inside `dragstart`, an async lookup would
// not reliably reach it in time.
function onDragStart(event: DragEvent, entry: IndexedEntry): void {
  event.dataTransfer?.setData("text/plain", JSON.stringify({ type: entry.documentName, uuid: uuidOf(entry) }));
}

// The cross-compendium search overlay (milestone M13): a frameless `ApplicationV2` a keybinding opens from anywhere
// in Foundry (UI guide rules R-03, R-07, R-09 still apply; R-01/R-02, about a framed window's title and icon, do
// not — there is no frame). Typing searches every Eagle Compendium's already-built index (Apply section C: built
// once, on first use, then kept for the session by the caller); arrow keys move the selection, Enter opens the
// selected entry's sheet, Escape or a click outside closes it, and a result row is a native drag source.
export function createSearchApplicationClass(context: SearchWindowContext) {
  const { ApplicationV2 } = foundry.applications.api;

  async function onOpenEntry(this: EagleSearchApplication, _event: PointerEvent, target: HTMLElement): Promise<void> {
    const uuid = target.dataset.uuid;
    if (!uuid) return;
    await context.openDocument(uuid);
    await this.close();
  }

  function onSearchInput(this: EagleSearchApplication, event: Event): void {
    this.setQuery((event.currentTarget as HTMLInputElement).value);
  }

  function onSearchKeyDown(this: EagleSearchApplication, event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      void this.close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      this.moveSelection(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      this.moveSelection(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      void this.openSelected();
    }
  }

  class EagleSearchApplication extends ApplicationV2 {
    static override DEFAULT_OPTIONS = {
      id: "eagle-library-search",
      // `positioned: false` (live fund, Live-Check M13 Runde 1: the position stayed centered no matter what
      // `v13/styles/eagle-library.css` said) — by default Foundry places a positioned Application with its own
      // inline style, which always wins over an external stylesheet; turning that off hands placement fully to CSS.
      window: { frame: false, positioned: false },
      position: { width: 480 },
      actions: { openEntry: onOpenEntry },
    };

    #query = "";
    // Built once per overlay instance, from the caller's cache (Apply section C) — undefined until the first load
    // finishes, so the overlay can show something before it does.
    #index: readonly IndexedEntry[] | undefined;
    #results: readonly IndexedEntry[] = [];
    #selected = 0;
    #resultsList: HTMLElement | undefined;
    #inputEl: HTMLInputElement | undefined;
    #outsideClick = (event: PointerEvent): void => {
      if (this.element && !this.element.contains(event.target as Node)) void this.close();
    };

    protected override async _renderHTML(): Promise<HTMLElement> {
      const root = element("div");
      root.classList.add("eagle-search-root");
      const input = fields.createTextInput({ name: "eagle-library-search-query", value: this.#query });
      input.placeholder = text("EAGLELIBRARY.search.placeholder");
      input.addEventListener("input", (event) => onSearchInput.call(this, event));
      input.addEventListener("keydown", (event) => onSearchKeyDown.call(this, event as KeyboardEvent));
      this.#inputEl = input;
      root.append(input);

      const results = element("ul");
      results.classList.add("eagle-search-results");
      this.#resultsList = results;
      root.append(results);

      if (this.#index === undefined) void this.#loadIndex();
      this.#renderResults();
      return root;
    }

    protected override _replaceHTML(result: HTMLElement, content: HTMLElement): void {
      content.replaceChildren(result);
    }

    protected override async _onRender(): Promise<void> {
      document.addEventListener("pointerdown", this.#outsideClick);
      this.#inputEl?.focus?.();
    }

    protected override _onClose(): void {
      document.removeEventListener("pointerdown", this.#outsideClick);
    }

    async #loadIndex(): Promise<void> {
      try {
        this.#index = await context.index();
      } catch (error) {
        this.#index = [];
        context.log.warn(`eagle-library | the search index could not be built: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.#results = searchAll(this.#index, this.#query);
      this.#renderResults();
    }

    // Called by the search field's `input` listener; rebuilds only the results list, never the whole overlay (the
    // input would lose focus otherwise — the same lesson M12 already drew for the Library window's search field).
    setQuery(query: string): void {
      this.#query = query;
      this.#selected = 0;
      this.#results = this.#index === undefined ? [] : searchAll(this.#index, query);
      this.#renderResults();
    }

    moveSelection(delta: number): void {
      if (this.#results.length === 0) return;
      this.#selected = (this.#selected + delta + this.#results.length) % this.#results.length;
      this.#renderResults();
    }

    async openSelected(): Promise<void> {
      const entry = this.#results[this.#selected];
      if (!entry) return;
      await context.openDocument(uuidOf(entry));
      await this.close();
    }

    #renderResults(): void {
      const list = this.#resultsList;
      if (!list) return;
      list.replaceChildren();
      if (this.#index === undefined) {
        list.append(element("li", text("EAGLELIBRARY.search.loading")));
        return;
      }
      if (this.#results.length === 0) {
        const empty = this.#query.trim() === "" ? text("EAGLELIBRARY.search.hint") : text("EAGLELIBRARY.window.noMatches", { query: this.#query.trim() });
        list.append(element("li", empty));
        return;
      }
      this.#results.forEach((entry, index) => {
        const item = element("li");
        if (index === this.#selected) item.classList.add("active");
        const row = element("div", `${entry.name} — ${entry.label}`);
        row.dataset.action = "openEntry";
        row.dataset.uuid = uuidOf(entry);
        row.setAttribute("draggable", "true");
        row.addEventListener("dragstart", (event) => onDragStart(event as DragEvent, entry));
        item.append(row);
        list.append(item);
      });
    }
  }

  return EagleSearchApplication;
}
