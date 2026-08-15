// Итоговая таблица каталога + подсчёт одновкусовых листингов по РАСКЛАДКАМ.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { rationalBandFor, RENDER_LIMITS } from "../src/lib/bundle-factory/uncrustables-box-planner";

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

function layoutsFor(sizes: number[]) {
  const out: number[][] = [];
  const s = [...sizes].sort((a, b) => b - a);
  const rec = (i: number, acc: number[], sum: number) => {
    if (acc.length) {
      const rows = Math.ceil(acc.length / RENDER_LIMITS.maxCartonsPerRow);
      if (sum >= 24 && sum <= 135 && rationalBandFor(sum) && rows <= RENDER_LIMITS.maxRows) out.push([...acc]);
    }
    if (sum > 135 || acc.length >= RENDER_LIMITS.maxCartons) return;
    for (let j = i; j < s.length; j++) rec(j, [...acc, s[j]], sum + s[j]);
  };
  rec(0, [], 0);
  return out;
}

async function main() {
  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;

  // Шоколадный орех 18 шт — Sam's Club, Клируотер (свидетельство владельца
  // 2026-08-15, скрин витрины). Фото упаковки ещё не добыто: Sam's закрыт
  // капчей для анонимного захода, нужен авторизованный канал.
  try {
  await prisma.donorProduct.upsert({
    where: { identityKey: "uncrustables|chocolate-hazelnut-spread-sandwich|18" },
    create: {
      identityKey: "uncrustables|chocolate-hazelnut-spread-sandwich|18",
      brand: "Smucker's", productLine: "Uncrustables",
      title: "Smucker's Uncrustables Chocolate Flavored Hazelnut Spread Sandwiches, Frozen, 1.8oz, 18 pk.",
      containerType: "box", size: "18 count", unitMeasure: "count", unitAmount: 18,
      category: "Frozen", bestPrice: 13.76, bestRetailer: "samsclub",
      pricePerMeasure: 13.76 / 18, identityStatus: "candidate", needsReview: true,
    },
    update: { bestPrice: 13.76, bestRetailer: "samsclub", pricePerMeasure: 13.76 / 18 },
  });
  } catch { /* карточка уже заведена предыдущим прогоном */ }

  const donors = await prisma.donorProduct.findMany({
    where: { OR: [{ brand: { contains: "Uncrustable" } }, { title: { contains: "Uncrustable" } }, { productLine: "Uncrustables" }] },
    select: { title: true, mainImageUrl: true, bestPrice: true, bestRetailer: true, unitAmount: true, unitMeasure: true },
  });

  const cell = new Map<string, { img: boolean; unit: number | null; ret: string | null }>();
  for (const d of donors) {
    const t = d.title ?? "";
    const hit = FL.find(([, re]) => re.test(t)); if (!hit) continue;
    // Фасовку берём ТОЛЬКО из явного счёта: «24 ct», «18 pk», «4 Count».
    // unitAmount у старых карточек хранит УНЦИИ («8 oz»), и подстановка его
    // как фасовки перекидывала мёд из четвёрки в восьмёрку.
    const m = t.match(/(\d+)\s*(?:ct\b|count\b|pk\b|pack\b)/i);
    const size = m ? Number(m[1]) : (d.unitMeasure === "count" ? d.unitAmount : null);
    if (!size || !SIZES.includes(size)) continue;
    const k = `${hit[0]}|${size}`;
    const cur = cell.get(k) ?? { img: false, unit: null as number | null, ret: null as string | null };
    if (d.mainImageUrl) cur.img = true;
    if (d.bestPrice) { const u = d.bestPrice / size; if (cur.unit == null || u < cur.unit) { cur.unit = u; cur.ret = d.bestRetailer; } }
    cell.set(k, cur);
  }

  console.log("вкус                          " + SIZES.map((s) => String(s).padStart(6)).join(""));
  const perSize = new Map<number, number>();
  const withPhoto = new Map<number, number>();
  const flavorSizes = new Map<string, number[]>();
  for (const [name] of FL) {
    let line = name.padEnd(30); const mine: number[] = [];
    for (const s of SIZES) {
      const c = cell.get(`${name}|${s}`);
      line += c ? (c.img ? "   ✓  " : "   ?  ") : "   ·  ";
      if (c) { perSize.set(s, (perSize.get(s) ?? 0) + 1); mine.push(s); if (c.img) withPhoto.set(s, (withPhoto.get(s) ?? 0) + 1); }
    }
    console.log(line);
    if (mine.length) flavorSizes.set(name, mine);
  }
  console.log("\nВКУСОВ В КАЖДОЙ ФАСОВКЕ (в скобках — с фото упаковки):");
  for (const s of SIZES) console.log(`  ${String(s).padStart(2)} шт — ${perSize.get(s) ?? 0} вкусов (${withPhoto.get(s) ?? 0})`);

  console.log("\nОДНОВКУСОВЫЕ ЛИСТИНГИ ПО РАСКЛАДКАМ (только вкусы с фото):");
  let total = 0;
  for (const [flavor, sizes] of flavorSizes) {
    const withImg = sizes.filter((s) => cell.get(`${flavor}|${s}`)?.img);
    if (!withImg.length) continue;
    const n = layoutsFor(withImg).length;
    total += n;
    console.log(`  ${flavor.padEnd(28)} фасовки ${withImg.join("/").padEnd(14)} → ${String(n).padStart(4)} раскладок`);
  }
  console.log(`\nИТОГО ОДНОВКУСОВЫХ ЛИСТИНГОВ: ${total}`);
  const units = [...cell.values()].map((c) => c.unit).filter((u): u is number => u != null).sort((a, b) => a - b);
  if (units.length) console.log(`цена за сэндвич: $${units[0].toFixed(2)} … $${units[units.length - 1].toFixed(2)}, медиана $${units[Math.floor(units.length / 2)].toFixed(2)}`);
  await prisma.$disconnect(); process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
