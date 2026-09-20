/**
 * GET /api/adjustments/dispute-pack?class=A|D&days=180
 *
 * Готовый пакет доказательств для кейса. Один кейс подаётся не на заказ, а на
 * ПАТТЕРН: 200+ отдельных обращений никто не рассмотрит, а таблица из данных
 * самого перевозчика рассматривается как одно заявление.
 *
 *   класс A — замер перевозчика не больше заявленного, доначислять не за что
 *   класс D — замер раздут в 2.5+ раза, машинная ошибка измерителя
 *
 * Отдаёт и структурой (для UI), и готовым текстом (для вставки в обращение).
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  classifyAdjustment,
  DISPUTE_CLASS_LABEL,
  type DisputeClass,
} from "@/lib/adjustments/carrier-measure";

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const want = (sp.get("class") || "D").toUpperCase() as DisputeClass;
  const days = Math.min(400, Math.max(7, parseInt(sp.get("days") || "180")));
  const carrier = (sp.get("carrier") || "").toUpperCase();
  const since = new Date(Date.now() - days * 86400_000);

  const rows = await prisma.shippingAdjustment.findMany({
    where: {
      adjustmentAmount: { lt: 0 },
      adjustedDimL: { not: null },
      createdAt: { gte: since },
      ...(carrier ? { carrier } : {}),
    },
    orderBy: { adjustmentAmount: "asc" },
  });

  const items = rows
    .map((r) => ({ row: r, ...classifyAdjustment(r) }))
    .filter((x) => x.cls === want)
    .map(({ row, declared, measured }) => ({
      date: row.adjustmentDate,
      trackingNumber: row.trackingNumber,
      orderId: row.amazonOrderId,
      sku: row.sku,
      carrier: row.carrier,
      amount: row.adjustmentAmount,
      labelCost: row.originalLabelCost,
      declared: {
        L: row.declaredDimL, W: row.declaredDimW, H: row.declaredDimH,
        weight: row.declaredWeightLbs, billable: Math.round(declared * 10) / 10,
      },
      measured: {
        L: row.adjustedDimL, W: row.adjustedDimW, H: row.adjustedDimH,
        weight: row.adjustedWeightLbs, billable: Math.round(measured * 10) / 10,
      },
      disputeCaseId: row.disputeCaseId,
    }));

  const total = Math.round(items.reduce((s, i) => s + i.amount, 0) * 100) / 100;

  const lines = [
    `Tracking | Ship date | Declared (L x W x H, lb) | ${
      items[0]?.carrier === "UPS" ? "UPS" : "Carrier"
    } record (L x W x H, lb) | Billable declared -> recorded | Amount charged`,
    ...items.map(
      (i) =>
        `${i.trackingNumber} | ${i.date} | ${i.declared.L}x${i.declared.W}x${i.declared.H}, ${i.declared.weight} lb | ` +
        `${i.measured.L}x${i.measured.W}x${i.measured.H}, ${i.measured.weight} lb | ` +
        `${i.declared.billable} -> ${i.measured.billable} lb | $${Math.abs(i.amount).toFixed(2)}`
    ),
  ];

  return NextResponse.json({
    class: want,
    label: DISPUTE_CLASS_LABEL[want] ?? null,
    count: items.length,
    totalCharged: total,
    items,
    evidenceTable: lines.join("\n"),
  });
}
