/**
 * Пересчёт класса расхождения на всех строках реестра.
 *
 *   ./node_modules/.bin/tsx scripts/reclassify-adjustments.ts
 *
 * Гонять после смены порогов в audit-classify.ts и после любого изменения
 * источника аудита — класс кэшируется в ShippingAdjustment.disputeClass,
 * чтобы реестр фильтровался запросом к базе, а не перебором в памяти.
 */
import { reclassifyAll } from "@/lib/adjustments/audit-import";

async function main() {
  const counts = await reclassifyAll();
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
