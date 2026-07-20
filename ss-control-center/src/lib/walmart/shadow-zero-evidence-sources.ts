/**
 * Deterministic no-spend baseline for Walmart Shadow-50 evidence sources.
 *
 * Historical visual/remediation rows are not promoted here. The only accepted
 * ledgers are sealed, empty ZERO_EVIDENCE ledgers tied to the exact authoritative
 * PUBLISHED population. Every listing is emitted as NOT_AUDITED / NOT_APPLIED.
 * This proves population joins while deliberately remaining insufficient for
 * the Shadow-50 remediated quotas.
 */

import {
  WALMART_SHADOW_LISTING_CHANNEL,
  WALMART_SHADOW_PRIOR_VISUAL_SOURCE_SCHEMA,
  WALMART_SHADOW_REMEDIATION_SOURCE_SCHEMA,
  canonicalWalmartShadowJson,
  verifyWalmartShadowPriorVisualSource,
  verifyWalmartShadowPublishedCatalogSource,
  verifyWalmartShadowRemediationSource,
  walmartShadowCanonicalSha256,
  type WalmartShadowPriorVisualSource,
  type WalmartShadowPublishedCatalogSource,
  type WalmartShadowRemediationSource,
} from "./shadow-50.ts";
import {
  verifyWalmartShadowPublishedCatalogSourceAgainstItemReportCapture,
  type WalmartItemReportCompileContext,
} from "./item-report-published-source.ts";

export const WALMART_SHADOW_PRIOR_VISUAL_ZERO_LEDGER_SCHEMA =
  "walmart-shadow-prior-visual-qualified-evidence-ledger/v1" as const;
export const WALMART_SHADOW_REMEDIATION_ZERO_LEDGER_SCHEMA =
  "walmart-shadow-remediation-qualified-evidence-ledger/v1" as const;

interface PublishedCatalogBinding {
  artifact_id: string;
  body_sha256: string;
  captured_at: string;
}

interface WalmartShadowZeroEvidenceLedgerBase {
  ledger_id: string;
  body_sha256: string;
  captured_at: string;
  channel: typeof WALMART_SHADOW_LISTING_CHANNEL;
  mode: "ZERO_EVIDENCE";
  published_catalog: PublishedCatalogBinding;
  entries: [];
}

export interface WalmartShadowPriorVisualZeroEvidenceLedger
  extends WalmartShadowZeroEvidenceLedgerBase {
  schema_version: typeof WALMART_SHADOW_PRIOR_VISUAL_ZERO_LEDGER_SCHEMA;
  purpose: "PRIOR_VISUAL_SELECTION_EVIDENCE";
}

export interface WalmartShadowRemediationZeroEvidenceLedger
  extends WalmartShadowZeroEvidenceLedgerBase {
  schema_version: typeof WALMART_SHADOW_REMEDIATION_ZERO_LEDGER_SCHEMA;
  purpose: "REMEDIATION_SELECTION_EVIDENCE";
}

export interface WalmartShadowZeroEvidenceSources {
  prior_visual_ledger: WalmartShadowPriorVisualZeroEvidenceLedger;
  remediation_ledger: WalmartShadowRemediationZeroEvidenceLedger;
  prior_visual_source: WalmartShadowPriorVisualSource;
  remediation_source: WalmartShadowRemediationSource;
}

function publishedBinding(
  source: WalmartShadowPublishedCatalogSource,
): PublishedCatalogBinding {
  return {
    artifact_id: source.snapshot_id,
    body_sha256: source.body_sha256,
    captured_at: source.captured_at,
  };
}

function sealLedger<
  TSchema extends
    | typeof WALMART_SHADOW_PRIOR_VISUAL_ZERO_LEDGER_SCHEMA
    | typeof WALMART_SHADOW_REMEDIATION_ZERO_LEDGER_SCHEMA,
  TPurpose extends
    | "PRIOR_VISUAL_SELECTION_EVIDENCE"
    | "REMEDIATION_SELECTION_EVIDENCE",
>(
  schemaVersion: TSchema,
  purpose: TPurpose,
  idPrefix: string,
  source: WalmartShadowPublishedCatalogSource,
): WalmartShadowZeroEvidenceLedgerBase & {
  schema_version: TSchema;
  purpose: TPurpose;
} {
  const body = {
    schema_version: schemaVersion,
    captured_at: source.captured_at,
    channel: WALMART_SHADOW_LISTING_CHANNEL,
    mode: "ZERO_EVIDENCE" as const,
    purpose,
    published_catalog: publishedBinding(source),
    entries: [] as [],
  };
  const bodySha256 = walmartShadowCanonicalSha256(body);
  return {
    ...body,
    ledger_id: `${idPrefix}-${bodySha256.slice(0, 16)}`,
    body_sha256: bodySha256,
  };
}

function sealPriorVisualSource(
  published: WalmartShadowPublishedCatalogSource,
  ledger: WalmartShadowPriorVisualZeroEvidenceLedger,
): WalmartShadowPriorVisualSource {
  const body = {
    schema_version: WALMART_SHADOW_PRIOR_VISUAL_SOURCE_SCHEMA,
    captured_at: published.captured_at,
    channel: WALMART_SHADOW_LISTING_CHANNEL,
    published_population_complete: true as const,
    cutoff_at: published.captured_at,
    source_bindings: {
      published_catalog: publishedBinding(published),
      evidence_ledger: {
        schema_version: ledger.schema_version,
        ledger_id: ledger.ledger_id,
        body_sha256: ledger.body_sha256,
        captured_at: ledger.captured_at,
        mode: ledger.mode,
      },
    },
    source_reconciliation: {
      population_rows: published.rows.length,
      ledger_entries: 0,
      evidence_accepted: 0,
      evidence_rejected: 0,
      output_rows: published.rows.length,
      duplicate_listing_keys: 0 as const,
      conflicting_evidence: 0 as const,
      malformed_evidence: 0 as const,
    },
    rows: published.rows.map((row) => ({
      channel: row.channel,
      store_index: row.store_index,
      sku: row.sku,
      listing_key: row.listing_key,
      verdict: "NOT_AUDITED" as const,
      label: null,
    })),
  };
  const bodySha256 = walmartShadowCanonicalSha256(body);
  return {
    ...body,
    snapshot_id: `walmart-shadow-prior-visual-${bodySha256.slice(0, 16)}`,
    body_sha256: bodySha256,
  };
}

