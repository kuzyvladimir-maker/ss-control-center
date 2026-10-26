import { test } from "node:test";
import assert from "node:assert/strict";
import { formatEngineLine, tempTone } from "../temp-class/engine-line";

const base = {
  originMaxC: 28.4,
  routeMaxC: 28.2,
  allowedDays: 4,
  extraIce: 0,
  iceBase: 5,
  iceTotal: 5,
  iceWeightDeltaLb: 0,
  noForecast: false,
  destCity: "Loveland",
  destState: "CO",
  destMaxC: 20.1,
  pick: { service: "UPS Ground Saver", price: 13.98, calDays: 4 },
  summerPrice: 24.15,
  savingsUsd: 10.17,
  longerTransitPrices: [{ calDays: 3, price: 18.5 }, { calDays: 4, price: 13.98 }],
  reasonRu: "охлаждёнка: 3 дн. как у заморозки +1 = 4 дн. (макс. 5)",
};

test("owner format: one short line — temps · class · max days; no carrier, no brackets", () => {
  const r = formatEngineLine({
    tempClass: "CHILLED",
    rateProfile: "live",
    selected: { service: "UPS Ground Saver", price: 13.98, calDays: 4 },
    shadow: base,
  });
  // Temperatures and the day limit only — the carrier/price are in the
  // Carrier box above (owner 2026-10-26).
  assert.equal(r?.text, "Clearwater 28°C → Loveland, CO 20°C · Chilled · макс. 4 дн.");
  assert.equal(r?.toneC, 28.2);
  assert.ok(!/[()]/.test(r!.text), "no explanations in brackets on the line");
  assert.deepEqual(r?.details, [
    "Почему 4 дн.: охлаждёнка: 3 дн. как у заморозки +1 = 4 дн. (макс. 5)",
    "Максимум по пути (середина маршрута и получатель): 28°C",
    "Лёд: 5 шт",
    "По летним правилам: $24.15 — экономия $10.17",
    "Самые дешёвые по сроку: 3 дн. $18.50 · 4 дн. $13.98",
  ]);
});

test("shadow says what the engine WOULD buy", () => {
  const r = formatEngineLine({ tempClass: "FROZEN", rateProfile: "shadow", shadow: { ...base, allowedDays: 3 } });
  assert.match(r!.text, /· Frozen · макс\. 3 дн\. · движок выбрал бы 4 дн\. за \$13\.98$/);
});

test("engine not run → the same place, the exact reason", () => {
  assert.equal(
    formatEngineLine({ tempClass: "FROZEN", shadow: null, engineSkip: "box_unrecognized", boxSize: "30x30x30" })?.text,
    "Frozen · движок не запущен: коробка 30x30x30 больше любого кулера (XS–XL) — правила лета",
  );
  assert.equal(
    formatEngineLine({ tempClass: "FROZEN", shadow: null })?.text,
    "Frozen · движок не запущен: заказ остановлен до расчёта тарифа — правила лета",
  );
});

test("no forecast; engine off (Summer); dry", () => {
  assert.equal(formatEngineLine({ tempClass: "FROZEN", shadow: { ...base, noForecast: true } })?.mode, "summer");
  assert.equal(formatEngineLine({ tempClass: null, productType: "Frozen" })?.text, "Frozen · движок выключен (Summer) — правила лета");
  assert.equal(formatEngineLine({ tempClass: null, productType: "Dry" }), null);
  assert.equal(formatEngineLine({ tempClass: "DRY" })?.mode, "dry");
});

test("tone: dark blue in frost → light blue when cool → neutral mild → light red warm → dark red heat", () => {
  assert.equal(tempTone(-12).bg, "#1e3a8a");
  assert.equal(tempTone(3).bg, "#93c5fd");
  assert.equal(tempTone(18).bg, "#f1f5f9");
  assert.equal(tempTone(22).bg, "#fee2e2");
  assert.equal(tempTone(28).bg, "#fca5a5");
  assert.equal(tempTone(35).bg, "#991b1b");
  assert.equal(tempTone(null).bg, "#eef0f3");
});
