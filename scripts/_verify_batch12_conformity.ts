// Full conformity check before Amazon submission (owner: "должно
// соответствовать все: и картинки и название и цена полностью"):
// per SKU — DB title/bullets/description vs the verified preview texts,
// price vs the canonical model, number_of_items, band floor, and the R2
// image bytes vs the EXACT local copies I verified carton-by-carton.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const SCRATCH = "/private/tmp/claude-501/-Users-vladimirkuznetsov-SS-Command-Center/1dbdc77d-9c20-49be-9e0d-c48b604008f6/scratchpad/";
const FILES = [
  "preview-final-2.json", "preview-final-4.json", "preview-final-5.json",
  "preview-final-6.json", "preview-final-7.json", "preview-final-7b.json",
];
const LOCAL_PNG: Record<string, string> = {
  "honey-choc-strawberry-28": "main2-honey-choc-strawberry-28",
  "grape-raspberry-24": "main2-grape-raspberry-24",
  "honey-hazelnut-grape-30": "main2-honey-hazelnut-grape-30",
  "protein-blueberry-strawberry-grape-48": "main4-protein-blueberry-strawberry-grape-48",
  "honey-berry-quartet-54": "main5-honey-berry-quartet-54",
  "classic-trio-24": "main6-classic-trio-24",
  "protein-duo-wwgrape-28": "main6-protein-duo-wwgrape-28",
  "chocolate-hazelnut-raspberry-30": "main7-chocolate-hazelnut-raspberry-30",
  "honey-chocolate-60": "main6-honey-chocolate-60",
};

async function main() {
  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const cm: any = await import("../src/lib/pricing/cost-model");
  const priceFor = cm.priceFor ?? cm.default?.priceFor;
  const bySlug = new Map<string, any>();
  for (const f of FILES) {
    if (!existsSync(SCRATCH + f)) continue;
    for (const l of JSON.parse(readFileSync(SCRATCH + f, "utf8"))) bySlug.set(l.slug, l);
  }
  const rows: any[] = JSON.parse(readFileSync(SCRATCH + "publish-batch12-skus.json", "utf8"));
  let allOk = true;
  for (const r of rows) {
    const l = bySlug.get(r.slug);
    const sku = await prisma.channelSKU.findUnique({ where: { id: r.channel_sku_id } });
    const probs: string[] = [];
    if (!sku || !l) { console.log(`✗ ${r.slug}: SKU/preview missing`); allOk = false; continue; }
    if (sku.title !== l.title) probs.push("TITLE≠");
    if (JSON.stringify(JSON.parse(sku.bullets ?? "[]")) !== JSON.stringify(l.bullets)) probs.push("BULLETS≠");
    if (sku.description !== l.description) probs.push("DESC≠");
    const model = priceFor(l.total);
    if (sku.price_cents !== Math.round(model.suggested * 100)) probs.push(`PRICE ${sku.price_cents}≠${Math.round(model.suggested * 100)}`);
    if (sku.main_image_url !== l.main_image_url) probs.push("IMG URL≠");
    const localSha = createHash("sha256").update(readFileSync(SCRATCH + LOCAL_PNG[r.slug] + ".png")).digest("hex");
    const resp = await fetch(l.main_image_url);
    const remoteSha = createHash("sha256").update(Buffer.from(await resp.arrayBuffer())).digest("hex");
    if (localSha !== remoteSha) probs.push("IMG BYTES DRIFT");
    const a = typeof sku.attributes === "string" ? JSON.parse(sku.attributes) : sku.attributes;
    const n = a?.number_of_items?.[0]?.value;
    if (n !== l.total) probs.push(`COUNT ${n}≠${l.total}`);
    const po = a?.purchasable_offer?.[0];
    const min = po?.minimum_seller_allowed_price?.[0]?.schedule?.[0]?.value_with_tax;
    if (min && Math.abs(min - model.floor) > 0.01) probs.push(`MIN ${min}≠${model.floor}`);
    console.log(`${probs.length ? "✗" : "✓"} ${r.sku} | ${r.slug} | $${(sku.price_cents / 100).toFixed(2)} | img ${remoteSha.slice(0, 10)} ${localSha === remoteSha ? "= local" : "≠ LOCAL"} | qty ${sku.available_quantity}${probs.length ? " | " + probs.join(", ") : ""}`);
    if (probs.length) allOk = false;
  }
  console.log(allOk ? "\nВСЕ 9 СООТВЕТСТВУЮТ ПОЛНОСТЬЮ" : "\nЕСТЬ РАСХОЖДЕНИЯ — НЕ ПУБЛИКОВАТЬ");
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
