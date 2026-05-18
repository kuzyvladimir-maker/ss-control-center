/**
 * Analytical report generator for the latest completed audit scan.
 *
 * Reads every ListingAuditResult row for the latest scan, aggregates
 * along multiple axes (distribution, reason frequency, brand exposure,
 * false-positive patterns, remediation strategy), and writes the
 * report to docs/AUDIT_ANALYSIS_<date>.md.
 *
 * Used during Phase 2.6.0:
 *   - First run = "before vision-refinement" snapshot (Sections A–G).
 *   - Re-run after rescore-audit-scan.ts to append Section H with the
 *     before/after deltas.
 *
 * Usage:
 *   set -a; source .env.local; set +a
 *   npx tsx scripts/analyze-audit-scan.ts                       # default report path
 *   npx tsx scripts/analyze-audit-scan.ts --append-section-h    # append H block instead
 */

import "dotenv/config";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { prisma } from "@/lib/prisma";
import {
  OWN_BRANDS_WHITELIST,
  GENERIC_DELI_TERMS_IGNORELIST,
} from "@/lib/bundle-factory/audit/vision-check";

const REPORT_PATH = join(
  process.cwd(),
  "..",
  "docs",
  "AUDIT_ANALYSIS_2026-05-19.md",
);

function pct(n: number, total: number): string {
  if (total === 0) return "0%";
  return ((n * 100) / total).toFixed(1) + "%";
}

function parseJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

interface SnapshotCounts {
  blocked: number;
  warning: number;
  low_risk: number;
  compliant: number;
}

