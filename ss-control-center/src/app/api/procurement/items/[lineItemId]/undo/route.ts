import { NextRequest, NextResponse } from "next/server";
import { applyProcurementAction } from "@/lib/procurement/order-state-update";

export const dynamic = "force-dynamic";

interface UndoBody {
  orderId?: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ lineItemId: string }> }
) {
  const { lineItemId } = await params;

  let body: UndoBody = {};
  try {
    body = (await req.json()) as UndoBody;
  } catch {
    // optional JSON
  }

  const orderId =
    body.orderId ?? new URL(req.url).searchParams.get("orderId") ?? "";
  if (!orderId) {
    return NextResponse.json({ error: "orderId is required" }, { status: 400 });
  }

  try {
    const result = await applyProcurementAction(orderId, lineItemId, {
      kind: "undo",
    });
    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[procurement/undo]", { orderId, lineItemId, error: e });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
