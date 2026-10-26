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
  /** The rate actually selected for purchase (shown in Live). */
  selected?: { service: string | null; price: number; calDays: number } | null;
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
    reasonRu?: string;
  } | null;
}

export interface EngineLine {
  text: string;
  /** rules = the weather table decided; summer = fell back to summer rules;
   *  dry = no temperature logic; off = engine switched off. */
  mode: "rules" | "summer" | "dry" | "off";
  /** Folded "подробнее" lines. */
  details: string[];
  /** Temperature (°C) that colours the line; absent when not weather-based. */
  toneC?: number | null;
}

/**
 * Background/foreground for the engine line by temperature (owner 2026-10-26):
 * a gradient from dark blue (frost) through light blue to light/dark red
 * (heat), so a glance shows whether the cold season has arrived.
 */
export function tempTone(c: number | null | undefined): { bg: string; fg: string } {
  if (c == null || !Number.isFinite(c)) return { bg: "#eef0f3", fg: "#1f2328" };
  if (c <= -10) return { bg: "#1e3a8a", fg: "#ffffff" }; // deep frost
  if (c <= -5) return { bg: "#1d4ed8", fg: "#ffffff" };
  if (c <= 0) return { bg: "#3b82f6", fg: "#ffffff" };
  if (c <= 5) return { bg: "#93c5fd", fg: "#0b1f44" };
  if (c <= 10) return { bg: "#bfdbfe", fg: "#0b1f44" };
  if (c <= 15) return { bg: "#dbeafe", fg: "#0b1f44" }; // cool
  if (c <= 20) return { bg: "#f1f5f9", fg: "#1f2328" }; // mild
  if (c <= 24) return { bg: "#fee2e2", fg: "#5c0b0b" }; // warm
  if (c <= 28) return { bg: "#fca5a5", fg: "#4a0606" };
  if (c <= 32) return { bg: "#ef4444", fg: "#ffffff" }; // hot
  return { bg: "#991b1b", fg: "#ffffff" }; // extreme heat
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

  // Owner format (2026-10-26): temperatures and the day limit only — the
  // carrier/price/days already sit in the Carrier box right above.
  //   Clearwater 28°C → Loveland, CO 20°C · Chilled · макс. 4 дн.
  const place =
    [s.destCity, s.destState].filter(Boolean).join(", ") || "получатель";
  const parts = [
    `Clearwater ${deg(s.originMaxC)} → ${place} ${deg(s.destMaxC)}`,
    label(cls),
    s.allowedDays == null || !Number.isFinite(s.allowedDays)
      ? "без лимита дней"
      : `макс. ${s.allowedDays} дн.`,
  ];
  // Live: the rate actually chosen for purchase. Shadow: what the engine
  // WOULD buy — kept for the details only.
  const live = (input.rateProfile ?? "") === "live";
  const chosen = live && input.selected ? input.selected : s.pick ?? null;
  if (!live && s.pick) {
    // Shadow: the purchase goes by summer, so say what the engine would buy.
    parts.push(`движок выбрал бы ${s.pick.calDays} дн. за ${money(s.pick.price)}`);
  }
  const details: string[] = [];
  if (s.reasonRu) details.push(`Почему ${s.allowedDays} дн.: ${s.reasonRu}`);
  if (
    s.routeMaxC != null &&
    (s.destMaxC == null || Math.round(s.routeMaxC) !== Math.round(s.destMaxC))
  ) {
    details.push(`Максимум по пути (середина маршрута и получатель): ${deg(s.routeMaxC)}`);
  }
  if (s.iceBase != null) {
    details.push(
      s.extraIce > 0
        ? `Лёд: ${s.iceBase} + ${s.extraIce} доп. = ${s.iceTotal ?? s.iceBase + s.extraIce} шт (+${s.iceWeightDeltaLb ?? s.extraIce} lb к весу)`
        : `Лёд: ${s.iceBase} шт`,
    );
  }
  if (s.summerPrice != null && chosen) {
    const diff = s.summerPrice - chosen.price;
    details.push(
      Math.abs(diff) < 0.01
        ? `По летним правилам: ${money(s.summerPrice)} — так же`
        : diff > 0
          ? `По летним правилам: ${money(s.summerPrice)} — экономия ${money(diff)}`
          : `По летним правилам: ${money(s.summerPrice)} — дороже на ${money(-diff)}`,
    );
  }
  if (s.longerTransitPrices && s.longerTransitPrices.length > 0) {
    details.push(
      "Самые дешёвые по сроку: " +
        s.longerTransitPrices
          .map((p) => `${p.calDays} дн. ${money(p.price)}`)
          .join(" · "),
    );
  }
  // Tone follows the warmest point the engine decided on (route incl.
  // destination), falling back to the destination.
  const toneC = s.routeMaxC ?? s.destMaxC ?? null;
  return { text: parts.join(" · "), mode: "rules", details, toneC };
}
