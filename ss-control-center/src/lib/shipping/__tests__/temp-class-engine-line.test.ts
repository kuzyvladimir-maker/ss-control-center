import { test } from "node:test";
import assert from "node:assert/strict";
import { formatEngineLine } from "../temp-class/engine-line";

const base = {
  originMaxC: 28.4,
  routeMaxC: 24.2,
  allowedDays: 2,
  extraIce: 0,
  iceBase: 9,
  iceTotal: 9,
  iceWeightDeltaLb: 0,
  noForecast: false,
  destCity: "Ypsilanti",
  destState: "MI",
  destMaxC: 23.9,
  pick: { service: "FedEx 2Day®", price: 40.33, calDays: 2 },
  summerPrice: 18.12,
  savingsUsd: -22.21,
  longerTransitPrices: [{ calDays: 3, price: 18.12 }],
};

test("owner's card: route, class, day limit and the engine's pick vs current price on ONE line", () => {
  const r = formatEngineLine({ tempClass: "FROZEN", shadow: base });
  assert.equal(
    r?.text,
    "Clearwater 28°C → Ypsilanti, MI 24°C · Frozen · до 2 дн. в пути · движок: FedEx 2Day® $40.33, 2 дн. (дороже на $22.21)",
  );
  assert.equal(r?.mode, "rules");
  assert.deepEqual(r?.details, [
    "Лёд: 9 шт (обычная норма)",
    "Сейчас по правилам лета: $18.12",
    "Самые дешёвые тарифы по сроку в пути: 3 дн. $18.12",
  ]);
});

test("route max shown only when it differs from the destination; savings and extra ice", () => {
  const r = formatEngineLine({
    tempClass: "CHILLED",
    shadow: {
      ...base,
      routeMaxC: 9.2,
      destMaxC: 4.1,
      allowedDays: 4,
      extraIce: 2,
      iceTotal: 11,
      iceWeightDeltaLb: 2,
      pick: { service: "UPS® Ground", price: 13.1, calDays: 4 },
      savingsUsd: 5.02,
    },
  });
  assert.match(r!.text, /→ Ypsilanti, MI 4°C · по пути до 9°C · Chilled · до 4 дн\. в пути · движок: UPS® Ground \$13\.10, 4 дн\. \(дешевле на \$5\.02\)$/);
  assert.equal(r?.details[0], "Лёд: 9 + 2 доп. = 11 шт (+2 lb к весу этикетки)");
});

test("engine not run → the same line with the exact reason", () => {
  assert.equal(
    formatEngineLine({ tempClass: "FROZEN", shadow: null, engineSkip: "box_unrecognized", boxSize: "30x30x30" })?.text,
    "Frozen · движок не запущен: коробка 30x30x30 больше любого кулера (XS–XL) — правила лета",
  );
  assert.equal(
    formatEngineLine({ tempClass: "FROZEN", shadow: null, engineSkip: "no_box" })?.text,
    "Frozen · движок не запущен: у заказа не задан размер коробки — правила лета",
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
