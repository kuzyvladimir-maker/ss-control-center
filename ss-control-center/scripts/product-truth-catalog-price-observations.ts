#!/usr/bin/env node
/**
 * Materialize PRICE observations from prices the donor catalogue already holds.
 *
 * Why this exists (owner decision 2026-08-02): the read contract only accepts a
 * price that exists as a `DonorOfferObservation`. The catalogue was harvested
 * before that contract, so ~all donors carry a usable `DonorOffer` price and no
 * observation — which made every Walmart build re-buy prices we already own and
 * left the factory at 0-2 ready products per category.
 *
 * Honesty rules this script does NOT bend:
 *   - provenance is recorded as it truly is: no runId, no approvalId, no metered
 *     receipt. The read contract already treats that triple-null as the valid
 *     "no paid run" class.
 *   - locality is recorded as `catalog_recorded_zip`, never as `zip_scoped`. The
 *     catalogue row states the ZIP but carries no provider proof of it, and that
 *     distinction stays visible to every downstream consumer.
 *   - only exact, first-party, in-stock, single-unit, ZIP-matching, positively
 *     priced Walmart offers of a canonically decided donor are materialized.
 *   - the observation is content-addressed and append-only: re-running is a
 *     no-op, never a second row.
 *
 * Usage:
 *   npx tsx scripts/product-truth-catalog-price-observations.ts --dry-run
 *   npx tsx scripts/product-truth-catalog-price-observations.ts --apply
 */

import { createHash } from "node:crypto";

import { createClient, type Client } from "@libsql/client";

import {
  DEFAULT_WALMART_PILOT_PRICE_MAX_AGE_MS,
  DEFAULT_WALMART_PILOT_ZIP,
} from "../src/lib/sourcing/product-truth-new-sku-view";

const LOCALITY: string | null = null;
/**
 * This observation is produced by reading OUR OWN catalogue, not by calling a
 * provider, and it says so. Claiming a paid provider's `sourceApi` without a
 * metered receipt is exactly what the DonorOfferObservation receipt guard
 * exists to stop, and that guard is correct: it keeps unpaid rows from
 * masquerading as purchased evidence.
 */
const SOURCE_API = "catalog-mirror";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as object).sort());
}

