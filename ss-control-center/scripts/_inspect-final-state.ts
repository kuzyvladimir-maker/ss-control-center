// Final post-execute breakdown for Phase 2.6.2 report.
import "dotenv/config";
import { prisma } from "@/lib/prisma";

async function main() {
  const scan = "cmpaisoq80000wlfz4llxuo5k";
  const total = await prisma.listingRemediation.count({
    where: { audit_result: { scan_id: scan } },
  });
  const byStatus = await prisma.listingRemediation.groupBy({
    by: ["status"],
    where: { audit_result: { scan_id: scan } },
    _count: { _all: true },
  });
  console.log(`Scan ${scan}\nTotal ListingRemediation rows: ${total}\n`);
  console.log("By status:");
  for (const r of byStatus.sort((a, b) => a.status.localeCompare(b.status))) {
    console.log(`  ${r.status.padEnd(20)} ${r._count._all}`);
  }

  // Audit-side breakdown by account
  const byAudit = await prisma.listingAuditResult.groupBy({
    by: ["account", "remediation_status"],
    where: {
      scan_id: scan,
      risk_reasons: { contains: "Missing curator/assembler disclaimer" },
    },
    _count: { _all: true },
  });
  console.log("\nAudit rows by account/remediation_status:");
  const grouped: Record<string, Record<string, number>> = {};
  for (const r of byAudit) {
    grouped[r.account] = grouped[r.account] ?? {};
    grouped[r.account][r.remediation_status] = r._count._all;
  }
  for (const acct of Object.keys(grouped).sort()) {
    const states = grouped[acct];
    const total = Object.values(states).reduce((a, b) => a + b, 0);
    const parts = Object.entries(states)
      .sort()
      .map(([s, n]) => `${s}=${n}`)
      .join("  ");
    console.log(`  ${acct.padEnd(10)} total=${total}  ${parts}`);
  }

  // Error breakdown by code on failed rows
  console.log("\nFailure error codes:");
  const failed = await prisma.listingRemediation.findMany({
    where: { status: "failed", audit_result: { scan_id: scan } },
    select: { sp_api_error: true, audit_result: { select: { account: true } } },
  });
  const codeFreq: Record<string, number> = {};
  const codeByAccount: Record<string, Record<string, number>> = {};
  for (const f of failed) {
    const err = f.sp_api_error ?? "";
    // Match all codes like "code":"5665"
    const codes = [...err.matchAll(/"code":"(\d+)"/g)].map((m) => m[1]);
    const uniq = [...new Set(codes)];
    const key = uniq.length > 0 ? uniq.sort().join("+") : "no-code";
    codeFreq[key] = (codeFreq[key] ?? 0) + 1;
    const acct = f.audit_result.account;
    codeByAccount[acct] = codeByAccount[acct] ?? {};
    codeByAccount[acct][key] = (codeByAccount[acct][key] ?? 0) + 1;
  }
  for (const [code, n] of Object.entries(codeFreq).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${code.padEnd(20)} ${n}`);
  }
  console.log("\nFailure codes by account:");
  for (const acct of Object.keys(codeByAccount).sort()) {
    console.log(`  ${acct}:`);
    for (const [code, n] of Object.entries(codeByAccount[acct]).sort(
      (a, b) => b[1] - a[1],
    )) {
      console.log(`    ${code.padEnd(20)} ${n}`);
    }
  }

  // Cost total
  const costAgg = await prisma.listingRemediation.aggregate({
    where: { audit_result: { scan_id: scan } },
    _sum: { ai_cost_cents: true },
  });
  console.log(
    `\nTotal AI cost (cents): ${costAgg._sum.ai_cost_cents ?? 0} ($${((costAgg._sum.ai_cost_cents ?? 0) / 100).toFixed(2)})`,
  );

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
