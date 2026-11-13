import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { processCase } from "@/lib/customer-hub/cs-pipeline";

// GET — single message with conversation history
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const message = await prisma.buyerMessage.findUnique({ where: { id } });
    if (!message) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Conversation history — same order
    let history: typeof message[] = [];
    if (message.amazonOrderId) {
      history = await prisma.buyerMessage.findMany({
        where: {
          amazonOrderId: message.amazonOrderId,
          id: { not: id },
        },
        orderBy: { createdAt: "asc" },
      });
    }

    return NextResponse.json({ message, history });
  } catch (error) {
    console.error("Message GET error:", error);
    return NextResponse.json({ error: "Failed to fetch" }, { status: 500 });
  }
}

// POST — analyze or other actions
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));

    if (body.action === "analyze") {
      return await runAnalysis(id);
    }
    if (body.action === "rewrite") {
      return await runRewrite(id, body.style);
    }
    if (body.action === "fix") {
      return await runFix(id);
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (error) {
    console.error("Message POST error:", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}

// PATCH — partial update. Only whitelisted fields are writeable through
// this endpoint; anything else in the body is silently ignored.
//
// Auto-behaviours:
//  - status=RESOLVED without resolution → resolution="resolved"
//  - status=SENT without responseSentAt  → responseSentAt=now (server clock)
//    This is used by the "Responded in Seller Central" button so Vladimir
//    doesn't have to send a client-side timestamp.
const PATCHABLE_FIELDS = [
  "status",
  "resolution",
  "editedResponse",
  "editedResponseRu",
  "vladimirNotes",
  "responseSentVia",
  "responseSentAt",
] as const;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const data: Record<string, unknown> = {};
    for (const field of PATCHABLE_FIELDS) {
      if (body[field] !== undefined) data[field] = body[field];
    }
    // Coerce responseSentAt into a Date if the client sent a string
    if (typeof data.responseSentAt === "string") {
      data.responseSentAt = new Date(data.responseSentAt);
    }
    if (data.status === "RESOLVED" && !data.resolution) {
      data.resolution = "resolved";
    }
    if (data.status === "SENT" && data.responseSentAt === undefined) {
      data.responseSentAt = new Date();
    }
    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { error: "No patchable fields provided" },
        { status: 400 }
      );
    }

    const updated = await prisma.buyerMessage.update({ where: { id }, data });
    return NextResponse.json({ message: updated });
  } catch (error) {
    console.error("Message PATCH error:", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}

async function runAnalysis(id: string, ownerInstruction?: string) {
  const existing = await prisma.buyerMessage.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const result = await processCase(id, { ownerInstruction, forceCard: true });
  const message = await prisma.buyerMessage.findUnique({ where: { id } });
  return NextResponse.json({ message, analysis: result });
}

const REWRITE_STYLES: Record<string, string> = {
  polite: "Rewrite with empathy. Preserve the evidence-selected decision and do not admit fault.",
  amazon_safe: "Rewrite to be policy-safe. Preserve the evidence-selected decision.",
  shorter: "Rewrite in at most four sentences, preserving the evidence-selected decision.",
  no_refund: "Avoid unnecessary discussion of money. Do not override the evidence-selected rule.",
};
async function runRewrite(id: string, style: unknown) {
  if (typeof style !== "string" || !(style in REWRITE_STYLES)) return NextResponse.json({ error: "Invalid rewrite style" }, { status: 400 });
  return runAnalysis(id, REWRITE_STYLES[style]);
}
async function runFix(id: string) {
  return runAnalysis(id, "Check all facts and correct the draft under the evidence-selected rule.");
}