function sealRemediationSource(
  published: WalmartShadowPublishedCatalogSource,
  ledger: WalmartShadowRemediationZeroEvidenceLedger,
): WalmartShadowRemediationSource {
  const body = {
    schema_version: WALMART_SHADOW_REMEDIATION_SOURCE_SCHEMA,
    captured_at: published.captured_at,
    channel: WALMART_SHADOW_LISTING_CHANNEL,
    published_population_complete: true as const,
    cutoff_at: published.captured_at,
    source_bindings: {
      published_catalog: publishedBinding(published),
      evidence_ledger: {
        schema_version: ledger.schema_version,
        ledger_id: ledger.ledger_id,
        body_sha256: ledger.body_sha256,
        captured_at: ledger.captured_at,
        mode: ledger.mode,
      },
    },
    source_reconciliation: {
      population_rows: published.rows.length,
      ledger_entries: 0,
      evidence_accepted: 0,
      evidence_rejected: 0,
      output_rows: published.rows.length,
      duplicate_listing_keys: 0 as const,
      conflicting_evidence: 0 as const,
      malformed_evidence: 0 as const,
    },
    rows: published.rows.map((row) => ({
      channel: row.channel,
      store_index: row.store_index,
      sku: row.sku,
      listing_key: row.listing_key,
      status: "NOT_APPLIED" as const,
      verification: null,
    })),
  };
  const bodySha256 = walmartShadowCanonicalSha256(body);
  return {
    ...body,
    snapshot_id: `walmart-shadow-remediation-${bodySha256.slice(0, 16)}`,
    body_sha256: bodySha256,
  };
}

/**
 * Integrity-only deterministic projection from an already supplied PUBLISHED
 * bridge. This function does not authenticate that bridge. Operational code
 * must first establish ITEM-capture provenance and should use
 * verifyWalmartShadowZeroEvidenceSourcesAgainstItemReportCapture below.
 */
export function compileWalmartShadowZeroEvidenceSources(
  publishedCatalogInput: unknown,
): WalmartShadowZeroEvidenceSources {
  const published = verifyWalmartShadowPublishedCatalogSource(publishedCatalogInput);
  const priorVisualLedger = sealLedger(
    WALMART_SHADOW_PRIOR_VISUAL_ZERO_LEDGER_SCHEMA,
    "PRIOR_VISUAL_SELECTION_EVIDENCE",
    "walmart-shadow-prior-visual-zero-ledger",
    published,
  );
  const remediationLedger = sealLedger(
    WALMART_SHADOW_REMEDIATION_ZERO_LEDGER_SCHEMA,
    "REMEDIATION_SELECTION_EVIDENCE",
    "walmart-shadow-remediation-zero-ledger",
    published,
  );
  const sources = {
    prior_visual_ledger: priorVisualLedger,
    remediation_ledger: remediationLedger,
    prior_visual_source: sealPriorVisualSource(published, priorVisualLedger),
    remediation_source: sealRemediationSource(published, remediationLedger),
  };
  verifyWalmartShadowPriorVisualSource(sources.prior_visual_source);
  verifyWalmartShadowRemediationSource(sources.remediation_source);
  return sources;
}

/**
 * Integrity-only verifier relative to the supplied PUBLISHED bridge: rebuilds
 * both ledgers and both sources from that exact population. A forged and fully
 * resealed QUALIFIED/BAD/APPLIED row cannot pass against a fixed bridge, but
 * this function does not authenticate the bridge itself. Operational code
 * should use the ITEM-capture-aware verifier below.
 */
export function verifyWalmartShadowZeroEvidenceSourcesAgainstPublishedCatalog(
  rawSources: unknown,
  publishedCatalogInput: unknown,
): WalmartShadowZeroEvidenceSources {
  const expected = compileWalmartShadowZeroEvidenceSources(publishedCatalogInput);
  if (canonicalWalmartShadowJson(rawSources) !== canonicalWalmartShadowJson(expected)) {
    throw new Error(
      "zero-evidence ledgers/sources do not exactly match deterministic compilation from the PUBLISHED catalog",
    );
  }
  return expected;
}

/**
 * Recommended operational verifier. It first rebuilds the PUBLISHED bridge
 * from the raw ITEM capture plus separately trusted atomic-exchange context,
 * then deterministically rebuilds the zero-evidence ledgers and sources.
 */
export function verifyWalmartShadowZeroEvidenceSourcesAgainstItemReportCapture(
  rawSources: unknown,
  publishedCatalogInput: unknown,
  itemReportSourceInput: unknown,
  itemReportCaptureInput: unknown,
  itemReportContextInput: WalmartItemReportCompileContext,
): WalmartShadowZeroEvidenceSources {
  const published = verifyWalmartShadowPublishedCatalogSourceAgainstItemReportCapture(
    publishedCatalogInput,
    itemReportSourceInput,
    itemReportCaptureInput,
    itemReportContextInput,
  );
  return verifyWalmartShadowZeroEvidenceSourcesAgainstPublishedCatalog(
    rawSources,
    published,
  );
}
