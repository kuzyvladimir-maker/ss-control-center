import { NextRequest, NextResponse } from "next/server";

// POST /api/customer-hub/messages/:id/send
// Sends a response to the buyer via SP-API Messaging.
// Not yet implemented — wire up to src/lib/amazon-sp-api/messaging.ts when ready.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return NextResponse.json(
    {
      id,
      sent: false,
      error: "Sending buyer messages is not yet wired up to SP-API Messaging.",
    },
    { status: 501 }
  );
}
