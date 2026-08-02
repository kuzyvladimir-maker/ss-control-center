#!/usr/bin/env node
/**
 * Re-render studio-lane Walmart draft copy from the draft's own stored
 * Product Truth component.
 *
 * The first studio drafts were written before the engine knew that
 * `component.flavor` is a canonical hashing token bag rather than prose, so
 * their bullets read "Exact flavor or variant: chicken pie pot pub style".
 * This re-runs the SAME deterministic content builder the engine now runs,
 * with the manufacturer's own flavor wording, and re-runs the compliance gate
 * on the result. It reads nothing from a provider and touches no marketplace.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/walmart-studio-draft-content-refresh.ts --dry-run
 *   npx tsx --env-file=.env scripts/walmart-studio-draft-content-refresh.ts --apply
 *   … --apply --draft <id>            # one draft instead of every studio draft
 */

import { prisma } from "../src/lib/prisma";
import { runComplianceGate } from "../src/lib/bundle-factory/compliance/gate";
import {
  buildDeterministicWalmartMultipackContent,
} from "../src/lib/bundle-factory/walmart-new-sku-engine";
import {
  walmartStudioDisplayBrand,
  walmartStudioDisplayFlavor,
} from "../src/lib/bundle-factory/walmart-studio-listing";

const STUDIO_TEMPLATE = "walmart-deterministic-product-truth-draft";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const dryRun = process.argv.includes("--dry-run");
  if (apply === dryRun) throw new Error("choose exactly one of --dry-run or --apply");
  const only = process.argv[process.argv.indexOf("--draft") + 1];

  const rows = await prisma.generatedContent.findMany({
    where: {
      channel: "WALMART",
      template: STUDIO_TEMPLATE,
      ...(process.argv.includes("--draft") ? { bundle_draft_id: only } : {}),
    },
    select: { id: true, bundle_draft_id: true },
  });
  console.log(JSON.stringify({
    mode: apply ? "APPLY" : "DRY_RUN",
    studio_content_rows: rows.length,
    marketplace_mutations: 0,
  }));

  for (const row of rows) {
    const draft = await prisma.bundleDraft.findUnique({
      where: { id: row.bundle_draft_id },
      select: { id: true, pack_count: true, draft_components: true },
    });
    if (!draft) {
      console.log(`  SKIP ${row.bundle_draft_id}: draft is gone`);
      continue;
    }
    let snapshot: Array<Record<string, unknown>>;
    try {
      const parsed = JSON.parse(draft.draft_components) as unknown;
      if (!Array.isArray(parsed)) throw new Error("not an array");
      snapshot = parsed as Array<Record<string, unknown>>;
    } catch {
      console.log(`  SKIP ${draft.id}: unreadable component snapshot`);
      continue;
    }
    const component = snapshot[0]?.product_truth_component as
      | Record<string, unknown>
      | undefined;
    if (!component) {
      console.log(`  SKIP ${draft.id}: snapshot has no Product Truth component`);
      continue;
    }
    const displayFlavor = walmartStudioDisplayFlavor(component);
    const displayBrand = walmartStudioDisplayBrand(component);
    const content = buildDeterministicWalmartMultipackContent({
      component: {
        product_name: String(component.product_name ?? ""),
        manufacturer_brand: displayBrand,
        flavor: displayFlavor,
        qty: Number(component.qty),
      },
      packCount: draft.pack_count,
    });
    const decision = await runComplianceGate(
      {
        title: content.title,
        brand: displayBrand,
        bullets: content.bullets,
        description: content.description,
        main_image_url: null,
        bundle_components: [{
          brand: displayBrand,
          product_name: String(component.product_name ?? ""),
        }],
        skip_image_check: true,
        channel: "WALMART",
      },
      { actor: "walmart-studio-draft-content-refresh", autoFix: true },
    );
    const flavorBullet = decision.final_bullets.find((bullet) =>
      bullet.startsWith("Exact flavor")) ?? "(no flavor bullet)";
    console.log(`  ${decision.decision} ${draft.id} — ${flavorBullet}`);
    if (!apply) continue;

    snapshot[0] = { ...snapshot[0], flavor: displayFlavor, brand: displayBrand };
    await prisma.generatedContent.update({
      where: { id: row.id },
      data: {
        title: content.title,
        bullets_json: JSON.stringify(decision.final_bullets),
        description: decision.final_description,
        compliance_status: decision.decision,
      },
    });
    await prisma.bundleDraft.update({
      where: { id: draft.id },
      data: {
        brand: displayBrand,
        draft_name: content.title,
        draft_title: content.title,
        draft_bullets: JSON.stringify(decision.final_bullets),
        draft_description: decision.final_description,
        draft_components: JSON.stringify(snapshot),
      },
    });
    // The canonical recipe row feeds the recipe/content validator.
    const master = await prisma.bundleDraft.findUnique({
      where: { id: draft.id },
      select: { master_bundle_id: true },
    });
    if (master?.master_bundle_id) {
      const components = await prisma.bundleComponent.findMany({
        where: { master_bundle_id: master.master_bundle_id },
        select: { id: true },
        orderBy: { created_at: "asc" },
      });
      if (components.length === 1) {
        await prisma.bundleComponent.update({
          where: { id: components[0].id },
          data: { flavor: displayFlavor, manufacturer_brand: displayBrand },
        });
      }
      await prisma.masterBundle.update({
        where: { id: master.master_bundle_id },
        data: { brand: displayBrand },
      });
    }
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
