import { NextResponse } from "next/server";
import { getAuthUrl } from "@/lib/gmail-api";

export async function GET() {
  try {
    const url = getAuthUrl();
    return NextResponse.redirect(url);
  } catch (error) {
    return NextResponse.redirect(
      `/settings?gmail=error&reason=${encodeURIComponent(
        error instanceof Error ? error.message : "OAuth not configured"
      )}`
    );
  }
}
