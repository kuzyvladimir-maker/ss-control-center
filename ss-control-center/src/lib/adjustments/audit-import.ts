/**
 * Приём настоящего аудита габаритов со страницы Transaction Details.
 *
 * Данные собирает отдельный сборщик и кладёт JSON-массивом; формат полей там
 * пока не зацементирован, поэтому парсеры ниже нарочно терпимые: габариты
 * принимаются и строкой «13 x 42 x 11 in», и массивом [13,42,11], и объектом
 * { length, width, height, unit }. Падать из-за того, что сборщик поменял
 * форму записи, реестр не должен — он должен сказать, сколько строк не понял.
 */
import { prisma } from "@/lib/prisma";
import {
  AUDIT_SOURCES,
  classifyByAudit,
  type ChargeLine,
} from "@/lib/adjustments/audit-classify";

export interface ParsedDims {
  l: number;
  w: number;
  h: number;
  unit: string;
}

export interface ParsedWeight {
  value: number;
  unit: string;
}

const numOf = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export function parseDims(raw: unknown): ParsedDims | null {
  if (raw == null) return null;

  if (Array.isArray(raw)) {
    const [l, w, h] = raw.map(numOf);
    if (l == null || w == null || h == null) return null;
    return { l, w, h, unit: "IN" };
  }

  if (typeof raw === "string") {
    const nums = raw.match(/\d+(?:\.\d+)?/g);
    if (!nums || nums.length < 3) return null;
    const unit = /cm/i.test(raw) ? "CM" : "IN";
    return { l: parseFloat(nums[0]), w: parseFloat(nums[1]), h: parseFloat(nums[2]), unit };
  }

  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const l = numOf(o.l ?? o.length ?? o.L);
    const w = numOf(o.w ?? o.width ?? o.W);
    const h = numOf(o.h ?? o.height ?? o.H);
    if (l == null || w == null || h == null) return null;
    const unitRaw = typeof o.unit === "string" ? o.unit : typeof o.units === "string" ? o.units : "IN";
    return { l, w, h, unit: /cm/i.test(unitRaw) ? "CM" : "IN" };
  }

  return null;
}

export function parseWeight(raw: unknown): ParsedWeight | null {
  if (raw == null) return null;

  if (typeof raw === "number") {
    return Number.isFinite(raw) ? { value: raw, unit: "LB" } : null;
  }

  if (typeof raw === "string") {
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return null;
    const unit = /kg/i.test(raw) ? "KG" : /oz/i.test(raw) ? "OZ" : "LB";
    return { value: n, unit };
  }

  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const value = numOf(o.value ?? o.weight ?? o.lbs ?? o.amount);
    if (value == null) return null;
    const unitRaw = typeof o.unit === "string" ? o.unit : typeof o.units === "string" ? o.units : "LB";
    const unit = /kg/i.test(unitRaw) ? "KG" : /oz/i.test(unitRaw) ? "OZ" : "LB";
    return { value, unit };
  }

  return null;
}

export function parseCharges(raw: unknown): ChargeLine[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x): ChargeLine | null => {
      if (!x || typeof x !== "object") return null;
      const o = x as Record<string, unknown>;
      const label =
        typeof o.label === "string"
          ? o.label
          : typeof o.name === "string"
            ? o.name
            : typeof o.description === "string"
              ? o.description
              : null;
      const amount = numOf(o.amount ?? o.value ?? o.charge);
      if (!label || amount == null) return null;
      return { label: label.trim(), amount };
    })
    .filter((x): x is ChargeLine => x !== null);
}

/** Одна запись аудита из файла сборщика. */
export interface AuditRecord {
  orderId?: string | null;
  financialEventId?: string | null;
  trackingNumber?: string | null;
  enteredDims?: unknown;
  enteredWeight?: unknown;
  auditedDims?: unknown;
  auditedWeight?: unknown;
  charges?: unknown;
  amountAlreadyPaid?: unknown;
  totalChargeFromCarrier?: unknown;
  transactionTotal?: unknown;
  detailsUrl?: string | null;
  transactionDetailsUrl?: string | null;
}

export interface ImportResult {
  total: number;
  matched: number;
  updated: number;
  unmatched: Array<{ orderId?: string | null; trackingNumber?: string | null }>;
  unparsed: number;
}

/**
 * Находит строку списания по аудиту. Порядок поиска — от самого надёжного
 * ключа к самому слабому: трек-номер уникален, financialEventId привязан к
 * конкретной проводке, order id может дать несколько строк.
 */
