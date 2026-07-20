import { createHash } from "node:crypto";

import type { Client } from "@libsql/client";

import {
  matchCanonicalProduct,
  matchCanonicalProductTitle,
  type CanonicalProductIdentity,
} from "@/lib/sourcing/canonical-product-match";
import type { ProductTruthNewSkuRecipeComponentEvidence } from "@/lib/sourcing/product-truth-read-contract";
import {
  PRODUCT_TRUTH_READ_CONTRACT_VERSION,
  readProductTruthSnapshots,
  type ProductTruthBatchReadOptions,
  type ProductTruthSnapshot,
} from "@/lib/sourcing/product-truth-read-contract";
import { buildProductTruthListingScope } from
  "@/lib/sourcing/product-truth-listing-scope";

export const WALMART_SELLER_CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const WALMART_ITEM_REPORT_MIRROR_SKEW_MAX_MS = 5 * 60 * 1_000;

export type WalmartRecipeCollisionBasis =
  | "SELLER_CATALOG_EXACT_TITLE"
  | "SELLER_CATALOG_PRODUCT_TRUTH_RECIPE"
  | "SELLER_CATALOG_EXACT_DONOR_ALIAS"
  | "SELLER_CATALOG_STRUCTURED_IDENTITY"
  | "CHANNEL_SKU_PRODUCT_TRUTH_RECIPE"
  | "CHANNEL_SKU_PRODUCT_TRUTH_MANIFEST"
  | "CHANNEL_SKU_EXACT_COMPONENT_UPC"
  | "CHANNEL_SKU_EXACT_TITLE"
  | "CHANNEL_SKU_IDENTITY_UNRESOLVED";

export interface WalmartRecipeCollision {
  source: "WalmartCatalogItem" | "ChannelSKU";
  sku: string;
  item_id: string | null;
  channel_sku_id: string | null;
  basis: WalmartRecipeCollisionBasis;
  lifecycle_status: string | null;
  published_status: string | null;
}

interface SellerCatalogRow {
  sku: string;
  itemId: string | null;
  title: string | null;
  lifecycleStatus: string | null;
  publishedStatus: string | null;
  syncedAt: string;
}

interface SellerComponentRow {
  sku: string;
  id: string;
  qty: number;
  donorProductId: string | null;
  contentDonorProductId: string | null;
}

interface SellerStructuredIdentityRow {
  sku: string;
  identityJson: string;
  unitsInListing: number | null;
}

interface SellerCatalogIdentityResolution {
  sku: string;
  canonicalVariantId: string | null;
  packCount: number;
  componentSetSize: number;
  evidenceBasis: "PRODUCT_TRUTH_READ_CONTRACT";
  evidenceSha256: string;
}

interface ChannelSkuRow {
  channelSkuId: string;
  sku: string;
  upc: string;
  title: string;
  lifecycleStatus: string | null;
  listingStatus: string | null;
  attributes: string;
  masterPackCount: number;
  componentId: string | null;
  componentQty: number | null;
  componentManufacturerUpc: string | null;
}

export interface WalmartSellerCatalogNoveltyIndex {
  store_index: number;
  loaded_at: string;
  seller_catalog_synced_at: string;
  seller_catalog_row_count: number;
  seller_catalog_active_row_count: number;
  seller_catalog_sha256: string;
  seller_catalog_identity_resolution_sha256: string;
  authoritative_item_report_downloaded_at: string;
  authoritative_item_report_request_id_sha256: string;
  catalogRows: SellerCatalogRow[];
  sellerComponents: SellerComponentRow[];
  sellerStructuredIdentities: SellerStructuredIdentityRow[];
  sellerIdentityResolutions: SellerCatalogIdentityResolution[];
  channelSkus: ChannelSkuRow[];
  channelIdentityUnresolvedIds: string[];
  donorAliasesByCanonicalVariant: Map<string, Set<string>>;
}

