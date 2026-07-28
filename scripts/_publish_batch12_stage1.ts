// PUBLISH batch 1+2, stage 1 — owner gate 2026-07-22: "давай листить их на amazon".
// Creates the DB substrate for the 10 preview listings through the REAL
// Bundle Factory promote path (no engine edits):
//   GenerationJob → BundleDraft (draft_components with official allergen
//   declarations) → GeneratedContent → real runComplianceGate (8 rules) →
//   promoteDraftToChannelSkus (SKU mint + UPC claim + canonical band) →
//   operator ship-specs (live cohort convention: S 12x12x10/160oz,
//   M 13x13x15/256oz, XL 24x13x16/544oz) → operator-declared inventory
//   (buy-to-order; Veeqo does not track these retail components, same as the
//   161 live listings).
// Output: scratchpad/publish-batch12-skus.json for the approvals-v3 minter
// and the submit runner. DRY=1 prints the plan without writing.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const SCRATCH = "/private/tmp/claude-501/-Users-vladimirkuznetsov-SS-Command-Center/1dbdc77d-9c20-49be-9e0d-c48b604008f6/scratchpad/";
// later files win per slug. FILES env overrides for other batches (e.g. the
// trial run: FILES=trial-wave1.json,trial-wavecustom.json OUT_MAP=publish-trial-skus.json)
const FILES = process.env.FILES
  ? process.env.FILES.split(",").map((s) => s.trim()).filter(Boolean)
  : [
      "preview-final-2.json", "preview-final-4.json", "preview-final-5.json",
      "preview-final-6.json", "preview-final-7.json", "preview-final-7b.json",
    ];

const STD_ALLERGENS = { contains: ["Peanuts", "Wheat"], may_contain: ["Hazelnut", "Milk"] };
// smuckersuncrustables.com/sandwiches/hazelnut-spread-sandwich (verified 2026-07-22):
// CONTAINS HAZELNUT, MILK, AND WHEAT INGREDIENTS. MAY CONTAIN PEANUT INGREDIENTS.
const HAZELNUT_ALLERGENS = { contains: ["Hazelnut", "Milk", "Wheat"], may_contain: ["Peanuts"] };
// 4ct Walmart-donor UPCs for the two flavors whose picked donors lack upc
const UPC_OVERRIDES: Record<string, string> = {
  "Peanut Butter & Strawberry Jam": "051500048160",
  "Peanut Butter & Grape Jelly": "051500048153",
};
const QTY_OPERATOR_DECLARED = 10;

