import { test } from "node:test";
import assert from "node:assert/strict";
import {
  importAuditRecords,
  pickUnambiguous,
  reclassifyAll,
  type AdjRow,
  type AuditDb,
} from "../audit-import";

/**
 * База в памяти: понимает ровно те where, что строит импорт —
 * равенство по полям и OR из таких же равенств.
 */
function memoryDb(seed: AdjRow[]) {
  const rows = seed.map((r) => ({ ...r }));
  const updates: string[] = [];
  const matches = (row: AdjRow, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) =>
      k === "OR"
        ? (v as Record<string, unknown>[]).some((w) => matches(row, w))
        : row[k] === v
    );
  const db: AuditDb = {
    shippingAdjustment: {
      async findMany({ where }) {
        return rows.filter((r) => matches(r, where)).map((r) => ({ ...r }));
      },
      async update({ where, data }) {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        updates.push(where.id);
        return row;
      },
    },
  };
  const get = (id: string) => rows.find((r) => r.id === id)!;
  return { db, rows, updates, get };
}

const fedexAudited = {
  auditSource: "FEDEX_API",
  auditedDimL: 22,
  auditedDimW: 13,
  auditedDimH: 13,
  auditedDimUnit: "IN",
  auditedWeight: 9,
  auditedWeightUnit: "LB",
  enteredDimL: 12,
  enteredDimW: 12,
  enteredDimH: 10,
  enteredDimUnit: "IN",
  enteredWeight: 9,
  enteredWeightUnit: "LB",
  chargeBreakdown: JSON.stringify([{ label: "Base postage", amount: -7.1 }]),
  amountAlreadyPaid: 12.5,
  disputeClass: "DISCREPANCY",
};

const row = (id: string, extra: Record<string, unknown> = {}): AdjRow => ({
  id,
  storeId: "store1",
  orderId: null,
  amazonOrderId: null,
  trackingNumber: null,
  financialEventId: null,
  adjustmentAmount: -5,
  disputeClass: null,
  auditSource: null,
  ...extra,
});

test("1. строка ошибки сборщика не обнуляет уже собранный аудит", async () => {
  const { db, get, updates } = memoryDb([
    row("a", { orderId: "111-1", financialEventId: "EV1", ...fedexAudited }),
  ]);
  const res = await importAuditRecords(
    [{ orderId: "111-1", financialEventId: "EV1", error: "details HTTP 503" }],
    { storeId: "store1", db }
  );
  assert.equal(res.updated, 0);
  assert.equal(res.skipped.length, 1);
  assert.equal(res.skipped[0].reason, "collector_error");
  assert.deepEqual(updates, []);
  const r = get("a");
  assert.equal(r.auditSource, "FEDEX_API");
  assert.equal(r.auditedDimL, 22);
  assert.equal(r.auditedWeight, 9);
  assert.equal(r.chargeBreakdown, fedexAudited.chargeBreakdown);
  assert.equal(r.disputeClass, "DISCREPANCY");
});

test("2. частичный импорт сохраняет заполненные поля, 0 записывается как 0", async () => {
  const { db, get } = memoryDb([
    row("a", { orderId: "111-2", financialEventId: "EV2", ...fedexAudited }),
  ]);
  const res = await importAuditRecords(
    [
      {
        orderId: "111-2",
        financialEventId: "EV2",
        // аудита и разбивки в записи нет, суммы частично: 0 — валидное значение
        auditedDims: null,
        charges: [],
        amountAlreadyPaid: 0,
        totalChargeFromCarrier: "",
        transactionTotal: -5,
        detailsUrl: "https://sellercentral.amazon.com/payments/event/details?financialEventId=EV2",
      },
    ],
    { storeId: "store1", db }
  );
  assert.equal(res.matched, 1);
  assert.equal(res.unparsed, 1);
  const r = get("a");
  // собранный FedEx-аудит на месте
  assert.equal(r.auditSource, "FEDEX_API");
  assert.equal(r.auditedDimL, 22);
  assert.equal(r.auditedDimH, 13);
  assert.equal(r.auditedWeight, 9);
  assert.equal(r.enteredDimL, 12);
  assert.equal(r.chargeBreakdown, fedexAudited.chargeBreakdown);
  // 0 — это 0, а не «нет значения»; пустая строка — не 0
  assert.equal(r.amountAlreadyPaid, 0);
  assert.equal(r.totalChargeFromCarrier, undefined);
  assert.equal(r.transactionTotal, -5);
  assert.match(String(r.transactionDetailsUrl), /EV2$/);
});

