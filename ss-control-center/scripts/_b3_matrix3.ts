// Сколько ВКУСОВ подтверждено в каждой розничной фасовке.
// Фасовка = счёт, напечатанный на ОДНОЙ коробке. «10 count - Pack of 3» —
// это фасовка 10, а не 30. Наши собственные листинги отсекаются по ASIN.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { readFileSync, writeFileSync } from "node:fs";

const FACTORY = [4, 8, 10, 15, 18, 24];
const FLAVORS: [string, RegExp][] = [
  ["Цельнозерновая клубника", /whole wheat.*strawberry|strawberry.*(whole wheat|on wheat)/i],
  ["Цельнозерновой виноград", /whole wheat.*grape|grape.*(whole wheat|on wheat)/i],
  ["Bright-Eyed Berry", /bright.?eyed/i],
  ["Beamin' Berry", /beamin|morning protein/i],
  ["Up & Apple", /up ?& ?apple|apple cinnamon/i],
  ["Burstin' Blueberry", /burstin|blueberry/i],
  ["Шоколадный орех", /hazelnut/i],
  ["Шоколад", /chocolate/i],
  ["Мёд", /honey/i],
  ["Малина", /raspberry/i],
  ["Blackberry Boom", /blackberry/i],
  ["Berry Burst", /mixed berry/i],
  ["Клубника", /strawberry/i],
  ["Виноград", /grape/i],
  ["Только арахисовая паста", /peanut butter (only|sandwich)/i],
];

async function main() {
  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const ours = new Set(
    (await prisma.channelSKU.findMany({ where: { asin: { not: null } }, select: { asin: true } }))
      .map((r: any) => r.asin),
  );
  const rows: any[] = JSON.parse(readFileSync("data/batch300/amazon-uncrustables-catalog.json", "utf8"));

  const bySize = new Map<number, Map<string, string>>();
  for (const r of rows) {
    if (ours.has(r.asin)) continue;
    if (/variety pack|assortment|combo|mixed flavors/i.test(r.title)) continue;
    // счёт ОДНОЙ коробки: первое «N count/ct» в титуле
    const m = r.title.match(/(\d+)\s*(?:ct\b|count\b)/i);
    if (!m) continue;
    const size = Number(m[1]);
    if (!FACTORY.includes(size)) continue;
    const hit = FLAVORS.find(([, re]) => re.test(r.title));
    if (!hit) continue;
    if (!bySize.has(size)) bySize.set(size, new Map());
    if (!bySize.get(size)!.has(hit[0])) bySize.get(size)!.set(hit[0], r.title.slice(0, 70));
  }

  console.log("фасовка | вкусов | какие именно");
  const out: any[] = [];
  for (const size of FACTORY) {
    const m = bySize.get(size) ?? new Map();
    const names = [...m.keys()];
    console.log(`${String(size).padStart(5)}шт | ${String(names.length).padStart(6)} | ${names.join(", ") || "—"}`);
    for (const f of names) out.push({ size, flavor: f });
  }
  const pairs = out.length;
  console.log(`\nподтверждённых пар «вкус × фасовка»: ${pairs} (из ${FACTORY.length * FLAVORS.length} теоретически возможных)`);
  writeFileSync("data/batch300/flavor-size-confirmed.json", JSON.stringify(out, null, 1));
  await prisma.$disconnect(); process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
