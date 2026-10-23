// Resolve the temperature class of an order.
//
// Precedence for one SKU (first match wins), owner 2026-10-23:
//   1. SkuTemperatureClass row — the MANUAL value the owner sets in the
//      Command Center. Nothing reads a Veeqo tag back over it.
//   2. Legacy ProductTypeOverride (Frozen/Dry, keyed by Veeqo product id).
//   3. Veeqo product tag (frozen / chilled / refrigerated / dry).
//   4. Nothing → FROZEN (the safe default), flagged `unknown` on the card.
//
// The ORDER class is the strictest of its lines (FROZEN > CHILLED > DRY), so
// one frozen item drags a mixed box onto the frozen cold chain — fixing the old
// "read only line_items[0]" bug. Walmart orders stay DRY (frozen & chilled are
// forbidden there); a cold SKU on a Walmart order is surfaced as a conflict.
//
// The pure decideLine/decideOrder functions below hold the logic and are unit-
// tested; resolveOrderClass is the thin DB wrapper the plan route calls.

import {
  type TempClass,
  DEFAULT_CLASS,
  parseTempClass,
  strictestClass,
  isTempClass,
} from "./classes";

export type ClassSource = "manual" | "legacy" | "tag" | "default";

export interface LineClass {
  tempClass: TempClass;
  source: ClassSource;
  /** true when the class fell through to the FROZEN default (no signal). */
  unknown: boolean;
}

export interface LineInputs {
  /** SkuTemperatureClass.class for this SKU, if the owner set one. */
  manual?: string | null;
  /** ProductTypeOverride.type ("Frozen"/"Dry"), if present. */
  legacy?: string | null;
  /** Veeqo product tag names for this line. */
  tags?: readonly string[];
}

/** Resolve one line to a class with its provenance. */
export function decideLineClass(inputs: LineInputs): LineClass {
  const manual = parseTempClass(inputs.manual);
  if (manual) return { tempClass: manual, source: "manual", unknown: false };

  const legacy = parseTempClass(inputs.legacy);
  if (legacy) return { tempClass: legacy, source: "legacy", unknown: false };

  for (const t of inputs.tags ?? []) {
    const fromTag = parseTempClass(t);
    if (fromTag) return { tempClass: fromTag, source: "tag", unknown: false };
  }

  return { tempClass: DEFAULT_CLASS, source: "default", unknown: true };
}

export interface OrderClassResult {
  tempClass: TempClass;
  perLine: LineClass[];
  /** Any line fell through to the default (needs owner attention). */
  unknownAny: boolean;
  /** Walmart order carrying a FROZEN/CHILLED line — forbidden, flag it. */
  walmartColdConflict: boolean;
}

/**
 * Resolve the order's effective class. On Walmart the effective class is forced
 * to DRY (cold isn't allowed on that channel), but a cold line still raises
 * walmartColdConflict so the card can warn the operator.
 */
export function decideOrderClass(
  lines: readonly LineInputs[],
  opts: { isWalmart?: boolean } = {},
): OrderClassResult {
  const perLine = lines.map(decideLineClass);
  const resolved = perLine.map((l) => l.tempClass);
  const strictest = strictestClass(resolved);
  const unknownAny = perLine.some((l) => l.unknown);

  if (opts.isWalmart) {
    const walmartColdConflict = resolved.some(
      (c) => c === "FROZEN" || c === "CHILLED",
    );
    return { tempClass: "DRY", perLine, unknownAny, walmartColdConflict };
  }

  return {
    tempClass: strictest,
    perLine,
    unknownAny,
    walmartColdConflict: false,
  };
}

// ── DB wrapper ──
// Thin prisma-backed resolver for the plan route. Kept out of the pure module
// above so the unit tests need no database.

interface PrismaLike {
  skuTemperatureClass: {
    findMany: (args: {
      where: { sku: { in: string[] } };
      select: { sku: true; class: true };
    }) => Promise<Array<{ sku: string; class: string }>>;
  };
}

export interface OrderLineForClass {
  sku: string;
  /** Legacy ProductTypeOverride.type for this line's product, if known. */
  legacyType?: string | null;
  /** Veeqo tag names for this line's product, if fetched. */
  tags?: readonly string[];
}

/**
 * Resolve an order's class from the DB. Batch-reads SkuTemperatureClass for all
 * line SKUs; legacy override + tags are passed in by the caller (it already has
 * them). Manual class (per SKU) always wins per line.
 */
export async function resolveOrderClass(
  prisma: PrismaLike,
  lines: readonly OrderLineForClass[],
  opts: { isWalmart?: boolean } = {},
): Promise<OrderClassResult> {
  const skus = [...new Set(lines.map((l) => l.sku).filter(Boolean))];
  const manualBySku = new Map<string, string>();
  if (skus.length > 0) {
    try {
      const rows = await prisma.skuTemperatureClass.findMany({
        where: { sku: { in: skus } },
        select: { sku: true, class: true },
      });
      for (const r of rows) {
        if (isTempClass(r.class)) manualBySku.set(r.sku, r.class);
      }
    } catch (e) {
      // Table missing (migration not applied yet) or read error — degrade to
      // legacy/tag resolution rather than crash the plan.
      console.warn(
        "[temp-class] SkuTemperatureClass lookup failed:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  const inputs: LineInputs[] = lines.map((l) => ({
    manual: manualBySku.get(l.sku) ?? null,
    legacy: l.legacyType ?? null,
    tags: l.tags,
  }));
  return decideOrderClass(inputs, opts);
}
