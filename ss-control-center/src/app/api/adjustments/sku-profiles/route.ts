import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const profiles = await prisma.skuAdjustmentProfile.findMany({
    orderBy: { totalAdjustments: "desc" },
  });

  return NextResponse.json(profiles);
}
