import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseManualClass } from "@/lib/shipping/temp-class";
import { saveManualTempClass } from "@/lib/shipping/temp-class/save-manual";

export async function POST(request: NextRequest) {
  try {
    const { productId, tag, sku: rawSku } = await request.json();
    const sku = String(rawSku ?? "").trim();

    if (!productId || !tag) {
      return NextResponse.json(
        { error: "productId and tag are required" },
        { status: 400 }
      );
    }

    const parsed = parseManualClass(tag);
    if (!parsed.ok) {
      return NextResponse.json(
        { error: "tag must be 'Frozen', 'Chilled' or 'Dry'" },
        { status: 400 }
      );
    }
    // Chilled lives on the SKU's manual class (topic 135) — the legacy
    // Frozen/Dry row can't hold it without turning it into Frozen.
    if (parsed.klass === "CHILLED") {
      if (!sku) {
        return NextResponse.json(
          { error: "Chilled is saved per SKU — pass sku as well" },
          { status: 400 }
        );
      }
      await saveManualTempClass({ sku, klass: "CHILLED", setBy: "fix-tag" });
      return NextResponse.json({ success: true, productId, sku, tag: "Chilled" });
    }
    if (sku) {
      await saveManualTempClass({ sku, klass: parsed.klass, setBy: "fix-tag" });
    }
    const legacy = parsed.klass === "FROZEN" ? "Frozen" : "Dry";

    // Save locally — Veeqo tags_attributes API doesn't reliably add tags
    await prisma.productTypeOverride.upsert({
      where: { productId: Number(productId) },
      update: { type: legacy },
      create: { productId: Number(productId), type: legacy },
    });

    return NextResponse.json({ success: true, productId, tag: legacy });
  } catch (error) {
    console.error("Fix tag error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to set tag" },
      { status: 500 }
    );
  }
}