export interface WalmartSellerCatalogNoveltyInspection {
  store_index: number;
  canonical_variant_id: string;
  pack_count: number;
  checked_at: string;
  seller_catalog_synced_at: string;
  seller_catalog_row_count: number;
  seller_catalog_active_row_count: number;
  seller_catalog_sha256: string;
  seller_catalog_identity_resolution_sha256: string;
  authoritative_item_report_downloaded_at: string;
  authoritative_item_report_request_id_sha256: string;
  collisions: WalmartRecipeCollision[];
  novel: boolean;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function integer(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function canonicalIso(value: unknown, label: string): string {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not a valid timestamp`);
  return new Date(parsed).toISOString();
}

function hashRows(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function relevantSellerCatalogRow(row: SellerCatalogRow): boolean {
  const lifecycle = row.lifecycleStatus?.toUpperCase() ?? "";
  return lifecycle !== "RETIRED" && lifecycle !== "ARCHIVED";
}

function normalizedGtin(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  if (![12, 13, 14].includes(digits.length)) return null;
  return digits.padStart(14, "0");
}

function exactTargetIdentity(
  component: ProductTruthNewSkuRecipeComponentEvidence,
): CanonicalProductIdentity {
  const identity = component.canonical_identity;
  if (identity.outerPackCount !== 1) {
    throw new Error("Walmart pilot novelty requires a base-unit canonical variant");
  }
  if (!Number.isInteger(component.qty) || ![2, 3].includes(component.qty)) {
    throw new Error("Walmart pilot novelty supports only pack counts 2 or 3");
  }
  const modifiers = identity.modifiers.map((modifier) => {
    if (typeof modifier !== "string" || !modifier.trim()) {
      throw new Error("Canonical identity modifiers must be non-empty strings");
    }
    return modifier.trim();
  });
  return {
    brand: identity.brand,
    productLine: identity.productLine,
    flavor: identity.flavor,
    modifiers,
    form: identity.form,
    size: `${identity.sizeBaseAmount} ${identity.sizeBaseUnit}`,
    outerPackCount: component.qty,
  };
}

function parseStructuredIdentity(
  row: SellerStructuredIdentityRow,
): CanonicalProductIdentity | null {
  try {
    const parsed = JSON.parse(row.identityJson) as Record<string, unknown>;
    const units = integer(parsed.units_in_listing ?? parsed.unitsInListing ?? row.unitsInListing);
    if (!units || units < 1 || parsed.is_bundle === true || parsed.isBundle === true) {
      return null;
    }
    return {
      brand: text(parsed.brand),
      productLine: text(parsed.product_line ?? parsed.productLine),
      flavor: text(parsed.flavor),
      form: text(parsed.form ?? parsed.container_type ?? parsed.containerType),
      size: text(parsed.size),
      outerPackCount: units,
      title: text(parsed.base_unit ?? parsed.baseUnit),
    };
  } catch {
    return null;
  }
}

function completeStructuredIdentity(
  row: SellerStructuredIdentityRow,
): CanonicalProductIdentity | null {
  const parsed = parseStructuredIdentity(row);
  if (
    !parsed?.brand?.trim() ||
    !parsed.productLine?.trim() ||
    !parsed.flavor?.trim() ||
    !parsed.form?.trim() ||
    !parsed.size?.trim() ||
    !Number.isInteger(parsed.outerPackCount) ||
    Number(parsed.outerPackCount) < 1
  ) {
    return null;
  }
  return parsed;
}

function parseManifestIdentity(
  attributes: string,
  storeIndex: number,
): { canonicalVariantId: string; qty: number } | null {
  try {
    const root = JSON.parse(attributes) as Record<string, unknown>;
    const manifest = root.product_truth_manifest as Record<string, unknown> | undefined;
    const scope = manifest?.listing_scope as Record<string, unknown> | undefined;
    const components = Array.isArray(manifest?.components) ? manifest.components : [];
    if (Number(scope?.store_index) !== storeIndex || components.length !== 1) return null;
    const component = components[0] as Record<string, unknown>;
    const canonicalVariantId = text(component.canonical_variant_id);
    const qty = integer(component.qty);
    if (!canonicalVariantId || !qty || qty < 1) return null;
    return { canonicalVariantId, qty };
  } catch {
    return null;
  }
}

function manifestCollision(
  attributes: string,
  storeIndex: number,
  canonicalVariantId: string,
  packCount: number,
): boolean {
  const identity = parseManifestIdentity(attributes, storeIndex);
  return identity?.canonicalVariantId === canonicalVariantId &&
    identity.qty === packCount;
}

function deduplicateCollisions(
  collisions: WalmartRecipeCollision[],
): WalmartRecipeCollision[] {
  const seen = new Set<string>();
  return collisions
    .sort((left, right) =>
      left.source.localeCompare(right.source) ||
      left.sku.localeCompare(right.sku) ||
      left.basis.localeCompare(right.basis),
    )
    .filter((collision) => {
      const key = `${collision.source}:${collision.sku}:${collision.basis}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export async function loadWalmartSellerCatalogNoveltyIndex(input: {
  db: Client;
  storeIndex: number;
  now?: Date;
  maxAgeMs?: number;
  readProductTruthSnapshotsImpl?: (
    db: Client,
    options: ProductTruthBatchReadOptions,
  ) => Promise<ProductTruthSnapshot[]>;
}): Promise<WalmartSellerCatalogNoveltyIndex> {
  const now = input.now ?? new Date();
  const maxAgeMs = input.maxAgeMs ?? WALMART_SELLER_CATALOG_MAX_AGE_MS;
  if (!Number.isInteger(input.storeIndex) || input.storeIndex < 1) {
    throw new Error("Walmart seller catalog storeIndex must be a positive integer");
  }
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new Error("Walmart seller catalog freshness inputs are invalid");
  }

  const catalogResult = await input.db.execute({
    sql: `SELECT sku,itemId,title,lifecycleStatus,publishedStatus,syncedAt
          FROM WalmartCatalogItem WHERE storeIndex=? ORDER BY sku`,
    args: [input.storeIndex],
  });
  const catalogRows: SellerCatalogRow[] = catalogResult.rows.map((row) => ({
    sku: text(row.sku) ?? "",
    itemId: text(row.itemId),
    title: text(row.title),
    lifecycleStatus: text(row.lifecycleStatus),
    publishedStatus: text(row.publishedStatus),
    syncedAt: canonicalIso(row.syncedAt, "WalmartCatalogItem.syncedAt"),
  }));
  if (catalogRows.length === 0 || catalogRows.some((row) => !row.sku)) {
    throw new Error("SELLER_CATALOG_SNAPSHOT_EMPTY_OR_INVALID");
  }
  const syncInstants = [...new Set(catalogRows.map((row) => row.syncedAt))];
  if (syncInstants.length !== 1) {
    throw new Error("SELLER_CATALOG_SNAPSHOT_NOT_ATOMIC");
  }
  const syncedAt = syncInstants[0]!;
  const ageMs = now.getTime() - Date.parse(syncedAt);
  if (ageMs < 0 || ageMs > maxAgeMs) {
    throw new Error("SELLER_CATALOG_SNAPSHOT_STALE_OR_FUTURE");
  }
  const relevantRows = catalogRows.filter(relevantSellerCatalogRow);
  if (relevantRows.some((row) => !row.title)) {
    throw new Error("SELLER_CATALOG_ACTIVE_IDENTITY_COVERAGE_INCOMPLETE");
  }

  const reportResult = await input.db.execute({
    sql: `SELECT requestId,rowCount,downloadedAt,status
          FROM WalmartReport
          WHERE storeIndex=? AND reportType='ITEM_CATALOG' AND status='DOWNLOADED'
          ORDER BY julianday(downloadedAt) DESC,downloadedAt DESC,requestedAt DESC
          LIMIT 1`,
    args: [input.storeIndex],
  });
  const report = reportResult.rows[0];
  const reportRequestId = text(report?.requestId);
  const reportRowCount = integer(report?.rowCount);
  const reportDownloadedAt = report?.downloadedAt == null
    ? null
    : canonicalIso(report.downloadedAt, "WalmartReport.downloadedAt");
  if (
    !reportRequestId ||
    reportRowCount !== catalogRows.length ||
    !reportDownloadedAt ||
    Math.abs(Date.parse(reportDownloadedAt) - Date.parse(syncedAt)) >
      WALMART_ITEM_REPORT_MIRROR_SKEW_MAX_MS ||
    now.getTime() - Date.parse(reportDownloadedAt) < 0 ||
    now.getTime() - Date.parse(reportDownloadedAt) > maxAgeMs
  ) {
    throw new Error("SELLER_CATALOG_AUTHORITATIVE_ITEM_REPORT_UNPROVEN");
  }
  const reportRequestIdSha256 = createHash("sha256")
    .update(reportRequestId)
    .digest("hex");

  const [componentResult, structuredResult, channelResult, aliasResult] =
    await Promise.all([
      input.db.execute({
        sql: `SELECT catalog.sku,component.id,component.qty,
                     component.donorProductId,component.contentDonorProductId
              FROM WalmartCatalogItem catalog
              JOIN SkuComponent component ON component.sku=catalog.sku
              WHERE catalog.storeIndex=?
                AND lower(COALESCE(component.channel,'walmart'))='walmart'
              ORDER BY catalog.sku,component.idx,component.id`,
        args: [input.storeIndex],
      }),
      input.db.execute({
        sql: `SELECT catalog.sku,shipping.productIdentity,shipping.unitsInListing
              FROM WalmartCatalogItem catalog
              JOIN SkuShippingData shipping ON shipping.sku=catalog.sku
              WHERE catalog.storeIndex=? AND shipping.productIdentity IS NOT NULL
              ORDER BY catalog.sku`,
        args: [input.storeIndex],
      }),
      input.db.execute({
        sql: `SELECT channel.id AS channelSkuId,channel.sku,channel.upc,channel.title,
                     channel.lifecycle_status AS lifecycleStatus,
                     channel.listing_status AS listingStatus,channel.attributes,
                     master.pack_count AS masterPackCount,
                     component.id AS componentId,component.qty AS componentQty,
                     component.manufacturer_upc AS componentManufacturerUpc
              FROM ChannelSKU channel
              JOIN MasterBundle master ON master.id=channel.master_bundle_id
              LEFT JOIN BundleComponent component
                ON component.master_bundle_id=master.id
              WHERE channel.channel='WALMART'
              ORDER BY channel.id,component.id`,
      }),
      input.db.execute(
        `SELECT donorProductId,canonicalVariantId
         FROM DonorProductVariantDecision
         WHERE decisionStatus='exact_confirmed' AND canonicalVariantId IS NOT NULL
         ORDER BY canonicalVariantId,donorProductId`,
      ),
    ]);

  const sellerComponents: SellerComponentRow[] = componentResult.rows.map((row) => ({
    sku: String(row.sku),
    id: String(row.id),
    qty: integer(row.qty) ?? -1,
    donorProductId: text(row.donorProductId),
    contentDonorProductId: text(row.contentDonorProductId),
  }));
  const sellerStructuredIdentities: SellerStructuredIdentityRow[] =
    structuredResult.rows.map((row) => ({
      sku: String(row.sku),
      identityJson: String(row.productIdentity),
      unitsInListing: integer(row.unitsInListing),
    }));
  const allChannelSkus: ChannelSkuRow[] = channelResult.rows.map((row) => ({
    channelSkuId: String(row.channelSkuId),
    sku: String(row.sku),
    upc: String(row.upc),
    title: String(row.title),
    lifecycleStatus: text(row.lifecycleStatus),
    listingStatus: text(row.listingStatus),
    attributes: String(row.attributes),
    masterPackCount: integer(row.masterPackCount) ?? -1,
    componentId: text(row.componentId),
    componentQty: integer(row.componentQty),
    componentManufacturerUpc: text(row.componentManufacturerUpc),
  }));
  const donorAliasesByCanonicalVariant = new Map<string, Set<string>>();
  for (const row of aliasResult.rows) {
    const variant = String(row.canonicalVariantId);
    const donor = String(row.donorProductId);
    const aliases = donorAliasesByCanonicalVariant.get(variant) ?? new Set<string>();
    aliases.add(donor);
    donorAliasesByCanonicalVariant.set(variant, aliases);
  }
  const sellerIdentityResolutions: SellerCatalogIdentityResolution[] = [];
  const unresolvedCatalogSkus = new Set<string>();
  const unresolvedChannelSkuIds = new Set<string>();
  const scopeResult = await input.db.execute({
    sql: `SELECT listingKey,sku,manifestSha256,storeIndex
          FROM ProductTruthListingScope
          WHERE channel='walmart'
          ORDER BY storeIndex,listingKey`,
  });
  const currentScopesBySku = new Map<string, {
    listingKey: string;
    sku: string;
    manifestSha256: string;
  }>();
  const scopeStoresBySku = new Map<string, Set<number>>();
  for (const row of scopeResult.rows) {
    const sku = String(row.sku);
    const storeIndex = integer(row.storeIndex);
    if (!storeIndex || storeIndex < 1) {
      throw new Error("SELLER_CATALOG_CANONICAL_SCOPE_INVALID");
    }
    const stores = scopeStoresBySku.get(sku) ?? new Set<number>();
    stores.add(storeIndex);
    scopeStoresBySku.set(sku, stores);
    if (storeIndex !== input.storeIndex) continue;
    if (currentScopesBySku.has(sku)) {
      throw new Error("SELLER_CATALOG_CANONICAL_SCOPE_DUPLICATE");
    }
    currentScopesBySku.set(sku, {
      listingKey: String(row.listingKey),
      sku,
      manifestSha256: String(row.manifestSha256),
    });
  }
  const catalogSkuSet = new Set(catalogRows.map((row) => row.sku));
  const channelSkus = allChannelSkus.filter((row) => {
    if (catalogSkuSet.has(row.sku) || currentScopesBySku.has(row.sku)) return true;
    const knownStores = scopeStoresBySku.get(row.sku);
    if (knownStores && knownStores.size > 0) return false;
    unresolvedChannelSkuIds.add(row.channelSkuId);
    return true;
  });
  const channelIdsBySku = new Map<string, Set<string>>();
  for (const row of channelSkus) {
    const ids = channelIdsBySku.get(row.sku) ?? new Set<string>();
    ids.add(row.channelSkuId);
    channelIdsBySku.set(row.sku, ids);
  }
  const scopesByManifest = new Map<string, Array<{
    sku: string;
    channel: string;
    storeIndex: number;
    listingKey: string;
  }>>();
  const requiredSkus = new Set([
    ...catalogRows.map((row) => row.sku),
    ...channelSkus.map((row) => row.sku),
  ]);
  for (const sku of requiredSkus) {
    const scope = currentScopesBySku.get(sku);
    if (!scope || !/^[a-f0-9]{64}$/.test(scope.manifestSha256)) {
      if (catalogSkuSet.has(sku)) unresolvedCatalogSkus.add(sku);
      for (const channelSkuId of channelIdsBySku.get(sku) ?? []) {
        unresolvedChannelSkuIds.add(channelSkuId);
      }
      continue;
    }
    const expectedListingScope = buildProductTruthListingScope({
      channel: "walmart",
      storeIndex: input.storeIndex,
      sku,
    });
    if (scope.listingKey !== expectedListingScope.listingKey) {
      if (catalogSkuSet.has(sku)) unresolvedCatalogSkus.add(sku);
      for (const channelSkuId of channelIdsBySku.get(sku) ?? []) {
        unresolvedChannelSkuIds.add(channelSkuId);
      }
      continue;
    }
    const rows = scopesByManifest.get(scope.manifestSha256) ?? [];
    rows.push({
      sku,
      channel: "walmart",
      storeIndex: input.storeIndex,
      listingKey: scope.listingKey,
    });
    scopesByManifest.set(scope.manifestSha256, rows);
  }
  const snapshotReader = input.readProductTruthSnapshotsImpl ??
    readProductTruthSnapshots;
  for (const [manifestSha256, scopes] of scopesByManifest) {
    for (let offset = 0; offset < scopes.length; offset += 100) {
      const batch = scopes.slice(offset, offset + 100);
      let snapshots: ProductTruthSnapshot[];
      try {
        snapshots = await snapshotReader(input.db, {
          scopes: batch.map(({ sku, channel, storeIndex }) => ({
            sku,
            channel,
            storeIndex,
          })),
          expectedManifestSha256: manifestSha256,
          asOf: now,
          maxPriceAgeMs: maxAgeMs,
        });
      } catch {
        for (const scope of batch) {
          if (catalogSkuSet.has(scope.sku)) unresolvedCatalogSkus.add(scope.sku);
          for (const channelSkuId of channelIdsBySku.get(scope.sku) ?? []) {
            unresolvedChannelSkuIds.add(channelSkuId);
          }
        }
        continue;
      }
      if (snapshots.length !== batch.length) {
        for (const scope of batch) {
          if (catalogSkuSet.has(scope.sku)) unresolvedCatalogSkus.add(scope.sku);
          for (const channelSkuId of channelIdsBySku.get(scope.sku) ?? []) {
            unresolvedChannelSkuIds.add(channelSkuId);
          }
        }
        continue;
      }
      snapshots.forEach((snapshot, index) => {
        const expectedScope = batch[index]!;
        const components = snapshot.recipe.components;
        if (
          snapshot.contractVersion !== PRODUCT_TRUTH_READ_CONTRACT_VERSION ||
          snapshot.snapshot.sku !== expectedScope.sku ||
          snapshot.snapshot.channel !== "walmart" ||
          snapshot.snapshot.storeIndex !== input.storeIndex ||
          snapshot.snapshot.listingKey !== expectedScope.listingKey ||
          snapshot.snapshot.asOf !== now.toISOString() ||
          snapshot.snapshot.maxPriceAgeMs !== maxAgeMs ||
          snapshot.recipe.blockers.length > 0 ||
          components.length === 0 ||
          components.some((component) =>
            !component.componentEvidenceId?.trim() ||
            !component.targetCanonicalVariantId?.trim() ||
            !Number.isInteger(component.qty) ||
            component.qty < 1,
          )
        ) {
          if (catalogSkuSet.has(expectedScope.sku)) {
            unresolvedCatalogSkus.add(expectedScope.sku);
          }
          for (const channelSkuId of
            channelIdsBySku.get(expectedScope.sku) ?? []) {
            unresolvedChannelSkuIds.add(channelSkuId);
          }
          return;
        }
        const quantitiesByVariant = new Map<string, number>();
        for (const component of components) {
          quantitiesByVariant.set(
            component.targetCanonicalVariantId,
            (quantitiesByVariant.get(component.targetCanonicalVariantId) ?? 0) +
              component.qty,
          );
        }
        const canonicalComponents = [...quantitiesByVariant.entries()]
          .map(([canonicalVariantId, qty]) => ({ canonicalVariantId, qty }))
          .sort((left, right) =>
            left.canonicalVariantId.localeCompare(right.canonicalVariantId),
          );
        const evidenceSha256 = hashRows({
          contract_version: snapshot.contractVersion,
          manifest_sha256: manifestSha256,
          snapshot: snapshot.snapshot,
          recipe: snapshot.recipe,
          bundle_factory_view: snapshot.views.bundleFactory,
        });
        for (const component of canonicalComponents) {
          sellerIdentityResolutions.push({
            sku: expectedScope.sku,
            canonicalVariantId: component.canonicalVariantId,
            packCount: component.qty,
            componentSetSize: canonicalComponents.length,
            evidenceBasis: "PRODUCT_TRUTH_READ_CONTRACT",
            evidenceSha256,
          });
        }
      });
    }
  }
  if (unresolvedCatalogSkus.size > 0) {
    const unresolved = [...unresolvedCatalogSkus].sort();
    throw new Error(
      `SELLER_CATALOG_IDENTITY_RESOLUTION_INCOMPLETE:${unresolved.length}:` +
      hashRows(unresolved),
    );
  }
  const identityResolutionSha256 = hashRows(
    {
      resolutions: sellerIdentityResolutions
        .map((resolution) => ({
          sku: resolution.sku,
          canonical_variant_id: resolution.canonicalVariantId,
          pack_count: resolution.packCount,
          component_set_size: resolution.componentSetSize,
          evidence_basis: resolution.evidenceBasis,
          evidence_sha256: resolution.evidenceSha256,
        }))
        .sort((left, right) =>
          left.sku.localeCompare(right.sku) ||
          left.evidence_basis.localeCompare(right.evidence_basis) ||
          String(left.canonical_variant_id).localeCompare(
            String(right.canonical_variant_id),
          ),
        ),
      unresolved_channel_sku_ids: [...unresolvedChannelSkuIds].sort(),
    },
  );
  const catalogHashRows = catalogRows.map((row) => ({
    sku: row.sku,
    item_id: row.itemId,
    title: row.title,
    lifecycle_status: row.lifecycleStatus,
    published_status: row.publishedStatus,
    synced_at: row.syncedAt,
  }));
  return {
    store_index: input.storeIndex,
    loaded_at: now.toISOString(),
    seller_catalog_synced_at: syncedAt,
    seller_catalog_row_count: catalogRows.length,
    seller_catalog_active_row_count: relevantRows.length,
    seller_catalog_sha256: hashRows(catalogHashRows),
    seller_catalog_identity_resolution_sha256: identityResolutionSha256,
    authoritative_item_report_downloaded_at: reportDownloadedAt,
    authoritative_item_report_request_id_sha256: reportRequestIdSha256,
    catalogRows,
    sellerComponents,
    sellerStructuredIdentities,
    sellerIdentityResolutions,
    channelSkus,
    channelIdentityUnresolvedIds: [...unresolvedChannelSkuIds].sort(),
    donorAliasesByCanonicalVariant,
  };
}

export function inspectWalmartSellerCatalogRecipeNovelty(input: {
  index: WalmartSellerCatalogNoveltyIndex;
  component: ProductTruthNewSkuRecipeComponentEvidence;
  allowedSellerSku?: string | null;
  allowedChannelSkuId?: string | null;
  now?: Date;
}): WalmartSellerCatalogNoveltyInspection {
  const now = input.now ?? new Date();
  const target = exactTargetIdentity(input.component);
  const catalogBySku = new Map(input.index.catalogRows.map((row) => [row.sku, row]));
  const collisions: WalmartRecipeCollision[] = [];
  const pushSeller = (sku: string, basis: WalmartRecipeCollisionBasis) => {
    if (input.allowedSellerSku && sku === input.allowedSellerSku) return;
    const row = catalogBySku.get(sku);
    if (!row) return;
    collisions.push({
      source: "WalmartCatalogItem",
      sku,
      item_id: row.itemId,
      channel_sku_id: null,
      basis,
      lifecycle_status: row.lifecycleStatus,
      published_status: row.publishedStatus,
    });
  };

  for (const row of input.index.catalogRows) {
    if (!row.title) continue;
    if (matchCanonicalProductTitle(target, { title: row.title }).verdict === "EXACT_IDENTITY") {
      pushSeller(row.sku, "SELLER_CATALOG_EXACT_TITLE");
    }
  }

  for (const resolution of input.index.sellerIdentityResolutions) {
    if (
      resolution.componentSetSize === 1 &&
      resolution.canonicalVariantId === input.component.canonical_variant_id &&
      resolution.packCount === input.component.qty
    ) {
      pushSeller(resolution.sku, "SELLER_CATALOG_PRODUCT_TRUTH_RECIPE");
    }
  }

  const sellerComponentsBySku = new Map<string, SellerComponentRow[]>();
  for (const row of input.index.sellerComponents) {
    const rows = sellerComponentsBySku.get(row.sku) ?? [];
    rows.push(row);
    sellerComponentsBySku.set(row.sku, rows);
  }
  const targetDonorAliases = input.index.donorAliasesByCanonicalVariant.get(
    input.component.canonical_variant_id,
  ) ?? new Set<string>();
  for (const [sku, rows] of sellerComponentsBySku) {
    if (
      rows.length === 1 &&
      rows[0]!.qty === input.component.qty &&
      [rows[0]!.donorProductId, rows[0]!.contentDonorProductId]
        .some((donorId) => donorId && targetDonorAliases.has(donorId))
    ) {
      pushSeller(sku, "SELLER_CATALOG_EXACT_DONOR_ALIAS");
    }
  }
  for (const row of input.index.sellerStructuredIdentities) {
    const structuredIdentity = completeStructuredIdentity(row);
    if (
      structuredIdentity &&
      matchCanonicalProduct(target, structuredIdentity).verdict === "EXACT_IDENTITY"
    ) {
      pushSeller(row.sku, "SELLER_CATALOG_STRUCTURED_IDENTITY");
    }
  }

  const channelRowsById = new Map<string, ChannelSkuRow[]>();
  for (const row of input.index.channelSkus) {
    const rows = channelRowsById.get(row.channelSkuId) ?? [];
    rows.push(row);
    channelRowsById.set(row.channelSkuId, rows);
  }
  const targetManufacturerUpc = normalizedGtin(input.component.manufacturer_upc);
  const unresolvedChannelIds = new Set(input.index.channelIdentityUnresolvedIds);
  const canonicalResolutionsBySku = new Map<
    string,
    SellerCatalogIdentityResolution[]
  >();
  for (const resolution of input.index.sellerIdentityResolutions) {
    const rows = canonicalResolutionsBySku.get(resolution.sku) ?? [];
    rows.push(resolution);
    canonicalResolutionsBySku.set(resolution.sku, rows);
  }
  for (const [channelSkuId, rows] of channelRowsById) {
    if (input.allowedChannelSkuId && channelSkuId === input.allowedChannelSkuId) continue;
    const first = rows[0]!;
    const pushChannel = (basis: WalmartRecipeCollisionBasis) => {
      collisions.push({
        source: "ChannelSKU",
        sku: first.sku,
        item_id: null,
        channel_sku_id: channelSkuId,
        basis,
        lifecycle_status: first.lifecycleStatus,
        published_status: first.listingStatus,
      });
    };
    const canonicalResolutions = canonicalResolutionsBySku.get(first.sku) ?? [];
    if (canonicalResolutions.some((resolution) =>
      resolution.componentSetSize === 1 &&
      resolution.canonicalVariantId === input.component.canonical_variant_id &&
      resolution.packCount === input.component.qty
    )) {
      pushChannel("CHANNEL_SKU_PRODUCT_TRUTH_RECIPE");
    }
    if (
      manifestCollision(
        first.attributes,
        input.index.store_index,
        input.component.canonical_variant_id,
        input.component.qty,
      )
    ) {
      pushChannel("CHANNEL_SKU_PRODUCT_TRUTH_MANIFEST");
    }
    if (
      rows.length === 1 &&
      targetManufacturerUpc &&
      normalizedGtin(first.componentManufacturerUpc) === targetManufacturerUpc &&
      first.componentQty === input.component.qty &&
      first.masterPackCount === input.component.qty
    ) {
      pushChannel("CHANNEL_SKU_EXACT_COMPONENT_UPC");
    }
    if (matchCanonicalProductTitle(target, { title: first.title }).verdict === "EXACT_IDENTITY") {
      pushChannel("CHANNEL_SKU_EXACT_TITLE");
    }
    if (unresolvedChannelIds.has(channelSkuId) || canonicalResolutions.length === 0) {
      pushChannel("CHANNEL_SKU_IDENTITY_UNRESOLVED");
    }
  }

  const exactCollisions = deduplicateCollisions(collisions);
  return {
    store_index: input.index.store_index,
    canonical_variant_id: input.component.canonical_variant_id,
    pack_count: input.component.qty,
    checked_at: now.toISOString(),
    seller_catalog_synced_at: input.index.seller_catalog_synced_at,
    seller_catalog_row_count: input.index.seller_catalog_row_count,
    seller_catalog_active_row_count: input.index.seller_catalog_active_row_count,
    seller_catalog_sha256: input.index.seller_catalog_sha256,
    seller_catalog_identity_resolution_sha256:
      input.index.seller_catalog_identity_resolution_sha256,
    authoritative_item_report_downloaded_at:
      input.index.authoritative_item_report_downloaded_at,
    authoritative_item_report_request_id_sha256:
      input.index.authoritative_item_report_request_id_sha256,
    collisions: exactCollisions,
    novel: exactCollisions.length === 0,
  };
}

export async function assertWalmartSellerCatalogRecipeNovelty(input: {
  db: Client;
  storeIndex: number;
  component: ProductTruthNewSkuRecipeComponentEvidence;
  allowedSellerSku?: string | null;
  allowedChannelSkuId?: string | null;
  now?: Date;
}): Promise<WalmartSellerCatalogNoveltyInspection> {
  const index = await loadWalmartSellerCatalogNoveltyIndex({
    db: input.db,
    storeIndex: input.storeIndex,
    now: input.now,
  });
  const inspection = inspectWalmartSellerCatalogRecipeNovelty({
    index,
    component: input.component,
    allowedSellerSku: input.allowedSellerSku,
    allowedChannelSkuId: input.allowedChannelSkuId,
    now: input.now,
  });
  if (!inspection.novel) {
    const targets = inspection.collisions
      .map((collision) => `${collision.source}:${collision.sku}:${collision.basis}`)
      .join(",");
    throw new Error(
      `RECIPE_ALREADY_EXISTS_OR_REQUIRES_RECONCILIATION:${targets}`,
    );
  }
  return inspection;
}