async function findAdjustment(rec: AuditRecord, storeId?: string) {
  const scope = storeId ? { storeId } : {};

  if (rec.trackingNumber) {
    const byTracking = await prisma.shippingAdjustment.findFirst({
      where: { trackingNumber: rec.trackingNumber, ...scope },
      orderBy: { adjustmentDate: "desc" },
    });
    if (byTracking) return byTracking;
  }
  if (rec.financialEventId) {
    const byEvent = await prisma.shippingAdjustment.findFirst({
      where: { financialEventId: rec.financialEventId, ...scope },
    });
    if (byEvent) return byEvent;
  }
  if (rec.orderId) {
    return prisma.shippingAdjustment.findFirst({
      where: {
        OR: [{ amazonOrderId: rec.orderId }, { orderId: rec.orderId }],
        ...scope,
      },
      orderBy: { adjustmentDate: "desc" },
    });
  }
  return null;
}

export async function importAuditRecords(
  records: AuditRecord[],
  opts: { storeId?: string; source?: string } = {}
): Promise<ImportResult> {
  const source = opts.source ?? AUDIT_SOURCES.TRANSACTION_DETAILS;
  const result: ImportResult = {
    total: records.length,
    matched: 0,
    updated: 0,
    unmatched: [],
    unparsed: 0,
  };

  for (const rec of records) {
    const row = await findAdjustment(rec, opts.storeId);
    if (!row) {
      result.unmatched.push({ orderId: rec.orderId, trackingNumber: rec.trackingNumber });
      continue;
    }
    result.matched++;

    const entered = parseDims(rec.enteredDims);
    const enteredW = parseWeight(rec.enteredWeight);
    const audited = parseDims(rec.auditedDims);
    const auditedW = parseWeight(rec.auditedWeight);
    const charges = parseCharges(rec.charges);

    if (!audited && !auditedW) result.unparsed++;

    const data = {
      enteredDimL: entered?.l ?? null,
      enteredDimW: entered?.w ?? null,
      enteredDimH: entered?.h ?? null,
      enteredDimUnit: entered?.unit ?? null,
      enteredWeight: enteredW?.value ?? null,
      enteredWeightUnit: enteredW?.unit ?? null,
      auditedDimL: audited?.l ?? null,
      auditedDimW: audited?.w ?? null,
      auditedDimH: audited?.h ?? null,
      auditedDimUnit: audited?.unit ?? null,
      auditedWeight: auditedW?.value ?? null,
      auditedWeightUnit: auditedW?.unit ?? null,
      auditSource: audited || auditedW ? source : null,
      auditCapturedAt: audited || auditedW ? new Date() : null,
      chargeBreakdown: charges.length ? JSON.stringify(charges) : null,
      amountAlreadyPaid: numOf(rec.amountAlreadyPaid),
      totalChargeFromCarrier: numOf(rec.totalChargeFromCarrier),
      transactionTotal: numOf(rec.transactionTotal),
      financialEventId: rec.financialEventId ?? row.financialEventId ?? null,
      transactionDetailsUrl:
        rec.transactionDetailsUrl ?? rec.detailsUrl ?? row.transactionDetailsUrl ?? null,
    };

    const cls = classifyByAudit({ ...row, ...data });

    await prisma.shippingAdjustment.update({
      where: { id: row.id },
      data: { ...data, disputeClass: cls.cls },
    });
    result.updated++;
  }

  return result;
}

/**
 * Пересчитывает класс на всех строках — после смены порогов или после того,
 * как источник у части строк переставили на честный.
 */
export async function reclassifyAll(): Promise<Record<string, number>> {
  const rows = await prisma.shippingAdjustment.findMany({
    select: {
      id: true,
      auditSource: true,
      enteredDimL: true,
      enteredDimW: true,
      enteredDimH: true,
      enteredDimUnit: true,
      enteredWeight: true,
      enteredWeightUnit: true,
      auditedDimL: true,
      auditedDimW: true,
      auditedDimH: true,
      auditedDimUnit: true,
      auditedWeight: true,
      auditedWeightUnit: true,
      declaredDimL: true,
      declaredDimW: true,
      declaredDimH: true,
      declaredWeightLbs: true,
      chargeBreakdown: true,
      disputeClass: true,
    },
  });

  const counts: Record<string, number> = {};
  for (const row of rows) {
    const cls = classifyByAudit(row).cls;
    counts[cls] = (counts[cls] ?? 0) + 1;
    if (row.disputeClass !== cls) {
      await prisma.shippingAdjustment.update({
        where: { id: row.id },
        data: { disputeClass: cls },
      });
    }
  }
  return counts;
}
