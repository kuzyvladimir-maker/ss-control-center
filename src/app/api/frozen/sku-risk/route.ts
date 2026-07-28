import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const profiles = await prisma.skuRiskProfile.findMany({
    orderBy: { riskScore: "desc" },
  });

  return NextResponse.json(profiles);
}
