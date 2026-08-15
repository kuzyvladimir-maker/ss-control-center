import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { readFileSync } from "node:fs";
async function main() {
  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const wave: any[] = JSON.parse(readFileSync("data/batch200/waves/b3-plan.json", "utf8"));
  const staged: any[] = JSON.parse(readFileSync("data/batch200/staged.json", "utf8"));
  const slugs = new Set(wave.map((w) => w.slug));
  const mine = staged.filter((s) => slugs.has(s.slug));
  const skus = await prisma.channelSKU.findMany({
    where: { sku: { in: mine.map((m) => m.sku) } },
    select: { sku: true, submission_id: true, price_cents: true, main_image_url: true },
  });
  const bySku = new Map(skus.map((s: any) => [s.sku, s]));
  let ok = 0, no = 0;
  for (const m of mine) {
    const r: any = bySku.get(m.sku);
    const good = r?.submission_id && r?.main_image_url;
    if (good) ok++; else { no++; console.log(`  ✗ ${m.slug} | sub=${r?.submission_id ?? "нет"} | img=${r?.main_image_url ? "есть" : "НЕТ"}`); }
  }
  console.log(`\nс submission_id и картинкой: ${ok} | без: ${no} | всего застейджено из партии-3: ${mine.length}`);
  await prisma.$disconnect(); process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
