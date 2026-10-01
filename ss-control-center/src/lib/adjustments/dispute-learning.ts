/**
 * Обучение модуля споров: какой тип случая и какой довод приносит кредит.
 *
 * Тип случая определяется по геометрии «заявлено против аудита», а не по
 * ярлыку из очереди: строка 112-6607996-5293053 ($24.49) стояла в очереди как
 * GROSS_WEIGHT, а зачислена 29.09 в пачке «одна ось аномальна» — по форме
 * 12×12×10 → 22×13×13 это ровно тот же дефект сканера, что у пяти остальных.
 *
 * Исход строки:
 *   credited — кредит виден в Payments / SP-API (REFUNDED / PARTIAL);
 *   denied   — отказ Amazon (REJECTED, либо CLOSED без кредита);
 *   pending  — подано, решения нет.
 * Письмо «одобрено» исходом не считается: только кредит.
 *
 * Таблица считается из реестра модуля на каждом запросе — новые исходы сами
 * меняют долю успеха и выбор довода для следующих кейсов.
 */

export type Pattern =
  | "SINGLE_AXIS_SCAN_ERROR"
  | "WEIGHT_ONLY"
  | "DECLARED_UNDER_DIMWEIGHT"
  | "MULTI_AXIS_GROWTH"
  | "WEIGHT_MINOR"
  | "NO_MEASURE_CHANGE"
  | "UNEXPLAINED_CHARGE"
  | "USPS_APV"
  | "NO_AUDIT";

export interface ArgumentSpec {
  pattern: Pattern;
  title: string; // по-русски, для дашборда
  argument: string; // суть довода по-русски
  /** Абзац довода в обращение (англ.) */
  claim: string;
  /** Чего просим (англ.) */
  ask: string;
  /** Можно ли вообще готовить по нему обращение без доп. проверки */
  fileable: boolean;
  /** Что сделать до подачи, если fileable = false */
  prerequisite?: string;
}

