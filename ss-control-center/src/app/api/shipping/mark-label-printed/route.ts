// POST /api/shipping/mark-label-printed
//
// Body: { driveFileId: string }
//
// Called by the client after DYMO Connect confirms it accepted a label
// print job. Moves the matching Drive file from its date+channel folder
// into the sibling "Printed" subfolder so the Drive layout reflects
// "physically printed" state.
//
// Idempotent — re-runs against an already-Printed file are no-ops.

import { NextRequest, NextResponse } from "next/server";
import { moveLabelToPrinted } from "@/lib/google-drive";

export const dynamic = "force-dynamic";

interface Body {
  driveFileId?: string;
}

export async function POST(req: NextRequest) {
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const driveFileId = (body.driveFileId ?? "").trim();
  if (!driveFileId) {
    return NextResponse.json(
      { error: "driveFileId is required" },
      { status: 400 },
    );
  }

  const result = await moveLabelToPrinted({ fileId: driveFileId });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.reason },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true });
}