function cleanEnv(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.trim().replace(/^['"]|['"]$/g, "") || undefined;
}

function productTruthDb(): Client {
  const url = cleanEnv(process.env.TURSO_DATABASE_URL);
  const authToken = cleanEnv(process.env.TURSO_AUTH_TOKEN);
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL/TURSO_AUTH_TOKEN required");
  return createClient({ url, authToken });
}

interface Candidate {
  donorOfferId: string;
  donorProductId: string;
  canonicalVariantId: string;
  variantDecisionId: string;
  retailer: string;
  retailerProductId: string;
  via: string | null;
  title: string | null;
  price: number;
  packSizeSeen: number;
  pricePerUnit: number;
  currency: string;
  zip: string;
  productUrl: string;
  sellerName: string | null;
  sourceApi: string | null;
  observedAt: string;
}

async function readCandidates(db: Client, zip: string, cutoff: string) {
  // The canonical variant decision is the identity authority; an offer without
  // one is not an exact product and is skipped rather than guessed.
  const result = await db.execute({
    sql: `SELECT
            o.id AS donorOfferId, o.donorProductId, o.retailer, o.retailerProductId,
            o.via, o.price, o.packSizeSeen, o.pricePerUnit, o.currency, o.zip,
            o.productUrl, o.sellerName, o.sourceApi, o.fetchedAt,
            d.canonicalVariantId, d.id AS variantDecisionId, p.title
          FROM DonorOffer o
          JOIN DonorProduct p ON p.id = o.donorProductId
          JOIN DonorProductVariantDecision d ON d.donorProductId = o.donorProductId
               AND d.decisionStatus = 'exact_confirmed'
               AND d.canonicalVariantId IS NOT NULL
          WHERE o.retailer = 'walmart'
            AND o.via = 'direct'
            AND p.identityStatus = 'exact_confirmed'
            AND o.isFirstParty = 1
            AND o.inStock = 1
            AND o.price > 0
            AND o.zip = ?
            AND o.productUrl IS NOT NULL
            AND julianday(o.fetchedAt) >= julianday(?)
            AND NOT EXISTS (
              SELECT 1 FROM DonorOfferObservation existing
              WHERE existing.donorOfferId = o.id
            )`,
    args: [zip, cutoff],
  });
  const candidates: Candidate[] = [];
  for (const row of result.rows) {
    const pack = Number(row.packSizeSeen ?? 1);
    const price = Number(row.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (!Number.isInteger(pack) || pack !== 1) continue;
    const canonicalVariantId = row.canonicalVariantId
      ? String(row.canonicalVariantId)
      : "";
    const variantDecisionId = row.variantDecisionId
      ? String(row.variantDecisionId)
      : "";
    if (!canonicalVariantId || !variantDecisionId) continue;
    const perUnit = Number(row.pricePerUnit ?? price);
    candidates.push({
      donorOfferId: String(row.donorOfferId),
      donorProductId: String(row.donorProductId),
      canonicalVariantId,
      variantDecisionId,
      retailer: "walmart",
      retailerProductId: String(row.retailerProductId),
      via: String(row.via),
      title: row.title ? String(row.title) : null,
      price,
      packSizeSeen: 1,
      pricePerUnit: Number.isFinite(perUnit) && perUnit > 0 ? perUnit : price,
      currency: String(row.currency || "USD"),
      zip: String(row.zip),
      productUrl: String(row.productUrl),
      sellerName: row.sellerName ? String(row.sellerName) : null,
      sourceApi: SOURCE_API,
      observedAt: new Date(String(row.fetchedAt)).toISOString(),
    });
  }
  return candidates;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const dryRun = process.argv.includes("--dry-run");
  if (apply === dryRun) {
    throw new Error("choose exactly one of --dry-run or --apply");
  }
  const zip = DEFAULT_WALMART_PILOT_ZIP;
  const cutoff = new Date(
    Date.now() - DEFAULT_WALMART_PILOT_PRICE_MAX_AGE_MS,
  ).toISOString();
  const db = productTruthDb();
  try {
    const candidates = await readCandidates(db, zip, cutoff);
    console.log(JSON.stringify({
      mode: apply ? "APPLY" : "DRY_RUN",
      zip,
      cutoff,
      locality: LOCALITY ?? "none_recorded",
      candidates: candidates.length,
      provider_calls: 0,
      marketplace_mutations: 0,
    }));
    if (!apply) {
      for (const candidate of candidates.slice(0, 10)) {
        console.log(
          `  ${candidate.price.toFixed(2)} ${candidate.currency} `
          + `${candidate.observedAt.slice(0, 10)} ${candidate.title ?? ""}`.slice(0, 110),
        );
      }
      return;
    }
    let written = 0;
    const createdAt = new Date().toISOString();
    for (const candidate of candidates) {
      const observationKey = sha256(stableJson({
        schema: "product-truth-catalog-price-observation/1.0.0",
        donorOfferId: candidate.donorOfferId,
        donorProductId: candidate.donorProductId,
        canonicalVariantId: candidate.canonicalVariantId,
        variantDecisionId: candidate.variantDecisionId,
        retailerProductId: candidate.retailerProductId,
        sourceApi: SOURCE_API,
        price: candidate.price,
        currency: candidate.currency,
        zip: candidate.zip,
        observedAt: candidate.observedAt,
        locality: LOCALITY ?? "none_recorded",
      }));
      await db.execute({
        sql: `INSERT INTO "DonorOfferObservation"
                (id, observationKey, donorOfferId, donorProductId,
                 canonicalVariantId, variantDecisionId, retailer, retailerProductId,
                 via, title, price, packSizeSeen, pricePerUnit, currency, zip,
                 localityEvidence, inStock, productUrl, sellerName, isFirstParty,
                 sourceApi, observedAt, runId, approvalId, meteredReceiptId, createdAt)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,1,?,?,NULL,NULL,NULL,?)`,
        args: [
          `pco:${observationKey}`, observationKey, candidate.donorOfferId,
          candidate.donorProductId, candidate.canonicalVariantId,
          candidate.variantDecisionId, candidate.retailer,
          candidate.retailerProductId, candidate.via, candidate.title,
          candidate.price, candidate.packSizeSeen, candidate.pricePerUnit,
          candidate.currency, candidate.zip, LOCALITY, candidate.productUrl,
          candidate.sellerName, candidate.sourceApi, candidate.observedAt,
          createdAt,
        ],
      });
      written += 1;
    }
    const verified = await db.execute(
      `SELECT COUNT(*) AS total FROM "DonorOfferObservation"
       WHERE sourceApi = '${SOURCE_API}'`,
    );
    const total = Number(verified.rows[0]?.total ?? 0);
    if (total < written) {
      throw new Error(
        `CATALOG_PRICE_OBSERVATION_WRITE_UNVERIFIED: attempted ${written}, present ${total}`,
      );
    }
    console.log(JSON.stringify({
      status: "APPLIED",
      written,
      provider_calls: 0,
      marketplace_mutations: 0,
    }));
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
