import { NextResponse } from "next/server";
import { fetchProcurementCards } from "@/lib/veeqo/orders-procurement";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const cards = await fetchProcurementCards();

    // Default sort: most-urgent ship-by first; orders with no ship-by date
    // sink to the bottom.
    cards.sort((a, b) => {
      const aDate = a.shipBy
        ? new Date(a.shipBy).getTime()
        : Number.POSITIVE_INFINITY;
      const bDate = b.shipBy
        ? new Date(b.shipBy).getTime()
        : Number.POSITIVE_INFINITY;
      return aDate - bDate;
    });

    return NextResponse.json({ cards, total: cards.length });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[procurement/items] error", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
