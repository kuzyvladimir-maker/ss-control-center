#!/usr/bin/env npx tsx
/**
 * Plans and optionally seeds the durable DonorHarvestState lifecycle.
 *
 * Safety contract:
 * - default mode is read-only and prints aggregate counts/credit forecasts;
 * - the script never calls retailer, AI, image, or other enrichment APIs;
 * - writes require --apply plus an exact run-bound confirmation token;
 * - both Product Truth evidence and full harvest-store migrations are asserted;
 * - all lifecycle writes go through the idempotent store/CAS contract.
 *
 * Dry run:
 *   npx tsx scripts/plan-seed-donor-harvest.ts
 *
 * Explicit BlueCart alternative for Walmart (still dry):
 *   npx tsx scripts/plan-seed-donor-harvest.ts --bluecart-walmart
 *
 * Apply a reviewed run:
 *   npx tsx scripts/plan-seed-donor-harvest.ts \
 *     --run-id=harvest-seed-20260718-a \
 *     --apply \
 *     --confirm=APPLY_DONOR_HARVEST_SEED:harvest-seed-20260718-a
 */

import { config } from "dotenv";
import { createClient, type Client } from "@libsql/client";

import {
  assertDonorHarvestStoreReady,
  parseDonorHarvestStateRow,
  persistDonorHarvestTransition,
  seedDonorHarvestState,
  type StoredDonorHarvestState,
} from "../src/lib/sourcing/donor-harvest-store";
import {
  donorHarvestIdentityKey,
  normalizeDonorHarvestFields,
} from "../src/lib/sourcing/donor-harvest-lifecycle";
import {
  donorHarvestSeedConfirmation,
  planDonorHarvestSeed,
  type DonorHarvestSeedPlan,
  type HarvestSeedDonorSnapshot,
  type HarvestSeedOfferSnapshot,
  type HarvestSeedSource,
} from "../src/lib/sourcing/donor-harvest-seed-plan";
import { assertProductTruthEvidenceSchema } from "../src/lib/sourcing/product-truth-schema-gate";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

interface CliOptions {
  apply: boolean;
  confirm: string | null;
  runId: string;
  explicitRunId: boolean;
  useBluecartWalmart: boolean;
  maxAttempts: number;
  help: boolean;
}

type PlannedAction =
  | "none"
  | "create_queue"
  | "create_terminal"
  | "terminalize_existing"
  | "already_seeded"
  | "blocked_by_other_active_state"
  | "seed_conflict";

interface ClassifiedPlan {
  plan: DonorHarvestSeedPlan;
  action: PlannedAction;
  existing: StoredDonorHarvestState | null;
}

const ACTIVE_STATUSES = new Set(["pending", "running", "retry_wait", "partial"]);

function cleanEnv(value: string | undefined): string | undefined {
  return value?.trim().replace(/^['"]|['"]$/g, "") || undefined;
}

function generatedRunId(now = new Date()): string {
  return `harvest-seed-${now.toISOString().replace(/[-:.]/g, "").replace("Z", "Z")}`;
}

function requiredRunId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)) {
    throw new Error("--run-id must be 1-120 safe characters: letters, digits, . _ : -");
  }
  return normalized;
}

