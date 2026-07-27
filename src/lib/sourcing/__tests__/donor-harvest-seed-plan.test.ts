import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createClient } from "@libsql/client";

import {
  DONOR_HARVEST_BOOTSTRAP_FIELDS,
  TARGET_ONLY_TERMINAL_REASON,
  donorHarvestSeedConfirmation,
  planDonorHarvestSeed,
  type HarvestSeedDonorSnapshot,
  type HarvestSeedOfferSnapshot,
} from "../donor-harvest-seed-plan";
import {
  persistDonorHarvestTransition,
  seedDonorHarvestState,
} from "../donor-harvest-store";

function offer(
  retailer: string,
  options: Partial<HarvestSeedOfferSnapshot> = {},
): HarvestSeedOfferSnapshot {
  return {
    retailer,
    retailerProductId: `${retailer}-item`,
    productUrl: `https://${retailer}.example.test/item`,
    via: "direct",
    exactDonorLink: true,
    ...options,
  };
}

function donor(overrides: Partial<HarvestSeedDonorSnapshot> = {}): HarvestSeedDonorSnapshot {
  return {
    id: "donor-1",
    title: "Exact Product",
    description: "Description",
    bullets: '["One"]',
    attributes: '{"form":"box"}',
    ingredients: "Water, salt",
    nutritionFacts: '{"calories":100}',
    upc: "012345678905",
    imageUrls: JSON.stringify(["1", "2", "3", "4", "5"]),
    offers: [offer("walmart")],
    ...overrides,
  };
}

test("requires five real gallery entries and plans only conservative gaps", () => {
  const complete = planDonorHarvestSeed(donor());
  assert.equal(complete.disposition, "already_complete");
  assert.deepEqual(complete.completedFields, DONOR_HARVEST_BOOTSTRAP_FIELDS);

  const incomplete = planDonorHarvestSeed(donor({
    description: " ",
    attributes: "not-json",
    imageUrls: '["1","2","3","4"]',
  }));
  assert.equal(incomplete.disposition, "queue");
  assert.deepEqual(incomplete.requestedFields, ["attributes", "description", "gallery"]);
});

test("chooses one richest deterministic source and gates BlueCart behind explicit opt-in", () => {
  const snapshot = donor({
    ingredients: null,
    offers: [offer("target"), offer("walmart")],
  });
  const defaultPlan = planDonorHarvestSeed(snapshot);
  assert.equal(defaultPlan.source, "unwrangle:walmart");
  assert.equal(defaultPlan.estimatedUnitsFirstAttempt, 2.5);

  const bluecartPlan = planDonorHarvestSeed(snapshot, { useBluecartWalmart: true });
  assert.equal(bluecartPlan.source, "bluecart:walmart");
  assert.equal(bluecartPlan.estimatedUnitsFirstAttempt, 1);
  assert.equal(bluecartPlan.maximumUnitsAtAttemptCap, 3);
});

test("rejects intermediary, unlinked, URL-less, and unsupported offers", () => {
  const plan = planDonorHarvestSeed(donor({
    ingredients: null,
    offers: [
      offer("walmart", { via: "instacart" }),
      offer("target", { exactDonorLink: false }),
      offer("samsclub", { productUrl: null }),
      offer("publix"),
    ],
  }));
  assert.equal(plan.disposition, "no_exact_offer_url");
  assert.equal(plan.source, null);
  assert.equal(plan.maximumCallsAtAttemptCap, 0);
});

test("terminalizes Target-only structural gaps with no paid attempt", () => {
  const plan = planDonorHarvestSeed(donor({
    description: null,
    bullets: null,
    attributes: null,
    ingredients: null,
    nutritionFacts: null,
    upc: null,
    offers: [offer("target")],
  }));
  assert.equal(plan.disposition, "terminal_source_unavailable");
  assert.equal(plan.source, "unwrangle:target");
  assert.equal(plan.terminalReason, TARGET_ONLY_TERMINAL_REASON);
  assert.equal(plan.estimatedCallsFirstAttempt, 0);
  assert.equal(plan.maximumUnitsAtAttemptCap, 0);
});

