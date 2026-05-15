/**
 * Standalone Walmart API diagnostic — runs the same probe as
 * POST /api/settings/walmart-diagnose, but locally so we don't need to
 * deploy to test. Writes findings to docs/WALMART_API_DIAGNOSTIC_RESULTS.md
 * verbatim (overwrites any prior run).
 *
 * Usage:
 *   npx tsx scripts/walmart-diagnose-api.ts            # store1 (default)
 *   npx tsx scripts/walmart-diagnose-api.ts 2          # store2
 *
 * Requires WALMART_CLIENT_ID_STORE{N}, WALMART_CLIENT_SECRET_STORE{N},
 * WALMART_STORE{N}_SELLER_ID, WALMART_STORE{N}_NAME in .env (loaded by
 * Next via dotenv when running through tsx; for raw node use `--env-file`).
 */

import "dotenv/config";
import { writeFileSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import {
  runDiagnostic,
  findingsToMarkdown,
} from "../src/lib/walmart/diagnose";

async function main() {
  const storeIndex = Number(process.argv[2] ?? "1");
  console.log(`[walmart-diagnose] running for store${storeIndex}…`);

  const findings = await runDiagnostic(storeIndex);
  const md = findingsToMarkdown(findings);

  const out = resolve(process.cwd(), "docs/WALMART_API_DIAGNOSTIC_RESULTS.md");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, md, "utf8");

  console.log("\n=== SUMMARY ===");
  console.log(`Token issued: ${findings.tokenIssued}`);
  console.log(`Winner: ${findings.winner.approach} — ${findings.winner.note}`);
  console.log(
    `OTD probes: ${findings.otdProbes.filter((p) => p.ok).length}/${findings.otdProbes.length} 2xx`
  );
  console.log(
    `Report probes: ${findings.reportProbes.filter((p) => p.ok).length}/${findings.reportProbes.length} accepted`
  );
  console.log(`\nFull report written to: ${out}`);
}

main().catch((err) => {
  console.error("[walmart-diagnose] failed:", err);
  process.exit(1);
});
