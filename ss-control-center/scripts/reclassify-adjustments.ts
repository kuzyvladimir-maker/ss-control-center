/**
 * Пересчёт класса расхождения на строках реестра.
 *
 *   ./node_modules/.bin/tsx scripts/reclassify-adjustments.ts [--store store1]
 *
 * Классы, пришедшие с сервера (UNEXPLAINED_CHARGE и др., их нет в нашем
 * классификаторе), не перезаписываются.
 *
 * Гонять после смены порогов в audit-classify.ts и после любого изменения
 * источника аудита — класс кэшируется в ShippingAdjustment.disputeClass,
 * чтобы реестр фильтровался запросом к базе, а не перебором в памяти.
 */
import { reclassifyAll } from "@/lib/adjustments/audit-import";

async function main() {
  const i = process.argv.indexOf("--store");
  const storeId = i >= 0 ? process.argv[i + 1] : undefined;
  const counts = await reclassifyAll({ storeId });
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  console.log(`пересчитано строк: ${total}`);
  for (const [cls, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cls.padEnd(16)} ${n}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