test("Target terminal seed is durable, zero-attempt, and idempotent", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await db.execute("PRAGMA foreign_keys=ON");
    await db.execute("CREATE TABLE DonorProduct (id TEXT PRIMARY KEY)");
    await db.execute("INSERT INTO DonorProduct(id) VALUES ('donor-target')");
    const migrationUrl = new URL(
      "../../../../prisma/migrations/20260718233000_donor_harvest_lifecycle/migration.sql",
      import.meta.url,
    );
    await db.executeMultiple(await readFile(migrationUrl, "utf8"));
    const plan = planDonorHarvestSeed(donor({
      id: "donor-target",
      description: null,
      offers: [offer("target")],
    }));
    assert.equal(plan.disposition, "terminal_source_unavailable");
    assert.ok(plan.source && plan.retailerProductId && plan.terminalReason);
    const first = await seedDonorHarvestState(db, {
      donorProductId: plan.donorProductId,
      source: plan.source,
      retailerProductId: plan.retailerProductId,
      requestedFields: plan.requestedFields,
      maxAttempts: plan.maxAttempts,
      now: "2026-07-18T20:00:00.000Z",
    });
    const terminal = await persistDonorHarvestTransition(db, first.state, {
      type: "source_unavailable",
      at: "2026-07-18T20:00:01.000Z",
      reason: plan.terminalReason,
    });
    assert.equal(terminal?.status, "source_unavailable");
    assert.equal(terminal?.attempts, 0);
    assert.equal(terminal?.nextEligibleAt, null);

    const second = await seedDonorHarvestState(db, {
      donorProductId: plan.donorProductId,
      source: plan.source,
      retailerProductId: plan.retailerProductId,
      requestedFields: plan.requestedFields,
      maxAttempts: plan.maxAttempts,
      now: "2026-07-18T21:00:00.000Z",
    });
    assert.equal(second.created, false);
    assert.equal(second.state.status, "source_unavailable");
    const count = await db.execute("SELECT COUNT(*) AS count FROM DonorHarvestState");
    assert.equal(Number(count.rows[0]?.count), 1);
  } finally {
    await db.close();
  }
});

test("keeps a Target gallery/title gap bounded and claimable", () => {
  const plan = planDonorHarvestSeed(donor({
    title: null,
    nutritionFacts: null,
    imageUrls: '["one"]',
    offers: [offer("target")],
  }));
  assert.equal(plan.disposition, "queue");
  assert.deepEqual(plan.requestedFields, ["gallery", "nutrition", "title"]);
  assert.equal(plan.estimatedCallsFirstAttempt, 1);
  assert.equal(plan.maximumCallsAtAttemptCap, 3);
});

test("a non-Target exact source prevents false Target-only terminalization", () => {
  const plan = planDonorHarvestSeed(donor({
    ingredients: null,
    offers: [offer("target"), offer("walmart")],
  }));
  assert.equal(plan.targetOnly, false);
  assert.equal(plan.disposition, "queue");
  assert.equal(plan.source, "unwrangle:walmart");
});

test("confirmation token is exact and run-bound", () => {
  assert.equal(
    donorHarvestSeedConfirmation("seed-run-20260718"),
    "APPLY_DONOR_HARVEST_SEED:seed-run-20260718",
  );
  assert.throws(() => donorHarvestSeedConfirmation("  "), /runId is required/);
});

test("seed CLI has no enrichment-provider transport path", async () => {
  const scriptUrl = new URL("../../../../scripts/plan-seed-donor-harvest.ts", import.meta.url);
  const source = await readFile(scriptUrl, "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /https?:\/\/(?:api\.bluecartapi|data\.unwrangle|api\.anthropic|api\.openai)/i);
  assert.doesNotMatch(source, /from\s+["'][^"']*(?:retail-fetch|donor-catalog|vision|oxylabs-fetch)["']/i);
  assert.match(source, /row\.identityStatus === "exact_confirmed"/);
});
