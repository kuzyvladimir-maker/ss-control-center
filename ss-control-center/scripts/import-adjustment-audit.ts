/**
 * Импорт настоящего аудита габаритов в реестр споров.
 *
 *   ./node_modules/.bin/tsx scripts/import-adjustment-audit.ts \
 *       --file /path/to/audit_salutem.json [--store store1] [--source TRANSACTION_DETAILS]
 *
 * Файл — JSON-массив записей (или объект с полем items/records) в формате
 * сборщика Transaction Details: orderId, financialEventId, trackingNumber,
 * enteredDims/enteredWeight, auditedDims/auditedWeight, charges[],
 * amountAlreadyPaid, totalChargeFromCarrier, transactionTotal.
 *
 * Скрипт НИЧЕГО не отправляет в Amazon — только читает файл и пишет в базу.
 */
import { readFileSync } from "node:fs";
import {
  importAuditRecords,
  reclassifyAll,
  type AuditRecord,
} from "@/lib/adjustments/audit-import";
import { AUDIT_SOURCES } from "@/lib/adjustments/audit-classify";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const file = arg("file");
  if (!file) {
    console.error("нужен --file <path to audit json>");
    process.exit(1);
  }
  const store = arg("store");
  const source = arg("source") ?? AUDIT_SOURCES.TRANSACTION_DETAILS;

  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const records: AuditRecord[] = Array.isArray(parsed)
    ? parsed
    : (parsed.items ?? parsed.records ?? parsed.rows ?? []);

  if (!Array.isArray(records) || records.length === 0) {
    console.error(`в ${file} не нашёл массива записей аудита`);
    process.exit(1);
  }

  const result = await importAuditRecords(records, { storeId: store, source });
  console.log("импорт аудита:", JSON.stringify(result, null, 2));

  const counts = await reclassifyAll();
  console.log("классы после импорта:", JSON.stringify(counts, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
