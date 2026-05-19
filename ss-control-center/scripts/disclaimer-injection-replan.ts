/**
 * Phase 2.6.1 — Re-plan the disclaimer-injection for a scan after the
 * Smart Scrub change.
 *
 * Wipes prior `plan` + `failed` ListingRemediation rows for the scan,
 * resets ListingAuditResult.remediation_status back to PENDING for them,
 * then re-runs the plan logic from `disclaimer-injection-plan.ts` so the
 * new rows carry the scrubbed bullets/description through to execute.
 *
 * Original audit data (title, bullets, description, scores, reasons) is
 * NEVER touched. Only the remediation rows we wrote ourselves are
 * affected. Rows already `completed` / `rolled_back` / `verification_failed`
 * are left alone — we don't unwind successful work just to re-plan.
 *
 * Usage:
 *   set -a; source .env.local; set +a
 *   npx tsx scripts/disclaimer-injection-replan.ts <scan_id> --confirm
 *   npx tsx scripts/disclaimer-injection-replan.ts <scan_id> --confirm --mode=claude
 *   npx tsx scripts/disclaimer-injection-replan.ts <scan_id> --confirm --mode=scrub --limit=20
 *
 * Pass-through flags (forwarded verbatim to plan script):
 *   --mode=claude|scrub   (default: plan-script default, currently 'claude')
 *   --limit=N             (cap planned rows for safety tests)
 */

import "dotenv/config";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";

const SCRIPTS_DIR = join(process.cwd(), "scripts");

async function main() {
  const scanId = process.argv[2];
  const confirm = process.argv.includes("--confirm");
  if (!scanId) {
    console.error(
      "Usage: npx tsx scripts/disclaimer-injection-replan.ts <scan_id> --confirm [--mode=claude|scrub] [--limit=N]",
    );
    process.exit(1);
  }
  // Capture pass-through flags (mode + limit + account) to forward to
  // the plan script. Useful for cohort-scoped safety tests:
  //   replan --confirm --mode=claude --account=AMZCOM --limit=5
  const passthroughFlags = process.argv
    .slice(3)
    .filter(
      (a) =>
        a.startsWith("--mode=") ||
        a.startsWith("--limit=") ||
        a.startsWith("--account="),
    );

  const scan = await prisma.listingAuditScan.findUniqueOrThrow({
    where: { id: scanId },
  });
  if (scan.status !== "completed") {
    throw new Error(
      `Scan ${scanId} status=${scan.status}, expected 'completed'.`,
    );
  }

  // Count what we'd delete before doing anything.
  const toDelete = await prisma.listingRemediation.findMany({
    where: {
      status: { in: ["plan", "failed"] },
      audit_result: { scan_id: scanId },
    },
    select: { id: true, audit_result_id: true, status: true },
  });
  const byStatus: Record<string, number> = {};
  for (const r of toDelete) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  console.log(
    `Scan ${scanId}: ${toDelete.length} ListingRemediation rows would be deleted` +
      ` (${Object.entries(byStatus)
        .map(([s, n]) => `${s}=${n}`)
        .join(", ")}).`,
  );

  if (!confirm) {
    console.log(
      "\nDry run — pass --confirm to actually delete + re-plan.\n" +
        "Original ListingAuditResult content is NEVER affected; only the " +
        "remediation rows we wrote ourselves are removed. 'completed' / " +
        "'rolled_back' / 'verification_failed' rows are left alone.",
    );
    return;
  }

  // ── Delete in two steps to side-step Turso latency on large IN-lists ──
  const auditIdsToReset: string[] = toDelete.map((r) => r.audit_result_id);
  const deletion = await prisma.listingRemediation.deleteMany({
    where: {
      status: { in: ["plan", "failed"] },
      audit_result: { scan_id: scanId },
    },
  });
  console.log(`Deleted ${deletion.count} ListingRemediation rows.`);

  // Reset remediation_status on the parent audit rows so the plan script
  // will pick them up again (it filters on `remediation_status='PENDING'`).
  if (auditIdsToReset.length > 0) {
    // Chunk to avoid hitting libsql parameter limits with very large IN().
    const CHUNK = 200;
    let resetCount = 0;
    for (let i = 0; i < auditIdsToReset.length; i += CHUNK) {
      const slice = auditIdsToReset.slice(i, i + CHUNK);
      const r = await prisma.listingAuditResult.updateMany({
        where: { id: { in: slice } },
        data: { remediation_status: "PENDING" },
      });
      resetCount += r.count;
    }
    console.log(
      `Reset ${resetCount}/${auditIdsToReset.length} ListingAuditResult.remediation_status → PENDING.`,
    );
  }

  // Disconnect Prisma before invoking the plan script so it gets its own
  // libsql connection without resource contention.
  await prisma.$disconnect();

  // Re-invoke the plan script as a child process. We can't import its
  // `main()` because the plan file already calls main() on import side
  // (top-level await chain). Subprocess is the cleanest way to reuse
  // every plan-side guardrail (scrub verdict, idempotent upserts, the
  // markdown report writer).
  console.log(
    `\nRe-running plan script${passthroughFlags.length > 0 ? ` with ${passthroughFlags.join(" ")}` : ""} …\n`,
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "npx",
      [
        "tsx",
        join(SCRIPTS_DIR, "disclaimer-injection-plan.ts"),
        scanId,
        ...passthroughFlags,
      ],
      {
        stdio: "inherit",
        env: process.env,
      },
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`plan script exited with code ${code}`));
    });
  });

  console.log("\nReplan complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