export const ARGUMENTS: Record<Pattern, ArgumentSpec> = {
  SINGLE_AXIS_SCAN_ERROR: {
    pattern: "SINGLE_AXIS_SCAN_ERROR",
    title: "Одна ось аномальна (ошибка дименсионера)",
    argument:
      "одна сторона в 1.6+ раза и на 8+ дюймов больше заявленной, две другие в пределах 3 дюймов, вес аудита не выше заявленного; объёмный вес посчитан с неверной стороны",
    claim:
      "In each shipment exactly one side recorded by the carrier is anomalously large while the other two sides are within 1-3 in of the declared carton. A carton cannot grow on one axis only. The billed weight is the dimensional weight of an erroneous dimension reading, which is consistent with a dimensioner error, not with an oversize package.",
    ask:
      "Please submit a measurement dispute with the carrier on our behalf, have the carrier review its audited scan data for these tracking numbers, and reverse the adjustments.",
    fileable: true,
  },
  WEIGHT_ONLY: {
    pattern: "WEIGHT_ONLY",
    title: "Вырос только вес, габариты совпали",
    argument: "габариты аудита совпали с заявленными в пределах 1.5 дюйма, а вес аудита выше в 1.5+ раза",
    claim:
      "The carrier-audited dimensions match the declared carton within 1.5 in per side (sides compared as a set), yet the audited weight is 1.5x or more of the declared weight. A weight increase without any corresponding size change is a meaningful inconsistency.",
    ask:
      "Please have the carrier review its audited scan data for these tracking numbers and reverse the adjustments where the weight reading cannot be supported.",
    fileable: true,
  },
  DECLARED_UNDER_DIMWEIGHT: {
    pattern: "DECLARED_UNDER_DIMWEIGHT",
    title: "Заявлен вес ниже объёмного",
    argument:
      "«вес вырос в 6–15 раз» — это объёмный вес коробки (Д×Ш×В/139–166), заявленный вес был ниже объёмного; Amazon опровергает такой довод",
    claim:
      "The audited dimensions differ from the declared carton; the billed weight is the dimensional weight of the audited dimensions.",
    ask:
      "Please provide the carrier's audited dimension record for these tracking numbers so the dimension difference itself can be reviewed.",
    fileable: false,
    prerequisite:
      "не подавать как «рост веса»; спорна только разница габаритов. На будущее заявлять при покупке лейбла объёмный вес коробки",
  },
  MULTI_AXIS_GROWTH: {
    pattern: "MULTI_AXIS_GROWTH",
    title: "Выросли несколько сторон",
    argument: "две-три стороны выросли на 1–3 дюйма и больше — выпирание или шум сканера",
    claim:
      "The carrier-audited dimensions exceed the declared carton on several sides by a few inches.",
    ask: "Please review the carrier's audited dimensions for these tracking numbers.",
    fileable: false,
    prerequisite:
      "Amazon стабильно отказывает «consistent with the carrier's measurement process» — подавать только с новым доказательством (фото коробки, заводской артикул)",
  },
  WEIGHT_MINOR: {
    pattern: "WEIGHT_MINOR",
    title: "Вес +10–50% при тех же габаритах",
    argument: "габариты совпали в пределах 1.5 дюйма, вес аудита выше на 10–50% — Amazon считает это обычным замером",
    claim:
      "The carrier-audited dimensions match the declared carton; the audited weight is moderately higher than declared.",
    ask: "Please review the carrier's audited weight for these tracking numbers.",
    fileable: false,
    prerequisite:
      "слабая строка: шаблонный отказ «consistent with the carrier's measurement»; подавать только с весовым доказательством (фото на весах); на будущее проверить заявляемый вес профиля коробки",
  },
  NO_MEASURE_CHANGE: {
    pattern: "NO_MEASURE_CHANGE",
    title: "Замер не изменился — надбавки",
    argument: "габариты и вес аудита совпали с заявленными — в доначислении адресные надбавки (residential, DAS, super rural, address correction)",
    claim: "The carrier-audited dimensions and weight match the declared values.",
    ask: "Please provide the itemized reason for the adjustment.",
    fileable: false,
    prerequisite:
      "адресные надбавки зависят от адреса покупателя и не оспариваются; спорна только Address Correction при верном адресе",
  },
  UNEXPLAINED_CHARGE: {
    pattern: "UNEXPLAINED_CHARGE",
    title: "Доначисление без изменения замера",
    argument:
      "замер не изменился, а перевозчик выставил в 2+ раза больше уплаченного за лейбл",
    claim:
      "The carrier-audited dimensions and weight match the declared values, yet the carrier billed more than twice the label amount already paid. The Transaction Details record shows a Shipping Charge Correction with no measurement change to support it.",
    ask:
      "Please identify the specific discrepancy behind this correction and reverse it if the measurement record does not support it.",
    fileable: true,
    prerequisite:
      "сначала открыть Transaction Details на VPS аккаунта: если там только адресные надбавки — не подавать",
  },
  USPS_APV: {
    pattern: "USPS_APV",
    title: "USPS APV (пересчёт базового тарифа)",
    argument: "USPS Automated Package Verification — Amazon ссылается на APV и отказывает",
    claim: "USPS adjusted the base postage after Automated Package Verification.",
    ask: "Please provide the APV record for these tracking numbers.",
    fileable: false,
    prerequisite: "кейс 22235365411 (7 USPS) отказан целиком — без нового доказательства не подавать",
  },
  NO_AUDIT: {
    pattern: "NO_AUDIT",
    title: "Нет аудита",
    argument: "в базе нет аудит-габаритов перевозчика — спорить нечем",
    claim: "",
    ask: "",
    fileable: false,
    prerequisite:
      "снять Transaction Details харвестером на VPS аккаунта (shipping_penalty_monitor.py harvester <store>), затем ingest-audit",
  },
};

/** Ярлык детектора/очереди → тип случая, когда геометрии нет. */
const CLASS_TO_PATTERN: Record<string, Pattern> = {
  GROSS_DIM: "SINGLE_AXIS_SCAN_ERROR",
  GROSS_WEIGHT: "WEIGHT_ONLY",
  DECLARED_UNDER_DIMWEIGHT: "DECLARED_UNDER_DIMWEIGHT",
  UNIFORM_GROWTH: "MULTI_AXIS_GROWTH",
  DISCREPANCY: "MULTI_AXIS_GROWTH",
  SCANNER_NOISE: "MULTI_AXIS_GROWTH",
  SURCHARGE_ONLY: "NO_MEASURE_CHANGE",
  MATCH: "NO_MEASURE_CHANGE",
  UNEXPLAINED_CHARGE: "UNEXPLAINED_CHARGE",
  USPS_BASE_POSTAGE_RECALC: "USPS_APV",
  NEEDS_AUDIT: "NO_AUDIT",
  NO_AUDIT_DATA: "NO_AUDIT",
};

export interface Measure {
  dims: [number, number, number] | null;
  weight: number | null; // lb
}

