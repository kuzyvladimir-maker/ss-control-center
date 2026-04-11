import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { saveToKnowledgeBase } from "@/lib/customer-hub/knowledge-base";

// GET /api/customer-hub/knowledge-base?problemType=T21&tag=cancel_request
// Returns knowledge base entries, optionally filtered by problemType or
// a comma/substring in the tags field.
export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const problemType = sp.get("problemType");
    const tag = sp.get("tag");
    const limit = parseInt(sp.get("limit") || "50");

    const where: Record<string, unknown> = {};
    if (problemType) where.problemType = problemType;
    if (tag) where.tags = { contains: tag };

    const [entries, total] = await Promise.all([
      prisma.knowledgeBaseEntry.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
      prisma.knowledgeBaseEntry.count({ where }),
    ]);

    return NextResponse.json({ entries, total });
  } catch (err) {
    console.error("[knowledge-base] GET failed:", err);
    return NextResponse.json(
      { error: "Failed to load knowledge base" },
      { status: 500 }
    );
  }
}

// POST /api/customer-hub/knowledge-base
// Creates a new manual entry. Required body fields: problemType, scenario,
// customerSaid, correctAction, correctResponse, reasoning.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));

    const required = [
      "problemType",
      "scenario",
      "customerSaid",
      "correctAction",
      "correctResponse",
      "reasoning",
    ] as const;
    for (const field of required) {
      if (!body[field] || typeof body[field] !== "string") {
        return NextResponse.json(
          { error: `Missing required field: ${field}` },
          { status: 400 }
        );
      }
    }

    const entry = await saveToKnowledgeBase({
      problemType: body.problemType,
      scenario: body.scenario,
      customerSaid: body.customerSaid,
      trackingStatus: body.trackingStatus || null,
      shippingMismatch: body.shippingMismatch === true,
      productType: body.productType || null,
      correctAction: body.correctAction,
      correctResponse: body.correctResponse,
      reasoning: body.reasoning,
      whoShouldPay: body.whoShouldPay || null,
      outcome:
        body.outcome === "positive" ||
        body.outcome === "negative" ||
        body.outcome === "neutral"
          ? body.outcome
          : null,
      tags: body.tags || null,
      source: "manual",
    });

    return NextResponse.json({ entry });
  } catch (err) {
    console.error("[knowledge-base] POST failed:", err);
    return NextResponse.json(
      { error: "Failed to save knowledge base entry" },
      { status: 500 }
    );
  }
}
