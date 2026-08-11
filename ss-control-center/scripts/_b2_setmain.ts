// BATCH-200 — переводит застейдженный листинг на MAIN, сгенерированную по
// канону BUNDLE_FACTORY_FROZEN_MAIN_IMAGE_v2.0 (GPT Image 2 + якорь кулера).
// Ночные композитные картинки отвергнуты контрактом (§1), поэтому у уже
// созданных SKU и драфтов main_image_url надо заменить ДО минта пруфа:
// пруф печатается по точным байтам той картинки, которая уйдёт на Amazon.
// Env: WAVES=v2a.json,v2b.json,…  SLUGS=a,b (по умолчанию все из волн)  DRY=1
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { readFileSync, readdirSync } from "node:fs";

const WAVE_DIR = "data/batch200/waves/";

async function main() {
  const DRY = process.env.DRY === "1";
  const SLUGS = (process.env.SLUGS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const waves = (process.env.WAVES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const files = waves.length
    ? waves
    : readdirSync(WAVE_DIR).filter((f) => /^(v2|r50)/.test(f) && f.endsWith(".json")).sort();

  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;

  // later-wins: у слага может быть несколько попыток, берём последнюю
  const bySlug = new Map<string, any>();
  for (const f of files) {
    for (const row of JSON.parse(readFileSync(WAVE_DIR + f, "utf8"))) bySlug.set(row.slug, row);
  }
  const staged: any[] = JSON.parse(readFileSync("data/batch200/staged.json", "utf8"));
  const targets = staged.filter(
    (r) => bySlug.has(r.slug) && (SLUGS.length ? SLUGS.includes(r.slug) : true),
  );
  console.log(`волн: ${files.length} | к обновлению: ${targets.length}`);

  let ok = 0, same = 0;
  for (const row of targets) {
    const wave = bySlug.get(row.slug);
    const url = wave.main_image_url;
    const sku = await prisma.channelSKU.findUnique({
      where: { id: row.channel_sku_id },
      select: { id: true, main_image_url: true, master_bundle_id: true },
    });
    if (!sku) { console.log(`✗ ${row.slug}: SKU не найден`); continue; }
    if (sku.main_image_url === url) { same++; continue; }
    if (!DRY) {
      await prisma.channelSKU.update({ where: { id: sku.id }, data: { main_image_url: url } });
      await prisma.masterBundle.update({
        where: { id: sku.master_bundle_id },
        data: { main_image_url: url },
      }).catch(() => { /* поле может отсутствовать */ });
      await prisma.bundleDraft.updateMany({
        where: { master_bundle_id: sku.master_bundle_id },
        data: { draft_main_image_url: url },
      }).catch(() => { /* не критично */ });
      await prisma.generatedContent.updateMany({
        where: { bundle_draft_id: row.draft_id },
        data: { main_image_url: url },
      }).catch(() => { /* не критично */ });
    }
    console.log(`✓ ${row.slug} → ${url.slice(-58)}`);
    ok++;
  }
  console.log(`\nитого: обновлено ${ok} | уже совпадало ${same}`);
  await prisma.$disconnect();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
