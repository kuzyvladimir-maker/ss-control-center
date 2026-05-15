// GET  /api/frozen/rules        — list all rules
// PUT  /api/frozen/rules        — update a rule (body: { id, ...fields })
//
// No DELETE: rules are toggled via `enabled: false` so audit trail stays.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const rules = await prisma.frozenRule.findMany({
    orderBy: [{ ruleType: "asc" }, { priority: "asc" }, { ruleCode: "asc" }],
  });
  return NextResponse.json({ rules });
}

interface PutBody {
  id: string;
  description?: string;
  conditions?: string | Record<string, unknown>;
  riskLevel?: string;
  modifier?: number;
  recommendation?: string;
  enabled?: boolean;
  priority?: number;
}

export async function PUT(request: NextRequest) {
  const body = (await request.json()) as PutBody;
  if (!body?.id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  const data: Record<string, unknown> = {};
  for (const key of [
    "description",
    "riskLevel",
    "modifier",
    "recommendation",
    "enabled",
    "priority",
  ] as const) {
    if (body[key] !== undefined) data[key] = body[key];
  }
  // Conditions can come as object or string — normalize to JSON string.
  if (body.conditions !== undefined) {
    data.conditions =
      typeof body.conditions === "string"
        ? body.conditions
        : JSON.stringify(body.conditions);
  }

  try {
    const updated = await prisma.frozenRule.update({
      where: { id: body.id },
      data,
    });
    return NextResponse.json(updated);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 404 },
    );
  }
}
