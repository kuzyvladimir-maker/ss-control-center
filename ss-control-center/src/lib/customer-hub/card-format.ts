/**
 * Telegram card text for Customer Service (topic 42) — owner-approved
 * format, 2026-10-20 (Jackie's memory/rule_cs_card_format.md, sample = topic
 * message 106): `#` title, bold deadline + version, `##` sections with a
 * blank line between blocks, facts as a | Что | Данные | table (tracking in
 * backticks), verdict in bold + bullets, "Не удалось проверить" only when
 * there are gaps, buyer text as a `>` quote. Pure — no DB.
 */

export interface CardView {
  orderId: string | null;
  store: string;
  version: number;
  deadlineRu: string;
  clientRu: string;
  historyRu: string | null;
  facts: Array<{ what: string; value: string }>;
  verdictRu: string;
  pointsRu: string[];
  missing: string[];
  /** Russian translation for the owner — never sent. */
  draftRu: string | null;
  /** The text that will actually go to the buyer. */
  draftEn: string;
  attachments: string[];
}

const cell = (s: string) => s.replace(/\|/g, "/").replace(/\s*\n\s*/g, " ").trim();

export function renderCardText(v: CardView): string {
  const blocks: string[] = [];
  blocks.push(`# Заказ ${v.orderId || "—"} · ${v.store}`);
  blocks.push(`**${v.deadlineRu}** · v${v.version}`);
  blocks.push(`## Что пишет клиент\n\n${v.clientRu.trim()}`);
  if (v.historyRu?.trim()) blocks.push(`## История переписки\n\n${v.historyRu.trim()}`);
  if (v.facts.length)
    blocks.push(
      `## Факты\n\n| Что | Данные |\n|---|---|\n${v.facts.map((f) => `| ${cell(f.what)} | ${cell(f.value)} |`).join("\n")}`
    );
  const points = v.pointsRu.filter(Boolean).map((p) => `- ${p.replace(/^[-•]\s*/, "")}`);
  blocks.push(`## Решение движка\n\n**${v.verdictRu.trim()}**${points.length ? `\n\n${points.join("\n")}` : ""}`);
  if (v.missing.length) blocks.push(`## Не удалось проверить\n\n${v.missing.map((m) => `- ${m}`).join("\n")}`);
  const quote = (t: string) =>
    t
      .trim()
      .split("\n")
      .map((l) => (l.trim() ? `> ${l}` : ">"))
      .join("\n");
  // The owner does not read English (2026-10-20): Russian first, then the
  // English text that actually goes out.
  if (v.draftRu?.trim()) blocks.push(`## Ответ покупателю (по-русски, для тебя)\n\n${quote(v.draftRu)}`);
  blocks.push(`## Что уйдёт покупателю (по-английски)\n\n${quote(v.draftEn)}`);
  if (v.attachments.length) blocks.push(`Вложения: ${v.attachments.join(", ")}`);
  return blocks.join("\n\n");
}

export const FACT_LABEL_RU: Record<string, string> = {
  M2: "Переписка",
  M3: "Заказ",
  M4: "Сроки",
  M5: "Отгрузка",
  M6: "Трекинг",
  M7: "Тип товара",
  M8: "Уже сделано",
};

/** Fallback verdict when the analyzer gave none: first line after "Решение:". */
export function verdictFromBrief(brief: string | null | undefined): string {
  const m = /Решение:\s*([^\n]+)/.exec(brief || "");
  return (m?.[1] || "Решение не сформировано — см. данные").trim();
}