async function buildReport(): Promise<{ md: string; summary: SnapshotCounts }> {
  // ── Find latest completed scan ─────────────────────────────────────
  const scan = await prisma.listingAuditScan.findFirst({
    where: { status: "completed" },
    orderBy: { started_at: "desc" },
  });
  if (!scan) {
    throw new Error("No completed scans found in database.");
  }
  console.log(
    `Latest completed scan: ${scan.id} (${scan.total_listings} listings, ` +
      `completed ${scan.completed_at?.toISOString()})`,
  );

  const accounts = parseJson<string[]>(scan.accounts_scanned, []);
  const results = await prisma.listingAuditResult.findMany({
    where: { scan_id: scan.id },
    select: {
      id: true,
      asin: true,
      sku: true,
      account: true,
      title: true,
      brand: true,
      browse_node: true,
      main_image_url: true,
      risk_score: true,
      risk_category: true,
      risk_reasons: true,
      detected_brands: true,
      detected_logos: true,
      vision_cost_cents: true,
    },
    orderBy: { risk_score: "desc" },
  });
  console.log(`Loaded ${results.length} ListingAuditResult rows.`);

  // ── Section A — Overall distribution ──────────────────────────────
  const byCategory: Record<string, number> = {
    BLOCKED: 0,
    WARNING: 0,
    LOW_RISK: 0,
    COMPLIANT: 0,
  };
  for (const r of results) {
    byCategory[r.risk_category] = (byCategory[r.risk_category] ?? 0) + 1;
  }
  const byAccount: Record<string, Record<string, number>> = {};
  for (const r of results) {
    const acct = r.account;
    if (!byAccount[acct]) {
      byAccount[acct] = { BLOCKED: 0, WARNING: 0, LOW_RISK: 0, COMPLIANT: 0 };
    }
    byAccount[acct][r.risk_category] =
      (byAccount[acct][r.risk_category] ?? 0) + 1;
  }
  const histogram = { "0-20": 0, "21-40": 0, "41-60": 0, "61-80": 0, "81-100": 0 };
  for (const r of results) {
    const s = r.risk_score;
    if (s <= 20) histogram["0-20"]++;
    else if (s <= 40) histogram["21-40"]++;
    else if (s <= 60) histogram["41-60"]++;
    else if (s <= 80) histogram["61-80"]++;
    else histogram["81-100"]++;
  }
  const visionRan = results.filter((r) => r.vision_cost_cents > 0).length;
  const visionCostUsd = (
    results.reduce((s, r) => s + r.vision_cost_cents, 0) / 100
  ).toFixed(2);

  // ── Section B — Reason frequency ──────────────────────────────────
  const reasonFreq = new Map<string, number>();
  const foreignBrandInTitleFreq = new Map<string, number>(); // X brands
  const foreignLogosFreq = new Map<string, number>();
  let missingDisclaimerCount = 0;
  let permanentBlocklistCount = 0;
  let wrongCategoryCount = 0;
  for (const r of results) {
    const reasons = parseJson<string[]>(r.risk_reasons, []);
    for (const reason of reasons) {
      reasonFreq.set(reason, (reasonFreq.get(reason) ?? 0) + 1);
      const titleMatch = reason.match(
        /Foreign brand "([^"]+)" in title under own brand/,
      );
      if (titleMatch) {
        const fb = titleMatch[1];
        foreignBrandInTitleFreq.set(
          fb,
          (foreignBrandInTitleFreq.get(fb) ?? 0) + 1,
        );
      }
      const extraMatch = reason.match(/Additional foreign brand "([^"]+)"/);
      if (extraMatch) {
        const fb = extraMatch[1];
        foreignBrandInTitleFreq.set(
          fb,
          (foreignBrandInTitleFreq.get(fb) ?? 0) + 1,
        );
      }
      if (reason === "Missing curator/assembler disclaimer") {
        missingDisclaimerCount++;
      }
      if (reason.startsWith("Matches permanent blocklist")) {
        permanentBlocklistCount++;
      }
      if (reason.startsWith("Foreign brands present but browse node")) {
        wrongCategoryCount++;
      }
    }
    // Detected logos column (already-stored logos from Vision)
    const logos = parseJson<string[]>(r.detected_logos, []);
    for (const logo of logos) {
      foreignLogosFreq.set(logo, (foreignLogosFreq.get(logo) ?? 0) + 1);
    }
  }
  const topReasons = [...reasonFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30);
  const topTitleBrands = [...foreignBrandInTitleFreq.entries()].sort(
    (a, b) => b[1] - a[1],
  );
  const topLogos = [...foreignLogosFreq.entries()].sort((a, b) => b[1] - a[1]);

  // ── Section C — BLOCKED listings ──────────────────────────────────
  const blocked = results.filter((r) => r.risk_category === "BLOCKED");

  // ── Section D — Top 50 WARNING ────────────────────────────────────
  const topWarning = results
    .filter((r) => r.risk_category === "WARNING")
    .sort((a, b) => b.risk_score - a.risk_score)
    .slice(0, 50);

  // ── Section E — False-positive patterns ──────────────────────────
  const ownLower = OWN_BRANDS_WHITELIST.map((s) => s.toLowerCase());
  const genericLower = GENERIC_DELI_TERMS_IGNORELIST.map((s) =>
    s.toLowerCase(),
  );
  const falsePositiveCounts: Record<string, { rows: number; categories: Record<string, number> }> = {};
  function bump(key: string, category: string) {
    if (!falsePositiveCounts[key]) {
      falsePositiveCounts[key] = {
        rows: 0,
        categories: { BLOCKED: 0, WARNING: 0, LOW_RISK: 0, COMPLIANT: 0 },
      };
    }
    falsePositiveCounts[key].rows++;
    falsePositiveCounts[key].categories[category] =
      (falsePositiveCounts[key].categories[category] ?? 0) + 1;
  }
  for (const r of results) {
    const logos = parseJson<string[]>(r.detected_logos, []);
    const logosLower = logos.map((s) => s.toLowerCase());
    for (const own of ownLower) {
      if (logosLower.includes(own)) bump(`OWN_BRAND:${own}`, r.risk_category);
    }
    for (const gen of genericLower) {
      if (logosLower.includes(gen)) bump(`GENERIC:${gen}`, r.risk_category);
    }
  }

  // ── Section F — Real foreign brand exposure ──────────────────────
  const realBrandExposure = new Map<
    string,
    { rows: number; totalScore: number; accounts: Record<string, number> }
  >();
  for (const r of results) {
    const logos = parseJson<string[]>(r.detected_logos, []);
    const detectedBrands = parseJson<string[]>(r.detected_brands, []);
    const allMentions = new Set<string>([...logos, ...detectedBrands]);
    for (const name of allMentions) {
      const lower = name.toLowerCase();
      if (ownLower.includes(lower) || genericLower.includes(lower)) continue;
      let entry = realBrandExposure.get(name);
      if (!entry) {
        entry = { rows: 0, totalScore: 0, accounts: {} };
        realBrandExposure.set(name, entry);
      }
      entry.rows++;
      entry.totalScore += r.risk_score;
      entry.accounts[r.account] = (entry.accounts[r.account] ?? 0) + 1;
    }
  }
  const topRealBrands = [...realBrandExposure.entries()]
    .sort((a, b) => b[1].rows - a[1].rows)
    .slice(0, 20);

  // ── Section G — Remediation cost ─────────────────────────────────
  const REMEDIATION_COST_CENTS: Record<string, number> = {
    DISCLAIMER_ONLY: 0,
    TITLE_ONLY: 1,
    IMAGE_ONLY: 4,
    MULTI: 5,
    BRAND_MISMATCH: 0,
    COMPLIANT: 0,
  };
  const strategyCounts: Record<string, number> = {
    DISCLAIMER_ONLY: 0,
    TITLE_ONLY: 0,
    IMAGE_ONLY: 0,
    MULTI: 0,
    BRAND_MISMATCH: 0,
    COMPLIANT: 0,
  };
  for (const r of results) {
    // Classify by reasons (not by category) — a "disclaimer only" row
    // has score=15 and lands in COMPLIANT, but the disclaimer is still
    // worth injecting; it's the Phase 2.6.1 target.
    const reasons = parseJson<string[]>(r.risk_reasons, []);
    const hasDisclaimer = reasons.some((x) =>
      x.includes("Missing curator/assembler disclaimer"),
    );
    const hasTitleBrand = reasons.some((x) =>
      x.includes("Foreign brand") && x.includes("in title under own brand"),
    );
    const hasImage = reasons.some((x) =>
      x.startsWith("Foreign logos detected"),
    );
    const issues = [hasDisclaimer, hasTitleBrand, hasImage].filter(Boolean).length;
    if (issues === 0) {
      strategyCounts.COMPLIANT++;
      continue;
    }
    if (issues >= 2) strategyCounts.MULTI++;
    else if (hasDisclaimer) strategyCounts.DISCLAIMER_ONLY++;
    else if (hasTitleBrand) strategyCounts.TITLE_ONLY++;
    else if (hasImage) strategyCounts.IMAGE_ONLY++;
    // BRAND_MISMATCH (brand attribute differs from title brand) requires
    // text comparison at remediation time, not detectable from reasons
    // alone — left at 0 here; the bulk-remediation script will mark
    // those rows when it processes them.
  }
  const totalCostCents = Object.entries(strategyCounts).reduce(
    (sum, [s, n]) => sum + (REMEDIATION_COST_CENTS[s] ?? 0) * n,
    0,
  );

  // ── Render markdown ──────────────────────────────────────────────
  const lines: string[] = [];
  lines.push(`# Listing Audit Analysis — ${new Date().toISOString().slice(0, 10)}`);
  lines.push("");
  lines.push(
    `**Scan:** \`${scan.id}\` · started ${scan.started_at.toISOString()} · ` +
      `completed ${scan.completed_at?.toISOString()}`,
  );
  lines.push(
    `**Accounts scanned:** ${accounts.join(", ")} · **Total listings:** ${scan.total_listings}`,
  );
  lines.push(
    `**Vision coverage:** ${visionRan}/${results.length} listings (${pct(visionRan, results.length)}) · ` +
      `total Vision spend $${visionCostUsd}`,
  );
  if (scan.error_message) {
    lines.push("");
    lines.push("**Scan notes:**");
    lines.push("```");
    lines.push(scan.error_message.slice(0, 1000));
    lines.push("```");
  }
  lines.push("");

  // Section A
  lines.push("## Section A — Overall distribution");
  lines.push("");
  lines.push("### Risk category");
  lines.push("| Category | Count | % |");
  lines.push("|---|---:|---:|");
  for (const cat of ["BLOCKED", "WARNING", "LOW_RISK", "COMPLIANT"]) {
    lines.push(
      `| ${cat} | ${byCategory[cat]} | ${pct(byCategory[cat], results.length)} |`,
    );
  }
  lines.push("");
  lines.push("### By account");
  lines.push("| Account | BLOCKED | WARNING | LOW_RISK | COMPLIANT | Total |");
  lines.push("|---|---:|---:|---:|---:|---:|");
  for (const acct of Object.keys(byAccount).sort()) {
    const b = byAccount[acct];
    const total = b.BLOCKED + b.WARNING + b.LOW_RISK + b.COMPLIANT;
    lines.push(
      `| ${acct} | ${b.BLOCKED} | ${b.WARNING} | ${b.LOW_RISK} | ${b.COMPLIANT} | ${total} |`,
    );
  }
  lines.push("");
  lines.push("### Score histogram");
  lines.push("| Bucket | Count |");
  lines.push("|---|---:|");
  for (const k of Object.keys(histogram) as Array<keyof typeof histogram>) {
    lines.push(`| ${k} | ${histogram[k]} |`);
  }
  lines.push("");

  // Section B
  lines.push("## Section B — Reason frequency analysis");
  lines.push("");
  lines.push(
    `Permanent blocklist hits: **${permanentBlocklistCount}** · ` +
      `Missing disclaimer: **${missingDisclaimerCount}** · ` +
      `Wrong category (foreign brand outside Gift Basket Exception): **${wrongCategoryCount}**`,
  );
  lines.push("");
  lines.push("### Top 30 reasons (by row count)");
  lines.push("| # | Reason | Count | % of all rows |");
  lines.push("|---:|---|---:|---:|");
  topReasons.forEach(([reason, n], i) => {
    lines.push(
      `| ${i + 1} | ${reason.replace(/\|/g, "\\|")} | ${n} | ${pct(n, results.length)} |`,
    );
  });
  lines.push("");
  lines.push("### Foreign brands found in titles (Rule 2)");
  if (topTitleBrands.length === 0) {
    lines.push("_None._");
  } else {
    lines.push("| Brand | Title-rule hits |");
    lines.push("|---|---:|");
    topTitleBrands.forEach(([b, n]) => lines.push(`| ${b} | ${n} |`));
  }
  lines.push("");
  lines.push("### Logos detected in main images (Rule 5, raw stored)");
  if (topLogos.length === 0) {
    lines.push("_None._");
  } else {
    lines.push("| Logo name | Frequency |");
    lines.push("|---|---:|");
    topLogos.slice(0, 40).forEach(([b, n]) => lines.push(`| ${b} | ${n} |`));
  }
  lines.push("");

  // Section C
  lines.push("## Section C — BLOCKED listings (full list)");
  lines.push("");
  if (blocked.length === 0) {
    lines.push("_None — no BLOCKED listings in this scan._");
  } else {
    for (const r of blocked) {
      lines.push(`### \`${r.asin}\` · ${r.account}`);
      lines.push(`**Title:** ${r.title}`);
      lines.push(`**SKU:** \`${r.sku ?? "—"}\` · **Brand:** ${r.brand || "—"}`);
      lines.push(`**Score:** ${r.risk_score}`);
      const reasons = parseJson<string[]>(r.risk_reasons, []);
      lines.push("**Reasons:**");
      for (const reason of reasons) lines.push(`- ${reason}`);
      lines.push("");
    }
  }

  // Section D
  lines.push("## Section D — Top 50 WARNING listings (by score)");
  lines.push("");
  lines.push("| ASIN | Account | Score | Title | Top reasons | Detected logos |");
  lines.push("|---|---|---:|---|---|---|");
  for (const r of topWarning) {
    const reasons = parseJson<string[]>(r.risk_reasons, []);
    const logos = parseJson<string[]>(r.detected_logos, []);
    const reasonsPreview = reasons
      .slice(0, 2)
      .map((x) => x.replace(/\|/g, "\\|"))
      .join("<br/>");
    const titleClip =
      r.title.length > 70 ? r.title.slice(0, 70) + "…" : r.title;
    lines.push(
      `| \`${r.asin}\` | ${r.account} | ${r.risk_score} | ${titleClip.replace(/\|/g, "\\|")} | ${reasonsPreview} | ${logos.join(", ")} |`,
    );
  }
  lines.push("");

  // Section E
  lines.push("## Section E — False-positive patterns in Vision output");
  lines.push("");
  lines.push(
    "Rows where Vision detected a name that is either our **own brand** or a " +
      "**generic deli/product term** (i.e. probably not a real foreign brand). " +
      "Counts split by current risk_category to show what we'd be downgrading.",
  );
  lines.push("");
  const fpKeys = Object.keys(falsePositiveCounts).sort(
    (a, b) =>
      falsePositiveCounts[b].rows - falsePositiveCounts[a].rows,
  );
  if (fpKeys.length === 0) {
    lines.push("_None observed._");
  } else {
    lines.push(
      "| Pattern | Total rows | BLOCKED | WARNING | LOW_RISK | COMPLIANT |",
    );
    lines.push("|---|---:|---:|---:|---:|---:|");
    for (const key of fpKeys) {
      const fp = falsePositiveCounts[key];
      lines.push(
        `| ${key} | ${fp.rows} | ${fp.categories.BLOCKED} | ${fp.categories.WARNING} | ${fp.categories.LOW_RISK} | ${fp.categories.COMPLIANT} |`,
      );
    }
  }
  lines.push("");

  // Section F
  lines.push("## Section F — Real foreign brand exposure");
  lines.push("");
  lines.push(
    "Brands detected (in title and/or image) that are NOT in the own-brand " +
      "whitelist and NOT generic deli terms. Sorted by listing count.",
  );
  lines.push("");
  if (topRealBrands.length === 0) {
    lines.push("_No real foreign brands detected._");
  } else {
    lines.push("| Brand | Listings | Avg score | Accounts |");
    lines.push("|---|---:|---:|---|");
    for (const [brand, info] of topRealBrands) {
      const avg = info.rows ? (info.totalScore / info.rows).toFixed(1) : "—";
      const accts = Object.entries(info.accounts)
        .sort((a, b) => b[1] - a[1])
        .map(([a, n]) => `${a}=${n}`)
        .join(", ");
      lines.push(`| ${brand} | ${info.rows} | ${avg} | ${accts} |`);
    }
  }
  lines.push("");

  // Section G
  lines.push("## Section G — Remediation cost projection");
  lines.push("");
  lines.push(
    "Remediation strategy assigned per listing based on which rules fired. " +
      "Costs estimated per ASIN: DISCLAIMER_ONLY = $0 (text-only template), " +
      "TITLE_ONLY = $0.01 (Claude rewrite), IMAGE_ONLY = $0.04 (image regen), " +
      "MULTI = $0.05, BRAND_MISMATCH = $0 (no AI cost, just SP-API patch).",
  );
  lines.push("");
  lines.push("| Strategy | Count | Unit cost | Subtotal |");
  lines.push("|---|---:|---:|---:|");
  for (const s of [
    "DISCLAIMER_ONLY",
    "TITLE_ONLY",
    "IMAGE_ONLY",
    "MULTI",
    "BRAND_MISMATCH",
    "COMPLIANT",
  ]) {
    const c = strategyCounts[s] ?? 0;
    const u = REMEDIATION_COST_CENTS[s];
    lines.push(`| ${s} | ${c} | $${(u / 100).toFixed(2)} | $${((c * u) / 100).toFixed(2)} |`);
  }
  lines.push(`| **Total** | ${results.length} | | **$${(totalCostCents / 100).toFixed(2)}** |`);
  lines.push("");
  lines.push(`_Total estimated remediation budget: **$${(totalCostCents / 100).toFixed(2)}**._`);
  lines.push("");

  const md = lines.join("\n");
  const summary: SnapshotCounts = {
    blocked: byCategory.BLOCKED,
    warning: byCategory.WARNING,
    low_risk: byCategory.LOW_RISK,
    compliant: byCategory.COMPLIANT,
  };
  return { md, summary };
}

