// Что РЕАЛЬНО есть в справочном донорском каталоге: вкус × фасовка,
// с ритейлером, ценой за штуку и наличием фото упаковки.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
async function main() {
  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const donors = await prisma.donorProduct.findMany({
    where: { OR: [{ brand: { contains: "Uncrustable" } }, { title: { contains: "Uncrustable" } }] },
    select: { title: true, mainImageUrl: true, bestPrice: true,
      offers: { select: { price: true, packSizeSeen: true, retailer: true } } },
  });
  const FL: [string, RegExp][] = [
    ["Цельнозерновая клубника", /whole wheat.*strawberry|strawberry.*whole wheat/i],
    ["Цельнозерновой виноград", /whole wheat.*grape|grape.*whole wheat/i],
    ["Bright-Eyed Berry", /bright.?eyed|strawberry.*protein|protein.*strawberry/i],
    ["Beamin' Berry", /beamin|morning protein/i],
    ["Up & Apple", /apple cinnamon/i],
    ["Burstin' Blueberry", /blueberry/i],
    ["Шоколадный орех", /hazelnut/i],
    ["Шоколад", /chocolate/i],
    ["Мёд", /honey/i],
    ["Малина", /raspberry/i],
    ["Blackberry Boom", /blackberry/i],
    ["Berry Burst", /mixed berry/i],
    ["Клубника", /strawberry/i],
    ["Виноград", /grape/i],
    ["Только арахисовая паста", /peanut butter/i],
  ];
  const SIZES = [4, 8, 10, 15, 18, 24];
  const cell = new Map<string, { retailers: Set<string>; unit: number | null; img: boolean }>();
  for (const d of donors) {
    const t = d.title ?? "";
    const hit = FL.find(([, re]) => re.test(t)); if (!hit) continue;
    const m = t.match(/(\d+)\s*(?:ct\b|count\b)/i); if (!m) continue;
    const size = Number(m[1]); if (!SIZES.includes(size)) continue;
    const k = `${hit[0]}|${size}`;
    const cur = cell.get(k) ?? { retailers: new Set<string>(), unit: null as number | null, img: false };
    for (const o of d.offers ?? []) if (o.retailer) cur.retailers.add(o.retailer);
    const price = d.bestPrice ?? d.offers?.[0]?.price ?? null;
    if (price) { const u = price / size; if (cur.unit == null || u < cur.unit) cur.unit = u; }
    if (d.mainImageUrl) cur.img = true;
    cell.set(k, cur);
  }
  console.log("вкус                          " + SIZES.map((s) => String(s).padStart(6)).join(""));
  const perSize = new Map<number, number>();
  for (const [name] of FL) {
    let line = name.padEnd(30);
    for (const s of SIZES) {
      const c = cell.get(`${name}|${s}`);
      line += (c ? (c.img ? "   ✓  " : "   ?  ") : "   ·  ");
      if (c) perSize.set(s, (perSize.get(s) ?? 0) + 1);
    }
    console.log(line);
  }
  console.log("\nВКУСОВ В КАЖДОЙ ФАСОВКЕ:");
  for (const s of SIZES) console.log(`  ${String(s).padStart(2)} шт — ${perSize.get(s) ?? 0} вкусов`);
  const units = [...cell.values()].map((c) => c.unit).filter((u): u is number => u != null);
  if (units.length) {
    units.sort((a, b) => a - b);
    console.log(`\nцена за сэндвич: от $${units[0].toFixed(2)} до $${units[units.length - 1].toFixed(2)}, медиана $${units[Math.floor(units.length / 2)].toFixed(2)}`);
  }
  const rets = new Set<string>(); for (const c of cell.values()) for (const r of c.retailers) rets.add(r);
  console.log(`ритейлеры в каталоге: ${[...rets].join(", ") || "—"}`);
  console.log(`✓ = есть фото упаковки, ? = карточка без фото`);
  await prisma.$disconnect(); process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