/** «12x12x10/12lb», «13.0x11.0x13.0/160oz» → габариты и вес в фунтах. */
export function parseMeasure(s: string | null | undefined): Measure {
  if (!s) return { dims: null, weight: null };
  const m = s.match(/(\d+(?:\.\d+)?)\s*[x×X]\s*(\d+(?:\.\d+)?)\s*[x×X]\s*(\d+(?:\.\d+)?)/);
  const w = s.match(/\/\s*(\d+(?:\.\d+)?)\s*(lb|lbs|oz)?/i);
  const dims = m ? ([+m[1], +m[2], +m[3]] as [number, number, number]) : null;
  let weight: number | null = null;
  if (w) {
    weight = +w[1];
    if ((w[2] ?? "").toLowerCase() === "oz") weight = Math.round((weight / 16) * 100) / 100;
  }
  return { dims, weight };
}

const PERMS: Array<[number, number, number]> = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

/** Объёмный вес, фунты (делитель 139 — розничный FedEx/UPS, как в разборе Amazon по 22198660051). */
export function dimWeight(d: [number, number, number], divisor = 139) {
  return Math.ceil((d[0] * d[1] * d[2]) / divisor);
}

/**
 * Тип случая по геометрии. Стороны сопоставляются перестановкой, при которой
 * лучше всего сходятся: Amazon и перевозчик пишут оси в разном порядке.
 */
export function detectPattern(input: {
  entered: Measure;
  audited: Measure;
  carrier?: string | null;
  cls?: string | null;
}): Pattern {
  const cls = (input.cls ?? "").toUpperCase();
  if (cls === "UNEXPLAINED_CHARGE") return "UNEXPLAINED_CHARGE";
  if (cls === "USPS_BASE_POSTAGE_RECALC" || (input.carrier ?? "").toUpperCase() === "USPS") {
    if (cls !== "GROSS_DIM") return "USPS_APV";
  }
  const e = input.entered.dims;
  const a = input.audited.dims;
  if (!e || !a) return CLASS_TO_PATTERN[cls] ?? "NO_AUDIT";

  let single = false;
  let bestGrown = 3;
  let allClose = false;
  for (const p of PERMS) {
    const diffs = [0, 1, 2].map((i) => a[p[i]] - e[i]);
    const big = [0, 1, 2].filter((i) => a[p[i]] >= 1.6 * e[i] && diffs[i] >= 8).length;
    const ok = diffs.filter((d) => Math.abs(d) <= 3).length;
    if (big === 1 && ok === 2) single = true;
    const grown = diffs.filter((d) => d > 1.5).length;
    if (grown < bestGrown) bestGrown = grown;
    if (diffs.every((d) => Math.abs(d) <= 1.5)) allClose = true;
  }
  if (single) return "SINGLE_AXIS_SCAN_ERROR";

  const ew = input.entered.weight;
  const aw = input.audited.weight;
  if (allClose) {
    if (ew && aw && aw >= 1.5 * ew) {
      // «Вес вырос» на деле объёмный вес: аудит-вес не выше объёмного по аудит-габаритам.
      if (aw <= dimWeight(a) + 1 && ew < dimWeight(e) * 0.8) return "DECLARED_UNDER_DIMWEIGHT";
      return "WEIGHT_ONLY";
    }
    if (ew && aw && aw >= 1.1 * ew) return "WEIGHT_MINOR";
    return "NO_MEASURE_CHANGE";
  }
  if (ew && aw && aw >= 1.5 * ew && ew < dimWeight(e) * 0.8) return "DECLARED_UNDER_DIMWEIGHT";
  return bestGrown >= 1 ? "MULTI_AXIS_GROWTH" : "NO_MEASURE_CHANGE";
}

export type Outcome = "credited" | "denied" | "pending";

export function outcomeOf(status: string | null | undefined, recovered: number): Outcome | null {
  const s = status ?? "NONE";
  if (s === "REFUNDED" || s === "PARTIAL") return "credited";
  if (s === "REJECTED") return "denied";
  if (s === "CLOSED") return recovered > 0 ? "credited" : "denied";
  if (["FILED", "AWAITING", "REPLIED", "ESCALATED"].includes(s)) return "pending";
  return null; // NONE, DRAFT, заблокированный аккаунт — в обучение не идут
}

export interface OutcomeCell {
  pattern: Pattern;
  carrier: string;
  credited: { count: number; amount: number };
  denied: { count: number; amount: number };
  pending: { count: number; amount: number };
  /** credited / (credited + denied); null — решений ещё не было */
  successRate: number | null;
}

