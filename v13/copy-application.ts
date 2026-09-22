import type { BulkCopyOptions, BulkCopyResult, BulkLinkGap, BulkPlanOptions, BulkPlanResult, BulkProgressInfo, BulkSelection } from "../core/bulk";
import type { CopyOptions, CopyResult } from "../core/copy";
import type { ProtocolEntry, ProtocolRead } from "../core/protocol";
import { allSelected, formatProgress, kindIsVersioned, progressFraction, protocolRows, sortPacks, type PackRow, type ProtocolRow } from "../core/copy-window";
import type { RulesVersion } from "../core/rules-version";

function text(key: string, data?: Record<string, string>): string {
  const i18n = game.i18n!;
  return data ? i18n.format(key, data) : i18n.localize(key);
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, content?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  return node;
}

// What the window needs, handed in so the class can be built without arguments (`v13/library-application.ts`'s new
// "Copy from other compendia…" button calls `new CopyApplication()`). All of it wraps existing, unchanged logic
// (`core/bulk.ts` since M9, `core/copy.ts` since M5) — this window adds no new way of copying, only a face for it.
export interface CopyWindowContext {
  listPacks(): Promise<readonly PackRow[]>;
  plan(selection: BulkSelection, options: BulkPlanOptions): Promise<BulkPlanResult>;
  copy(selection: BulkSelection, options: BulkCopyOptions): Promise<BulkCopyResult>;
  protocolOf(): ProtocolRead;
  clearProtocol(): Promise<{ written: boolean; detail?: string }>;
  force(uuid: string, options: CopyOptions): Promise<CopyResult>;
  openDocument(uuid: string): Promise<void>;
  notify(level: "info" | "warn" | "error", message: string): void;
}

// Asks whether to really start a run over `count` compendia (Apply section D: a confirmation, no exact count computed
// first — that would mean the multi-minute dry run of a large selection before every single confirmation).
async function confirmStart(count: number): Promise<boolean> {
  // DialogV2 insists on a <div> as `content` (confirmed live, 2026-09-22: a <p> throws "config.content must be
  // <div> element"); the text itself still goes into a child <p>, as the removed M3-era dialog already did it.
  const content = element("div");
  content.append(element("p", text("EAGLELIBRARY.copy.confirmTitle", { count: String(count) })));
  const choice = await foundry.applications.api.DialogV2.wait({
    window: { title: text("EAGLELIBRARY.copy.title") },
    content,
    buttons: [
      { action: "start", label: text("EAGLELIBRARY.copy.confirmStart"), icon: "fa-solid fa-copy", default: true },
      { action: "cancel", label: text("EAGLELIBRARY.copy.confirmCancel"), icon: "fa-solid fa-xmark" },
    ],
    rejectClose: false,
  });
  return choice === "start";
}

// Asks which ruleset version a forced duplicate goes to (Apply section H, convention R12: the Gamemaster's choice, no
// default). `undefined` if the dialog was closed without a choice.
async function confirmVersion(): Promise<RulesVersion | undefined> {
  const choice = await foundry.applications.api.DialogV2.wait({
    window: { title: text("EAGLELIBRARY.copy.versionTitle") },
    content: element("div"),
    buttons: [
      { action: "2014", label: "2014" },
      { action: "2024", label: "2024" },
    ],
    rejectClose: false,
  });
  return choice === "2014" || choice === "2024" ? choice : undefined;
}

