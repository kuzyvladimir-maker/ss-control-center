import { NextRequest, NextResponse } from "next/server";

// POST /api/customer-hub/atoz/:id/submit
// Submits an A-to-Z claim response back to Amazon. Requires SP-API A-to-Z
// claims endpoint — not yet wired up.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return NextResponse.json(
    {
      id,
      submitted: false,
      error: "A-to-Z claim submission is not yet wired up to SP-API.",
    },
    { status: 501 }
  );
}
