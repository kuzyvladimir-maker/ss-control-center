/**
 * Phase 2.6.1 — Disclaimer Injection PLAN (dry run).
 *
 * Identifies every ListingAuditResult of a given completed scan whose
 * risk_reasons mention "Missing curator/assembler disclaimer", computes
 * the proposed new_bullets + new_description (appending the Option C
 * Defensive disclaimer), and writes a ListingRemediation row with
 * status='plan' for each one.
 *
 * Skips listings that:
 *   - already have the disclaimer in their existing bullets/description
 *     (idempotent — re-running is safe)
 *   - have empty/missing original_bullets (nothing useful to patch)
 *
 * NEVER touches the SP-API. Output is a human-readable preview report
 * written to docs/PHASE_2_6_1_PLAN_REPORT.md.
 *
 * Usage:
 *   set -a; source .env.local; set +a
 *   npx tsx scripts/disclaimer-injection-plan.ts <scan_id>
 */

import "dotenv/config";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { prisma } from "@/lib/prisma";
import {
  DISCLAIMER_BULLET,
  DISCLAIMER_DESCRIPTION,
  hasDisclaimerText,
} from "@/lib/bundle-factory/remediation/disclaimer-text";

const REPORT_PATH = join(
  process.cwd(),
  "..",
  "docs",
  "PHASE_2_6_1_PLAN_REPORT.md",
);

function parseJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function trunc(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

async function main() {
  const scanId = process.argv[2];
  if (!scanId) {
    console.error("Usage: npx tsx scripts/disclaimer-injection-plan.ts <scan_id>");
    process.exit(1);
  }

  const scan = await prisma.listingAuditScan.findUniqueOrThrow({
    where: { id: scanId },
  });
  if (scan.status !== "completed") {
    throw new Error(
      `Scan ${scanId} is in status='${scan.status}', expected 'completed'.`,
    );
  }
  console.log(`Scan ${scan.id} — ${scan.total_listings} listings`);

  // Pull every audit row of this scan whose reasons mention the missing
  // disclaimer. risk_reasons is stored as a JSON string of an array of
  // strings, so a SQL LIKE on the substring works (we still verify in
  // JS in case of false positives from the LIKE).
  const rows = await prisma.listingAuditResult.findMany({
    where: {
      scan_id: scan.id,
      risk_reasons: { contains: "Missing curator/assembler disclaimer" },
    },
    select: {
      id: true,
      asin: true,
      sku: true,
      account: true,
      title: true,
      original_bullets: true,
      original_description: true,
      main_image_url: true,
      remediation_status: true,
      risk_reasons: true,
    },
  });
  console.log(`Candidates (by reason match): ${rows.length}`);

  let alreadyCompliant = 0;
  let skippedEmpty = 0;
  let skippedNonPending = 0;
  const planned: Array<{
    audit: (typeof rows)[number];
    originalBullets: string[];
    newBullets: string[];
    newDescription: string;
  }> = [];

  for (const r of rows) {
    // Re-verify reason substring (LIKE is greedy on JSON-escaped strings,
    // but the reasons array is built deterministically by risk-scorer so
    // this is normally a no-op).
    const reasons = parseJson<string[]>(r.risk_reasons, []);
    if (!reasons.some((x) => x.includes("Missing curator/assembler disclaimer"))) {
      continue;
    }
    if (r.remediation_status !== "PENDING") {
      skippedNonPending++;
      continue;
    }
    const originalBullets = parseJson<string[]>(r.original_bullets, []).filter(
      (b) => typeof b === "string",
    );
    if (originalBullets.length === 0) {
      skippedEmpty++;
      continue;
    }
    const originalDescription = r.original_description ?? "";
    if (hasDisclaimerText(originalDescription, ...originalBullets)) {
      alreadyCompliant++;
      continue;
    }
    const newBullets = [...originalBullets, DISCLAIMER_BULLET];
    const trimmedDesc = originalDescription.trim();
    const newDescription = trimmedDesc
      ? trimmedDesc + "\n\n" + DISCLAIMER_DESCRIPTION
      : DISCLAIMER_DESCRIPTION;
    planned.push({ audit: r, originalBullets, newBullets, newDescription });
  }

  console.log(`Already compliant (disclaimer present): ${alreadyCompliant}`);
  console.log(`Skipped (empty bullets):                ${skippedEmpty}`);
  console.log(`Skipped (remediation_status not PENDING): ${skippedNonPending}`);
  console.log(`Planned for remediation:                ${planned.length}`);

  // Write plan rows sequentially (no transaction wrapper — at this scale
  // the interactive-transaction 5s ceiling is exceeded by Turso latency
  // long before 1000+ upserts finish). Upserts are idempotent on
  // audit_result_id, so partial completion is safe to resume from.
  let written = 0;
  for (const p of planned) {
    await prisma.listingRemediation.upsert({
      where: { audit_result_id: p.audit.id },
      create: {
        audit_result_id: p.audit.id,
        status: "plan",
        original_title: p.audit.title,
        new_title: null,
        original_bullets: JSON.stringify(p.originalBullets),
        new_bullets: JSON.stringify(p.newBullets),
        original_description: p.audit.original_description ?? "",
        new_description: p.newDescription,
        original_image_url: p.audit.main_image_url,
        new_image_url: null,
        ai_cost_cents: 0,
      },
      update: {
        status: "plan",
        new_bullets: JSON.stringify(p.newBullets),
        new_description: p.newDescription,
        // Clear any prior failure state — re-planning is a reset.
        sp_api_response: null,
        sp_api_error: null,
        completed_at: null,
      },
    });
    await prisma.listingAuditResult.update({
      where: { id: p.audit.id },
      data: { remediation_status: "PLANNED" },
    });
    written++;
    if (written % 100 === 0) {
      process.stderr.write(`  wrote ${written}/${planned.length}\r`);
    }
  }
  if (planned.length >= 100) process.stderr.write("\n");
  console.log(`Wrote ${written} ListingRemediation rows (status=plan).`);

  // ── Per-account breakdown ───────────────────────────────────────────
  const byAccount: Record<string, number> = {};
  for (const p of planned) {
    byAccount[p.audit.account] = (byAccount[p.audit.account] ?? 0) + 1;
  }

  // ── Sample 3 ASINs for the report ───────────────────────────────────
  const samples = planned.slice(0, 3);

  // ── Render markdown report ──────────────────────────────────────────
  const lines: string[] = [];
  lines.push(`# Phase 2.6.1 — Disclaimer Injection Plan Report`);
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Scan:** \`${scan.id}\` (${scan.total_listings} total listings)`);
  lines.push(`**Mode:** PLAN (dry run, no SP-API calls)`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Bucket | Count |");
  lines.push("|---|---:|");
  lines.push(`| Candidates by reason match | ${rows.length} |`);
  lines.push(`| Already compliant (skipped) | ${alreadyCompliant} |`);
  lines.push(`| Empty bullets (skipped) | ${skippedEmpty} |`);
  lines.push(`| Non-PENDING status (skipped) | ${skippedNonPending} |`);
  lines.push(`| **Planned for remediation** | **${planned.length}** |`);
  lines.push("");
  lines.push("### By account");
  lines.push("| Account | Planned |");
  lines.push("|---|---:|");
  for (const acct of Object.keys(byAccount).sort()) {
    lines.push(`| ${acct} | ${byAccount[acct]} |`);
  }
  lines.push("");

  lines.push("## Sample listings (first 3 of plan)");
  lines.push("");
  samples.forEach((p, i) => {
    lines.push(`### ${i + 1}. \`${p.audit.asin}\` · ${p.audit.account}`);
    lines.push(`**Title:** ${trunc(p.audit.title, 80)}`);
    lines.push("");
    lines.push(
      `**Existing bullets (first 200 chars of joined):** \`${trunc(
        p.originalBullets.join(" · "),
        200,
      ).replace(/`/g, "\\`")}\``,
    );
    lines.push("");
    if (p.originalBullets.length > 0) {
      lines.push(`**Original last bullet:** ${trunc(p.originalBullets[p.originalBullets.length - 1], 200)}`);
    }
    lines.push(`**New last bullet (disclaimer):** ${DISCLAIMER_BULLET}`);
    lines.push("");
    lines.push(
      `**Existing description (first 200 chars):** ${trunc(p.audit.original_description ?? "", 200)}`,
    );
    lines.push("");
    lines.push(
      `**After patch — appended paragraph (last 250 chars of new description):**`,
    );
    lines.push("```");
    lines.push(p.newDescription.slice(-250));
    lines.push("```");
    lines.push("");
  });

  lines.push("## Next step (manual, requires Vladimir approval)");
  lines.push("");
  lines.push("```bash");
  lines.push(`# Safety: run on first 10 only`);
  lines.push(
    `npx tsx scripts/disclaimer-injection-execute.ts ${scan.id} --apply --batch-size=10 --limit=10`,
  );
  lines.push("");
  lines.push(`# After verifying those 10 are clean → full execute`);
  lines.push(
    `npx tsx scripts/disclaimer-injection-execute.ts ${scan.id} --apply --batch-size=25`,
  );
  lines.push("```");
  lines.push("");

  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, lines.join("\n"), "utf8");
  console.log(`Wrote plan report → ${REPORT_PATH}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
