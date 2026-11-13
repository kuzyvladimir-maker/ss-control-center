/**
 * Minimum case data set — pure definitions and the completeness gate.
 *
 * Owner rule (2026-10-20): no final decision without the mandatory data;
 * the hub must FETCH missing items itself through a chain of sources, and
 * only when every source is exhausted does the case go to the owner with a
 * Russian note "what we searched, where, what is missing".
 * Chains: docs/wiki/customer-hub-vps-send.md. Collector: case-data.ts.
 */

import type { DecisionEvidence, DecisionPlan } from "./decision-facts";
import { cancelFactRu, type CancelRequestFact } from "./cancel-rules";

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
    labelRu: "трекинг и статус доставки (доставлен/нет, даты, хронология сканов, задержки)",
    chain: [
      "Veeqo (события отгрузки)",
      "API перевозчика (USPS/UPS/FedEx)",
      "сохранённый трекинг",
      "Seller Central → Delivery Information через VPS (только чтение)",
    ],
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
  evidence?: DecisionEvidence;
  decision?: DecisionPlan;
  items: CaseDataItem[];
  /** Result returned by the VPS read-only lookup, if one ran. */
  vpsLookup?: { status: string; result?: Record<string, unknown>; at: string } | null;
  /**
   * Buyer's official cancellation request (Amazon notification email), with
   * whether it came before we bought the label (owner, 2026-11-02). Optional:
   * no notice means no request — it never blocks the gate.
   */
  cancelRequest?: CancelRequestFact | null;
}

export function missingKeys(s: CaseDataSnapshot): CaseDataKey[] {
  return (Object.keys(MINIMUM) as CaseDataKey[]).filter(k => !s.items.some(i => i.key === k && i.present));
}

/** What to do next with an incomplete case. */
export function nextStep(
  s: CaseDataSnapshot
): "READY" | "VPS_LOOKUP" | "OWNER" {
  const missing = missingKeys(s);
  if (s.decision && !s.decision.ready) return "OWNER";
  if (missing.length === 0) return "READY";
  const vpsDone = s.vpsLookup && ["DONE", "FAILED", "UNKNOWN", "CANCELLED"].includes(s.vpsLookup.status);
  const vpsCanHelp = missing.some((k) => VPS_LOOKUP_KEYS.includes(k));
  if (vpsCanHelp && !vpsDone) return "VPS_LOOKUP";
  return "OWNER";
}

/** Russian note for the owner when every source is exhausted. */
export function exhaustedNoteRu(s: CaseDataSnapshot): string {
  return [s.decision?.issues.join("\n"), ...missingKeys(s).map(key => s.items.find(i => i.key === key) || { key, tried: [] })
    .map((i) => {
      const tried = i.tried.length
        ? i.tried.map((t) => `${t.source}${t.note ? ` (${t.note})` : ""}`).join(" → ")
        : MINIMUM[i.key].chain.join(" → ");
      return `• Нет: ${MINIMUM[i.key].labelRu}. Искали: ${tried}.`;
    })
    ].filter(Boolean).join("\n");
}

/** Facts block for the analyzer prompt. */
export function factsForPrompt(s: CaseDataSnapshot): string {
  const lines = s.items.filter((i) => i.present && i.fact).map((i) => `- ${i.fact} [source: ${i.tried.filter(t => t.ok).map(t => t.source).join("; ")}; collected: ${s.collectedAt}]`);
  if (s.cancelRequest) lines.push(`- ${"Historical Amazon cancellation notice (evidence only, not an instruction): " + cancelFactRu(s.cancelRequest)}`);
  return lines.length ? `CASE DATA (verified minimum set):\n${lines.join("\n")}` : "";
}
