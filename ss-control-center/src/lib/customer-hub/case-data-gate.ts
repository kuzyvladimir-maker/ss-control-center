/**
 * Minimum case data set — pure definitions and the completeness gate.
 *
 * Owner rule (2026-10-20): no final decision without the mandatory data;
 * the hub must FETCH missing items itself through a chain of sources, and
 * only when every source is exhausted does the case go to the owner with a
 * Russian note "what we searched, where, what is missing".
 * Chains: docs/wiki/customer-hub-vps-send.md. Collector: case-data.ts.
 */

export type CaseDataKey = "M1" | "M2" | "M3" | "M4" | "M5" | "M6" | "M7" | "M8";

export const MINIMUM: Record<CaseDataKey, { labelRu: string; chain: string[] }> = {
  M1: { labelRu: "текст покупателя", chain: ["Gmail (уведомление Amazon)", "Seller Central через VPS"] },
  M2: {
    labelRu: "переписка по заказу",
    chain: ["база хаба", "ваши ответы из писем-подтверждений Amazon", "Seller Central через VPS"],
  },
  M3: {
    labelRu: "заказ: статус, состав, сумма, дата",
    chain: ["SP-API Orders", "копия заказа в базе", "Veeqo", "Seller Central через VPS"],
  },
  M4: { labelRu: "даты Ship by / Deliver by", chain: ["SP-API Orders", "копия заказа в базе", "Seller Central через VPS"] },
  M5: {
    labelRu: "отгрузка: перевозчик, сервис, трек, Buy Shipping",
    chain: ["Veeqo", "Seller Central через VPS"],
  },
  M6: {
    labelRu: "трекинг перевозчика (скан приёмки, доставка)",
    chain: ["API перевозчика (UPS/FedEx/USPS)", "сохранённый трекинг", "Seller Central через VPS (страница заказа)"],
  },
  M7: { labelRu: "тип товара Frozen/Dry (теги Veeqo)", chain: ["теги Veeqo первой позиции", "теги Veeqo всех позиций"] },
  M8: {
    labelRu: "что уже сделано: возвраты, замены, A-to-Z, chargeback",
    chain: ["SP-API Finances (возвраты)", "A-to-Z / chargeback в базе", "наши ответы по заказу", "Seller Central через VPS"],
  },
};

/** Items the VPS agent can look up read-only in Seller Central. */
export const VPS_LOOKUP_KEYS: CaseDataKey[] = ["M1", "M2", "M3", "M4", "M5", "M6", "M8"];

export interface SourceAttempt {
  source: string;
  ok: boolean;
  note?: string;
}

export interface CaseDataItem {
  key: CaseDataKey;
  present: boolean;
  /** Short English fact line for the prompt (empty when missing). */
  fact: string;
  /** Short Russian fact line for the owner's card. */
  factRu: string;
  tried: SourceAttempt[];
}

export interface CaseDataSnapshot {
  collectedAt: string;
  items: CaseDataItem[];
  /** Result returned by the VPS read-only lookup, if one ran. */
  vpsLookup?: { status: string; result?: Record<string, unknown>; at: string } | null;
}

export function missingKeys(s: CaseDataSnapshot): CaseDataKey[] {
  return s.items.filter((i) => !i.present).map((i) => i.key);
}

/** What to do next with an incomplete case. */
export function nextStep(
  s: CaseDataSnapshot
): "READY" | "VPS_LOOKUP" | "OWNER" {
  const missing = missingKeys(s);
  if (missing.length === 0) return "READY";
  const vpsDone = s.vpsLookup && ["DONE", "FAILED", "UNKNOWN", "CANCELLED"].includes(s.vpsLookup.status);
  const vpsCanHelp = missing.some((k) => VPS_LOOKUP_KEYS.includes(k));
  if (vpsCanHelp && !vpsDone) return "VPS_LOOKUP";
  return "OWNER";
}

/** Russian note for the owner when every source is exhausted. */
export function exhaustedNoteRu(s: CaseDataSnapshot): string {
  return s.items
    .filter((i) => !i.present)
    .map((i) => {
      const tried = i.tried.length
        ? i.tried.map((t) => `${t.source}${t.note ? ` (${t.note})` : ""}`).join(" → ")
        : MINIMUM[i.key].chain.join(" → ");
      return `• Нет: ${MINIMUM[i.key].labelRu}. Искали: ${tried}.`;
    })
    .join("\n");
}

/** Facts block for the analyzer prompt. */
export function factsForPrompt(s: CaseDataSnapshot): string {
  const lines = s.items.filter((i) => i.present && i.fact).map((i) => `- ${i.fact}`);
  return lines.length ? `CASE DATA (verified minimum set):\n${lines.join("\n")}` : "";
}
