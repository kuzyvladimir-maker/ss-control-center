// Матрица «вкус × заводская фасовка» из каталога Amazon, БЕЗ наших собственных
// карточек и без чужих перепаковок. Заводская фасовка = один вкус + счёт из
// набора 4/8/10/15/18/24; всё остальное — чей-то набор, а не фасовка.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { readFileSync, writeFileSync } from "node:fs";

const FACTORY = [4, 8, 10, 15, 18, 24];
type Row = { asin: string; title: string; brand: string | null; count: number | null; image: string | null };

const FLAVORS: [string, RegExp, RegExp?][] = [
  ["Whole Wheat Strawberry", /whole wheat.*strawberry|strawberry.*whole wheat/i],
  ["Whole Wheat Grape", /whole wheat.*grape|grape.*whole wheat/i],
  ["Bright-Eyed Berry (protein)", /strawberry.*(12g|protein)|protein.*strawberry/i],
  ["Beamin' Berry (protein)", /mixed berry.*(12g|protein)|morning protein/i],
  ["Up & Apple (protein)", /apple cinnamon/i],
  ["Burstin' Blueberry (protein)", /blueberry/i],
  ["Chocolate Hazelnut", /hazelnut/i],
  ["Chocolate", /chocolate/i],
  ["Honey", /honey/i],
  ["Raspberry", /raspberry/i],
  ["Blackberry Boom", /blackberry/i],
  ["Berry Burst (mixed berry)", /mixed berry/i],
  ["Strawberry", /strawberry/i],
  ["Grape", /grape/i],
  ["Peanut Butter", /peanut butter/i],
];

async function main() {
  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const ours = new Set(
    (await prisma.channelSKU.findMany({ where: { asin: { not: null } }, select: { asin: true } }))
      .map((r: any) => r.asin),
  );
  const rows: Row[] = JSON.parse(readFileSync("data/batch300/amazon-uncrustables-catalog.json", "utf8"));

  const matrix = new Map<string, Map<number, Row>>();
  let skippedOurs = 0, skippedMulti = 0;
  for (const r of rows) {
    if (!r.count || !FACTORY.includes(r.count)) continue;
    if (ours.has(r.asin)) { skippedOurs++; continue; }
    // Чужие наборы и мультипаки: «Pack of N», «Variety Pack», «Bundle», два вкуса в титуле
    if (/pack of \d|variety pack|bundle|assortment|combo/i.test(r.title)) { skippedMulti++; continue; }
    const hit = FLAVORS.find(([, re]) => re.test(r.title));
    if (!hit) continue;
    const flavor = hit[0];
    if (!matrix.has(flavor)) matrix.set(flavor, new Map());
    const slot = matrix.get(flavor)!;
    if (!slot.has(r.count)) slot.set(r.count, r);
  }
  console.log(`отсеяно наших карточек: ${skippedOurs} | чужих наборов: ${skippedMulti}\n`);
  console.log("вкус                             " + FACTORY.map((f) => String(f).padStart(4)).join(""));
  const out: any[] = [];
  for (const [flavor] of FLAVORS) {
    const slot = matrix.get(flavor);
    const cells = FACTORY.map((f) => (slot?.has(f) ? "  ✓ " : "  · ")).join("");
    console.log(flavor.padEnd(32) + cells);
    for (const f of FACTORY) {
      const r = slot?.get(f);
      if (r) out.push({ flavor, size: f, asin: r.asin, title: r.title, image: r.image });
    }
  }
  writeFileSync("data/batch300/flavor-size-matrix.json", JSON.stringify(out, null, 1));
  console.log(`\nподтверждённых пар «вкус × фасовка»: ${out.length}`);
  await prisma.$disconnect(); process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
