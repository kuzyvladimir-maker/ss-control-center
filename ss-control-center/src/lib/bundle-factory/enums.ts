/**
 * Bundle Factory enum-like value sets.
 *
 * SQLite + Prisma 7 do not support native `enum` types, so the schema stores
 * these as `String` fields. This module is the single source of truth for the
 * allowed values, mirrored from docs/BUNDLE_FACTORY_DATA_MODEL.md.
 *
 * Use the exported tuples to:
 *   - validate API inputs at runtime (`LIFECYCLE_STATES.includes(value)`)
 *   - drive UI dropdowns
 *   - get a literal-union TS type via `typeof TUPLE[number]`
 */

export const LIFECYCLE_STATES = [
  "DRAFT",
  "RESEARCHED",
  "VARIATION_SELECTED",
  "GENERATED",
  // Phase 2.3 Stage 5 — transient while OpenAI image pipeline is in flight,
  // and the terminal Stage 5 status once every CAN_PUBLISH channel has either
  // a compliant image or has been routed to the manual_review queue.
  "IMAGE_GENERATING",
  "IMAGE_GENERATED",
  "APPROVED",
  "QUEUED",
  "SUBMITTED",
  "PROCESSING",
  "LIVE",
  "ERROR",
  "SUSPENDED",
  "SUNSET_REQUESTED",
  "ARCHIVED",
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const PRODUCT_CATEGORIES = [
  "FROZEN_GROCERY",
  "REFRIGERATED",
  "SHELF_STABLE",
  "PET_FOOD",
  "HEALTH_BEAUTY",
  "BABY",
  "OTHER",
] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

export const SALES_CHANNELS = [
  "AMAZON_PERSONAL",
  "AMAZON_SALUTEM",
  "AMAZON_AMZCOM",
  "AMAZON_SIRIUS",
  "AMAZON_RETAILER",
  "WALMART",
  "EBAY",
  "TIKTOK_1",
  "TIKTOK_2",
] as const;
export type SalesChannel = (typeof SALES_CHANNELS)[number];

export const COMPOSITION_TYPES = [
  "SINGLE_FLAVOR",
  "MIXED_FLAVOR",
  "USE_CASE",
  "HOLIDAY_THEMED",
  "CROSS_BRAND",
] as const;
export type CompositionType = (typeof COMPOSITION_TYPES)[number];

export const PIPELINE_STAGES = [
  "BRIEF",
  "RESEARCH",
  "VARIATION_MATRIX",
  "CONTENT_GENERATION",
  "IMAGE_GENERATION",
  "VALIDATION",
  "DISTRIBUTION",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const STAGE_STATUSES = [
  "PENDING",
  "IN_PROGRESS",
  "COMPLETED",
  "FAILED",
  "SKIPPED",
] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const ERROR_CATEGORIES = [
  "MISSING_REQUIRED_ATTRIBUTE",
  "TITLE_LENGTH_EXCEEDED",
  "BANNED_WORD",
  "IMAGE_URL_INACCESSIBLE",
  "DUPLICATE_GTIN",
  "INVALID_BROWSE_NODE",
  "POLICY_VIOLATION_BRAND",
  "POLICY_VIOLATION_BUNDLE",
  "COMPLIANCE_GROCERY",
  "COMPLIANCE_FROZEN",
  "UNKNOWN",
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export const UPC_STATUSES = [
  "AVAILABLE",
  "RESERVED",
  "ASSIGNED",
  "RETIRED",
  "INVALID",
] as const;
export type UPCStatus = (typeof UPC_STATUSES)[number];

export const STORE_TYPES = [
  "SUPERCENTER",
  "NEIGHBORHOOD_MARKET",
  "WAREHOUSE_CLUB",
  "STANDARD_GROCERY",
  "DEPARTMENT_STORE",
  "DISCOUNT_GROCERY",
  "PREMIUM_GROCERY",
  "SPECIALTY",
] as const;
export type StoreType = (typeof STORE_TYPES)[number];

export const STORE_TIERS = [
  "TIER_1",
  "TIER_2",
  "TIER_3",
  "TIER_4",
  "TIER_5",
] as const;
export type StoreTier = (typeof STORE_TIERS)[number];

export const GTIN_EXEMPTION_STATUSES = [
  "NOT_REQUESTED",
  "PENDING_APPLICATION",
  "UNDER_REVIEW",
  "APPROVED",
  "DENIED",
] as const;
export type GTINExemptionStatus = (typeof GTIN_EXEMPTION_STATUSES)[number];

/** Type-narrowing helper. Returns true and narrows when v ∈ allowed. */
export function isOneOf<T extends string>(
  allowed: readonly T[],
  v: unknown
): v is T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v);
}
