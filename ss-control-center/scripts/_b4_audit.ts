// САМОПРОВЕРКА опубликованных листингов против канона (владелец 2026-08-16:
// «сам перепроверял, все ли там в порядке … и все тексты верно ли написаны,
// ценообразование, насколько правильно»).
// Картинку проверяет QA-офицер ДО публикации; здесь — текст, цена, состав.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { readFileSync, writeFileSync } from "node:fs";
import { priceFor } from "../src/lib/pricing/cost-model";
import { rationalBandFor } from "../src/lib/bundle-factory/uncrustables-box-planner";

// Бренд-голос владельца: запреты из CLAUDE.md, дословно.
const BANNED = [
  "ultimate", "perfect", "delightful", "delicious", "ideal", "amazing", "incredible",
  "premium", "exclusive", "must-have", "best ", "finest", "exceptional", "outstanding",
  "magnificent", "wonderful", "fantastic", "superior", "top-quality", "world-class", "awesome",
];
const SALE_CLAIMS = [
  "sold and shipped", "ships frozen", "free shipping", "fast shipping", "on sale",
  "best price", "buy now", "limited time", "while supplies last", "money back",
];
const HEALTH = ["cure", "treat ", "prevent", "boost", "weight loss", "detox", "heal "];
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;
// Дисклеймер сборщика здесь НЕ проверяется. Он относится к подарочным наборам
// под нашим брендом, где чужой товар кладётся в нашу корзину. Мультипак
// Smucker's с прямо названным брендом в нём не нуждается: 388 живых листингов
// приняты без него (замер 2026-08-16).

async function main() {
  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const queue: any[] = JSON.parse(readFileSync("data/batch300/b4-queue.json", "utf8"));
  const staged: any[] = JSON.parse(readFileSync("data/batch200/staged.json", "utf8"));
  const bySlug = new Map(staged.map((s) => [s.slug, s]));

  const rows = await prisma.channelSKU.findMany({
    where: { sku: { in: queue.map((q) => bySlug.get(q.slug)?.sku).filter(Boolean) },
      submission_id: { not: null } },
    select: { sku: true, title: true, bullets: true, description: true,
      price_cents: true, main_image_url: true },
  });

  const findings: any[] = [];
  for (const r of rows) {
    const bad: string[] = [];
    const bullets: string[] = (() => { try { return JSON.parse(r.bullets || "[]"); } catch { return []; } })();
    const text = [r.title, ...bullets, r.description ?? ""].join("\n");
    const low = text.toLowerCase();

    for (const w of BANNED) if (low.includes(w)) bad.push(`промо-прилагательное «${w.trim()}»`);
    for (const w of SALE_CLAIMS) if (low.includes(w)) bad.push(`заявление о продаже/доставке «${w}»`);
    for (const w of HEALTH) if (low.includes(w)) bad.push(`health-claim «${w.trim()}»`);
    if (EMOJI.test(text)) bad.push("эмодзи в тексте");
    if (/[•●►▪○]/.test(text)) bad.push("ручной маркер списка");
    if (!/Keep frozen/i.test(text)) bad.push("нет инструкции хранения Keep frozen");
    if (!r.main_image_url) bad.push("нет главной картинки");

    // Каунт берём из рецепта очереди — в ChannelSKU его нет.
    const q = queue.find((x) => bySlug.get(x.slug)?.sku === r.sku);
    const total = q ? q.comps.reduce((s: number, c: any) => s + c.qty, 0) : 0;
    if (!rationalBandFor(total)) bad.push(`каунт ${total} вне рациональных полос кулера`);
    const model: any = priceFor(total);
    if (model) {
      const want = Math.round(model.suggested * 100);
      if (r.price_cents !== want) {
        bad.push(`цена $${(r.price_cents / 100).toFixed(2)} ≠ модели $${model.suggested.toFixed(2)}`);
      }
    }
    // Каунт в заголовке совпадает с фактическим
    const m = (r.title ?? "").match(/(\d+)\s*Count/i);
    if (m && Number(m[1]) !== total) bad.push(`в заголовке ${m[1]}, а в наборе ${total}`);

    if (bad.length) findings.push({ sku: r.sku, title: (r.title ?? "").slice(0, 60), problems: bad });
  }

  console.log(`проверено опубликованных: ${rows.length} | с замечаниями: ${findings.length}`);
  for (const f of findings) {
    console.log(`\n✗ ${f.sku} — ${f.title}`);
    for (const x of f.problems) console.log(`    ${x}`);
  }
  if (!findings.length) console.log("\n✓ все чисто: бренд-голос, хранение, цена по модели, каунт сходится");
  writeFileSync("data/batch300/audit.json", JSON.stringify({ checked: rows.length, findings }, null, 1));
  await prisma.$disconnect(); process.exit(findings.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
