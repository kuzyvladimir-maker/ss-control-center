import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(request: NextRequest) {
  try {
    const { productId, tag } = await request.json();

    if (!productId || !tag) {
      return NextResponse.json(
        { error: "productId and tag are required" },
        { status: 400 }
      );
    }

    if (tag !== "Frozen" && tag !== "Dry") {
      return NextResponse.json(
        { error: "tag must be 'Frozen' or 'Dry'" },
        { status: 400 }
      );
    }

    // Save locally — Veeqo tags_attributes API doesn't reliably add tags
    await prisma.productTypeOverride.upsert({
      where: { productId: Number(productId) },
      update: { type: tag },
      create: { productId: Number(productId), type: tag },
    });

    return NextResponse.json({ success: true, productId, tag });
  } catch (error) {
    console.error("Fix tag error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to set tag" },
      { status: 500 }
    );
  }
}
