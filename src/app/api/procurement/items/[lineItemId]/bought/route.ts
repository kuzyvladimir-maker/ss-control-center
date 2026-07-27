import { NextRequest, NextResponse } from "next/server";
import { applyProcurementAction } from "@/lib/procurement/order-state-update";

export const dynamic = "force-dynamic";

interface BoughtBody {
  orderId?: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ lineItemId: string }> }
) {
  const { lineItemId } = await params;

  let body: BoughtBody = {};
  try {
    body = (await req.json()) as BoughtBody;
  } catch {
    // empty body is fine if orderId comes via query, but we require it below
  }

  const orderId =
    body.orderId ?? new URL(req.url).searchParams.get("orderId") ?? "";
  if (!orderId) {
    return NextResponse.json(
      { error: "orderId is required (in JSON body or ?orderId=)" },
      { status: 400 }
    );
  }
  if (!lineItemId) {
    return NextResponse.json(
      { error: "lineItemId is required" },
      { status: 400 }
    );
  }

  try {
    const result = await applyProcurementAction(orderId, lineItemId, {
      kind: "bought",
    });
    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[procurement/bought]", { orderId, lineItemId, error: e });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
