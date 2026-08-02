import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  WALMART_STUDIO_DRAFT_BRIEF_SCHEMA,
  buildWalmartStudioDraftWorkItems,
  type WalmartStudioDraftBrief,
  type WalmartStudioDraftWorkItem,
} from "../walmart-studio-draft-contract";
import { parseWalmartShippingTemplateDetails } from
  "../walmart-shipping-templates";
import type {
  ProductTruthWalmartRequestCandidateDiagnostic,
} from "@/lib/sourcing/product-truth-read-contract";

function diagnostic(index: number): ProductTruthWalmartRequestCandidateDiagnostic {
  return {
    donor_product_id: `queue-donor-${index}`,
    canonical_variant_id: `queue-variant-${index}`,
    title: `Campbell's soup ${index}`,
    brand: "Campbell's",
    flavor: `Flavor ${index}`,
    match_score: 100 - index,
    ready: true,
    missing: [],
    blockers: [],
    candidate: {
      donor_product_id: `queue-donor-${index}`,
      canonical_variant_id: `queue-variant-${index}`,
      title: `Campbell's soup ${index}`,
      brand: "Campbell's",
      flavor: `Flavor ${index}`,
      manufacturer_upc: `0000000000${index}`,
      category: "Canned soup",
      storage_classification: "SHELF_STABLE",
      classification_evidence: {
        category_field: "category",
        storage_field: "storage",
        content_observation_id: `queue-content-${index}`,
        source_api: "target",
      },
      content_observation_id: `queue-content-${index}`,
      price_observation_id: `queue-price-${index}`,
      observed_price: 2.99,
      price_observed_at: "2026-08-01T12:00:00.000Z",
      content_observed_at: "2026-08-01T12:00:00.000Z",
      image_count: 4,
      default_pack_counts: [2, 3],
      score: 108,
    },
  };
}

function request(count: number): {
  brief: WalmartStudioDraftBrief;
  items: WalmartStudioDraftWorkItem[];
} {
  const template = parseWalmartShippingTemplateDetails({
    id: "queue-free",
    name: "Free shipping",
    type: "CUSTOM",
    status: "ACTIVE",
    rateModelType: "PER_SHIPMENT_PRICING",
    shippingMethods: [{
      shipMethod: "STANDARD",
      status: "ACTIVE",
      configurations: [{
        regions: [{ regionCode: "C", regionName: "48 State" }],
        addressTypes: ["STREET"],
        transitTime: 5,
        perShippingCharge: {
          unitOfMeasure: "LB",
          shippingAndHandling: { amount: 0, currency: "USD" },
          chargePerWeight: { amount: 0, currency: "USD" },
          chargePerItem: { amount: 0, currency: "USD" },
        },
      }],
    }],
  });
  const items = buildWalmartStudioDraftWorkItems({
    candidates: Array.from({ length: count }, (_, index) => diagnostic(index + 1)),
    listingCount: count,
    packCount: 8,
    storeIndex: 1,
    shippingTemplateId: template.id,
    shippingTemplateSha256: template.template_sha256,
    targetMarginBps: 3_000,
    asOf: "2026-08-01T12:00:00.000Z",
    priceMaxAgeMs: 86_400_000,
    zip: "33765",
  });
  return {
    items,
    brief: {
      studio_version: 5,
      workflow: "CANONICAL_WALMART_NEW_SKU",
      draft_schema_version: WALMART_STUDIO_DRAFT_BRIEF_SCHEMA,
      source: "prompt",
      prompt: `Create ${count} Campbell's soup listings, pack of 8`,
      channel: "WALMART",
      listing_count: count,
      pack_count: 8,
      target_margin_pct: 30,
      photo_strategy: "reuse-donor",
      walmart_shipping: {
        store_index: 1,
        account_name: "SIRIUS",
        selected_at: "2026-08-01T12:00:00.000Z",
        template: template as unknown as Record<string, unknown>,
      },
      product_truth_admission: {
        as_of: "2026-08-01T12:00:00.000Z",
        price_max_age_ms: 86_400_000,
        zip: "33765",
        matched_variants: count,
        ready_variants: count,
      },
      pricing_inputs: {
        packaging_cost_cents: 150,
        shipping_label_cents: 878,
        referral_fee_bps: 1_500,
        target_margin_bps: 3_000,
      },
      execution_work_items: items,
      operator_contract: {
        engine: "walmart-studio-draft-engine",
        marketplace_mutation_authorized: false,
        upc_reservation_authorized: false,
        next_step: "draft only",
      },
    },
  };
}

