/**
 * Re-score the latest completed audit scan WITHOUT re-running the
 * expensive Vision API calls.
 *
 * Why this exists: vision-check.ts now filters its output through an
 * own-brand whitelist (Salutem Vita / Starfit / Salutem Solutions) and
 * a generic-deli-terms ignorelist (Olive Loaf / Bologna / …). New
 * scans get those filters applied automatically. But the most recent
 * scan was completed BEFORE the filters existed — its detected_logos
 * column contains unfiltered names, and the risk-scorer scored 35
 * points whenever those non-foreign terms showed up.
 *
 * This script:
 *   1. Loads the latest completed scan
 *   2. For each ListingAuditResult row, parses stored detected_logos
 *      and applies the same filterRealLogos used by the live path
 *   3. Re-runs scoreAuditResult with `precomputedLogos` so no new
 *      Vision spend happens — only the rule arithmetic re-runs
 *   4. Updates the parent ListingAuditScan counts to match
 *   5. Prints before/after deltas
 *
 * Usage:
 *   set -a; source .env.local; set +a
 *   npx tsx scripts/rescore-audit-scan.ts
 *
 *   # Append the Section H comparison block to the report:
 *   npx tsx scripts/rescore-audit-scan.ts --update-report
 */

import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { scoreAuditResult } from "@/lib/bundle-factory/audit/risk-scorer";
import { filterRealLogos } from "@/lib/bundle-factory/audit/vision-check";

const REPORT_PATH = join(
  process.cwd(),
  "..",
  "docs",
  "AUDIT_ANALYSIS_2026-05-19.md",
);

interface Counts {
  BLOCKED: number;
  WARNING: number;
  LOW_RISK: number;
  COMPLIANT: number;
}

function emptyCounts(): Counts {
  return { BLOCKED: 0, WARNING: 0, LOW_RISK: 0, COMPLIANT: 0 };
}

