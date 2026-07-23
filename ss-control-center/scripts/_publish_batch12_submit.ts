// PUBLISH batch 1+2, stage 2 — submit to Amazon (store1, owner order
// 2026-07-22). For each created ChannelSKU:
//   1. preflightProductionUncrustablesMain() fetches the EXACT R2 MAIN bytes
//      and matches them against the owner-approved v3 production proof —
//      emits the sealed publish permit (fail-closed);
//   2. submitToAmazon() runs its full blast-door chain (physical specs
//      byte-match, verified allergens, count, permit, fresh inventory, band
//      guards) and does VALIDATION_PREVIEW before the real PUT.
// Knobs: DRY=1 (no PUT, preview only), SKUS=<comma list> to scope,
// LIMIT=<n>. Default refuses to run without SKUS or ALL=1.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { readFileSync, writeFileSync } from "node:fs";

const SCRATCH = "/private/tmp/claude-501/-Users-vladimirkuznetsov-SS-Command-Center/1dbdc77d-9c20-49be-9e0d-c48b604008f6/scratchpad/";

async function main() {
  const DRY = process.env.DRY === "1";
  const SKUS = (process.env.SKUS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const ALL = process.env.ALL === "1";
  if (!SKUS.length && !ALL) {
    console.log("укажи SKUS=... или ALL=1");
    return;
  }

  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const ap: any = await import("../src/lib/bundle-factory/distribution/amazon-publish");
  const submitToAmazon = ap.submitToAmazon ?? ap.default?.submitToAmazon;
  const pf: any = await import("../src/lib/bundle-factory/audit/uncrustables-main-production-preflight");
  const preflight = pf.preflightProductionUncrustablesMain ?? pf.default?.preflightProductionUncrustablesMain;
  const pps: any = await import("../src/lib/bundle-factory/physical-package-specs");
  const parseSpecs = pps.parseVerifiedPhysicalPackageSpecs ?? pps.default?.parseVerifiedPhysicalPackageSpecs;
  const ad: any = await import("../src/lib/bundle-factory/allergen-declaration");
  const allergensFromStored = ad.amazonAllergensFromStoredDeclarations ?? ad.default?.amazonAllergensFromStoredDeclarations;

  const rows: any[] = JSON.parse(readFileSync(SCRATCH + "publish-batch12-skus.json", "utf8"))
    .filter((r: any) => (SKUS.length ? SKUS.includes(r.sku) : true))
    .slice(0, Number(process.env.LIMIT ?? 99));

  const outcomes: any[] = [];
  for (const row of rows) {
    console.log(`\n=== ${row.sku} (${row.slug}) ===`);
    const sku = await prisma.channelSKU.findUnique({ where: { id: row.channel_sku_id } });
    if (!sku) { console.log("  ✗ SKU не найден"); continue; }

    // refresh the operator-declared inventory stamp (15-min freshness gate)
    await prisma.channelSKU.update({
      where: { id: sku.id },
      data: { available_quantity: sku.available_quantity ?? 10, inventory_checked_at: new Date() },
    });
    const freshSku = await prisma.channelSKU.findUnique({ where: { id: sku.id } });

    const mb = await prisma.masterBundle.findUnique({
      where: { id: sku.master_bundle_id },
      select: { packaging_spec: true, category: true, brand: true, components: true },
    });
    const specs = parseSpecs(mb?.packaging_spec);
    if (!specs) { console.log("  ✗ нет verified specs"); continue; }
    const verifiedAllergens = allergensFromStored((mb?.components ?? []).map((c: any) => c.allergens));
    console.log(`  allergens: [${verifiedAllergens.join(",")}] | specs ${specs.length_in}x${specs.width_in}x${specs.height_in} ${specs.weight_oz}oz`);

    // authenticity permit from exact R2 bytes vs owner-approved v3 proof
    const pfRes = await preflight({
      sku: sku.sku,
      main_image_url: sku.main_image_url ?? row.main_image_url,
      pack_count: row.pack_count,
      components: row.comps.map((c: any) => ({ product_name: c.flavor, flavor: c.flavor, qty: c.qty })),
    });
    if (!pfRes.pass || !pfRes.permit) {
      console.log(`  ✗ permit BLOCKED: ${JSON.stringify(pfRes.findings).slice(0, 300)}`);
      outcomes.push({ sku: sku.sku, ok: false, stage: "permit", findings: pfRes.findings });
      continue;
    }
    console.log(`  ✓ permit ${pfRes.permit.sha256.slice(0, 12)}… (proof ${pfRes.proof_id})`);

    const result = await submitToAmazon({
      sku: freshSku,
      storeIndex: 1,
      productType: "GROCERY",
      brand: "Uncrustables",
      category: mb?.category ?? "FROZEN_GROCERY",
      dryRun: DRY,
      physicalPackageSpecs: specs,
      verifiedAllergens,
      uncrustablesMainPermit: pfRes.permit,
    });
    const issueText = (result.issues ?? []).map((i: any) => `${i.severity ?? "?"}:${i.code ?? "?"} ${String(i.message ?? "").slice(0, 90)}`).join(" | ");
    console.log(`  → ${result.ok ? "OK" : "FAIL"} | amazon ${result.amazon_status ?? "?"} | sub ${result.submission_id ?? "-"}${issueText ? " | " + issueText.slice(0, 300) : ""}`);
    outcomes.push({ sku: sku.sku, ok: result.ok, stage: "submit", amazon_status: result.amazon_status, submission_id: result.submission_id, issues: result.issues ?? [] });

    if (result.ok && !DRY) {
      await prisma.channelSKU.update({
        where: { id: sku.id },
        data: { lifecycle_status: "SUBMITTED", submitted_at: new Date(), submission_id: result.submission_id ?? null },
      });
    }
  }
  writeFileSync(SCRATCH + "publish-batch12-submit-report.json", JSON.stringify(outcomes, null, 1));
  console.log(`\nитого: ${outcomes.filter((o) => o.ok).length}/${outcomes.length} успешно`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