async function appendSectionH(reportPath: string, summary: SnapshotCounts) {
  // We tag the prior summary by reading the existing top of the report.
  // The "before" numbers were captured BEFORE rescore, the "after" numbers
  // are the current state. Caller writes both.
  let priorSnapshot = "";
  try {
    priorSnapshot = await readFile(reportPath, "utf8");
  } catch {
    /* first run */
  }
  // The Section H content is fully prepared by rescore-audit-scan.ts.
  // Here we just no-op — analyze.ts is responsible only for the static
  // sections; the comparison block is appended separately.
  void priorSnapshot;
  void summary;
}

async function main() {
  const appendH = process.argv.includes("--append-section-h");
  const { md, summary } = await buildReport();
  await mkdir(dirname(REPORT_PATH), { recursive: true });
  if (appendH) {
    const existing = await readFile(REPORT_PATH, "utf8").catch(() => "");
    // Keep everything before Section H (if it exists) and replace with
    // the freshly-rendered sections; the H block itself is appended by
    // rescore-audit-scan.ts elsewhere.
    const cutoff = existing.indexOf("## Section H —");
    if (cutoff >= 0) {
      const sectionH = existing.slice(cutoff);
      await writeFile(REPORT_PATH, md + "\n" + sectionH, "utf8");
    } else {
      await writeFile(REPORT_PATH, md, "utf8");
    }
  } else {
    await writeFile(REPORT_PATH, md, "utf8");
  }
  console.log(
    `Wrote ${REPORT_PATH}\n` +
      `BLOCKED=${summary.blocked} WARNING=${summary.warning} ` +
      `LOW_RISK=${summary.low_risk} COMPLIANT=${summary.compliant}`,
  );
  await appendSectionH(REPORT_PATH, summary);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
