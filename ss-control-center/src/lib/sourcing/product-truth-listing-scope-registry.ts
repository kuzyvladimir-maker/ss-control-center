import type { Client, InStatement } from "@libsql/client";

import {
  PHASE1_SCOPE_MANIFEST_VERSION,
  renderPhase1ScopeManifestJson,
  sha256Hex,
  validatePhase1ScopeManifestV3Policy,
  type Phase1ScopeManifest,
} from "./phase1-scope-manifest";
import {
  PRODUCT_TRUTH_LISTING_KEY_VERSION,
  SKU_COST_LISTING_SCOPE_LINK_VERSION,
  buildProductTruthListingScope,
} from "./product-truth-listing-scope";
import { assertProductTruthListingScopeSchema } from "./product-truth-schema-gate";

export { SKU_COST_LISTING_SCOPE_LINK_VERSION };

export class ProductTruthListingScopeImportError extends Error {
  readonly code = "PRODUCT_TRUTH_LISTING_SCOPE_IMPORT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ProductTruthListingScopeImportError";
  }
}

/**
 * The only application importer for canonical listing scopes. It verifies the
 * exact canonical JSON bytes and caller-provided checksum, then inserts every
 * previously unseen listing in one transaction. It never derives scope from
 * legacy SKU rows or historical costs.
 */
export async function importAuthoritativePhase1ListingScopes(
  db: Client,
  input: {
    manifest: Phase1ScopeManifest;
    manifestJson: string;
    expectedManifestSha256: string;
    registeredAt: string;
  },
): Promise<{ manifestSha256: string; inserted: number; existing: number }> {
  const canonicalJson = renderPhase1ScopeManifestJson(input.manifest);
  const manifestSha256 = sha256Hex(input.manifestJson);
  if (input.manifest.schemaVersion !== PHASE1_SCOPE_MANIFEST_VERSION) {
    throw new ProductTruthListingScopeImportError("manifest schemaVersion is not current");
  }
  const policyErrors = validatePhase1ScopeManifestV3Policy(input.manifest);
  if (policyErrors.length > 0) {
    throw new ProductTruthListingScopeImportError(
      `manifest v3 policy binding is invalid: ${policyErrors.join("; ")}`,
    );
  }
  if (!input.manifest.authoritative || input.manifest.blockers.length > 0) {
    throw new ProductTruthListingScopeImportError("manifest is not authoritative");
  }
  if (canonicalJson !== input.manifestJson) {
    throw new ProductTruthListingScopeImportError("manifest JSON is not canonical or does not match the object");
  }
  if (!/^[a-f0-9]{64}$/.test(input.expectedManifestSha256) ||
      manifestSha256 !== input.expectedManifestSha256) {
    throw new ProductTruthListingScopeImportError("manifest SHA-256 mismatch");
  }
  const registeredAtMs = Date.parse(input.registeredAt);
  if (!Number.isFinite(registeredAtMs) || registeredAtMs < Date.parse(input.manifest.asOf)) {
    throw new ProductTruthListingScopeImportError("registeredAt must be at or after manifest asOf");
  }

  await assertProductTruthListingScopeSchema(db);
  const dispositions = new Map(
    input.manifest.scopeDispositions.map((scope) => [
      `${scope.channel}:${scope.scopeKey}`,
      scope,
    ]),
  );
  const statements: InStatement[] = [];
  let existingCount = 0;
  for (const listing of input.manifest.listings) {
    const exact = buildProductTruthListingScope(listing);
    if (exact.listingKey !== listing.listingKey) {
      throw new ProductTruthListingScopeImportError(
        `listingKey mismatch for ${listing.channel}:${listing.scopeKey}:${listing.sku}`,
      );
    }
    const disposition = dispositions.get(`${listing.channel}:${listing.scopeKey}`);
    if (!disposition || disposition.storeIndex !== listing.storeIndex ||
        disposition.disposition !== "IN_SCOPE" || !disposition.decisionId) {
      throw new ProductTruthListingScopeImportError(
        `listing scope provenance mismatch for ${listing.listingKey}`,
      );
    }
    const existing = (await db.execute({
      sql: `SELECT listingKey,keyVersion,channel,storeIndex,sku,
                   registrationKind,manifestSchemaVersion,manifestSha256,
                   manifestAsOf,ownerDecisionId,sourceReportId,
                   sourceContentSha256,sourceCapturedAt
            FROM ProductTruthListingScope
            WHERE listingKey=? OR (channel=? AND storeIndex=? AND sku=?)`,
      args: [listing.listingKey, listing.channel, listing.storeIndex, listing.sku],
    })).rows;
    if (existing.length > 1) {
      throw new ProductTruthListingScopeImportError(
        `registry collision for ${listing.listingKey}`,
      );
    }
    if (existing.length === 1) {
      const row = existing[0];
      if (row.listingKey !== listing.listingKey ||
          row.keyVersion !== PRODUCT_TRUTH_LISTING_KEY_VERSION ||
          row.channel !== listing.channel || Number(row.storeIndex) !== listing.storeIndex ||
          row.sku !== listing.sku ||
          row.registrationKind !== "AUTHORITATIVE_PHASE1_MANIFEST" ||
          row.manifestSchemaVersion !== input.manifest.schemaVersion ||
          row.manifestSha256 !== manifestSha256 ||
          String(row.manifestAsOf) !== input.manifest.asOf ||
          row.ownerDecisionId !== disposition.decisionId ||
          row.sourceReportId !== listing.sourceReportId ||
          row.sourceContentSha256 !== listing.sourceContentSha256 ||
          String(row.sourceCapturedAt) !== listing.sourceCapturedAt) {
        throw new ProductTruthListingScopeImportError(
          `registry immutable manifest binding conflict for ${listing.listingKey}`,
        );
      }
      existingCount += 1;
      continue;
    }
    statements.push({
      sql: `INSERT INTO ProductTruthListingScope (
        listingKey,keyVersion,channel,storeIndex,sku,registrationKind,
        manifestSchemaVersion,manifestSha256,manifestAsOf,ownerDecisionId,
        sourceReportId,sourceContentSha256,sourceCapturedAt,createdAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        listing.listingKey, PRODUCT_TRUTH_LISTING_KEY_VERSION, listing.channel,
        listing.storeIndex, listing.sku, "AUTHORITATIVE_PHASE1_MANIFEST",
        input.manifest.schemaVersion, manifestSha256, input.manifest.asOf,
        disposition.decisionId, listing.sourceReportId, listing.sourceContentSha256,
        listing.sourceCapturedAt, input.registeredAt,
      ],
    });
  }
  if (statements.length) await db.batch(statements, "write");
  return {
    manifestSha256,
    inserted: statements.length,
    existing: existingCount,
  };
}
