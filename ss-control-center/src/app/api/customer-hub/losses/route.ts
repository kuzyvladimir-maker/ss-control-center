import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/customer-hub/losses?period=30&store=all
// Aggregates monetary losses across BuyerMessage actions and AtozzClaim
// decisions over a rolling window. All calculations use the stored
// `orderTotal` on BuyerMessage and `amountCharged` / `amountSaved` on
// AtozzClaim. COGS % and replacement label cost are read from the Setting
// table so Vladimir can tune them in /settings without a deploy.

const DEFAULT_COGS_PERCENT = 40;
const DEFAULT_REPLACEMENT_LABEL_COST = 12;

async function readNumericSetting(key: string, fallback: number): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key } });
  if (!row) return fallback;
  const parsed = parseFloat(row.value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const period = Math.max(1, parseInt(sp.get("period") || "30"));
    const store = sp.get("store") || "all";

    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - period);

    const [cogsPercentRaw, labelCostRaw] = await Promise.all([
      readNumericSetting("cogs_percent", DEFAULT_COGS_PERCENT),
      readNumericSetting("replacement_label_cost", DEFAULT_REPLACEMENT_LABEL_COST),
    ]);
    // Stored as "40" (meaning 40%), convert to decimal multiplier.
    const cogsMultiplier = cogsPercentRaw / 100;
    const labelCost = labelCostRaw;

    const storeFilter =
      store !== "all" && /^\d+$/.test(store)
        ? { storeIndex: parseInt(store, 10) }
        : {};

    // 1. Full refunds — treat orderTotal as the loss
    const refunds = await prisma.buyerMessage.findMany({
      where: {
        action: "full_refund",
        status: { in: ["SENT", "RESOLVED"] },
        createdAt: { gte: dateFrom },
        ...storeFilter,
      },
      select: { orderTotal: true },
    });
    const refundTotal = refunds.reduce(
      (sum, r) => sum + (r.orderTotal || 0),
      0
    );

    // 2. Partial refunds — estimate as 30% of orderTotal
    const partialRefunds = await prisma.buyerMessage.findMany({
      where: {
        action: "partial_refund",
        status: { in: ["SENT", "RESOLVED"] },
        createdAt: { gte: dateFrom },
        ...storeFilter,
      },
      select: { orderTotal: true },
    });
    const partialTotal = partialRefunds.reduce(
      (sum, r) => sum + (r.orderTotal || 0) * 0.3,
      0
    );

    // 3. Replacements — loss = COGS + estimated label
    const replacements = await prisma.buyerMessage.findMany({
      where: {
        action: "replacement",
        status: { in: ["SENT", "RESOLVED"] },
        createdAt: { gte: dateFrom },
        ...storeFilter,
      },
      select: { orderTotal: true },
    });
    const replacementTotal = replacements.reduce(
      (sum, r) => sum + (r.orderTotal || 0) * cogsMultiplier + labelCost,
      0
    );

    // 4. A-to-Z claims lost — actual amountCharged from Amazon decision
    const atozLost = await prisma.atozzClaim.findMany({
      where: {
        claimType: "A_TO_Z",
        amazonDecision: "AGAINST_US",
        createdAt: { gte: dateFrom },
      },
      select: { amountCharged: true },
    });
    const atozTotal = atozLost.reduce(
      (sum, c) => sum + (c.amountCharged || 0),
      0
    );

    // 5. Chargebacks lost
    const cbLost = await prisma.atozzClaim.findMany({
      where: {
        claimType: "CHARGEBACK",
        amazonDecision: "AGAINST_US",
        createdAt: { gte: dateFrom },
      },
      select: { amountCharged: true },
    });
    const cbTotal = cbLost.reduce(
      (sum, c) => sum + (c.amountCharged || 0),
      0
    );

    // 6. Saved — Amazon funded or decided in our favour
    const saved = await prisma.atozzClaim.findMany({
      where: {
        amazonDecision: { in: ["IN_OUR_FAVOR", "AMAZON_FUNDED"] },
        createdAt: { gte: dateFrom },
      },
      select: { amountSaved: true },
    });
    const savedTotal = saved.reduce(
      (sum, c) => sum + (c.amountSaved || 0),
      0
    );

    const total =
      refundTotal + partialTotal + replacementTotal + atozTotal + cbTotal;

    return NextResponse.json({
      period,
      store,
      total,
      breakdown: {
        refunds: { amount: refundTotal, count: refunds.length },
        partialRefunds: { amount: partialTotal, count: partialRefunds.length },
        replacements: {
          amount: replacementTotal,
          count: replacements.length,
        },
        atozLost: { amount: atozTotal, count: atozLost.length },
        chargebacksLost: { amount: cbTotal, count: cbLost.length },
      },
      saved: { amount: savedTotal, count: saved.length },
      config: {
        cogsPercent: cogsPercentRaw,
        replacementLabelCost: labelCost,
      },
    });
  } catch (err) {
    console.error("[customer-hub/losses] GET failed:", err);
    return NextResponse.json(
      { error: "Failed to compute losses" },
      { status: 500 }
    );
  }
}
