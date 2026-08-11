// BATCH-200 галерея — вторичные слоты листинга по канону
// (amazon-brand-card-and-attributes.md + уточнение владельца 2026-08-11:
// инфо-карточка идёт слотом #1 сразу после main, до 8 слотов всего).
//
// Слот 1        — cold-chain brand card (о нас, кулер, гель-лёд, почему цена).
// Слоты 2..8    — донорские фото вкусов рецепта (lifestyle / инфографика /
//                 nutrition label), замирроренные в R2 и апсайзенные.
//
// Донорские фото распределяются ПО КРУГУ между вкусами, чтобы в галерее были
// представлены все вкусы набора, а не 7 картинок одного.
// Env: SLUGS=a,b  (или все из staged.json)  DRY=1
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { readFileSync, writeFileSync } from "node:fs";

const MAX_SLOTS = 8;

async function main() {
  const DRY = process.env.DRY === "1";
  const SLUGS = (process.env.SLUGS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const gi: any = await import("../src/lib/bundle-factory/attributes/gallery-images");
  const ba: any = await import("../src/lib/bundle-factory/attributes/brand-assets");

  const staged: any[] = JSON.parse(readFileSync("data/batch200/staged.json", "utf8"));
  const rows = SLUGS.length ? staged.filter((r) => SLUGS.includes(r.slug)) : staged;
  console.log(`к обработке: ${rows.length} | brand card: ${ba.BRAND_CARD_COLD_CHAIN_URL}`);

  // донорские фото по точному title донора
  const donors = await prisma.donorProduct.findMany({
    where: { OR: [{ brand: { contains: "Uncrustable" } }, { title: { contains: "Uncrustable" } }] },
    select: { title: true, mainImageUrl: true, imageUrls: true },
  });
  const byTitle = new Map<string, string[]>();
  for (const d of donors) {
    let imgs: string[] = [];
    try { imgs = JSON.parse(String(d.imageUrls ?? "[]")); } catch { /* ignore */ }
    // main-фото коробки уже служит арт-референсом для MAIN; в галерее оно
    // тоже уместно первым от вкуса — оставляем, дальше идут остальные ракурсы.
    const all = [d.mainImageUrl, ...imgs].filter((u): u is string => Boolean(u));
    byTitle.set(d.title, [...new Set(all)]);
  }

  const report: any[] = [];
  for (const row of rows) {
    // по кругу: вкус1[0], вкус2[0], вкус1[1], вкус2[1], …
    const perFlavor = row.comps.map((c: any) => byTitle.get(c.donor_title) ?? []);
    const picked: string[] = [];
    for (let i = 0; picked.length < MAX_SLOTS - 1 && i < 12; i++) {
      for (const list of perFlavor) {
        if (picked.length >= MAX_SLOTS - 1) break;
        const u = list[i];
        if (u && !picked.includes(u)) picked.push(u);
      }
      if (perFlavor.every((l) => l.length <= i + 1)) break;
    }
    if (!picked.length) { console.log(`✗ ${row.slug}: нет донорских фото`); continue; }

    const mirrored: string[] = DRY ? picked : await gi.mirrorDonorGallery(row.sku, picked);
    if (!mirrored.length) { console.log(`✗ ${row.slug}: миррор не отдал ни одной картинки`); continue; }

    // Донорские фото кладём со слота 1. Карточку НЕ добавляем руками:
    // appendColdChainBrandCard() в amazon-publish сам вставит её слотом #1 и
    // сдвинет донорские в 2..8 (уточнение владельца уже вшито в тот код).
    // Иначе карточка задвоится и последнее донорское фото выпадет за слот 8.
    const attrs: Record<string, unknown> = gi.galleryLocatorAttrs(
      mirrored, "ATVPDKIKX0DER", 1, MAX_SLOTS - 1,
    );
    const slots = Object.keys(attrs).length + 1; // +1 = карточка при публикации

    if (!DRY) {
      const sku = await prisma.channelSKU.findUnique({
        where: { id: row.channel_sku_id },
        select: { attributes: true },
      });
      const merged = { ...JSON.parse(sku?.attributes || "{}"), ...attrs };
      await prisma.channelSKU.update({
        where: { id: row.channel_sku_id },
        data: { attributes: JSON.stringify(merged) },
      });
    }
    console.log(`✓ ${row.slug}: ${slots} слотов (карточка при публикации + ${slots - 1} донорских)`);
    report.push({ slug: row.slug, sku: row.sku, slots, urls: [ba.BRAND_CARD_COLD_CHAIN_URL, ...mirrored] });
  }
  writeFileSync("data/batch200/gallery.json", JSON.stringify(report, null, 1));
  console.log(`\nготово: ${report.length} листингов → data/batch200/gallery.json`);
  await prisma.$disconnect();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