test("3. несколько списаний одного заказа не сливаются в одну строку", async () => {
  const { db, get } = memoryDb([
    row("a", { orderId: "111-3", trackingNumber: "TRK3", adjustmentAmount: -4.25 }),
    row("b", { orderId: "111-3", trackingNumber: "TRK3", adjustmentAmount: -9.8 }),
  ]);
  const res = await importAuditRecords(
    [
      // суммы нет, кандидатов два — пропуск, а не «первая строка»
      { orderId: "111-3", financialEventId: "EV3C", trackingNumber: "TRK3", auditedDims: "50 x 50 x 50 in" },
      // у каждой транзакции своя сумма — привязка однозначна
      { orderId: "111-3", financialEventId: "EV3A", trackingNumber: "TRK3", transactionTotal: -4.25, auditedDims: "14 x 12 x 10 in", auditedWeight: "5 lb" },
      { orderId: "111-3", financialEventId: "EV3B", trackingNumber: "TRK3", transactionTotal: -9.8, auditedDims: "30 x 12 x 10 in", auditedWeight: "12 lb" },
      // повтор транзакции EV3A с другой формой — та же строка второй раз не пишется
      { orderId: "111-3", trackingNumber: "TRK3", transactionTotal: -4.25, auditedDims: "99 x 99 x 99 in" },
    ],
    { storeId: "store1", db }
  );
  assert.equal(get("a").financialEventId, "EV3A");
  assert.equal(get("a").auditedDimL, 14);
  assert.equal(get("b").financialEventId, "EV3B");
  assert.equal(get("b").auditedDimL, 30);
  assert.deepEqual(
    res.skipped.map((s) => s.reason),
    ["ambiguous", "duplicate_target"]
  );
  assert.equal(res.updated, 2);
});

test("4. совпадение ID транзакции между магазинами не смешивает данные", async () => {
  const { db, get } = memoryDb([
    row("s1", { storeId: "store1", financialEventId: "EVX", orderId: "111-4" }),
    row("s3", { storeId: "store3", financialEventId: "EVX", orderId: "111-4", ...fedexAudited }),
  ]);
  const rec = { orderId: "111-4", financialEventId: "EVX", auditedDims: "20 x 10 x 10 in", auditedWeight: "4 lb" };

  // с магазином — пишется только в свой
  const scoped = await importAuditRecords([rec], { storeId: "store1", db });
  assert.equal(scoped.updated, 1);
  assert.equal(get("s1").auditedDimL, 20);
  assert.equal(get("s3").auditedDimL, 22);
  assert.equal(get("s3").auditSource, "FEDEX_API");

  // без магазина — две строки на один ID: неоднозначно, ничего не пишем
  const unscoped = await importAuditRecords([rec], { db });
  assert.equal(unscoped.updated, 0);
  assert.equal(unscoped.skipped[0].reason, "ambiguous");
  assert.match(unscoped.skipped[0].detail, /store1, store3/);
  assert.equal(get("s3").auditedDimL, 22);
});

test("5. серверные классы и прочие магазины остаются неизменными", async () => {
  const { db, get, updates } = memoryDb([
    row("srv", { financialEventId: "EV5", orderId: "111-5", disputeClass: "UNEXPLAINED_CHARGE" }),
    row("loc", { financialEventId: "EV6", orderId: "111-6", disputeClass: "NO_AUDIT_DATA", enteredDimL: 10, enteredDimW: 10, enteredDimH: 10, enteredDimUnit: "IN" }),
    row("other", { storeId: "store3", orderId: "999-1", ...fedexAudited, auditedDimL: 40, disputeClass: "NO_AUDIT_DATA" }),
  ]);
  const res = await importAuditRecords(
    [
      { orderId: "111-5", financialEventId: "EV5", auditedDims: "30 x 10 x 10 in" },
      { orderId: "111-6", financialEventId: "EV6", auditedDims: "30 x 10 x 10 in" },
    ],
    { storeId: "store1", db }
  );
  assert.equal(res.serverClassKept, 1);
  assert.equal(get("srv").disputeClass, "UNEXPLAINED_CHARGE");
  assert.equal(get("srv").auditedDimL, 30); // аудит записан, класс — нет
  assert.equal(get("loc").disputeClass, "GROSS_DIM"); // локальный класс пересчитан
  // строка другого магазина не тронута: глобального пересчёта больше нет
  assert.equal(get("other").disputeClass, "NO_AUDIT_DATA");
  assert.ok(!updates.includes("other"));

  // ручной пересчёт по магазину тоже не трогает серверный класс и чужой магазин
  const counts = await reclassifyAll({ storeId: "store1", db });
  assert.equal(counts.UNEXPLAINED_CHARGE, 1);
  assert.equal(get("srv").disputeClass, "UNEXPLAINED_CHARGE");
  assert.equal(get("other").disputeClass, "NO_AUDIT_DATA");
});

test("сборщик: трек берётся только при однозначном совпадении", () => {
  const cands = [
    { trackingNumber: "T1", amount: -4.25 },
    { trackingNumber: "T2", amount: -9.8 },
  ];
  assert.deepEqual(pickUnambiguous(cands, -9.8, (c) => c.amount), { hit: cands[1] });
  assert.deepEqual(pickUnambiguous(cands, null, (c) => c.amount), { reason: "ambiguous", count: 2 });
  assert.deepEqual(pickUnambiguous(cands, -1, (c) => c.amount), { reason: "amount_mismatch", count: 2 });
  assert.deepEqual(pickUnambiguous([cands[0]], null, (c) => c.amount), { hit: cands[0] });
  assert.equal(pickUnambiguous([], -1, (c: { amount: number }) => c.amount), null);
});
