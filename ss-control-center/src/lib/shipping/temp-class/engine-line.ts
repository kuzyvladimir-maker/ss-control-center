/**
 * The one engine line on a shipping card — the SAME shape on every card, in
 * one place, readable in a second (owner, 2026-10-25):
 *
 *   Clearwater 28°C → Ypsilanti, MI 24°C · Frozen · до 2 дн. в пути · движок: FedEx 2Day $40.33 (+$22.21)
 *
 * Details (ice, prices for longer transit, why) fold into "подробнее". When
 * the engine didn't run, the same line says exactly why. Built only from what
 * the plan already computed — no extra API calls. Texts are Russian on the
 * owner's explicit request for this line.
 */

export type EngineSkipReason =
  | "not_amazon"
  | "no_box"
  | "box_unrecognized"
  | "no_zip"
  | "no_rates"
  | "error";

export interface EngineLineInput {
  /** Resolved temperature class; null when the engine is off (Summer). */
  tempClass: string | null | undefined;
  /** Fallback Frozen/Dry type when the engine is off. */
  productType?: string | null;
  rateProfile?: string | null;
  engineSkip?: EngineSkipReason | null;
  boxSize?: string | null;
  shadow?: {
    originMaxC: number | null;
    routeMaxC: number | null;
    allowedDays: number | null;
    extraIce: number;
    iceBase?: number;
    iceTotal?: number;
    iceWeightDeltaLb?: number;
    noForecast: boolean;
    destCity?: string | null;
    destState?: string | null;
    destMaxC?: number | null;
    pick?: { service: string | null; price: number; calDays: number } | null;
    summerPrice?: number | null;
    savingsUsd?: number | null;
    longerTransitPrices?: Array<{ calDays: number; price: number }>;
  } | null;
}

export interface EngineLine {
  text: string;
  /** rules = the weather table decided; summer = fell back to summer rules;
   *  dry = no temperature logic; off = engine switched off. */
  mode: "rules" | "summer" | "dry" | "off";
  /** Folded "подробнее" lines. */
  details: string[];
}

const deg = (c: number | null | undefined) =>
  c == null || !Number.isFinite(c) ? "?°C" : `${Math.round(c)}°C`;

const label = (c: string) => c.charAt(0) + c.slice(1).toLowerCase();

const money = (n: number) => `$${n.toFixed(2)}`;

function skipText(reason: EngineSkipReason, boxSize?: string | null): string {
  switch (reason) {
    case "not_amazon":
      return "движок работает только для Amazon";
    case "no_box":
      return "у заказа не задан размер коробки";
    case "box_unrecognized":
      return `коробка ${boxSize ?? "?"} больше любого кулера (XS–XL)`;
    case "no_zip":
      return "нет ZIP получателя";
    case "no_rates":
      return "Veeqo не дал тарифов";
    case "error":
      return "ошибка при расчёте погоды";
  }
}

export function formatEngineLine(input: EngineLineInput): EngineLine | null {
  const cls = (input.tempClass ?? "").toUpperCase();

  if (!cls) {
    // Engine off (Summer) — say so on cold orders, stay quiet on dry ones.
    if ((input.productType ?? "").toLowerCase() === "frozen") {
      return {
        text: "Frozen · движок выключен (Summer) — правила лета",
        mode: "off",
        details: [],
      };
    }
    return null;
  }
  if (cls === "DRY") {
    return {
      text: "Dry · без температурных ограничений — самый дешёвый тариф",
      mode: "dry",
      details: [],
    };
  }

  const s = input.shadow;
  if (!s) {
    const why = input.engineSkip
      ? skipText(input.engineSkip, input.boxSize)
      : "заказ остановлен до расчёта тарифа";
    return {
      text: `${label(cls)} · движок не запущен: ${why} — правила лета`,
      mode: "summer",
      details: [],
    };
  }
  if (s.noForecast) {
    return {
      text: `${label(cls)} · нет прогноза погоды — правила лета`,
      mode: "summer",
      details: [],
    };
  }

  const place =
    [s.destCity, s.destState].filter(Boolean).join(", ") || "получатель";
  const parts = [`Clearwater ${deg(s.originMaxC)} → ${place} ${deg(s.destMaxC)}`];
  // The engine decides on the ROUTE max (midpoint + destination); show it when
  // it differs from the destination so the day limit is explained.
  if (
    s.routeMaxC != null &&
    (s.destMaxC == null || Math.round(s.routeMaxC) !== Math.round(s.destMaxC))
  ) {
    parts.push(`по пути до ${deg(s.routeMaxC)}`);
  }
  parts.push(label(cls));
  parts.push(
    s.allowedDays == null || !Number.isFinite(s.allowedDays)
      ? "без лимита дней"
      : `до ${s.allowedDays} дн. в пути`,
  );
  if (s.pick) {
    const diff = s.savingsUsd;
    const delta =
      diff == null || Math.abs(diff) < 0.01
        ? "тот же тариф"
        : diff > 0
          ? `дешевле на ${money(diff)}`
          : `дороже на ${money(-diff)}`;
    parts.push(
      `движок: ${s.pick.service ?? "?"} ${money(s.pick.price)}, ${s.pick.calDays} дн. (${delta})`,
    );
  } else {
    parts.push("движок: нет тарифа в лимите — берётся летний");
  }

  const details: string[] = [];
  if (s.iceBase != null) {
    details.push(
      s.extraIce > 0
        ? `Лёд: ${s.iceBase} + ${s.extraIce} доп. = ${s.iceTotal ?? s.iceBase + s.extraIce} шт (+${s.iceWeightDeltaLb ?? s.extraIce} lb к весу этикетки)`
        : `Лёд: ${s.iceBase} шт (обычная норма)`,
    );
  }
  if (s.summerPrice != null) {
    details.push(`Сейчас по правилам лета: ${money(s.summerPrice)}`);
  }
  if (s.longerTransitPrices && s.longerTransitPrices.length > 0) {
    details.push(
      "Самые дешёвые тарифы по сроку в пути: " +
        s.longerTransitPrices
          .map((p) => `${p.calDays} дн. ${money(p.price)}`)
          .join(" · "),
    );
  }
  return { text: parts.join(" · "), mode: "rules", details };
}
