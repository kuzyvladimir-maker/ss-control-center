import { NextRequest, NextResponse } from "next/server";
import { seedKnowledgeBase } from "@/lib/customer-hub/seed-knowledge-base";

/**
 * POST /api/customer-hub/knowledge-base/seed
 *
 * One-shot administrative endpoint that inserts the 40 reference cases
 * defined in src/lib/customer-hub/seed-knowledge-base.ts into the
 * KnowledgeBaseEntry table. Idempotent by default — a second call when
 * the table is already populated returns { inserted: 0 }.
 *
 * Body: { "force": true }  — wipe existing entries and re-seed from
 * scratch. Useful after editing the seed file to update corrected cases.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const force = body?.force === true;

    const result = await seedKnowledgeBase({ force });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[knowledge-base/seed] POST failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Seed failed" },
      { status: 500 }
    );
  }
}