test("durable queue claims once, retries, reclaims stale work and stays idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "walmart-draft-queue-"));
  const databasePath = join(directory, "queue.db");
  await copyFile(join(process.cwd(), "dev.db"), databasePath);
  const databaseUrl = `file:${databasePath}`;
  execFileSync(
    process.execPath,
    [
      "scripts/turso-migrate-bundle-factory-core-integrity.mjs",
      "--apply",
      "--confirm=BUNDLE_FACTORY_CORE_INTEGRITY",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TURSO_DATABASE_URL: databaseUrl,
        TURSO_AUTH_TOKEN: "local-test-token",
      },
      stdio: "ignore",
    },
  );
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  process.env.DATABASE_URL = databaseUrl;
  const [{ prisma }, { tickWalmartStudioDraftBatch }] = await Promise.all([
    import("@/lib/prisma"),
    import("../walmart-studio-draft-engine"),
  ]);
  const createJob = async (count: number) => {
    const prepared = request(count);
    return prisma.generationJob.create({
      data: {
        brief: JSON.stringify(prepared.brief),
        current_stage: "WALMART_DRAFT_QUEUE",
        status: "PENDING",
        bundles_target: count,
        work_items: {
          create: prepared.items.map((item) => ({
            spec_index: item.spec_index,
            spec_json: JSON.stringify(item),
            fingerprint: item.work_item_sha256,
          })),
        },
      },
    });
  };
  const mockDraft = async (input: {
    jobId: string;
    item: WalmartStudioDraftWorkItem;
  }) => {
    const existing = await prisma.bundleDraft.findUnique({
      where: { recipe_fingerprint: `queue-test:${input.item.work_item_sha256}` },
    });
    if (existing) return { draftId: existing.id, title: existing.draft_name };
    const draft = await prisma.bundleDraft.create({
      data: {
        generation_job_id: input.jobId,
        draft_name: input.item.title_at_admission,
        brand: "Campbell's",
        category: "SHELF_STABLE",
        composition_type: "SINGLE_FLAVOR",
        pack_count: input.item.pack_count,
        draft_components: "[]",
        status: "GENERATED",
        recipe_fingerprint: `queue-test:${input.item.work_item_sha256}`,
        target_channels: "[\"WALMART\"]",
      },
    });
    return { draftId: draft.id, title: draft.draft_name };
  };

  try {
    const parallelJob = await createJob(3);
    const calls: string[] = [];
    const buildDraft = async (input: Parameters<typeof mockDraft>[0]) => {
      calls.push(input.item.work_item_sha256);
      await new Promise((resolve) => setTimeout(resolve, 25));
      return mockDraft(input);
    };
    await Promise.all([
      tickWalmartStudioDraftBatch(parallelJob.id, { buildDraft }),
      tickWalmartStudioDraftBatch(parallelJob.id, { buildDraft }),
    ]);
    await tickWalmartStudioDraftBatch(parallelJob.id, { buildDraft });
    await tickWalmartStudioDraftBatch(parallelJob.id, { buildDraft });
    const completed = await tickWalmartStudioDraftBatch(parallelJob.id, { buildDraft });
    assert.equal(completed.status, "COMPLETED");
    assert.equal(completed.done, 3);
    assert.equal(calls.length, 3);
    assert.equal(new Set(calls).size, 3);
    const idempotent = await tickWalmartStudioDraftBatch(parallelJob.id, { buildDraft });
    assert.equal(idempotent.status, "COMPLETED");
    assert.equal(calls.length, 3);

    const retryJob = await createJob(1);
    let attempts = 0;
    const retrying = async (input: Parameters<typeof mockDraft>[0]) => {
      attempts += 1;
      if (attempts < 3) throw new Error("temporary R2 failure");
      return mockDraft(input);
    };
    await tickWalmartStudioDraftBatch(retryJob.id, { buildDraft: retrying });
    await tickWalmartStudioDraftBatch(retryJob.id, { buildDraft: retrying });
    await tickWalmartStudioDraftBatch(retryJob.id, { buildDraft: retrying });
    const retryComplete = await tickWalmartStudioDraftBatch(retryJob.id, {
      buildDraft: retrying,
    });
    assert.equal(retryComplete.status, "COMPLETED");
    assert.equal(attempts, 3);

    const staleJob = await createJob(1);
    await prisma.generationWorkItem.updateMany({
      where: { generation_job_id: staleJob.id },
      data: {
        status: "RUNNING",
        locked_at: new Date("2026-08-01T11:00:00.000Z"),
      },
    });
    const staleTick = await tickWalmartStudioDraftBatch(staleJob.id, {
      buildDraft: mockDraft,
      now: () => new Date("2026-08-01T12:00:00.000Z"),
    });
    assert.equal(staleTick.done, 1);
    const staleComplete = await tickWalmartStudioDraftBatch(staleJob.id, {
      buildDraft: mockDraft,
      now: () => new Date("2026-08-01T12:00:01.000Z"),
    });
    assert.equal(staleComplete.status, "COMPLETED");
  } finally {
    await prisma.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});