// Official manufacturer ingredient lists (smuckersuncrustables.com product
// pages, fetched 2026-07-22; Berry Burst from H-E-B PDP — page retired at
// manufacturer). Donors already carry ingredients for honey / chocolate /
// raspberry / hazelnut, so those are absent here and fall back to donor data.
const INGREDIENTS: Record<string, string> = {
  "Peanut Butter & Strawberry Jam":
    "Bread: Enriched Unbleached Flour (Wheat Flour, Malted Barley Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Unbleached Whole Wheat Flour, Sugar, Yeast, Soybean Oil, Contains 2% Or Less Of: Salt, Dough Conditioner (Enzymes, Ascorbic Acid, Calcium Peroxide). Peanut Butter: Peanuts, Sugar, Contains 2% Or Less Of: Molasses, Fully Hydrogenated Vegetable Oils (Rapeseed And Soybean), Mono And Diglycerides, Salt. Strawberry Jam: Sugar, Strawberries, Contains 2% Or Less Of: Pectin, Citric Acid, Potassium Sorbate (Preservative).",
  "Peanut Butter & Grape Jelly":
    "Bread: Enriched Unbleached Flour (Wheat Flour, Malted Barley Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Unbleached Whole Wheat Flour, Sugar, Yeast, Soybean Oil, Contains 2% Or Less Of: Wheat Gluten, Salt, Guar Gum, Dough Conditioner (Enzymes, Ascorbic Acid, Calcium Peroxide). Peanut Butter: Peanuts, Sugar, Contains 2% Or Less Of: Fully Hydrogenated Vegetable Oils (Rapeseed And Soybean), Salt, Molasses. Grape Jelly: Sugar, Grape Juice, Contains 2% Or Less Of: Pectin, Citric Acid, Potassium Sorbate (Preservative).",
  "Peanut Butter":
    "Bread: Enriched Unbleached Flour (Wheat Flour, Malted Barley Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Unbleached Whole Wheat Flour, Sugar, Yeast, Soybean Oil, Contains 2% Or Less Of: Wheat Gluten, Salt, Guar Gum, Dough Conditioner (Enzymes, Ascorbic Acid, Calcium Peroxide). Peanut Butter: Peanuts, Sugar, Contains 2% Or Less Of: Fully Hydrogenated Vegetable Oils (Rapeseed And Soybean), Salt, Molasses.",
  "Peanut Butter & Blueberry":
    "Peanut Butter: Peanuts, Contains 2% Or Less Of: Fully Hydrogenated Vegetable Oils (Rapeseed And Soybean), Sugar, Salt, Molasses. Bread: Unbleached Whole Wheat Flour, Enriched Unbleached Flour (Wheat Flour, Malted Barley Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Sugar, Yeast, Soybean Oil, Contains 2% Or Less Of: Wheat Gluten, Salt, Dough Conditioner (Mono And Diglycerides, Sodium Stearoyl Lactylate, DATEM, Enzymes, Ascorbic Acid, Calcium Peroxide). Blueberry Spread: Sugar, Blueberries, Water, Contains 2% Or Less Of: Pectin, Citric Acid, Potassium Sorbate (Preservative), Natural Flavor.",
  "Morning Protein Peanut Butter & Mixed Berry Spread":
    "Peanut Butter: Peanuts, Contains 2% Or Less Of: Fully Hydrogenated Vegetable Oils (Rapeseed And Soybean), Sugar, Salt, Molasses. Bread: Unbleached Whole Wheat Flour, Enriched Unbleached Flour (Wheat Flour, Malted Barley Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Sugar, Yeast, Soybean Oil, Contains 2% Or Less Of: Wheat Gluten, Salt, Dough Conditioner (Mono And Diglycerides, Sodium Stearoyl Lactylate, DATEM, Enzymes, Ascorbic Acid, Calcium Peroxide). Mixed Berry Spread: Sugar, Strawberries, Blueberries, Water, Contains 2% Or Less Of: Pectin, Citric Acid, Potassium Sorbate (Preservative).",
  "Peanut Butter & Blackberry Spread":
    "Bread: Enriched Unbleached Flour (Wheat Flour, Malted Barley Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Unbleached Whole Wheat Flour, Sugar, Yeast, Soybean Oil, Contains 2% Or Less Of: Wheat Gluten, Salt, Guar Gum, Dough Conditioner (Enzymes, Ascorbic Acid, Calcium Peroxide). Peanut Butter: Peanuts, Sugar, Contains 2% Or Less Of: Fully Hydrogenated Vegetable Oils (Rapeseed And Soybean), Salt, Molasses. Blackberry Spread: Sugar, Blackberries, Water, Contains 2% Or Less Of: Pectin, Citric Acid, Natural Flavor, Potassium Sorbate (Preservative).",
  "Whole Wheat Peanut Butter & Strawberry Jam":
    "Bread: Unbleached Whole Wheat Flour, Enriched Unbleached Flour (Wheat Flour, Malted Barley Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Sugar, Yeast, Contains 2% Or Less Of: Wheat Gluten, Soybean Oil, Salt, Dough Conditioner (Mono And Diglycerides, Sodium Stearoyl Lactylate, DATEM, Enzymes, Ascorbic Acid, Calcium Peroxide). Peanut Butter: Peanuts, Contains 2% Or Less Of: Fully Hydrogenated Vegetable Oils (Rapeseed And Soybean), Mono And Diglycerides, Molasses, Sugar, Salt. Strawberry Spread: Sugar, Strawberries, Water, Contains 2% Or Less Of: Fruit Pectin, Citric Acid, Locust Bean Gum, Potassium Sorbate (Preservative), Calcium Chloride.",
  "Whole Wheat Peanut Butter & Grape Jelly":
    "Bread: Unbleached Whole Wheat Flour, Enriched Unbleached Flour (Wheat Flour, Malted Barley Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Sugar, Yeast, Contains 2% Or Less Of: Wheat Gluten, Soybean Oil, Salt, Dough Conditioner (Mono And Diglycerides, Sodium Stearoyl Lactylate, DATEM, Enzymes, Ascorbic Acid, Calcium Peroxide). Peanut Butter: Peanuts, Contains 2% Or Less Of: Fully Hydrogenated Vegetable Oils (Rapeseed And Soybean), Mono And Diglycerides, Molasses, Sugar, Salt. Grape Spread: Grapes, Sugar, Water, Fruit Pectin, Citric Acid, Locust Bean Gum, Potassium Sorbate (Preservative), Calcium Chloride.",
  "Peanut Butter & Strawberry Jam Protein":
    "Peanut Butter: Peanuts, Contains 2% Or Less Of: Fully Hydrogenated Vegetable Oils (Rapeseed And Soybean), Mono And Diglycerides, Molasses, Sugar, Salt. Bread: Unbleached Whole Wheat Flour, Enriched Unbleached Flour (Wheat Flour, Malted Barley Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Sugar, Yeast, Soybean Oil, Contains 2% Or Less Of: Wheat Gluten, Salt, Dough Conditioner (Mono And Diglycerides, Sodium Stearoyl Lactylate, DATEM, Enzymes, Ascorbic Acid, Calcium Peroxide). Strawberry Jam: Sugar, Strawberries, Contains 2% Or Less Of: Pectin, Citric Acid, Potassium Sorbate (Preservative).",
  "Peanut Butter & Apple Cinnamon Jelly Protein":
    "Peanut Butter: Peanuts, Contains 2% Or Less Of: Fully Hydrogenated Vegetable Oils (Rapeseed And Soybean), Mono And Diglycerides, Molasses, Sugar, Salt. Bread: Unbleached Whole Wheat Flour, Enriched Unbleached Flour (Wheat Flour, Malted Barley Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Sugar, Yeast, Soybean Oil, Contains 2% Or Less Of: Wheat Gluten, Salt, Dough Conditioner (Mono And Diglycerides, Sodium Stearoyl Lactylate, DATEM, Enzymes, Ascorbic Acid, Calcium Peroxide). Apple Cinnamon Jelly: Sugar, Apple Juice, Contains 2% Or Less Of: Pectin, Citric Acid, Cinnamon, Potassium Sorbate (Preservative).",
  "Peanut Butter & Honey Spread":
    "UNBLEACHED WHOLE WHEAT FLOUR, ENRICHED UNBLEACHED FLOUR (WHEAT FLOUR, MALTED BARLEY FLOUR, NIACIN, FERROUS SULFATE, THIAMIN MONONITRATE, RIBOFLAVIN, FOLIC ACID), WATER, SUGAR, YEAST, WHEAT GLUTEN, SOYBEAN OIL, SALT, DOUGH CONDITIONER (MONO AND DIGLYCERIDES, SODIUM STEAROYL LACTYLATE, DATEM, ENZYMES, ASCORBIC ACID, CALCIUM PEROXIDE), PEANUTS, MOLASSES, FULLY HYDROGENATED VEGETABLE OILS (RAPESEED AND SOYBEAN), HONEY, PECTIN, CITRIC ACID, POTASSIUM SORBATE, NATURAL FLAVOR, CALCIUM CHLORIDE.",
  "Peanut Butter & Chocolate Flavored Spread":
    "Bread: Enriched Unbleached Flour (Wheat Flour, Malted Barley Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Unbleached Whole Wheat Flour, Sugar, Yeast, Soybean Oil, Contains 2% Or Less Of: Salt, Dough Conditioner (Enzymes, Ascorbic Acid, Calcium Peroxide). Peanut Butter: Peanuts, Sugar, Contains 2% Or Less Of: Molasses, Fully Hydrogenated Vegetable Oils (Rapeseed And Soybean), Mono And Diglycerides, Salt. Chocolate Flavored Spread: Corn Syrup, Sugar, Water, Cocoa Processed With Alkali, Contains 2% Or Less Of: Pectin, Potassium Sorbate (Preservative), Calcium Chloride, Artificial Flavor.",
  "Peanut Butter & Raspberry Spread":
    "Bread: Enriched Unbleached Flour (Wheat Flour, Malted Barley Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Unbleached Whole Wheat Flour, Sugar, Yeast, Soybean Oil, Contains 2% Or Less Of: Wheat Gluten, Salt, Guar Gum, Dough Conditioner (Enzymes, Ascorbic Acid, Calcium Peroxide). Peanut Butter: Peanuts, Sugar, Contains 2% Or Less Of: Fully Hydrogenated Vegetable Oils (Rapeseed And Soybean), Salt, Molasses. Raspberry Spread: Sugar, Raspberries, Water, Contains 2% Or Less Of: Pectin, Citric Acid, Natural Flavors, Potassium Sorbate (Preservative).",
  "Chocolate Flavored Hazelnut Spread":
    "Bread: Enriched Unbleached Flour (Wheat Flour, Malted Barley Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Unbleached Whole Wheat Flour, Sugar, Yeast, Soybean Oil, Contains 2% or Less of: Salt, Dough Conditioner (Enzymes, Ascorbic Acid, Calcium Peroxide). Chocolate Flavored Hazelnut Spread: Sugar, Vegetable Oils (Palm and Canola), Hazelnuts, Cocoa Processed with Alkali and Cocoa, Skim Milk, Whey, Contains 2% or Less of: Canola Lecithin, Vanillin (Artificial Flavor).",
  "Peanut Butter & Mixed Berry Spread":
    "Bread: Enriched Unbleached Flour (Wheat Flour, Malted Barley Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Unbleached Whole Wheat Flour, Sugar, Yeast, Soybean Oil, Contains 2% or Less of: Salt, Dough Conditioner (Enzymes, Ascorbic Acid, Calcium Peroxide). Peanut Butter: Peanuts, Sugar, Contains 2% or Less of: Molasses, Fully Hydrogenated Vegetable Oils (Rapeseed and Soybean), Mono and Diglycerides, Salt. Mixed Berry Spread: Sugar, Strawberries, Blueberries, Water, Contains 2% or Less of: Pectin, Citric Acid, Potassium Sorbate (Preservative).",
};

