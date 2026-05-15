// Builds the morning Telegram brief for upcoming frozen risks.
// n8n calls GET /api/frozen/morning-summary at 07:00 ET, takes `telegramMessage`,
// and pipes it to the bot with parse_mode=HTML.

import { prisma } from "@/lib/prisma";

export interface MorningSummary {
  date: string;
  total: number;
  byLevel: {
    ok: number;
    low: number;
    medium: number;
    high: number;
    critical: number;
  };
  topAlerts: Array<{
    orderId: string;
    sku: string;
    destCity: string;
    destState: string;
    riskLevel: string;
    topRecommendation: string;
  }>;
  telegramMessage: string;
}

const LEVEL_EMOJI: Record<string, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🟢",
  ok: "⚪",
};

export async function buildMorningSummary(): Promise<MorningSummary> {
  const today = new Date().toISOString().slice(0, 10);

  const alerts = await prisma.frozenRiskAlert.findMany({
    where: {
      shipDate: { gte: today },
      status: "pending",
      riskLevel: { in: ["medium", "high", "critical"] },
    },
    orderBy: [{ riskScore: "desc" }, { shipDate: "asc" }],
    take: 50,
  });

  const byLevel = { ok: 0, low: 0, medium: 0, high: 0, critical: 0 };
  for (const a of alerts) {
    if (a.riskLevel in byLevel) {
      byLevel[a.riskLevel as keyof typeof byLevel]++;
    }
  }

  const topAlerts = alerts.slice(0, 5).map((a) => {
    let topRec = "";
    try {
      const recs = JSON.parse(a.recommendations) as string[];
      topRec = recs[0] ?? "";
    } catch {
      /* malformed JSON — leave empty */
    }
    return {
      orderId: a.orderId,
      sku: a.sku,
      destCity: a.destCity || "Unknown",
      destState: a.destState || "",
      riskLevel: a.riskLevel,
      topRecommendation: topRec,
    };
  });

  const lines: string[] = [];
  lines.push(`🌡️ <b>Frozen Risk — ${today}</b>`);
  lines.push(`Total active alerts: ${alerts.length}`);
  lines.push(`🔴 CRITICAL: ${byLevel.critical}`);
  lines.push(`🟠 HIGH: ${byLevel.high}`);
  lines.push(`🟡 MEDIUM: ${byLevel.medium}`);

  if (topAlerts.length > 0) {
    lines.push("");
    lines.push("Top 5:");
    for (const a of topAlerts) {
      const emoji = LEVEL_EMOJI[a.riskLevel] ?? "⚠️";
      lines.push(`• ${emoji} ${a.orderId} → ${a.destCity}, ${a.destState}`);
      if (a.topRecommendation) lines.push(`  ${a.topRecommendation}`);
    }
  }
  lines.push("");
  lines.push("Open: /frozen-analytics");

  return {
    date: today,
    total: alerts.length,
    byLevel,
    topAlerts,
    telegramMessage: lines.join("\n"),
  };
}
