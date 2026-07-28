/**
 * Canonical, read-only Bundle Factory ledger for the Uncrustables launch.
 *
 * External state is never mutated: this script only runs Prisma findMany calls
 * and Amazon Listings Items GETs. Each run writes a new timestamped JSON file
 * with `wx`, so an earlier audit can never be overwritten.
 *
 *   # DB-only rehearsal (default; zero SP-API calls)
 *   npx tsx scripts/audit-uncrustables-ledger.ts
 *
 *   # Full live audit (one paced GET per Amazon SKU)
 *   npx tsx scripts/audit-uncrustables-ledger.ts --live
 *
 *   # Safe canary
 *   npx tsx scripts/audit-uncrustables-ledger.ts --live --limit=5
 */

import { config } from "dotenv";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";

import type {
  ChannelSkuSnapshot,
  DraftSnapshot,
  LedgerDbSnapshot,
  LedgerRow,
  MasterSnapshot,
  RecipeComponentSnapshot,
} from "@/lib/bundle-factory/audit/uncrustables-ledger";

config({ path: ".env.local" });
config({ path: ".env" });

interface CliOptions {
  live: boolean;
  limit: number | null;
  store: number | null;
  delayMs: number;
  maxAttempts: number;
  outputDir: string;
}

interface RawComponent {
  research_pool_id?: unknown;
  donor_product_id?: unknown;
  product_name?: unknown;
  manufacturer_brand?: unknown;
  brand?: unknown;
  flavor?: unknown;
  qty?: unknown;
  unit_price_cents?: unknown;
  source_url?: unknown;
}

type UnknownRecord = Record<string, unknown>;

function usage(): string {
  return [
    "Usage: npx tsx scripts/audit-uncrustables-ledger.ts [options]",
    "",
    "Options:",
    "  --live                 Read every matching SKU from Amazon SP-API.",
    "  --limit=N              Audit only the first N sorted rows (canary/dev).",
    "  --store=N              Keep only one Amazon store index.",
    "  --delay-ms=N           Delay after each live GET (minimum 200; default 250).",
    "  --max-attempts=N        Outer transient retry attempts (1-4; default 2).",
    "  --output-dir=PATH       Snapshot directory (default data/audits).",
    "  --help                  Show this help.",
    "",
    "Without --live, the script is a DB-only rehearsal and makes no SP-API calls.",
  ].join("\n");
}

