import { NextRequest, NextResponse } from "next/server";
import { sendResponse } from "@/lib/customer-hub/response-sender";

// POST /api/customer-hub/messages/:id/send
// Sends the prepared response for the given BuyerMessage via SP-API
// Messaging. Returns 422 on handled failures (Walmart, missing fields,
// SP-API errors) so the UI can show a specific error; 500 on unexpected
// exceptions.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const result = await sendResponse(id);
    return NextResponse.json(result, { status: result.success ? 200 : 422 });
  } catch (err) {
    console.error("[customer-hub/messages/:id/send] unhandled:", err);
    return NextResponse.json(
      {
        success: false,
        method: "MANUAL",
        error: err instanceof Error ? err.message : "Unexpected error",
      },
      { status: 500 }
    );
  }
}
