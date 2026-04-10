import { NextResponse } from "next/server";

export async function GET() {
  try {
    // Check which stores have Gmail refresh tokens configured
    const accounts = [];
    for (let i = 1; i <= 6; i++) {
      const token = process.env[`GMAIL_REFRESH_TOKEN_STORE${i}`];
      accounts.push({
        storeIndex: i,
        configured: !!token,
      });
    }

    return NextResponse.json({ accounts });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 500 }
    );
  }
}