function bandFor(count: number) {
  if (count <= 30) return { weight_oz: 160, length_in: 12, width_in: 12, height_in: 10 };
  if (count <= 60) return { weight_oz: 256, length_in: 13, width_in: 13, height_in: 15 };
  return { weight_oz: 544, length_in: 24, width_in: 13, height_in: 16 };
}

function allergensFor(flavor: string) {
  return /hazelnut/i.test(flavor) && !/peanut butter &/i.test(flavor)
    ? HAZELNUT_ALLERGENS
    : STD_ALLERGENS;
}

async function main() {
  const DRY = process.env.DRY === "1";
  const ONLY = (process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const dd: any = await import("../src/lib/bundle-factory/donor-dedup");
  const donorUnitPriceCents = dd.donorUnitPriceCents ?? dd.default?.donorUnitPriceCents;
  const gate: any = await import("../src/lib/bundle-factory/compliance/gate");
  const runComplianceGate = gate.runComplianceGate ?? gate.default?.runComplianceGate;
  const pd: any = await import("../src/lib/bundle-factory/validation/promote-draft");
  const promoteDraftToChannelSkus = pd.promoteDraftToChannelSkus ?? pd.default?.promoteDraftToChannelSkus;
  const pps: any = await import("../src/lib/bundle-factory/physical-package-specs");
  const withVerifiedPhysicalPackageSpecs = pps.withVerifiedPhysicalPackageSpecs ?? pps.default?.withVerifiedPhysicalPackageSpecs;

  // ---- load listings, later files override earlier by slug, keep first-seen order
  const bySlug = new Map<string, any>();
  const order: string[] = [];
  for (const f of FILES) {
    if (!existsSync(SCRATCH + f)) continue;
    for (const l of JSON.parse(readFileSync(SCRATCH + f, "utf8"))) {
      if (!bySlug.has(l.slug)) order.push(l.slug);
      bySlug.set(l.slug, l);
    }
  }
  const listings = order
    .map((s) => bySlug.get(s))
    .filter((l) => (ONLY.length ? ONLY.includes(l.slug) : true));

  // idempotency: remove orphans of failed prior runs (draft created, promote
  // threw → no master bundle), and skip slugs that already completed.
  // "done" = the job's draft reached a master bundle WITH ChannelSKUs.
  // Anything less is an orphan of a failed run and is removed for a clean
  // retry (SKU-less master bundles carry no marketplace state).
  const jobs = await prisma.generationJob.findMany({
    where: { brief: { contains: "preview-publish-batch12" } },
    select: { id: true, brief: true, bundle_drafts: { select: { id: true, master_bundle_id: true } } },
  });
  const doneSlugs = new Set<string>();
  for (const j of jobs) {
    let jobDone = false;
    for (const d of j.bundle_drafts) {
      const skuCount = d.master_bundle_id
        ? await prisma.channelSKU.count({ where: { master_bundle_id: d.master_bundle_id } })
        : 0;
      if (skuCount > 0) {
        jobDone = true;
        continue;
      }
      if (DRY) continue;
      await prisma.generatedContent.deleteMany({ where: { bundle_draft_id: d.id } });
      await prisma.complianceCheck.deleteMany({ where: { bundle_draft_id: d.id } }).catch(() => {});
      if (d.master_bundle_id) {
        await prisma.bundleComponent.deleteMany({ where: { master_bundle_id: d.master_bundle_id } }).catch(() => {});
        await prisma.bundleDraft.update({ where: { id: d.id }, data: { master_bundle_id: null } });
        await prisma.masterBundle.delete({ where: { id: d.master_bundle_id } }).catch(() => {});
      }
      await prisma.bundleDraft.delete({ where: { id: d.id } });
      console.log(`  🧹 удалён orphan-драфт ${d.id}`);
    }
    if (jobDone) {
      try { doneSlugs.add(JSON.parse(j.brief).slug); } catch {}
    } else if (!DRY) {
      await prisma.generationJob.delete({ where: { id: j.id } }).catch(() => {});
    }
  }

  const results: any[] = [];
  for (const l of listings) {
    console.log(`\n=== ${l.slug} (${l.total}ct, $${l.price}) ===`);
    if (doneSlugs.has(l.slug)) { console.log("  ↷ уже создан ранее — пропуск"); continue; }
    if (!l.main_image_url || !/^https:\/\/[^@]*\.r2\.dev\//.test(l.main_image_url)) {
      console.log(`  ✗ пропуск: нет R2 MAIN (${l.main_image_url})`);
      continue;
    }
    // components
    const components: any[] = [];
    let ok = true;
    for (const c of l.comps) {
      const donor = await prisma.donorProduct.findFirst({
        where: { title: c.donor_title ?? "___none___" },
        select: {
          id: true, title: true, upc: true, mainImageUrl: true, bestPrice: true,
          offers: { where: { isFirstParty: true, via: "direct", price: { gt: 0 } }, select: { price: true, packSizeSeen: true, pricePerUnit: true } },
        },
      });
      if (!donor) { console.log(`  ✗ донор не найден: ${c.donor_title}`); ok = false; break; }
      const upc = donor.upc?.trim() || UPC_OVERRIDES[c.flavor];
      if (!upc) { console.log(`  ✗ нет manufacturer UPC: ${c.flavor}`); ok = false; break; }
      const unit = donorUnitPriceCents(donor) ?? null;
      if (!unit || !Number.isInteger(unit) || unit <= 0) { console.log(`  ✗ нет unit price: ${c.flavor}`); ok = false; break; }
      components.push({
        research_pool_id: donor.id,
        product_name: c.flavor,
        brand: "Uncrustables",
        flavor: c.flavor,
        manufacturer_upc: upc,
        qty: c.qty,
        unit_price_cents: unit,
        ingredients: INGREDIENTS[c.flavor],
        allergen_declaration: allergensFor(c.flavor),
        donor_image_urls: donor.mainImageUrl ? [donor.mainImageUrl] : [],
      });
      console.log(`  + ${c.flavor}: qty ${c.qty}, upc ${upc}, unit ${unit}¢, allergens [${allergensFor(c.flavor).contains.join(",")}]`);
    }
    if (!ok) continue;
    const band = bandFor(l.total);
    console.log(`  band: ${band.length_in}x${band.width_in}x${band.height_in} in, ${band.weight_oz} oz | qty ${QTY_OPERATOR_DECLARED}`);
    if (DRY) continue;

    // ---- create job + draft + generated content
    const job = await prisma.generationJob.create({
      data: {
        brief: JSON.stringify({
          source: "preview-publish-batch12",
          owner_order: "2026-07-22 давай листить их на amazon",
          slug: l.slug,
        }),
        bundles_target: 1,
        current_stage: "CONTENT",
        status: "RUNNING",
        notes: "Manual preview→publish conveyor (batch 1+2), Claude Code as operator",
      },
    });
    const draft = await prisma.bundleDraft.create({
      data: {
        generation_job_id: job.id,
        draft_name: l.title,
        brand: "Uncrustables",
        category: "FROZEN_GROCERY",
        composition_type: l.comps.length > 1 ? "MIXED_FLAVOR" : "SINGLE_FLAVOR",
        pack_count: l.total,
        draft_components: JSON.stringify(components),
        draft_main_image_url: l.main_image_url,
        draft_cost_cents: l.cost_cents ?? null,
        status: "GENERATED",
        approved_at: new Date(),
        approved_by: "owner",
        target_channels: JSON.stringify(["AMAZON_SALUTEM"]),
      },
    });
    const gc = await prisma.generatedContent.create({
      data: {
        bundle_draft_id: draft.id,
        channel: "AMAZON_SALUTEM",
        template: "amazon",
        title: l.title,
        bullets_json: JSON.stringify(l.bullets),
        description: l.description,
        main_image_url: l.main_image_url,
      },
    });

    // ---- real compliance gate (8 rules incl. vision on the MAIN)
    const decision = await runComplianceGate(
      {
        bundle_draft_id: draft.id,
        title: l.title,
        brand: "Uncrustables",
        bullets: [...l.bullets],
        description: l.description,
        main_image_url: l.main_image_url,
        bundle_components: components.map((c) => ({ brand: "Uncrustables", product_name: c.product_name })),
      },
      { actor: "claude-publish-batch12" },
    );
    console.log(`  compliance: ${decision.decision}${decision.decision === "BLOCKED" ? " — " + decision.rules.filter((r: any) => !r.passed).map((r: any) => r.rule_id).join(",") : ""}`);
    if (decision.decision !== "CAN_PUBLISH") {
      results.push({ slug: l.slug, draft_id: draft.id, blocked: "compliance" });
      continue;
    }
    await prisma.generatedContent.update({
      where: { id: gc.id },
      data: { compliance_status: "CAN_PUBLISH", compliance_check_id: decision.compliance_check_id ?? null },
    });

    // ---- promote: MasterBundle + BundleComponents + ChannelSKU (SKU/UPC/band)
    const outcome = await promoteDraftToChannelSkus(draft.id);
    const fresh = await prisma.bundleDraft.findUnique({ where: { id: draft.id }, select: { master_bundle_id: true } });
    const mbId = fresh?.master_bundle_id;
    if (!mbId) { console.log("  ✗ promote не создал master bundle"); results.push({ slug: l.slug, draft_id: draft.id, blocked: "promote" }); continue; }

    // ---- operator ship-specs (live cohort convention) + operator-declared qty
    const mb = await prisma.masterBundle.findUnique({ where: { id: mbId }, select: { packaging_spec: true } });
    const spec = withVerifiedPhysicalPackageSpecs(mb?.packaging_spec ?? null, band);
    await prisma.masterBundle.update({
      where: { id: mbId },
      data: { packaging_spec: spec, total_weight_oz: band.weight_oz },
    });
    const skus = await prisma.channelSKU.findMany({ where: { master_bundle_id: mbId }, select: { id: true, sku: true, upc: true, price_cents: true, title: true } });
    for (const s of skus) {
      await prisma.channelSKU.update({
        where: { id: s.id },
        data: {
          package_length_in: band.length_in,
          package_width_in: band.width_in,
          package_height_in: band.height_in,
          package_weight_oz: band.weight_oz,
          available_quantity: QTY_OPERATOR_DECLARED,
          inventory_checked_at: new Date(),
        },
      });
      console.log(`  ✓ SKU ${s.sku} | upc ${s.upc} | price ${(s.price_cents / 100).toFixed(2)}`);
      results.push({
        slug: l.slug, draft_id: draft.id, master_bundle_id: mbId,
        channel_sku_id: s.id, sku: s.sku, upc: s.upc, price_cents: s.price_cents,
        pack_count: l.total, main_image_url: l.main_image_url,
        comps: l.comps, title: l.title,
      });
    }
  }

  if (!DRY) {
    writeFileSync(SCRATCH + (process.env.OUT_MAP ?? "publish-batch12-skus.json"), JSON.stringify(results, null, 1));
    console.log(`\nготово: ${results.filter((r) => r.sku).length} SKU создано, ${results.filter((r) => r.blocked).length} блокировано`);
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
