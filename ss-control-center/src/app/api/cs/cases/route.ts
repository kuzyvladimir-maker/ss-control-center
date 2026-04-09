import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const status = searchParams.get("status");
  const channel = searchParams.get("channel");
  const category = searchParams.get("category");
  const priority = searchParams.get("priority");
  const date = searchParams.get("date"); // YYYY-MM-DD
  const limit = parseInt(searchParams.get("limit") || "50");
  const offset = parseInt(searchParams.get("offset") || "0");

  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (channel) where.channel = channel;
  if (category) where.category = category;
  if (priority) where.priority = priority;

  if (date) {
    const startOfDay = new Date(`${date}T00:00:00.000Z`);
    const endOfDay = new Date(`${date}T23:59:59.999Z`);
    where.createdAt = { gte: startOfDay, lte: endOfDay };
  }

  const [cases, total] = await Promise.all([
    prisma.csCase.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.csCase.count({ where }),
  ]);

  return NextResponse.json({ cases, total });
}
