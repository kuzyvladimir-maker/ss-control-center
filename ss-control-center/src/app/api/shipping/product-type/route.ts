/**
 * POST /api/shipping/product-type
 *
 * Persist a temperature class (manual or AI-confirmed) for an order line —
 * Frozen, Chilled or Dry (topic 135, 2026-10-30: the Set product type dialog
 * gained Chilled).
 *
 *   - With `sku`: the SKU's MANUAL class (SkuTemperatureClass) is set. That is
 *     the value the card chip, the plan and the rate engine read first, so the
 *     pick takes effect even when an older manual class exists.
 *   - Frozen / Dry also keep the legacy ProductTypeOverride row (keyed by Veeqo
 *     product id) and mirror the tag back to Veeqo asynchronously, as before,
 *     so the tag-based lookup paths keep returning the same classification.
 *   - Chilled is saved per SKU only. It never writes the legacy Frozen/Dry row
 *     or a Veeqo tag (no silent "Frozen"); tag mirroring for chilled is a
 *     separate owner step (topic 135, point 3).
 *   - channel "walmart" → Dry only (frozen & chilled are forbidden there).
 *
 * Veeqo sync state for the legacy row is tracked on it (syncedToVeeqo /
 * veeqoSyncError) for the retry endpoint.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { setProductTag } from "@/lib/veeqo/client";
import { isWalmartChannel, parseManualClass } from "@/lib/shipping/temp-class";
import { saveManualTempClass } from "@/lib/shipping/temp-class/save-manual";

interface Body {
  productId?: number;
  type?: string;
  /** Line SKU — required for Chilled, recommended for every class. */
  sku?: string;
  /** Channel of the order the class is set from. */
  channel?: string;
  source?: "manual" | "ai";
  aiConfidence?: number;
  aiReasoning?: string;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Body;
  const productId = Number(body?.productId);
  const sku = String(body?.sku ?? "").trim();
  const source =
    body?.source === "ai" || body?.source === "manual" ? body.source : "manual";
  if (!Number.isFinite(productId) || productId <= 0) {
    return NextResponse.json(
      { error: "productId is required" },
      { status: 400 }
    );
  }
  const parsed = parseManualClass(body?.type, {
    isWalmart: isWalmartChannel(body?.channel),
  });
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const klass = parsed.klass;
  if (klass === "CHILLED" && !sku) {
    return NextResponse.json(
      { error: "Chilled is saved per SKU — sku is required" },
      { status: 400 }
    );
  }

  // The SKU's manual class first: it is what the card and the rate engine read.
  if (sku) {
    await saveManualTempClass({
      sku,
      klass,
      setBy: source === "ai" ? "ai-confirmed" : "set-type-dialog",
    });
  }
  if (klass === "CHILLED") {
    return NextResponse.json({
      success: true,
      productId,
      sku,
      type: "Chilled",
      source,
      veeqoSyncing: false,
    });
  }
  const type = klass === "FROZEN" ? "Frozen" : "Dry";

  await prisma.productTypeOverride.upsert({
    where: { productId },
    create: {
      productId,
      type,
      source,
      aiConfidence: source === "ai" ? body.aiConfidence ?? null : null,
      aiReasoning: source === "ai" ? body.aiReasoning ?? null : null,
      syncedToVeeqo: false,
    },
    update: {
      type,
      source,
      aiConfidence: source === "ai" ? body.aiConfidence ?? null : null,
      aiReasoning: source === "ai" ? body.aiReasoning ?? null : null,
      syncedToVeeqo: false,
      veeqoSyncError: null,
    },
  });

  // Mirror the tag back to Veeqo without blocking the response. The
  // override is the source of truth locally; the Veeqo tag exists so the
  // legacy lookup paths in /api/shipping/plan keep returning the same
  // classification.
  void (async () => {
    try {
      await setProductTag(productId, type);
      await prisma.productTypeOverride.update({
        where: { productId },
        data: { syncedToVeeqo: true, veeqoSyncError: null },
      });
    } catch (err) {
      await prisma.productTypeOverride.update({
        where: { productId },
        data: {
          syncedToVeeqo: false,
          veeqoSyncError:
            err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
        },
      });
    }
  })();

  return NextResponse.json({
    success: true,
    productId,
    sku: sku || null,
    type,
    source,
    veeqoSyncing: true,
  });
}
