import { NextRequest, NextResponse } from "next/server";

// POST /api/customer-hub/feedback/:id/remove
// Requests feedback removal via Amazon SP-API Solicitations/Feedback.
// Not yet wired up.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return NextResponse.json(
    {
      id,
      requested: false,
      error: "Feedback removal is not yet wired up to SP-API.",
    },
    { status: 501 }
  );
}
