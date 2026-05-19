/**
 * Phase 2.6.1+2.6.2 — Disclaimer Injection PLAN (dry run).
 *
 * Identifies every ListingAuditResult of a given completed scan whose
 * risk_reasons mention "Missing curator/assembler disclaimer", computes
 * the proposed new_bullets + new_description (appending the Option C
 * Defensive disclaimer), and writes a ListingRemediation row with
 * status='plan' for each one.
 *
 * Two content-generation modes:
 *   --mode=scrub   Phase 2.6.1 behaviour: keep original copy, strip
 *                  emojis/promo/HTML via regex, then append disclaimer.
 *   --mode=claude  Phase 2.6.2 behaviour (default): call Claude Sonnet 4.5
 *                  to generate fresh compliant bullets+description, then
 *                  run defensive scrub on Claude output, then append
 *                  disclaimer. ~$0.008/listing.
 *
 * Skips listings that:
 *   - already have the disclaimer in their existing bullets/description
 *     (idempotent — re-running is safe)
 *   - have empty/missing original_bullets (nothing useful to patch)
 *
 * NEVER touches the SP-API. Output is a human-readable preview report
 * written to docs/PHASE_2_6_X_PLAN_REPORT.md (filename depends on mode).
 *
 * Usage:
 *   set -a; source .env.local; set +a
 *   npx tsx scripts/disclaimer-injection-plan.ts <scan_id>                  # mode=claude (default)
 *   npx tsx scripts/disclaimer-injection-plan.ts <scan_id> --mode=scrub     # 2.6.1 fallback
 *   npx tsx scripts/disclaimer-injection-plan.ts <scan_id> --mode=claude --limit=20
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
import {
  scrubBulletArray,
  scrubDescription,
} from "@/lib/bundle-factory/remediation/content-scrub";
import {
  rewriteListingContent,
  type RewriteOutput,
} from "@/lib/bundle-factory/remediation/claude-rewrite";

type Mode = "scrub" | "claude";

interface CliArgs {
  scanId: string;
  mode: Mode;
  limit: number | null;
  account: string | null;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0].startsWith("--")) {
    console.error(
      "Usage: npx tsx scripts/disclaimer-injection-plan.ts <scan_id> [--mode=claude|scrub] [--limit=N] [--account=NAME]",
    );
    process.exit(1);
  }
  const scanId = argv[0];
  let mode: Mode = "claude";
  let limit: number | null = null;
  let account: string | null = null;
  for (const a of argv.slice(1)) {
    if (a.startsWith("--mode=")) {
      const v = a.split("=")[1];
      if (v !== "scrub" && v !== "claude") {
        console.error(`Unknown --mode=${v}. Allowed: scrub | claude`);
        process.exit(1);
      }
      mode = v;
    } else if (a.startsWith("--limit=")) {
      limit = Number(a.split("=")[1]);
    } else if (a.startsWith("--account=")) {
      account = a.split("=")[1].toUpperCase();
    } else {
      console.error(`Unknown flag: ${a}`);
      process.exit(1);
    }
  }
  return { scanId, mode, limit, account };
}

const REPORT_PATH_BY_MODE: Record<Mode, string> = {
  scrub: join(process.cwd(), "..", "docs", "PHASE_2_6_1_PLAN_REPORT.md"),
  claude: join(process.cwd(), "..", "docs", "PHASE_2_6_2_PLAN_REPORT.md"),
};

/**
 * Scrub scope decided by docs/PHASE_2_6_1_FAILED_CONTENT_ANALYSIS.md
 * Section B verdict (2026-05-19): SALUTEM samples carry the same
 * emoji + manual-bullet + promo + HTML template as the AMZCOM
 * failed-content sample → universal scrub on every plan row.
 *
 *   'A' — universal: every row scrubbed before disclaimer append
 *   'B' — AMZCOM only: SALUTEM proceeds with disclaimer-only
 *   'C' — bespoke: skip; manual review of SALUTEM pattern needed
 *
 * Phase 2.6.2 keeps this constant in force as a defensive filter on
 * Claude output (belt + suspenders).
 */
export const SCRUB_VERDICT: "A" | "B" | "C" = "A";

