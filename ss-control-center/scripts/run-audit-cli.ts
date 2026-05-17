/**
 * Listing audit CLI runner — bypass the Vercel Hobby 60s function cap.
 *
 * The /api/bundle-factory/audit/scan endpoint kicks off the scanner as
 * fire-and-forget, but on Hobby Vercel kills the function after 60 s
 * (well before SP-API has finished walking all listings). This script
 * runs the same scanner code (scanAllAccounts + scoreAuditResult) in a
 * regular long-running Node process against production Turso, so a
 * full audit can take its actual 5–15 minutes without being killed.
 *
 * Requires in .env.local:
 *   TURSO_DATABASE_URL                  (production DB)
 *   TURSO_AUTH_TOKEN
 *   AMAZON_SP_CLIENT_ID_STORE1..5       (SP-API per-store creds)
 *   AMAZON_SP_CLIENT_SECRET_STORE1..5
 *   AMAZON_SP_REFRESH_TOKEN_STORE1..5
 *   ANTHROPIC_API_KEY                   (optional — vision check;
 *                                        skipped gracefully if absent)
 *
 * Usage:
 *   set -a; source .env.local; set +a
 *   npx tsx scripts/run-audit-cli.ts
 *
 *   # Restrict to specific accounts:
 *   npx tsx scripts/run-audit-cli.ts RETAILER SALUTEM
 *
 * On completion the scan record is `completed` in production Turso and
 * results are immediately visible at
 *   https://salutemsolutions.info/bundle-factory/audit/<scanId>
 */

import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { scanAllAccounts } from "@/lib/bundle-factory/audit/scanner";
import { scoreAuditResult } from "@/lib/bundle-factory/audit/risk-scorer";
import {
  ACCOUNT_KEYS,
  AUDIT_ORDER,
  type AccountKey,
} from "@/lib/bundle-factory/audit/account-map";

function parseAccountsArg(): readonly AccountKey[] {
  const args = process.argv.slice(2).map((a) => a.toUpperCase());
  if (args.length === 0) return AUDIT_ORDER;
  const invalid = args.filter(
    (a) => !ACCOUNT_KEYS.includes(a as AccountKey),
  );
  if (invalid.length > 0) {
    console.error(
      `Unknown account(s): ${invalid.join(", ")}\n` +
        `Allowed: ${ACCOUNT_KEYS.join(", ")}`,
    );
    process.exit(1);
  }
  return args as AccountKey[];
}

async function main() {
  const accounts = parseAccountsArg();

  console.log("\n🔍 Listing Audit — CLI runner");
  console.log(`  accounts: ${accounts.join(", ")}`);
  console.log(`  target:   ${process.env.TURSO_DATABASE_URL?.split("@")[1] ?? "local"}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(
      "  warning:  ANTHROPIC_API_KEY not set — Rule 5 (Vision logo check) will be skipped",
    );
  }
  console.log("");

  // ── 1. Create scan record ────────────────────────────────────────────
  const scan = await prisma.listingAuditScan.create({
    data: {
      initiated_by: "cli",
      status: "running",
      accounts_scanned: JSON.stringify(accounts),
    },
  });
  console.log(`[1/3] Created scan ${scan.id}`);

  // ── 2. Scan listings ─────────────────────────────────────────────────
  console.log(`[2/3] Scanning ${accounts.length} account(s)…`);
  const t0 = Date.now();
  const { totalInserted, byAccount, errors } = await scanAllAccounts(
    scan.id,
    accounts,
  );
  const scanMs = Date.now() - t0;
  console.log(`      → ${totalInserted} listings inserted in ${(scanMs / 1000).toFixed(1)}s`);
  for (const acct of accounts) {
    console.log(`        ${acct.padEnd(10)} ${byAccount[acct] ?? 0}`);
  }
  if (errors.length > 0) {
    console.warn(`      ⚠ ${errors.length} scan error(s):`);
    for (const e of errors.slice(0, 10)) console.warn(`        · ${e}`);
    if (errors.length > 10) console.warn(`        … (+${errors.length - 10} more)`);
  }

  // ── 3. Score each result ─────────────────────────────────────────────
  const results = await prisma.listingAuditResult.findMany({
    where: { scan_id: scan.id },
    select: { id: true },
  });
  console.log(`[3/3] Scoring ${results.length} listing(s)…`);
  const counts = { BLOCKED: 0, WARNING: 0, LOW_RISK: 0, COMPLIANT: 0 };
  const scoringErrors: string[] = [];
  const t1 = Date.now();
  for (let i = 0; i < results.length; i++) {
    try {
      const { category } = await scoreAuditResult(results[i].id);
      counts[category]++;
    } catch (e) {
      scoringErrors.push(
        `${results[i].id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if ((i + 1) % 10 === 0 || i === results.length - 1) {
      process.stderr.write(
        `      scored ${i + 1}/${results.length} ` +
          `· BLOCKED=${counts.BLOCKED} WARNING=${counts.WARNING} ` +
          `LOW_RISK=${counts.LOW_RISK} COMPLIANT=${counts.COMPLIANT}\r`,
      );
    }
  }
  process.stderr.write("\n");
  const scoreMs = Date.now() - t1;
  console.log(`      → done in ${(scoreMs / 1000).toFixed(1)}s`);

  const allErrors = [...errors, ...scoringErrors.slice(0, 10)];
  await prisma.listingAuditScan.update({
    where: { id: scan.id },
    data: {
      status: "completed",
      completed_at: new Date(),
      total_listings: totalInserted,
      blocked_count: counts.BLOCKED,
      warning_count: counts.WARNING,
      low_risk_count: counts.LOW_RISK,
      compliant_count: counts.COMPLIANT,
      error_message: allErrors.length
        ? allErrors.join("\n").slice(0, 4000)
        : null,
    },
  });

  const totalMs = Date.now() - t0;
  console.log(
    `\n✓ Audit complete in ${(totalMs / 1000).toFixed(1)}s ` +
      `(scan ${(scanMs / 1000).toFixed(1)}s + score ${(scoreMs / 1000).toFixed(1)}s)`,
  );
  console.log(
    `  BLOCKED=${counts.BLOCKED}  WARNING=${counts.WARNING}  ` +
      `LOW_RISK=${counts.LOW_RISK}  COMPLIANT=${counts.COMPLIANT}`,
  );
  console.log(
    `\n→ View results: https://salutemsolutions.info/bundle-factory/audit/${scan.id}\n`,
  );
}

main()
  .catch((e) => {
    console.error("\n✗ Audit run failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
