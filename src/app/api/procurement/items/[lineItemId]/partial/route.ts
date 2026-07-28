import { NextRequest, NextResponse } from "next/server";
import { applyProcurementAction } from "@/lib/procurement/order-state-update";

export const dynamic = "force-dynamic";

interface PartialBody {
  orderId?: string;
  remaining?: number;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ lineItemId: string }> }
) {
  const { lineItemId } = await params;

  let body: PartialBody = {};
  try {
    body = (await req.json()) as PartialBody;
  } catch {
    return NextResponse.json(
      { error: "Body must be JSON: { orderId, remaining }" },
      { status: 400 }
    );
  }

  const orderId = body.orderId ?? "";
  const remaining = body.remaining;
  if (!orderId) {
    return NextResponse.json({ error: "orderId is required" }, { status: 400 });
  }
  if (
    typeof remaining !== "number" ||
    !Number.isFinite(remaining) ||
    !Number.isInteger(remaining) ||
    remaining <= 0
  ) {
    return NextResponse.json(
      { error: "remaining must be a positive integer" },
      { status: 400 }
    );
  }

  try {
    const result = await applyProcurementAction(orderId, lineItemId, {
      kind: "partial",
      remaining,
    });
    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[procurement/partial]", { orderId, lineItemId, error: e });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