async function main() {
  const updateReport = process.argv.includes("--update-report");

  const scan = await prisma.listingAuditScan.findFirst({
    where: { status: "completed" },
    orderBy: { started_at: "desc" },
  });
  if (!scan) throw new Error("No completed scans found.");
  console.log(`Re-scoring scan ${scan.id} (${scan.total_listings} listings)`);

  // Snapshot the BEFORE state.
  const before: Counts = {
    BLOCKED: scan.blocked_count,
    WARNING: scan.warning_count,
    LOW_RISK: scan.low_risk_count,
    COMPLIANT: scan.compliant_count,
  };

  const results = await prisma.listingAuditResult.findMany({
    where: { scan_id: scan.id },
    select: { id: true, detected_logos: true, risk_category: true },
  });

  const after = emptyCounts();
  // transitions[before][after] for delta analysis
  const transitions: Record<string, Record<string, number>> = {};
  for (const cat of ["BLOCKED", "WARNING", "LOW_RISK", "COMPLIANT"]) {
    transitions[cat] = emptyCounts() as unknown as Record<string, number>;
  }
  let filteredOutLogos = 0;

  const t0 = Date.now();
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const priorLogos: string[] = (() => {
      if (!r.detected_logos) return [];
      try {
        const v = JSON.parse(r.detected_logos);
        return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
      } catch {
        return [];
      }
    })();
    const realLogos = filterRealLogos(priorLogos);
    filteredOutLogos += priorLogos.length - realLogos.length;

    const next = await scoreAuditResult(r.id, {
      precomputedLogos: {
        has_foreign_logos: realLogos.length > 0,
        detected_logos: realLogos,
      },
    });
    after[next.category]++;
    const prev = r.risk_category as keyof Counts;
    transitions[prev][next.category]++;

    if ((i + 1) % 50 === 0 || i === results.length - 1) {
      process.stderr.write(
        `  rescored ${i + 1}/${results.length} · ` +
          `BLOCKED=${after.BLOCKED} WARNING=${after.WARNING} ` +
          `LOW_RISK=${after.LOW_RISK} COMPLIANT=${after.COMPLIANT}\r`,
      );
    }
  }
  process.stderr.write("\n");
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

  // Update parent scan counts.
  await prisma.listingAuditScan.update({
    where: { id: scan.id },
    data: {
      blocked_count: after.BLOCKED,
      warning_count: after.WARNING,
      low_risk_count: after.LOW_RISK,
      compliant_count: after.COMPLIANT,
    },
  });

  // Summary.
  console.log(`\nRescored ${results.length} listings in ${elapsedSec}s`);
  console.log("Before → After:");
  console.log(`  BLOCKED:   ${before.BLOCKED}  → ${after.BLOCKED}`);
  console.log(`  WARNING:   ${before.WARNING}  → ${after.WARNING}`);
  console.log(`  LOW_RISK:  ${before.LOW_RISK}  → ${after.LOW_RISK}`);
  console.log(`  COMPLIANT: ${before.COMPLIANT}  → ${after.COMPLIANT}`);
  console.log(`Logo names filtered out (whitelist + ignorelist): ${filteredOutLogos}`);

  // Show transitions
  console.log("\nTransitions:");
  for (const fromCat of ["BLOCKED", "WARNING", "LOW_RISK", "COMPLIANT"]) {
    const row = transitions[fromCat];
    const total = Object.values(row).reduce((a, b) => a + b, 0);
    if (total === 0) continue;
    const parts = Object.entries(row)
      .filter(([toCat, n]) => n > 0 && toCat !== fromCat)
      .map(([toCat, n]) => `${toCat}=${n}`)
      .join("  ");
    console.log(`  from ${fromCat}: ${parts || "(no change)"}`);
  }

  if (updateReport) {
    const existing = await readFile(REPORT_PATH, "utf8").catch(() => "");
    const sectionH: string[] = [];
    sectionH.push("");
    sectionH.push("## Section H — Comparison: before vs after vision refinement");
    sectionH.push("");
    sectionH.push(
      `Re-scored ${results.length} listings using stored Vision detections ` +
        `but new \`filterRealLogos\` (own-brand whitelist + generic-deli ` +
        `ignorelist). No Vision API calls were made; only Rule 5 (image ` +
        `logos) changes affect score.`,
    );
    sectionH.push("");
    sectionH.push("| Category | Before | After | Δ |");
    sectionH.push("|---|---:|---:|---:|");
    sectionH.push(
      `| BLOCKED | ${before.BLOCKED} | ${after.BLOCKED} | ${after.BLOCKED - before.BLOCKED} |`,
    );
    sectionH.push(
      `| WARNING | ${before.WARNING} | ${after.WARNING} | ${after.WARNING - before.WARNING} |`,
    );
    sectionH.push(
      `| LOW_RISK | ${before.LOW_RISK} | ${after.LOW_RISK} | ${after.LOW_RISK - before.LOW_RISK} |`,
    );
    sectionH.push(
      `| COMPLIANT | ${before.COMPLIANT} | ${after.COMPLIANT} | ${after.COMPLIANT - before.COMPLIANT} |`,
    );
    sectionH.push("");
    sectionH.push("### Category transitions");
    sectionH.push("");
    sectionH.push(
      `Total logo names filtered out across all rows: **${filteredOutLogos}** ` +
        `(own-brand mentions + generic deli/snack/product terms).`,
    );
    sectionH.push("");
    for (const fromCat of ["BLOCKED", "WARNING", "LOW_RISK", "COMPLIANT"]) {
      const row = transitions[fromCat];
      const total = Object.values(row).reduce((a, b) => a + b, 0);
      if (total === 0) continue;
      const moved = Object.entries(row)
        .filter(([toCat, n]) => n > 0 && toCat !== fromCat)
        .map(([toCat, n]) => `→ ${toCat}: ${n}`)
        .join(", ");
      if (moved) {
        sectionH.push(`- **From ${fromCat}** (${total} rows): ${moved}`);
      }
    }
    sectionH.push("");

    // Strip any prior Section H, then append the fresh one.
    const cutoff = existing.indexOf("## Section H —");
    const base = cutoff >= 0 ? existing.slice(0, cutoff).replace(/\n+$/, "\n") : existing;
    await writeFile(REPORT_PATH, base + sectionH.join("\n") + "\n", "utf8");
    console.log(`\nAppended Section H to ${REPORT_PATH}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
