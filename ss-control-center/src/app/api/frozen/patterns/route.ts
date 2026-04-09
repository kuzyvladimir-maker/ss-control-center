import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

interface PatternGroup {
  label: string;
  total: number;
  thawed: number;
  thawRate: number;
  recommendation: string;
  level: "safe" | "warning" | "danger";
}

export async function GET() {
  const incidents = await prisma.frozenIncident.findMany();

  if (incidents.length === 0) {
    return NextResponse.json({
      combinations: [],
      byTransitDays: [],
      byOriginTemp: [],
      totalIncidents: 0,
    });
  }

  // Pattern 1: Carrier+Service combinations with high origin temp
  const combos: Record<string, { total: number; thawed: number }> = {};
  for (const inc of incidents) {
    const key = `${inc.carrier} ${inc.service}`;
    if (!combos[key]) combos[key] = { total: 0, thawed: 0 };
    combos[key].total++;
    if (inc.outcome === "thawed") combos[key].thawed++;
  }

  const combinations: PatternGroup[] = Object.entries(combos)
    .map(([label, data]) => {
      const rate = data.total > 0 ? data.thawed / data.total : 0;
      return {
        label,
        total: data.total,
        thawed: data.thawed,
        thawRate: Math.round(rate * 100),
        recommendation:
          rate >= 0.5
            ? "Consider switching to faster service"
            : rate >= 0.2
              ? "Monitor closely, consider extra ice"
              : "Safe combination",
        level: (rate >= 0.5 ? "danger" : rate >= 0.2 ? "warning" : "safe") as
          | "safe"
          | "warning"
          | "danger",
      };
    })
    .sort((a, b) => b.thawRate - a.thawRate);

  // Pattern 2: Thaw rate by transit days
  const transitBuckets: Record<string, { total: number; thawed: number }> = {
    "1 day": { total: 0, thawed: 0 },
    "2 days": { total: 0, thawed: 0 },
    "3 days": { total: 0, thawed: 0 },
    "4+ days": { total: 0, thawed: 0 },
  };
  for (const inc of incidents) {
    if (inc.daysInTransit === null) continue;
    const key =
      inc.daysInTransit <= 1
        ? "1 day"
        : inc.daysInTransit === 2
          ? "2 days"
          : inc.daysInTransit === 3
            ? "3 days"
            : "4+ days";
    transitBuckets[key].total++;
    if (inc.outcome === "thawed") transitBuckets[key].thawed++;
  }

  const byTransitDays = Object.entries(transitBuckets).map(([label, data]) => ({
    label,
    total: data.total,
    thawed: data.thawed,
    thawRate: data.total > 0 ? Math.round((data.thawed / data.total) * 100) : 0,
  }));

  // Pattern 3: Thaw rate by origin temperature
  const tempBuckets: Record<string, { total: number; thawed: number }> = {
    "<75F": { total: 0, thawed: 0 },
    "75-80F": { total: 0, thawed: 0 },
    "80-85F": { total: 0, thawed: 0 },
    ">85F": { total: 0, thawed: 0 },
  };
  for (const inc of incidents) {
    if (inc.originTempF === null) continue;
    const key =
      inc.originTempF < 75
        ? "<75F"
        : inc.originTempF < 80
          ? "75-80F"
          : inc.originTempF < 85
            ? "80-85F"
            : ">85F";
    tempBuckets[key].total++;
    if (inc.outcome === "thawed") tempBuckets[key].thawed++;
  }

  const byOriginTemp = Object.entries(tempBuckets).map(([label, data]) => ({
    label,
    total: data.total,
    thawed: data.thawed,
    thawRate: data.total > 0 ? Math.round((data.thawed / data.total) * 100) : 0,
  }));

  return NextResponse.json({
    combinations,
    byTransitDays,
    byOriginTemp,
    totalIncidents: incidents.length,
  });
}