function shouldScrub(account: string): boolean {
  if (SCRUB_VERDICT === "A") return true;
  if (SCRUB_VERDICT === "B") return account === "AMZCOM";
  return false;
}

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Throttle Claude calls. Sonnet 4.5 Tier 1 is 50 req/min; 150ms = 6.6 req/s
// which is below 50 req/min on bursts but Anthropic rate-limits per minute
// so we won't hit the ceiling at this cadence either.
const CLAUDE_THROTTLE_MS = 150;

interface PlannedRow {
  audit: {
    id: string;
    asin: string;
    sku: string | null;
    account: string;
    title: string;
    brand: string | null;
    browse_node: string | null;
    main_image_url: string | null;
    original_bullets: string | null;
    original_description: string | null;
    remediation_status: string;
    risk_reasons: string | null;
  };
  originalBullets: string[];
  newBullets: string[];
  newDescription: string;
  scrubApplied: boolean;
  // Claude-mode telemetry (zeros in scrub mode)
  aiCostCents: number;
  cacheHit: boolean;
  claudeBullets: string[] | null;
  claudeDescription: string | null;
}

async function main() {
  const args = parseArgs();
  const { scanId, mode, limit, account } = args;

  const scan = await prisma.listingAuditScan.findUniqueOrThrow({
    where: { id: scanId },
  });
  if (scan.status !== "completed") {
    throw new Error(
      `Scan ${scanId} is in status='${scan.status}', expected 'completed'.`,
    );
  }
  console.log(
    `Scan ${scan.id} — ${scan.total_listings} listings · mode=${mode}` +
      (account ? ` · account=${account}` : "") +
      (limit ? ` · limit=${limit}` : ""),
  );

  const rows = await prisma.listingAuditResult.findMany({
    where: {
      scan_id: scan.id,
      risk_reasons: { contains: "Missing curator/assembler disclaimer" },
      ...(account ? { account } : {}),
    },
    select: {
      id: true,
      asin: true,
      sku: true,
      account: true,
      title: true,
      brand: true,
      browse_node: true,
      original_bullets: true,
      original_description: true,
      main_image_url: true,
      remediation_status: true,
      risk_reasons: true,
    },
    orderBy: { id: "asc" },
  });
  console.log(`Candidates (by reason match): ${rows.length}`);

  let alreadyCompliant = 0;
  let skippedEmpty = 0;
  let skippedNonPending = 0;
  const planned: PlannedRow[] = [];
  let scrubAppliedCount = 0;
  let claudeCalls = 0;
  let claudeFailures = 0;
  let totalAiCostCents = 0;
  let cacheHits = 0;
  let processedSinceLog = 0;

  // Single shared mutable counter for log lines; reused below.
  for (const r of rows) {
    if (limit !== null && planned.length + claudeFailures >= limit) break;

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

    let claudeBullets: string[] | null = null;
    let claudeDescription: string | null = null;
    let aiCostCents = 0;
    let cacheHit = false;
    let bulletsForScrub: string[];
    let descriptionForScrub: string;

    if (mode === "claude") {
      const rewrite: RewriteOutput = await rewriteListingContent({
        asin: r.asin,
        title: r.title,
        brand: r.brand ?? "Salutem Vita",
        browse_node: r.browse_node,
        original_bullets: originalBullets,
        original_description: originalDescription,
      });
      claudeCalls++;
      totalAiCostCents += rewrite.cost_cents;
      if (rewrite.cache_hit) cacheHits++;
      await sleep(CLAUDE_THROTTLE_MS);

      if (rewrite.error) {
        claudeFailures++;
        // Persist a failed-plan marker so this row surfaces in re-runs.
        const errMeta = JSON.stringify({
          mode: "claude",
          claude_error: rewrite.error,
          attempted_at: new Date().toISOString(),
        });
        await prisma.listingRemediation.upsert({
          where: { audit_result_id: r.id },
          create: {
            audit_result_id: r.id,
            status: "plan",
            original_title: r.title,
            new_title: null,
            original_bullets: JSON.stringify(originalBullets),
            new_bullets: null,
            original_description: originalDescription,
            new_description: null,
            original_image_url: r.main_image_url,
            new_image_url: null,
            ai_cost_cents: rewrite.cost_cents,
            sp_api_response: errMeta,
            sp_api_error: rewrite.error.slice(0, 1000),
          },
          update: {
            status: "plan",
            new_bullets: null,
            new_description: null,
            sp_api_response: errMeta,
            sp_api_error: rewrite.error.slice(0, 1000),
            ai_cost_cents: rewrite.cost_cents,
            completed_at: null,
          },
        });
        await prisma.listingAuditResult.update({
          where: { id: r.id },
          data: { remediation_status: "PLANNED" },
        });
        continue;
      }

      claudeBullets = rewrite.bullets;
      claudeDescription = rewrite.description;
      aiCostCents = rewrite.cost_cents;
      cacheHit = rewrite.cache_hit;
      bulletsForScrub = rewrite.bullets;
      descriptionForScrub = rewrite.description;
    } else {
      bulletsForScrub = originalBullets;
      descriptionForScrub = originalDescription;
    }

    // Smart Scrub (defensive in claude mode, primary in scrub mode).
    const willScrub = shouldScrub(r.account);
    const cleanedBullets = willScrub
      ? scrubBulletArray(bulletsForScrub)
      : bulletsForScrub;
    const cleanedDescription = willScrub
      ? scrubDescription(descriptionForScrub)
      : descriptionForScrub;
    if (willScrub) scrubAppliedCount++;

    // Amazon bullet_point cap is 10 per listing (code 99016 fires when
    // exceeded). Reserve last slot for disclaimer.
    const MAX_BULLETS_AMAZON = 10;
    const cappedBullets = cleanedBullets.slice(0, MAX_BULLETS_AMAZON - 1);
    const newBullets = [...cappedBullets, DISCLAIMER_BULLET];
    const trimmedDesc = cleanedDescription.trim();
    const newDescription = trimmedDesc
      ? trimmedDesc + "\n\n" + DISCLAIMER_DESCRIPTION
      : DISCLAIMER_DESCRIPTION;

    planned.push({
      audit: r,
      originalBullets,
      newBullets,
      newDescription,
      scrubApplied: willScrub,
      aiCostCents,
      cacheHit,
      claudeBullets,
      claudeDescription,
    });

    processedSinceLog++;
    if (mode === "claude" && processedSinceLog >= 25) {
      const avgCents = claudeCalls > 0 ? totalAiCostCents / claudeCalls : 0;
      console.log(
        `  …${planned.length} planned, ${claudeFailures} Claude failures, ` +
          `running cost $${(totalAiCostCents / 100).toFixed(2)} ` +
          `(avg ${avgCents.toFixed(2)}¢/listing, cache hit rate ${(
            (cacheHits / Math.max(1, claudeCalls)) *
            100
          ).toFixed(0)}%)`,
      );
      processedSinceLog = 0;
    }
  }

  console.log(`Already compliant (disclaimer present): ${alreadyCompliant}`);
  console.log(`Skipped (empty bullets):                ${skippedEmpty}`);
  console.log(`Skipped (remediation_status not PENDING): ${skippedNonPending}`);
  console.log(`Planned for remediation:                ${planned.length}`);
  console.log(`Smart scrub applied (verdict ${SCRUB_VERDICT}):    ${scrubAppliedCount}`);
  if (mode === "claude") {
    console.log(`Claude calls: ${claudeCalls} · failures: ${claudeFailures}`);
    console.log(
      `Claude cost: $${(totalAiCostCents / 100).toFixed(2)} ` +
        `(avg ${claudeCalls > 0 ? (totalAiCostCents / claudeCalls).toFixed(2) : "0.00"}¢/listing) ` +
        `· cache hits: ${cacheHits}/${claudeCalls}`,
    );
  }

  let written = 0;
  for (const p of planned) {
    const planMeta = JSON.stringify({
      mode,
      scrub_applied: p.scrubApplied,
      scrub_verdict: SCRUB_VERDICT,
      cache_hit: p.cacheHit,
      ai_cost_cents: p.aiCostCents,
      planned_at: new Date().toISOString(),
    });
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
        ai_cost_cents: p.aiCostCents,
        sp_api_response: planMeta,
        sp_api_error: null,
      },
      update: {
        status: "plan",
        new_bullets: JSON.stringify(p.newBullets),
        new_description: p.newDescription,
        ai_cost_cents: p.aiCostCents,
        sp_api_response: planMeta,
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

  const byAccount: Record<string, number> = {};
  for (const p of planned) {
    byAccount[p.audit.account] = (byAccount[p.audit.account] ?? 0) + 1;
  }

  const samples = planned.slice(0, 3);

  const reportPath = REPORT_PATH_BY_MODE[mode];
  const lines: string[] = [];
  const phaseLabel = mode === "claude" ? "2.6.2 Claude Rewrite" : "2.6.1 Smart Scrub";
  lines.push(`# Phase ${phaseLabel} — Disclaimer Injection Plan Report`);
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Scan:** \`${scan.id}\` (${scan.total_listings} total listings)`);
  lines.push(`**Mode:** PLAN (dry run, no SP-API calls) · content mode=\`${mode}\``);
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
  lines.push(`| Smart scrub applied | ${scrubAppliedCount} (verdict ${SCRUB_VERDICT}) |`);
  if (mode === "claude") {
    lines.push(`| Claude calls | ${claudeCalls} |`);
    lines.push(`| Claude failures (skipped or fallback) | ${claudeFailures} |`);
    lines.push(`| Claude cost total | $${(totalAiCostCents / 100).toFixed(2)} |`);
    lines.push(
      `| Claude cost avg / listing | ${claudeCalls > 0 ? (totalAiCostCents / claudeCalls).toFixed(2) : "0.00"}¢ |`,
    );
    lines.push(
      `| Cache hit rate | ${claudeCalls > 0 ? ((cacheHits / claudeCalls) * 100).toFixed(0) : "0"}% (${cacheHits}/${claudeCalls}) |`,
    );
  }
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
    lines.push(
      `### ${i + 1}. \`${p.audit.asin}\` · ${p.audit.account} · mode=${mode} · scrub=${p.scrubApplied ? "yes" : "no"}`,
    );
    lines.push(`**Title:** ${trunc(p.audit.title, 80)}`);
    lines.push("");
    if (p.originalBullets.length > 0) {
      lines.push(`**ORIGINAL last bullet:**`);
      lines.push("```");
      lines.push(p.originalBullets[p.originalBullets.length - 1]);
      lines.push("```");
    }
    if (mode === "claude" && p.claudeBullets) {
      lines.push(`**CLAUDE bullets (before disclaimer append):**`);
      lines.push("```");
      for (const b of p.claudeBullets) lines.push(`- ${b}`);
      lines.push("```");
    }
    if (p.newBullets.length >= 2) {
      lines.push(`**FINAL last bullet (before disclaimer):**`);
      lines.push("```");
      lines.push(p.newBullets[p.newBullets.length - 2]);
      lines.push("```");
    }
    lines.push(`**Disclaimer bullet appended:** ${DISCLAIMER_BULLET}`);
    lines.push("");
    lines.push(
      `**ORIGINAL description (first 200 chars):** ${trunc(p.audit.original_description ?? "", 200)}`,
    );
    lines.push("");
    if (mode === "claude" && p.claudeDescription) {
      lines.push(`**CLAUDE description (first 200 chars):**`);
      lines.push("```");
      lines.push(trunc(p.claudeDescription, 200));
      lines.push("```");
    }
    lines.push(`**FINAL description (last 250 chars):**`);
    lines.push("```");
    lines.push(p.newDescription.slice(-250));
    lines.push("```");
    lines.push("");
  });

  lines.push("## Next step (manual, requires Vladimir approval)");
  lines.push("");
  lines.push("```bash");
  lines.push(`# Safety test (5 AMZCOM)`);
  lines.push(
    `npx tsx scripts/disclaimer-injection-execute.ts ${scan.id} --apply --batch-size=5 --account=AMZCOM --limit=5`,
  );
  lines.push("");
  lines.push(`# If 4/5 pass → safety test (5 SALUTEM)`);
  lines.push(
    `npx tsx scripts/disclaimer-injection-execute.ts ${scan.id} --apply --batch-size=5 --account=SALUTEM --limit=5`,
  );
  lines.push("");
  lines.push(`# If both safety tests pass → full execute (requires Vladimir approval in chat)`);
  lines.push(
    `npx tsx scripts/disclaimer-injection-execute.ts ${scan.id} --apply --batch-size=25`,
  );
  lines.push("```");
  lines.push("");

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, lines.join("\n"), "utf8");
  console.log(`Wrote plan report → ${reportPath}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
