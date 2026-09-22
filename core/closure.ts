// The plan of a copy with its dependencies (milestone M8, rule R17 of the convention): which documents go where and in which
// portions. Pure logic; the search for the dependencies and the writing are in core/copy.ts.

// The most documents one request of Flight Control takes (`compendium.import`).
export const MAX_DOCUMENTS_PER_PORTION = 100;
// The most documents a copy with its dependencies may have unless the Gamemaster gives another limit.
export const DEFAULT_MAX_CLOSURE_DOCUMENTS = 5000;

// A document of the plan. A container and its contents are one `unit`; a portion never splits a unit.
export interface PlanDocument {
  readonly source: string;
  readonly target: string;
  readonly unit: number;
}

// Groups the documents by target compendium, in the order in which the compendia first appear, and cuts each group into portions
// of at most `max` documents without splitting a unit. The order of the documents inside a compendium is the order of the plan.
export function portionsOf<T extends PlanDocument>(documents: readonly T[], max: number = MAX_DOCUMENTS_PER_PORTION): T[][] {
  const units = new Map<string, Map<number, T[]>>();
  for (const document of documents) {
    let byUnit = units.get(document.target);
    if (!byUnit) units.set(document.target, (byUnit = new Map()));
    const list = byUnit.get(document.unit);
    if (list) list.push(document);
    else byUnit.set(document.unit, [document]);
  }
  const portions: T[][] = [];
  for (const byUnit of units.values()) {
    let current: T[] = [];
    for (const unit of byUnit.values()) {
      if (current.length > 0 && current.length + unit.length > max) {
        portions.push(current);
        current = [];
      }
      current.push(...unit);
    }
    if (current.length > 0) portions.push(current);
  }
  return portions;
}

export interface PlanSummary {
  readonly documents: number;
  readonly portions: number;
  // The documents per target compendium.
  readonly byCompendium: Readonly<Record<string, number>>;
}

export function summarizePlan(documents: readonly PlanDocument[], max: number = MAX_DOCUMENTS_PER_PORTION): PlanSummary {
  const byCompendium: Record<string, number> = {};
  for (const document of documents) byCompendium[document.target] = (byCompendium[document.target] ?? 0) + 1;
  return { documents: documents.length, portions: portionsOf(documents, max).length, byCompendium };
}
