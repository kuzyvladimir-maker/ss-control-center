/**
 * POST /api/shipping/product-type
 *
 * Persist a Frozen/Dry classification (manual or AI-confirmed) on a Veeqo
 * product. Writes the local override row immediately, then attempts to
 * mirror the tag back to Veeqo asynchronously so the existing tag-based
 * lookup paths keep working. Veeqo sync state is tracked on the row
 * (syncedToVeeqo / veeqoSyncError) for the retry endpoint.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { setProductTag } from "@/lib/veeqo/client";

interface Body {
  productId?: number;
  type?: "Frozen" | "Dry";
  source?: "manual" | "ai";
  aiConfidence?: number;
  aiReasoning?: string;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Body;
  const productId = Number(body?.productId);
  const type = body?.type;
  const source =
    body?.source === "ai" || body?.source === "manual" ? body.source : "manual";
  if (!Number.isFinite(productId) || productId <= 0) {
    return NextResponse.json(
      { error: "productId is required" },
      { status: 400 }
    );
  }
  if (type !== "Frozen" && type !== "Dry") {
    return NextResponse.json(
      { error: 'type must be "Frozen" or "Dry"' },
      { status: 400 }
    );
  }

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
    type,
    source,
    veeqoSyncing: true,
  });
}
