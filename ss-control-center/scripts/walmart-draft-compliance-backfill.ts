#!/usr/bin/env node
/**
 * Run the compliance gate over Walmart draft content that predates the engine
 * running it at write time.
 *
 * These rows were persisted as PENDING, and promotion only accepts
 * CAN_PUBLISH, so the listings could never reach publishing. This does not
 * flip a status: it executes the SAME gate the engine now runs at birth, on
 * the exact stored bytes, and records whatever the gate decides — CAN_PUBLISH
 * or BLOCKED with its reasons.
 *
 * Usage:
 *   npx tsx scripts/walmart-draft-compliance-backfill.ts --dry-run
 *   npx tsx scripts/walmart-draft-compliance-backfill.ts --apply
 */

import { prisma } from "../src/lib/prisma";
import { runComplianceGate } from "../src/lib/bundle-factory/compliance/gate";

interface SnapshotComponent {
  brand?: string;
  product_name?: string;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const dryRun = process.argv.includes("--dry-run");
  if (apply === dryRun) {
    throw new Error("choose exactly one of --dry-run or --apply");
  }

  const rows = await prisma.generatedContent.findMany({
    where: { channel: "WALMART", compliance_status: "PENDING" },
    select: {
      id: true,
      bundle_draft_id: true,
      title: true,
      bullets_json: true,
      description: true,
      main_image_url: true,
    },
  });
  console.log(JSON.stringify({
    mode: apply ? "APPLY" : "DRY_RUN",
    pending_rows: rows.length,
    marketplace_mutations: 0,
  }));

  for (const row of rows) {
    const draft = await prisma.bundleDraft.findUnique({
      where: { id: row.bundle_draft_id },
      select: { brand: true, draft_components: true },
    });
    if (!draft) {
      console.log(`  SKIP ${row.id}: draft is gone`);
      continue;
    }
    let components: SnapshotComponent[] = [];
    try {
      const parsed = JSON.parse(draft.draft_components ?? "[]") as unknown;
      if (Array.isArray(parsed)) components = parsed as SnapshotComponent[];
    } catch {
      // An unreadable snapshot must not become a silent pass.
      console.log(`  SKIP ${row.id}: unreadable component snapshot`);
      continue;
    }
    let bullets: string[] = [];
    try {
      const parsed = JSON.parse(row.bullets_json ?? "[]") as unknown;
      if (Array.isArray(parsed)) {
        bullets = parsed.filter((b): b is string => typeof b === "string");
      }
    } catch {
      console.log(`  SKIP ${row.id}: unreadable bullets`);
      continue;
    }

    const decision = await runComplianceGate(
      {
        title: row.title ?? "",
        brand: draft.brand ?? "",
        bullets,
        description: row.description ?? "",
        main_image_url: row.main_image_url,
        bundle_components: components.map((component) => ({
          brand: component.brand ?? draft.brand ?? "",
          product_name: component.product_name,
        })),
        // The main image is a deterministic composite of the exact donor
        // packshot, already proven by the composer.
        skip_image_check: true,
      },
      { actor: "walmart-draft-compliance-backfill" },
    );
    const failed = decision.rules
      .filter((rule) => !rule.passed)
      .map((rule) => `${rule.rule_id}${rule.reason ? `(${rule.reason})` : ""}`);
    console.log(
      `  ${decision.decision} ${row.bundle_draft_id}`
      + (failed.length ? ` — failed: ${failed.join(", ")}` : ""),
    );
    if (!apply) continue;
    await prisma.generatedContent.update({
      where: { id: row.id },
      data: { compliance_status: decision.decision },
    });
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