function parsePositiveInt(raw: string, label: string, maximum: number): number {
  if (!/^\d+$/.test(raw)) throw new Error(`${label} must be an integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function parseArgs(argv: readonly string[], now = new Date()): CliOptions {
  let apply = false;
  let confirm: string | null = null;
  let runId = generatedRunId(now);
  let explicitRunId = false;
  let useBluecartWalmart = false;
  let maxAttempts = 3;
  let help = false;
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else if (arg === "--bluecart-walmart") useBluecartWalmart = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg.startsWith("--confirm=")) confirm = arg.slice("--confirm=".length);
    else if (arg.startsWith("--run-id=")) {
      runId = requiredRunId(arg.slice("--run-id=".length));
      explicitRunId = true;
    } else if (arg.startsWith("--max-attempts=")) {
      maxAttempts = parsePositiveInt(arg.slice("--max-attempts=".length), "--max-attempts", 3);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  runId = requiredRunId(runId);
  if (apply) {
    if (!explicitRunId) throw new Error("--apply requires an explicit --run-id from a reviewed dry run");
    const expected = donorHarvestSeedConfirmation(runId);
    if (confirm !== expected) {
      throw new Error(`Writes are locked. Exact confirmation required: --confirm=${expected}`);
    }
  } else if (confirm !== null) {
    throw new Error("--confirm is only valid together with --apply");
  }
  return { apply, confirm, runId, explicitRunId, useBluecartWalmart, maxAttempts, help };
}

function usage(): string {
  return [
    "Usage: npx tsx scripts/plan-seed-donor-harvest.ts [options]",
    "",
    "Options:",
    "  --run-id=ID             Stable reviewed-run identifier (mandatory with --apply).",
    "  --max-attempts=1..3     Bounded source attempt cap (default 3).",
    "  --bluecart-walmart      Explicitly use bluecart:walmart instead of unwrangle:walmart.",
    "  --apply                 Enable database-only lifecycle writes.",
    "  --confirm=TOKEN         Exact APPLY_DONOR_HARVEST_SEED:<run-id> token.",
    "  --help                  Show this text.",
    "",
    "Without --apply the command is read-only. It never calls enrichment providers.",
  ].join("\n");
}

function databaseLabel(url: string): string {
  if (url.startsWith("file:")) return "local-file";
  try {
    return new URL(url.replace(/^libsql:/, "https:")).hostname || "remote-libsql";
  } catch {
    return "remote-libsql";
  }
}

function asNullable(value: unknown): unknown {
  return value == null ? null : value;
}

async function loadDonors(db: Client): Promise<HarvestSeedDonorSnapshot[]> {
  const result = await db.execute({
    sql: `SELECT dp.id AS donorProductId, dp.identityStatus,
                 dp.title, dp.description, dp.bullets, dp.attributes,
                 dp.nutritionFacts, dp.ingredients, dp.mainImageUrl,
                 dp.imageUrls, dp.upc, dp.gtin,
                 o.id AS offerId, o.retailer, o.retailerProductId,
                 o.productUrl, o.via
          FROM "DonorProduct" dp
          LEFT JOIN "DonorOffer" o ON o.donorProductId=dp.id
          ORDER BY dp.id, o.retailer, o.retailerProductId, o.id`,
    args: [],
  });
  const donors = new Map<string, HarvestSeedDonorSnapshot>();
  for (const row of result.rows) {
    const id = String(row.donorProductId || "").trim();
    if (!id) throw new Error("DonorProduct row without id");
    let donor = donors.get(id);
    if (!donor) {
      donor = {
        id,
        title: asNullable(row.title),
        description: asNullable(row.description),
        bullets: asNullable(row.bullets),
        attributes: asNullable(row.attributes),
        nutritionFacts: asNullable(row.nutritionFacts),
        ingredients: asNullable(row.ingredients),
        mainImageUrl: asNullable(row.mainImageUrl),
        imageUrls: asNullable(row.imageUrls),
        upc: asNullable(row.upc),
        gtin: asNullable(row.gtin),
        offers: [],
      };
      donors.set(id, donor);
    }
    if (row.offerId != null) {
      (donor.offers as HarvestSeedOfferSnapshot[]).push({
        retailer: asNullable(row.retailer),
        retailerProductId: asNullable(row.retailerProductId),
        productUrl: asNullable(row.productUrl),
        via: asNullable(row.via),
        // A legacy FK is not identity proof. Only canonical certification may
        // authorize paid content harvest for this donor variant.
        exactDonorLink: row.identityStatus === "exact_confirmed",
      });
    }
  }
  return [...donors.values()];
}

async function loadExistingStates(db: Client): Promise<StoredDonorHarvestState[]> {
  const result = await db.execute({ sql: `SELECT * FROM "DonorHarvestState" ORDER BY id`, args: [] });
  return result.rows.map((row) => parseDonorHarvestStateRow(row as Record<string, unknown>));
}

function sameFields(a: readonly string[], b: readonly string[]): boolean {
  return normalizeDonorHarvestFields(a).join("\u0000") === normalizeDonorHarvestFields(b).join("\u0000");
}

function classifyPlans(
  plans: readonly DonorHarvestSeedPlan[],
  existingStates: readonly StoredDonorHarvestState[],
): ClassifiedPlan[] {
  const byIdentity = new Map(existingStates.map((state) => [donorHarvestIdentityKey(state), state]));
  const activeByDonor = new Map<string, StoredDonorHarvestState[]>();
  for (const state of existingStates) {
    if (!ACTIVE_STATUSES.has(state.status)) continue;
    const values = activeByDonor.get(state.donorProductId) ?? [];
    values.push(state);
    activeByDonor.set(state.donorProductId, values);
  }
  return plans.map((plan): ClassifiedPlan => {
    if (!plan.source || !plan.retailerProductId || !["queue", "terminal_source_unavailable"].includes(plan.disposition)) {
      return { plan, action: "none", existing: null };
    }
    const key = donorHarvestIdentityKey({
      donorProductId: plan.donorProductId,
      source: plan.source,
      retailerProductId: plan.retailerProductId,
    });
    const existing = byIdentity.get(key) ?? null;
    if (existing) {
      if (!sameFields(existing.requestedFields, plan.requestedFields) || existing.maxAttempts !== plan.maxAttempts) {
        return { plan, action: "seed_conflict", existing };
      }
      if (plan.disposition === "terminal_source_unavailable" && ACTIVE_STATUSES.has(existing.status)) {
        return existing.status === "running"
          ? { plan, action: "blocked_by_other_active_state", existing }
          : { plan, action: "terminalize_existing", existing };
      }
      return { plan, action: "already_seeded", existing };
    }
    if ((activeByDonor.get(plan.donorProductId) ?? []).length > 0) {
      return { plan, action: "blocked_by_other_active_state", existing: null };
    }
    return {
      plan,
      action: plan.disposition === "queue" ? "create_queue" : "create_terminal",
      existing: null,
    };
  });
}

function increment(record: Record<string, number>, key: string, amount = 1): void {
  record[key] = (record[key] ?? 0) + amount;
}

function roundUnits(value: number): number {
  return Math.round(value * 100) / 100;
}

function summary(
  options: CliOptions,
  databaseUrl: string,
  classified: readonly ClassifiedPlan[],
  existingCount: number,
) {
  const dispositions: Record<string, number> = {};
  const actions: Record<string, number> = {};
  const requestedGapFields: Record<string, number> = {};
  const newQueueBySource: Record<string, { states: number; firstAttemptUnits: number; maximumUnits: number }> = {};
  let firstAttemptCalls = 0;
  let firstAttemptUnits = 0;
  let maximumCalls = 0;
  let maximumUnits = 0;
  for (const item of classified) {
    increment(dispositions, item.plan.disposition);
    increment(actions, item.action);
    for (const field of item.plan.requestedFields) increment(requestedGapFields, field);
    if (item.action !== "create_queue") continue;
    const source = item.plan.source as HarvestSeedSource;
    const sourceForecast = newQueueBySource[source] ?? { states: 0, firstAttemptUnits: 0, maximumUnits: 0 };
    sourceForecast.states += 1;
    sourceForecast.firstAttemptUnits += item.plan.estimatedUnitsFirstAttempt;
    sourceForecast.maximumUnits += item.plan.maximumUnitsAtAttemptCap;
    newQueueBySource[source] = sourceForecast;
    firstAttemptCalls += item.plan.estimatedCallsFirstAttempt;
    firstAttemptUnits += item.plan.estimatedUnitsFirstAttempt;
    maximumCalls += item.plan.maximumCallsAtAttemptCap;
    maximumUnits += item.plan.maximumUnitsAtAttemptCap;
  }
  for (const forecast of Object.values(newQueueBySource)) {
    forecast.firstAttemptUnits = roundUnits(forecast.firstAttemptUnits);
    forecast.maximumUnits = roundUnits(forecast.maximumUnits);
  }
  return {
    mode: options.apply ? "APPLY" : "DRY_RUN",
    runId: options.runId,
    database: databaseLabel(databaseUrl),
    providerNetworkCallsMadeByThisScript: 0,
    options: {
      minGalleryImages: 5,
      maxAttempts: options.maxAttempts,
      walmartSource: options.useBluecartWalmart ? "bluecart:walmart" : "unwrangle:walmart",
    },
    counts: {
      donorsScanned: classified.length,
      existingHarvestStates: existingCount,
      dispositions,
      actions,
      requestedGapFields,
    },
    newQueueForecast: {
      bySource: newQueueBySource,
      firstAttemptCalls,
      firstAttemptUnits: roundUnits(firstAttemptUnits),
      maximumCallsAtAttemptCap: maximumCalls,
      maximumUnitsAtAttemptCap: roundUnits(maximumUnits),
      note: "Forecast is informational only; it is not a spend permit and does not enable the worker.",
    },
    targetTerminalization: {
      newTerminalRows: actions.create_terminal ?? 0,
      existingRowsToTerminalize: actions.terminalize_existing ?? 0,
      sourceAttempts: 0,
      spendUnits: 0,
    },
    applyGate: options.apply
      ? "confirmation accepted"
      : {
          exactConfirmation: donorHarvestSeedConfirmation(options.runId),
          rerunRequiresExplicitRunId: true,
        },
  };
}

function transitionAt(state: StoredDonorHarvestState): string {
  return new Date(Math.max(Date.now(), Date.parse(state.updatedAt) + 1)).toISOString();
}

async function applyPlans(
  db: Client,
  classified: readonly ClassifiedPlan[],
  now: string,
): Promise<{ createdQueued: number; createdTerminal: number; terminalizedExisting: number; idempotentExisting: number }> {
  if (classified.some((item) => item.action === "seed_conflict")) {
    throw new Error("Apply refused: one or more existing harvest identities have a different field intent/attempt cap");
  }
  const result = { createdQueued: 0, createdTerminal: 0, terminalizedExisting: 0, idempotentExisting: 0 };
  for (const item of classified) {
    if (!["create_queue", "create_terminal", "terminalize_existing"].includes(item.action)) continue;
    const plan = item.plan;
    if (!plan.source || !plan.retailerProductId) throw new Error("Internal plan error: missing source identity");
    const seeded = await seedDonorHarvestState(db, {
      donorProductId: plan.donorProductId,
      source: plan.source,
      retailerProductId: plan.retailerProductId,
      requestedFields: plan.requestedFields,
      maxAttempts: plan.maxAttempts,
      now,
    });
    if (item.action === "create_queue") {
      if (seeded.created) result.createdQueued += 1;
      else result.idempotentExisting += 1;
      continue;
    }
    if (seeded.state.status === "source_unavailable") {
      result.idempotentExisting += 1;
      continue;
    }
    if (!ACTIVE_STATUSES.has(seeded.state.status) || seeded.state.status === "running") {
      throw new Error(`Cannot terminalize harvest state ${seeded.state.id} from ${seeded.state.status}`);
    }
    const terminal = await persistDonorHarvestTransition(db, seeded.state, {
      type: "source_unavailable",
      at: transitionAt(seeded.state),
      reason: plan.terminalReason || "SOURCE_CAPABILITY_UNAVAILABLE",
    });
    if (!terminal) throw new Error(`CAS lost while terminalizing harvest state ${seeded.state.id}`);
    if (seeded.created) result.createdTerminal += 1;
    else result.terminalizedExisting += 1;
  }
  return result;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const databaseUrl = cleanEnv(process.env.TURSO_DATABASE_URL) ?? cleanEnv(process.env.DATABASE_URL);
  const authToken = cleanEnv(process.env.TURSO_AUTH_TOKEN);
  if (!databaseUrl) throw new Error("TURSO_DATABASE_URL or DATABASE_URL is required");

  const db = createClient({ url: databaseUrl, authToken });
  try {
    await assertProductTruthEvidenceSchema(db);
    await assertDonorHarvestStoreReady(db);
    const [donors, existingStates] = await Promise.all([loadDonors(db), loadExistingStates(db)]);
    const plans = donors.map((donor) => planDonorHarvestSeed(donor, {
      useBluecartWalmart: options.useBluecartWalmart,
      minGalleryImages: 5,
      maxAttempts: options.maxAttempts,
    }));
    const classified = classifyPlans(plans, existingStates);
    const report = summary(options, databaseUrl, classified, existingStates.length);
    console.log(JSON.stringify(report, null, 2));
    if (!options.apply) return;
    const applied = await applyPlans(db, classified, new Date().toISOString());
    console.log(JSON.stringify({ mode: "APPLY_RESULT", runId: options.runId, ...applied }, null, 2));
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
