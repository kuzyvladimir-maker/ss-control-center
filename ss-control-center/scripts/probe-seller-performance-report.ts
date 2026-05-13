/**
 * Probe: request + poll + download GET_V2_SELLER_PERFORMANCE_REPORT for store 1.
 * Saves the raw JSON body to /tmp/seller-perf-report-store1.json so we can
 * inspect the exact shape Amazon returns and refine the parser if needed.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/probe-seller-performance-report.ts [storeIndex]
 */

import { writeFileSync } from "fs";
import {
  requestReport,
  getReportStatus,
  downloadReportDocument,
  parseSellerPerformanceReport,
} from "../src/lib/amazon-sp-api/seller-performance-report";

const STORE = parseInt(process.argv[2] || "1", 10);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(`[probe] requesting report for store${STORE}…`);
  const reportId = await requestReport(STORE);
  console.log(`[probe] reportId = ${reportId}`);

  let status = "IN_QUEUE";
  let reportDocumentId: string | undefined;
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(15_000);
    const s = await getReportStatus(STORE, reportId);
    status = s.status;
    reportDocumentId = s.reportDocumentId;
    console.log(`[probe] status = ${status}`);
    if (status === "DONE" || status === "CANCELLED" || status === "FATAL") break;
  }
  if (status !== "DONE") {
    console.error(`[probe] report did not complete (status=${status})`);
    process.exit(1);
  }
  if (!reportDocumentId) {
    console.error(`[probe] DONE but no reportDocumentId`);
    process.exit(1);
  }

  console.log(`[probe] downloading document ${reportDocumentId}…`);
  const raw = await downloadReportDocument(STORE, reportDocumentId);
  const outPath = `/tmp/seller-perf-report-store${STORE}.json`;
  writeFileSync(outPath, raw);
  console.log(`[probe] saved raw to ${outPath} (${raw.length} bytes)`);

  console.log("[probe] parsing…");
  const parsed = parseSellerPerformanceReport(raw);
  console.log("[probe] parsed metrics:");
  console.log(JSON.stringify(parsed, null, 2));
}

main().catch((e) => {
  console.error("[probe] failed:", e);
  process.exit(1);
});