function parsePositiveInt(name: string, raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${raw ?? ""}`);
  }
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    live: false,
    limit: null,
    store: null,
    delayMs: 250,
    maxAttempts: 2,
    outputDir: "data/audits",
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--live") {
      options.live = true;
    } else if (arg.startsWith("--limit=")) {
      options.limit = parsePositiveInt("--limit", arg.split("=", 2)[1]);
    } else if (arg.startsWith("--store=")) {
      options.store = parsePositiveInt("--store", arg.split("=", 2)[1]);
    } else if (arg.startsWith("--delay-ms=")) {
      options.delayMs = parsePositiveInt("--delay-ms", arg.split("=", 2)[1]);
    } else if (arg.startsWith("--max-attempts=")) {
      options.maxAttempts = parsePositiveInt(
        "--max-attempts",
        arg.split("=", 2)[1],
      );
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length).trim();
      if (!options.outputDir) throw new Error("--output-dir cannot be empty");
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }
  if (options.live && options.delayMs < 200) {
    throw new Error("--delay-ms must be >=200 for the Listings Items 5 req/sec limit");
  }
  if (options.maxAttempts > 4) {
    throw new Error("--max-attempts must be <=4");
  }
  return options;
}

function record(value: unknown): UnknownRecord | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function parseJson(value: string | null | undefined, fallback: unknown): unknown {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function jsonArray(value: string | null | undefined): unknown[] {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function jsonRecord(value: string | null | undefined): UnknownRecord {
  return record(parseJson(value, {})) ?? {};
}

function stringArray(value: string | null | undefined): string[] {
  return jsonArray(value).filter((v): v is string => typeof v === "string");
}

function jsonUnknownArray(value: string | null | undefined): unknown[] {
  return jsonArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function donorId(value: RawComponent): string | null {
  return stringOrNull(value.donor_product_id ?? value.research_pool_id);
}

function toRecipeComponent(
  value: unknown,
  donors: Map<
    string,
    { id: string; title: string | null; brand: string | null; flavor: string | null }
  >,
): RecipeComponentSnapshot | null {
  const raw = record(value) as RawComponent | null;
  if (!raw) return null;
  const id = donorId(raw);
  const donor = id ? donors.get(id) : null;
  const qty = numberOrNull(raw.qty);
  if (qty == null) return null;
  return {
    product_id: id,
    product_name:
      stringOrNull(raw.product_name) ?? donor?.title ?? "Unknown component",
    brand:
      stringOrNull(raw.manufacturer_brand ?? raw.brand) ?? donor?.brand ?? null,
    flavor: stringOrNull(raw.flavor) ?? donor?.flavor ?? null,
    qty,
    unit_price_cents: numberOrNull(raw.unit_price_cents),
    source_url: stringOrNull(raw.source_url),
  };
}

function toRecipeComponents(
  values: unknown[],
  donors: Map<
    string,
    { id: string; title: string | null; brand: string | null; flavor: string | null }
  >,
): RecipeComponentSnapshot[] {
  return values
    .map((value) => toRecipeComponent(value, donors))
    .filter((value): value is RecipeComponentSnapshot => value != null);
}

function selectedVariant(
  variantsJson: string | null | undefined,
  selectedIndex: number | null | undefined,
): UnknownRecord | null {
  if (selectedIndex == null) return null;
  const variants = jsonArray(variantsJson)
    .map(record)
    .filter((value): value is UnknownRecord => value != null);
  return (
    variants.find((value) => Number(value.idx) === selectedIndex) ??
    variants[selectedIndex] ??
    null
  );
}

function rawDraftComponents(draft: {
  draft_components: string;
  variation_matrix: { variants_json: string; selected_variant_idx: number | null } | null;
}): unknown[] {
  const variant = selectedVariant(
    draft.variation_matrix?.variants_json,
    draft.variation_matrix?.selected_variant_idx,
  );
  return [
    ...jsonArray(draft.draft_components),
    ...(Array.isArray(variant?.composition) ? variant.composition : []),
  ];
}

function collectDonorIds(
  drafts: Array<{
    draft_components: string;
    variation_matrix: { variants_json: string; selected_variant_idx: number | null } | null;
  }>,
): string[] {
  const ids = new Set<string>();
  for (const draft of drafts) {
    for (const value of rawDraftComponents(draft)) {
      const raw = record(value) as RawComponent | null;
      const id = raw ? donorId(raw) : null;
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

function transient(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(429|500|502|503|504)\b|rate.?limit|timeout|timed out|ECONNRESET|fetch failed|aborted|gateway/i.test(
    message,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTransientRetry<T>(
  action: () => Promise<T>,
  maxAttempts: number,
  label: string,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (!transient(error) || attempt === maxAttempts) throw error;
      const delay = 1_500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      console.warn(
        `  transient ${label}; retry ${attempt + 1}/${maxAttempts} in ${delay}ms`,
      );
      await sleep(delay);
    }
  }
  throw lastError;
}

function filenameTimestamp(value: Date): string {
  return value.toISOString().replace(/[-:]/g, "").replace(".", "");
}

async function writeImmutableSnapshot(
  directory: string,
  timestamp: Date,
  mode: "live" | "db-only",
  payload: unknown,
): Promise<string> {
  const resolvedDirectory = path.resolve(directory);
  await mkdir(resolvedDirectory, { recursive: true });
  const filename = `uncrustables-ledger-${filenameTimestamp(timestamp)}-${mode}.json`;
  const output = path.join(resolvedDirectory, filename);
  const handle = await open(output, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  return output;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  let interrupted = false;
  process.once("SIGINT", () => {
    interrupted = true;
    console.warn("\nSIGINT received; finishing the current GET and writing a partial immutable snapshot…");
  });

  const { prisma } = await import("@/lib/prisma");
  const { channelTarget } = await import(
    "@/lib/bundle-factory/distribution/account-map"
  );
  const {
    addCatalogAnomalies,
    assessLedgerRow,
    extractLiveListing,
    failedLiveListing,
    summarizeLedger,
  } = await import("@/lib/bundle-factory/audit/uncrustables-ledger");

  try {
    // Deliberately do not filter by DB listing_status. Amazon GET is the source
    // of truth for BUYABLE/DISCOVERABLE and exposes stale local state.
    const found = await prisma.channelSKU.findMany({
      where: {
        OR: [
          { title: { contains: "Uncrust" } },
          { master_bundle: { name: { contains: "Uncrust" } } },
        ],
      },
      select: {
        id: true,
        master_bundle_id: true,
        channel: true,
        sku: true,
        upc: true,
        asin: true,
        title: true,
        bullets: true,
        description: true,
        attributes: true,
        channel_category: true,
        channel_browse_node: true,
        price_cents: true,
        business_price_cents: true,
        lifecycle_status: true,
        compliance_status: true,
        validation_status: true,
        listing_status: true,
        main_image_url: true,
        submitted_at: true,
        live_at: true,
        published_at: true,
        errors: true,
        distribution_errors: true,
        master_bundle: {
          select: {
            id: true,
            generation_job_id: true,
            name: true,
            brand: true,
            category: true,
            composition_type: true,
            pack_count: true,
            lifecycle_status: true,
            estimated_cost_cents: true,
            suggested_price_cents: true,
            main_image_url: true,
            secondary_images: true,
            components: {
              select: {
                product_name: true,
                manufacturer_brand: true,
                flavor: true,
                qty: true,
                unit_price_cents: true,
                source_url: true,
              },
            },
          },
        },
      },
      orderBy: { sku: "asc" },
    });

    const amazonRows = found
      .map((row) => ({ row, target: channelTarget(row.channel) }))
      .filter(({ target }) => target.kind === "amazon")
      .filter(({ target }) => options.store == null || target.storeIndex === options.store);
    const selected = options.limit ? amazonRows.slice(0, options.limit) : amazonRows;
    const masterIds = selected.map(({ row }) => row.master_bundle_id);

    const drafts = await prisma.bundleDraft.findMany({
      where: { master_bundle_id: { in: masterIds } },
      select: {
        id: true,
        master_bundle_id: true,
        generation_job_id: true,
        draft_name: true,
        brand: true,
        category: true,
        composition_type: true,
        pack_count: true,
        draft_components: true,
        draft_title: true,
        draft_bullets: true,
        draft_description: true,
        draft_main_image_url: true,
        draft_secondary_images: true,
        status: true,
        compliance_status: true,
        variation_matrix: {
          select: { variants_json: true, selected_variant_idx: true },
        },
        generated_content: {
          select: {
            channel: true,
            compliance_status: true,
            title: true,
            bullets_json: true,
            description: true,
            main_image_url: true,
          },
        },
      },
    });
    const donorIds = collectDonorIds(drafts);
    const donors = donorIds.length
      ? await prisma.donorProduct.findMany({
          where: { id: { in: donorIds } },
          select: { id: true, title: true, brand: true, flavor: true },
        })
      : [];
    const donorsById = new Map(donors.map((donor) => [donor.id, donor]));
    const draftsByMaster = new Map(
      drafts
        .filter((draft) => draft.master_bundle_id != null)
        .map((draft) => [draft.master_bundle_id as string, draft]),
    );

    const dbSnapshots: LedgerDbSnapshot[] = selected.map(({ row, target }) => {
      const draftRow = draftsByMaster.get(row.master_bundle_id) ?? null;
      const variant = draftRow
        ? selectedVariant(
            draftRow.variation_matrix?.variants_json,
            draftRow.variation_matrix?.selected_variant_idx,
          )
        : null;
      const draft: DraftSnapshot | null = draftRow
        ? {
            id: draftRow.id,
            generation_job_id: draftRow.generation_job_id,
            name: draftRow.draft_name,
            brand: draftRow.brand,
            category: draftRow.category,
            composition_type: draftRow.composition_type,
            pack_count: draftRow.pack_count,
            status: draftRow.status,
            compliance_status: draftRow.compliance_status,
            components: toRecipeComponents(
              jsonArray(draftRow.draft_components),
              donorsById,
            ),
            selected_variant_idx:
              draftRow.variation_matrix?.selected_variant_idx ?? null,
            selected_variant: variant
              ? {
                  name: stringOrNull(variant.name),
                  composition: toRecipeComponents(
                    Array.isArray(variant.composition) ? variant.composition : [],
                    donorsById,
                  ),
                }
              : null,
            title: draftRow.draft_title,
            bullets: stringArray(draftRow.draft_bullets),
            description: draftRow.draft_description,
            main_image_url: draftRow.draft_main_image_url,
            secondary_image_urls: stringArray(
              draftRow.draft_secondary_images,
            ),
            generated_content: draftRow.generated_content.map((content) => ({
              channel: content.channel,
              compliance_status: content.compliance_status,
              title: content.title,
              bullets: stringArray(content.bullets_json),
              description: content.description,
              main_image_url: content.main_image_url,
            })),
          }
        : null;

      const master: MasterSnapshot = {
        id: row.master_bundle.id,
        generation_job_id: row.master_bundle.generation_job_id,
        name: row.master_bundle.name,
        brand: row.master_bundle.brand,
        category: row.master_bundle.category,
        composition_type: row.master_bundle.composition_type,
        pack_count: row.master_bundle.pack_count,
        lifecycle_status: row.master_bundle.lifecycle_status,
        estimated_cost_cents: row.master_bundle.estimated_cost_cents,
        suggested_price_cents: row.master_bundle.suggested_price_cents,
        main_image_url: row.master_bundle.main_image_url,
        secondary_image_urls: stringArray(row.master_bundle.secondary_images),
        components: row.master_bundle.components.map((component) => ({
          product_name: component.product_name,
          brand: component.manufacturer_brand,
          flavor: component.flavor,
          qty: component.qty,
          unit_price_cents: component.unit_price_cents,
          source_url: component.source_url,
        })),
      };
      const sku: ChannelSkuSnapshot = {
        id: row.id,
        channel: row.channel,
        store_index: target.storeIndex > 0 ? target.storeIndex : null,
        sku: row.sku,
        upc: row.upc,
        asin: row.asin,
        title: row.title,
        bullets: stringArray(row.bullets),
        description: row.description,
        attributes: jsonRecord(row.attributes),
        channel_category: row.channel_category,
        channel_browse_node: row.channel_browse_node,
        price_cents: row.price_cents,
        business_price_cents: row.business_price_cents,
        lifecycle_status: row.lifecycle_status,
        compliance_status: row.compliance_status,
        validation_status: row.validation_status,
        listing_status: row.listing_status,
        main_image_url: row.main_image_url,
        submitted_at: iso(row.submitted_at),
        live_at: iso(row.live_at),
        published_at: iso(row.published_at),
        errors: jsonUnknownArray(row.errors),
        distribution_errors: jsonUnknownArray(row.distribution_errors),
      };
      return { channel_sku: sku, master, draft };
    });

    console.log(
      `${options.live ? "LIVE" : "DB-ONLY"} ledger: ${dbSnapshots.length}/${amazonRows.length} Amazon Uncrustables rows`,
    );
    if (!options.live) {
      console.log("No SP-API calls will be made. Pass --live for marketplace truth.");
    }

    const sellerIds = new Map<number, string>();
    const sellerErrors = new Map<number, Error>();
    if (options.live) {
      const { getMerchantToken } = await import("@/lib/amazon-sp-api/sellers");
      for (const storeIndex of new Set(
        dbSnapshots
          .map((db) => db.channel_sku.store_index)
          .filter((value): value is number => value != null),
      )) {
        try {
          sellerIds.set(storeIndex, await getMerchantToken(storeIndex));
        } catch (error) {
          sellerErrors.set(
            storeIndex,
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
    }

    const rows: LedgerRow[] = [];
    const { getListing } = await import("@/lib/amazon-sp-api/listings");
    for (const [index, db] of dbSnapshots.entries()) {
      if (interrupted) break;
      let live = null;
      if (options.live) {
        const storeIndex = db.channel_sku.store_index;
        const sellerId = storeIndex == null ? null : sellerIds.get(storeIndex);
        const sellerError =
          storeIndex == null
            ? new Error(`No Amazon store mapping for ${db.channel_sku.channel}`)
            : sellerErrors.get(storeIndex);
        if (!sellerId) {
          live = failedLiveListing(
            sellerError ?? new Error(`No seller token for store${storeIndex}`),
          );
        } else {
          try {
            const raw = await withTransientRetry(
              () =>
                getListing(storeIndex as number, sellerId, db.channel_sku.sku, {
                  includedData: [
                    "summaries",
                    "attributes",
                    "issues",
                    "offers",
                    "fulfillmentAvailability",
                  ],
                }),
              options.maxAttempts,
              db.channel_sku.sku,
            );
            live = extractLiveListing(raw, startedAt);
          } catch (error) {
            live = failedLiveListing(error);
          }
          await sleep(options.delayMs);
        }
      }
      rows.push(assessLedgerRow(db, live));
      const liveLabel = !options.live
        ? "DB"
        : live?.fetched
          ? live.buyable
            ? "BUYABLE"
            : "NOT-BUYABLE"
          : "FETCH-ERROR";
      console.log(
        `[${index + 1}/${dbSnapshots.length}] ${db.channel_sku.sku} ${liveLabel} — ${rows.at(-1)?.anomalies.length ?? 0} findings`,
      );
    }

    const reconciled = addCatalogAnomalies(rows);
    const completedAt = new Date();
    const complete = !interrupted && reconciled.length === dbSnapshots.length;
    const payload = {
      schema_version: "uncrustables-ledger/v1.2",
      audit_id: `UL-${filenameTimestamp(startedAt)}`,
      mode: options.live ? "live" : "db-only",
      started_at: startedAt.toISOString(),
      completed_at: completedAt.toISOString(),
      complete,
      immutable: true,
      external_mutations: false,
      source_of_truth: {
        marketplace_status: "Amazon Listings Items GET; DB listing_status is informational only",
        recipe_count: "MasterBundle.pack_count",
        recipe_composition:
          "selected VariationMatrix composition, then draft_components fallback",
        pricing: "src/lib/pricing/cost-model.ts with explicit MasterBundle.pack_count",
      },
      scope: {
        db_matches_before_channel_filter: found.length,
        amazon_candidates: amazonRows.length,
        selected: dbSnapshots.length,
        scanned: reconciled.length,
        store_filter: options.store,
        limit: options.limit,
        request_delay_ms: options.live ? options.delayMs : null,
      },
      expectations: {
        live_statuses: ["BUYABLE", "DISCOVERABLE"],
        brand: "Uncrustables",
        product_types: ["GROCERY", "FOOD", "SNACK_FOOD"],
        main_image_required: true,
        first_secondary_image:
          "fixed cold-chain price rationale / thank-you infographic",
        minimum_secondary_images: 5,
        price: "cost-model suggested .99",
        minimum_seller_allowed_price: "cost-model floor",
        maximum_seller_allowed_price: "cost-model suggested .99",
      },
      summary: summarizeLedger(reconciled),
      rows: reconciled,
    };
    const output = await writeImmutableSnapshot(
      options.outputDir,
      startedAt,
      options.live ? "live" : "db-only",
      payload,
    );
    console.log(`\nImmutable snapshot: ${output}`);
    console.log(JSON.stringify(payload.summary, null, 2));
    if (!complete) process.exitCode = 130;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
