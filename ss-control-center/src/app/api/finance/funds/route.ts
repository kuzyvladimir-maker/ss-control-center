// Funds CRUD + balances. GET list, POST create, PATCH update, DELETE (id query).
// System funds (RESERVE / FREE) cannot be deleted.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { scopeOf } from "@/lib/finance/scope";

const GROUPS = new Set(["RESERVE", "FP1", "FP2", "FREE"]);
const TYPES = new Set(["percent", "absolute"]);

export async function GET(req: NextRequest) {
  const funds = await prisma.fund.findMany({ where: { scope: scopeOf(req) }, orderBy: { priority: "asc" } });
  return NextResponse.json({ funds });
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    if (!b.name || !GROUPS.has(b.group)) {
      return NextResponse.json({ error: "name + valid group required" }, { status: 400 });
    }
    const fund = await prisma.fund.create({
      data: {
        scope: scopeOf(req),
        name: String(b.name),
        group: b.group,
        allocationType: TYPES.has(b.allocationType) ? b.allocationType : "percent",
        value: Number(b.value) || 0,
        priority: Number.isFinite(b.priority) ? Number(b.priority) : 100,
        cap: b.cap != null && b.cap !== "" ? Number(b.cap) : null,
        active: b.active ?? true,
        notes: b.notes ?? null,
      },
    });
    return NextResponse.json({ fund });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const b = await req.json();
    if (!b.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const data: Record<string, unknown> = {};
    if (b.name != null) data.name = String(b.name);
    if (b.group && GROUPS.has(b.group)) data.group = b.group;
    if (b.allocationType && TYPES.has(b.allocationType)) data.allocationType = b.allocationType;
    if (b.value != null) data.value = Number(b.value) || 0;
    if (b.priority != null) data.priority = Number(b.priority);
    if (b.cap !== undefined) data.cap = b.cap === null || b.cap === "" ? null : Number(b.cap);
    if (b.active != null) data.active = Boolean(b.active);
    if (b.notes !== undefined) data.notes = b.notes;
    if (b.balance != null) data.balance = Number(b.balance) || 0; // manual balance correction
    const fund = await prisma.fund.update({ where: { id: b.id }, data });
    return NextResponse.json({ fund });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const fund = await prisma.fund.findUnique({ where: { id } });
  if (!fund) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (fund.isSystem) {
    return NextResponse.json({ error: "system fund cannot be deleted" }, { status: 400 });
  }
  await prisma.fund.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
