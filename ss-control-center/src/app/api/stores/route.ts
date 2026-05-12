import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/stores
// Returns the full directory of active stores. Amazon first (sorted by
// storeIndex), then Walmart. Consumed by the global Store Filter selector
// in the sidebar — see docs/STORE_FILTER_SYSTEM_SPEC_v1_0.md.
export async function GET() {
  try {
    const rows = await prisma.store.findMany({
      where: { active: true },
      orderBy: [{ channel: "asc" }, { storeIndex: "asc" }, { name: "asc" }],
    });

    return NextResponse.json({
      stores: rows.map((r) => ({
        id: r.id,
        name: r.name,
        channel: r.channel,
        storeIndex: r.storeIndex,
        sellerId: r.sellerId,
        active: r.active,
      })),
    });
  } catch (error) {
    console.error("[api/stores] GET failed:", error);
    return NextResponse.json(
      { error: "Failed to load stores" },
      { status: 500 }
    );
  }
}