export interface LearningRow {
  pattern: Pattern;
  carrier: string | null;
  status: string | null;
  amount: number; // положительное
  recovered: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function buildOutcomeTable(rows: LearningRow[]): OutcomeCell[] {
  const map = new Map<string, OutcomeCell>();
  for (const r of rows) {
    const o = outcomeOf(r.status, r.recovered);
    if (!o) continue;
    const carrier = (r.carrier ?? "—").toUpperCase();
    const key = `${r.pattern}|${carrier}`;
    let c = map.get(key);
    if (!c) {
      c = {
        pattern: r.pattern,
        carrier,
        credited: { count: 0, amount: 0 },
        denied: { count: 0, amount: 0 },
        pending: { count: 0, amount: 0 },
        successRate: null,
      };
      map.set(key, c);
    }
    const bucket = c[o];
    bucket.count += 1;
    bucket.amount = r2(bucket.amount + (o === "credited" ? r.recovered : r.amount));
  }
  const out = [...map.values()];
  for (const c of out) {
    const decided = c.credited.count + c.denied.count;
    c.successRate = decided > 0 ? r2(c.credited.count / decided) : null;
  }
  return out.sort(
    (a, b) =>
      (b.successRate ?? -1) - (a.successRate ?? -1) ||
      b.credited.count + b.denied.count - (a.credited.count + a.denied.count)
  );
}

export type Verdict = "FILE" | "FILE_CAUTION" | "DO_NOT_FILE" | "NEEDS_AUDIT";

export interface ArgumentChoice {
  pattern: Pattern;
  spec: ArgumentSpec;
  verdict: Verdict;
  /** Почему так — по-русски, со ссылкой на статистику */
  why: string;
  stats: { credited: number; denied: number; pending: number; successRate: number | null };
}

/**
 * Довод для новой строки — по аналогии с решёнными: сперва тот же тип случая
 * у того же перевозчика, иначе тот же тип у любых перевозчиков.
 */
export function chooseArgument(pattern: Pattern, carrier: string | null, table: OutcomeCell[]): ArgumentChoice {
  const spec = ARGUMENTS[pattern];
  const c = (carrier ?? "—").toUpperCase();
  const same = table.find((t) => t.pattern === pattern && t.carrier === c);
  const anyCarrier = table.filter((t) => t.pattern === pattern);
  const agg = (cells: OutcomeCell[]) => ({
    credited: cells.reduce((s, t) => s + t.credited.count, 0),
    denied: cells.reduce((s, t) => s + t.denied.count, 0),
    pending: cells.reduce((s, t) => s + t.pending.count, 0),
  });
  const basis = same && same.credited.count + same.denied.count > 0 ? [same] : anyCarrier;
  const a = agg(basis);
  const decided = a.credited + a.denied;
  const successRate = decided > 0 ? r2(a.credited / decided) : null;
  const scope = basis.length === 1 && basis[0] === same ? `${c}` : "все перевозчики";
  const stats = { ...a, successRate };

  if (pattern === "NO_AUDIT") {
    return { pattern, spec, verdict: "NEEDS_AUDIT", why: spec.prerequisite ?? "", stats };
  }
  if (!spec.fileable) {
    return {
      pattern,
      spec,
      verdict: "DO_NOT_FILE",
      why: `${spec.prerequisite ?? "довод не работает"}${decided ? ` (история: выиграно ${a.credited} из ${decided}, ${scope})` : ""}`,
      stats,
    };
  }
  if (decided >= 3 && a.credited === 0) {
    return {
      pattern,
      spec,
      verdict: "DO_NOT_FILE",
      why: `довод проиграл ${a.denied} из ${decided} (${scope}) — без нового доказательства не подавать`,
      stats,
    };
  }
  if (successRate != null && successRate >= 0.5) {
    return {
      pattern,
      spec,
      verdict: "FILE",
      why: `довод выигрывал ${a.credited} из ${decided} (${scope})`,
      stats,
    };
  }
  return {
    pattern,
    spec,
    verdict: "FILE_CAUTION",
    why: decided
      ? `выиграно ${a.credited} из ${decided} (${scope}) — шанс низкий${spec.prerequisite ? `; ${spec.prerequisite}` : ""}`
      : `решённых случаев ещё нет${spec.prerequisite ? `; ${spec.prerequisite}` : ""}`,
    stats,
  };
}

export const PATTERN_LABEL: Record<Pattern, string> = Object.fromEntries(
  Object.values(ARGUMENTS).map((a) => [a.pattern, a.title])
) as Record<Pattern, string>;
