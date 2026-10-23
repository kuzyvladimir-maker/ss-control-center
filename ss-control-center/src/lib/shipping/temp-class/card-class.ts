/**
 * Class shown on a /shipping card for EVERY order, not only the ones with a
 * plan. The dashboard used to label items from the Veeqo tag / legacy
 * Frozen/Dry override only. The manual SkuTemperatureClass never reached it,
 * so a SKU the owner marked CHILLED (e.g. AT-943E-XUUS) still read "Frozen" on
 * orders still waiting for procurement (2026-10-23). The manual class wins, as
 * everywhere else.
 */

import { isTempClass, type TempClass } from "./classes";

export type CardClass = "Frozen" | "Chilled" | "Dry";

const LABEL: Record<TempClass, CardClass> = {
  FROZEN: "Frozen",
  CHILLED: "Chilled",
  DRY: "Dry",
};

/**
 * One item: `knownType` keeps its old Frozen/Dry meaning (cold chain vs dry),
 * because need-attention, mixed-order and Walmart checks read it. `tempClass`
 * is the three-way label for the chip and the Chilled tab.
 */
export function applyManualClass(
  knownType: string | null,
  manual: string | null | undefined,
): { knownType: string | null; tempClass: CardClass | null } {
  if (manual && isTempClass(manual)) {
    return {
      knownType: manual === "DRY" ? "Dry" : "Frozen",
      tempClass: LABEL[manual],
    };
  }
  const t = knownType === "Frozen" || knownType === "Dry" ? knownType : null;
  return { knownType, tempClass: t };
}

/** The order's chip: strictest item class (Frozen > Chilled > Dry). */
export function strictestCardClass(
  items: ReadonlyArray<{ tempClass?: CardClass | null; knownType?: string | null }>,
): CardClass | null {
  const classes = items.map(
    (i) =>
      i.tempClass ??
      (i.knownType === "Frozen" || i.knownType === "Dry" ? i.knownType : null),
  );
  if (classes.includes("Frozen")) return "Frozen";
  if (classes.includes("Chilled")) return "Chilled";
  if (classes.includes("Dry")) return "Dry";
  return null;
}

/**
 * The exact mapping /api/shipping/dashboard applies to one order line: the
 * Veeqo-tag type, the Walmart rule (always Dry) and the manual class looked up
 * by the line's trimmed SKU.
 */
export function cardItemClass(args: {
  tagType: string | null;
  isWalmart: boolean;
  sku: string | null | undefined;
  manualBySku: ReadonlyMap<string, string>;
}): { knownType: string | null; tempClass: CardClass | null } {
  if (args.isWalmart) return { knownType: args.tagType, tempClass: "Dry" };
  return applyManualClass(
    args.tagType,
    args.manualBySku.get((args.sku ?? "").trim()),
  );
}

/**
 * True when the tab runs a different build than the server, i.e. the page
 * should reload to pick up new code. Unknown on either side → no reload.
 */
export function isStaleBuild(
  clientSha: string | null | undefined,
  serverSha: string | null | undefined,
): boolean {
  return !!clientSha && !!serverSha && clientSha !== serverSha;
}
