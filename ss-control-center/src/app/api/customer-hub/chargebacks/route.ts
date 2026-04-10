import { NextResponse } from "next/server";
export async function GET() {
  // TODO: fetch chargebacks
  return NextResponse.json({ chargebacks: [], total: 0 });
}