export function createCopyApplicationClass(context: CopyWindowContext) {
  const { ApplicationV2 } = foundry.applications.api;

  async function onTogglePack(this: EagleCopyApplication, event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const collection = input.dataset.collection;
    if (!collection) return;
    this.setSelected(collection, input.checked);
  }

  async function onToggleAll(this: EagleCopyApplication, event: Event): Promise<void> {
    const checked = (event.currentTarget as HTMLInputElement).checked;
    this.setAllSelected(checked);
  }

  async function onPreview(this: EagleCopyApplication): Promise<void> {
    await this.run("plan");
  }

  async function onStart(this: EagleCopyApplication): Promise<void> {
    const count = this.selectedCount();
    if (count === 0) {
      context.notify("warn", text("EAGLELIBRARY.copy.notify.noneSelected"));
      return;
    }
    if (!(await confirmStart(count))) return;
    await this.run("copy");
  }

  function onCancel(this: EagleCopyApplication): void {
    this.cancelRun();
  }

  async function onToggleProtocol(this: EagleCopyApplication): Promise<void> {
    await this.toggleProtocol();
  }

  async function onClearProtocol(this: EagleCopyApplication): Promise<void> {
    await this.clearProtocol();
  }

  async function onToggleReport(this: EagleCopyApplication): Promise<void> {
    await this.toggleReport();
  }

  async function onOpenEntry(_event: PointerEvent, target: HTMLElement): Promise<void> {
    const uuid = target.dataset.uuid;
    if (uuid) await context.openDocument(uuid);
  }

  async function onForce(this: EagleCopyApplication, _event: PointerEvent, target: HTMLElement): Promise<void> {
    await this.forceEntry(target.dataset.uuid, target.dataset.kind ?? null, target.dataset.name ?? "");
  }

  class EagleCopyApplication extends ApplicationV2 {
    static override DEFAULT_OPTIONS = {
      id: "eagle-copy-window",
      window: { title: "EAGLELIBRARY.copy.title", icon: "fa-solid fa-copy", resizable: true },
      position: { width: 560, height: 640 },
      actions: {
        preview: onPreview,
        start: onStart,
        cancel: onCancel,
        toggleProtocol: onToggleProtocol,
        clearProtocol: onClearProtocol,
        toggleReport: onToggleReport,
        openEntry: onOpenEntry,
        force: onForce,
      },
    };

    #packs: readonly PackRow[] = [];
    readonly #selected = new Set<string>();
    #running: "copy" | "plan" | false = false;
    #controller: AbortController | undefined;
    #lastPlan: BulkPlanResult | undefined;
    #lastResult: BulkCopyResult | undefined;
    #protocolRows: readonly ProtocolRow[] | undefined;
    #showReport = false;
    #readFailed = false;

    // References kept from the render that made them (not looked up again by a CSS selector): every input and button
    // this window ever needs to change the state of after the fact, without a full rebuild.
    #packInputs: readonly HTMLInputElement[] = [];
    #selectAllInput: HTMLInputElement | undefined;
    #startButton: HTMLButtonElement | undefined;
    #previewButton: HTMLButtonElement | undefined;
    #cancelButton: HTMLButtonElement | undefined;

    setSelected(collection: string, on: boolean): void {
      if (on) this.#selected.add(collection);
      else this.#selected.delete(collection);
      if (this.#selectAllInput) this.#selectAllInput.checked = allSelected(this.#packs, this.#selected);
    }

    setAllSelected(on: boolean): void {
      this.#selected.clear();
      if (on) for (const pack of this.#packs) this.#selected.add(pack.collection);
      for (const input of this.#packInputs) input.checked = on;
    }

    selectedCount(): number {
      return this.#selected.size;
    }

    cancelRun(): void {
      this.#controller?.abort();
    }

    async run(kind: "copy" | "plan"): Promise<void> {
      const selection = [...this.#selected];
      const controller = new AbortController();
      this.#controller = controller;
      this.#running = kind;
      this.#setRunningUi(true);
      const notification = ui.notifications?.info(text(kind === "copy" ? "EAGLELIBRARY.copy.progressCopying" : "EAGLELIBRARY.copy.progressPlanning"), { progress: true });
      // `ui.notifications.update` (not the notification's own `update`, whose type only takes a bare number) accepts
      // both the percentage and the message together (Discover f9).
      const onProgress = (info: BulkProgressInfo) => {
        if (notification) ui.notifications?.update(notification, { pct: progressFraction(info), message: formatProgress(info) });
      };
      try {
        if (kind === "copy") {
          this.#lastResult = await context.copy(selection, { onProgress, signal: controller.signal });
          this.#lastPlan = undefined;
        } else {
          this.#lastPlan = await context.plan(selection, { onProgress, signal: controller.signal });
        }
      } finally {
        this.#running = false;
        this.#controller = undefined;
        this.#setRunningUi(false);
        await this.render();
      }
    }

    async toggleProtocol(): Promise<void> {
      if (this.#protocolRows) {
        this.#protocolRows = undefined;
      } else {
        this.#protocolRows = this.#readProtocol();
      }
      await this.render();
    }

    async clearProtocol(): Promise<void> {
      const cleared = await context.clearProtocol();
      if (!cleared.written) {
        context.notify("error", text("EAGLELIBRARY.copy.notify.protocolReadFailed", { detail: cleared.detail ?? "" }));
      } else if (this.#protocolRows) {
        // Not a re-read (Live-Check M11, F-M11-2): this client's own `game.settings.get()` did not reliably reflect
        // its own just-finished write to a world setting within the same session (confirmed live — only a full world
        // reload showed the change otherwise, even after hiding and showing the view again). We already know the
        // outcome of the write we just made, so the view is updated from that instead of asking the setting again.
        this.#protocolRows = [];
      }
      await this.render();
    }

    async toggleReport(): Promise<void> {
      this.#showReport = !this.#showReport;
      await this.render();
    }

    async forceEntry(uuid: string | undefined, kind: string | null, name: string): Promise<void> {
      if (!uuid) return;
      let version: RulesVersion | undefined;
      if (kindIsVersioned(kind)) {
        version = await confirmVersion();
        if (!version) return;
      }
      const result = await context.force(uuid, { force: true, ...(version ? { version } : {}) });
      if (result.ok) {
        context.notify("info", text("EAGLELIBRARY.copy.notify.forced", { name }));
        // Same reason as `clearProtocol` above (F-M11-2): drop the resolved entry from the view we already have,
        // rather than asking the (within this session, not reliably fresh) setting again.
        if (this.#protocolRows) this.#protocolRows = this.#protocolRows.filter((row) => row.entry.source !== uuid);
      } else {
        context.notify("error", text("EAGLELIBRARY.copy.notify.forceFailed", { reason: result.reason, detail: result.detail }));
      }
      await this.render();
    }

    #readProtocol(): readonly ProtocolRow[] {
      const read = context.protocolOf();
      if (!read.ok) {
        context.notify("error", text("EAGLELIBRARY.copy.notify.protocolReadFailed", { detail: read.detail }));
        return [];
      }
      return protocolRows(read.protocol.entries);
    }

    #setRunningUi(running: boolean): void {
      if (this.#startButton) this.#startButton.disabled = running;
      if (this.#previewButton) this.#previewButton.disabled = running;
      if (this.#cancelButton) this.#cancelButton.disabled = !running;
      if (this.#selectAllInput) this.#selectAllInput.disabled = running;
      for (const input of this.#packInputs) input.disabled = running;
    }

    protected override async _renderHTML(): Promise<HTMLElement> {
      const root = element("div");
      root.classList.add("eagle-copy-root");
      try {
        this.#packs = sortPacks(await context.listPacks());
        this.#readFailed = false;
      } catch (error) {
        this.#readFailed = true;
        context.notify("error", text("EAGLELIBRARY.copy.notify.readFailed"));
        void error;
      }
      if (this.#readFailed) {
        root.append(element("p", text("EAGLELIBRARY.copy.notify.readFailed")));
        return root;
      }
      root.append(this.#renderSelection());
      root.append(this.#renderActions());
      if (this.#lastPlan) root.append(this.#renderPlanSummary(this.#lastPlan));
      if (this.#lastResult) root.append(this.#renderResultSummary(this.#lastResult));
      if (this.#protocolRows) root.append(this.#renderProtocol(this.#protocolRows));
      if (this.#showReport && this.#lastResult) root.append(this.#renderReport(this.#lastResult.linksWithGaps));
      return root;
    }

    protected override _replaceHTML(result: HTMLElement, content: HTMLElement): void {
      content.replaceChildren(result);
    }

    #renderSelection(): HTMLElement {
      const block = element("div");
      block.classList.add("eagle-copy-selection");
      if (this.#packs.length === 0) {
        block.append(element("p", text("EAGLELIBRARY.copy.noPacks")));
        this.#selectAllInput = undefined;
        this.#packInputs = [];
        return block;
      }
      const selectAllLabel = element("label");
      const selectAll = element("input") as HTMLInputElement;
      selectAll.type = "checkbox";
      selectAll.dataset.selectAll = "true";
      selectAll.checked = allSelected(this.#packs, this.#selected);
      selectAll.disabled = this.#running !== false;
      selectAll.addEventListener("change", (event) => void onToggleAll.call(this, event));
      selectAllLabel.append(selectAll, document.createTextNode(` ${text("EAGLELIBRARY.copy.selectAll")}`));
      block.append(selectAllLabel);
      this.#selectAllInput = selectAll;
      const list = element("ul");
      list.classList.add("eagle-copy-packs");
      const inputs: HTMLInputElement[] = [];
      for (const pack of this.#packs) {
        const item = element("li");
        const label = element("label");
        const input = element("input") as HTMLInputElement;
        input.type = "checkbox";
        input.dataset.collection = pack.collection;
        input.checked = this.#selected.has(pack.collection);
        input.disabled = this.#running !== false;
        input.addEventListener("change", (event) => void onTogglePack.call(this, event));
        label.append(input, document.createTextNode(` ${pack.label}`));
        item.append(label);
        list.append(item);
        inputs.push(input);
      }
      this.#packInputs = inputs;
      block.append(list);
      return block;
    }

    #renderActions(): HTMLElement {
      const block = element("div");
      block.classList.add("eagle-copy-actions");
      const preview = element("button", text("EAGLELIBRARY.copy.preview"));
      preview.type = "button";
      preview.dataset.action = "preview";
      preview.disabled = this.#running !== false;
      const start = element("button", text("EAGLELIBRARY.copy.start"));
      start.type = "button";
      start.dataset.action = "start";
      start.disabled = this.#running !== false;
      const cancel = element("button", text("EAGLELIBRARY.copy.cancel"));
      cancel.type = "button";
      cancel.dataset.action = "cancel";
      cancel.disabled = this.#running === false;
      this.#previewButton = preview;
      this.#startButton = start;
      this.#cancelButton = cancel;
      const protocolButton = element("button", text(this.#protocolRows ? "EAGLELIBRARY.copy.hideProtocol" : "EAGLELIBRARY.copy.showProtocol"));
      protocolButton.type = "button";
      protocolButton.dataset.action = "toggleProtocol";
      block.append(preview, start, cancel, protocolButton);
      if (this.#lastResult && this.#lastResult.linksWithGaps.length > 0) {
        const reportButton = element("button", text(this.#showReport ? "EAGLELIBRARY.copy.hideReport" : "EAGLELIBRARY.copy.showReport"));
        reportButton.type = "button";
        reportButton.dataset.action = "toggleReport";
        block.append(reportButton);
      }
      return block;
    }

    #renderPlanSummary(plan: BulkPlanResult): HTMLElement {
      const block = element("div");
      block.classList.add("eagle-copy-summary");
      block.append(
        element(
          "p",
          text("EAGLELIBRARY.copy.planSummary", {
            documents: String(plan.documents),
            total: String(plan.total),
            alreadyCopied: String(plan.alreadyCopied),
            duplicates: String(plan.duplicates),
          }),
        ),
      );
      if (plan.stopped) block.append(element("p", text("EAGLELIBRARY.copy.planStopped")));
      return block;
    }

    #renderResultSummary(result: BulkCopyResult): HTMLElement {
      const block = element("div");
      block.classList.add("eagle-copy-summary");
      block.append(
        element(
          "p",
          text("EAGLELIBRARY.copy.resultSummary", {
            copied: String(result.copied),
            alreadyCopied: String(result.alreadyCopied),
            duplicates: String(result.duplicates),
            failed: String(result.failed),
          }),
        ),
      );
      if (result.stoppedReason === "aborted") block.append(element("p", text("EAGLELIBRARY.copy.resultStoppedAborted")));
      else if (result.stoppedReason === "consecutive-failures") block.append(element("p", text("EAGLELIBRARY.copy.resultStoppedFailures")));
      return block;
    }

    #renderProtocol(rows: readonly ProtocolRow[]): HTMLElement {
      const block = element("div");
      block.classList.add("eagle-copy-protocol");
      if (rows.length === 0) {
        block.append(element("p", text("EAGLELIBRARY.copy.protocolEmpty")));
        return block;
      }
      const list = element("ul");
      for (const row of rows) {
        const item = element("li");
        item.append(element("span", text("EAGLELIBRARY.copy.protocolEntry", { name: row.entry.name, reason: row.entry.reason })));
        if (row.canForce) {
          const button = element("button", text("EAGLELIBRARY.copy.force"));
          button.type = "button";
          button.dataset.action = "force";
          button.dataset.uuid = row.entry.source;
          button.dataset.name = row.entry.name;
          if (row.entry.kind !== null) button.dataset.kind = row.entry.kind;
          item.append(document.createTextNode(" "), button);
        }
        list.append(item);
      }
      block.append(list);
      const clear = element("button", text("EAGLELIBRARY.copy.clearProtocol"));
      clear.type = "button";
      clear.dataset.action = "clearProtocol";
      block.append(clear);
      return block;
    }

    #renderReport(gaps: readonly BulkLinkGap[]): HTMLElement {
      const block = element("div");
      block.classList.add("eagle-copy-report");
      block.append(element("p", text("EAGLELIBRARY.copy.reportIntro", { count: String(gaps.length) })));
      const list = element("ul");
      for (const gap of gaps) {
        const item = element("li");
        const button = element("button", `${gap.uuid} (${gap.unresolved})`);
        button.type = "button";
        button.dataset.action = "openEntry";
        button.dataset.uuid = gap.uuid;
        item.append(button);
        list.append(item);
      }
      block.append(list);
      return block;
    }
  }

  return EagleCopyApplication;
}

// Referenced only for the type of a protocol entry a rendered row carries (`ProtocolRow.entry`); avoids an unused-import
// lint if a build ever checks that separately from `tsc`.
export type { ProtocolEntry };
