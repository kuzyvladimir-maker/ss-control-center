/**
 * Provenance for marketplace-facing package weight and dimensions.
 *
 * Cooler capacity, carrier pricing weights, and box presets are planning
 * inputs. They are not evidence of the packed item's actual measurements.
 * Marketplace payloads may use physical attributes only when the record says
 * where the numbers came from, and there are exactly two honest answers:
 *
 *   OPERATOR_SHIP_SPECS      — a human measured the packed box. Strongest.
 *   STUDIO_NET_MASS_ESTIMATE — derived from the manufacturer's declared net
 *                              mass plus the studio lane's tare and box
 *                              allowances (walmart-studio-listing.ts). Honest
 *                              about being an estimate, and the value we
 *                              actually declare on a buy-to-order multipack.
 *
 * Operator measurements always overwrite an estimate; a caller that needs a
 * human measurement checks `source` rather than merely a non-null result.
 */

import type { ChannelSKU } from "@/generated/prisma/client";

export const VERIFIED_PHYSICAL_PACKAGE_SCHEMA =
  "bundle-factory.verified-physical-package/v1" as const;

export type PhysicalPackageSpecSource =
  | "OPERATOR_SHIP_SPECS"
  | "STUDIO_NET_MASS_ESTIMATE";

export const PHYSICAL_PACKAGE_SPEC_SOURCES: readonly PhysicalPackageSpecSource[] = [
  "OPERATOR_SHIP_SPECS",
  "STUDIO_NET_MASS_ESTIMATE",
];

export interface VerifiedPhysicalPackageSpecs {
  schema_version: typeof VERIFIED_PHYSICAL_PACKAGE_SCHEMA;
  source: PhysicalPackageSpecSource;
  verified_at: string;
  weight_oz: number;
  length_in: number;
  width_in: number;
  height_in: number;
}

type PhysicalSkuFields = Pick<
  ChannelSKU,
  | "package_weight_oz"
  | "package_length_in"
  | "package_width_in"
  | "package_height_in"
>;

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveFinite(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function packagingObject(value: string | null | undefined): Record<string, unknown> {
  if (!value?.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return record(parsed) ?? {};
  } catch {
    return {};
  }
}

/** Read a verified measurement set from MasterBundle.packaging_spec. Invalid,
 * legacy, or merely calculated package data is deliberately treated as absent. */
export function parseVerifiedPhysicalPackageSpecs(
  packagingSpec: string | null | undefined,
): VerifiedPhysicalPackageSpecs | null {
  const raw = record(packagingObject(packagingSpec).verified_physical_package);
  if (
    !raw ||
    raw.schema_version !== VERIFIED_PHYSICAL_PACKAGE_SCHEMA ||
    !PHYSICAL_PACKAGE_SPEC_SOURCES.includes(raw.source as PhysicalPackageSpecSource) ||
    typeof raw.verified_at !== "string" ||
    !Number.isFinite(Date.parse(raw.verified_at))
  ) {
    return null;
  }
  const weight = positiveFinite(raw.weight_oz);
  const length = positiveFinite(raw.length_in);
  const width = positiveFinite(raw.width_in);
  const height = positiveFinite(raw.height_in);
  if (
    weight == null ||
    weight > 70 * 16 ||
    length == null ||
    length > 108 ||
    width == null ||
    width > 108 ||
    height == null ||
    height > 108
  ) {
    return null;
  }
  return {
    schema_version: VERIFIED_PHYSICAL_PACKAGE_SCHEMA,
    source: raw.source as PhysicalPackageSpecSource,
    verified_at: raw.verified_at,
    weight_oz: weight,
    length_in: length,
    width_in: width,
    height_in: height,
  };
}

/** Merge a newly measured operator set without discarding cooler/pricing
 *  metadata. */
export function withVerifiedPhysicalPackageSpecs(
  packagingSpec: string | null | undefined,
  measured: Omit<
    VerifiedPhysicalPackageSpecs,
    "schema_version" | "source" | "verified_at"
  >,
  verifiedAt = new Date(),
  source: PhysicalPackageSpecSource = "OPERATOR_SHIP_SPECS",
): string {
  const values = [
    measured.weight_oz,
    measured.length_in,
    measured.width_in,
    measured.height_in,
  ];
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error("Verified physical package values must be positive finite numbers.");
  }
  const verified: VerifiedPhysicalPackageSpecs = {
    ...measured,
    schema_version: VERIFIED_PHYSICAL_PACKAGE_SCHEMA,
    source,
    verified_at: verifiedAt.toISOString(),
  };
  let prior: Record<string, unknown> = {};
  if (packagingSpec?.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(packagingSpec) as unknown;
    } catch {
      throw new Error(
        "Cannot merge verified physical package values into malformed packaging_spec.",
      );
    }
    const parsedRecord = record(parsed);
    if (!parsedRecord) {
      throw new Error(
        "Cannot merge verified physical package values into non-object packaging_spec.",
      );
    }
    prior = parsedRecord;
  }
  // Reuse the parser as the single limits/schema gate before persistence.
  const merged = {
    ...prior,
    verified_physical_package: verified,
  };
  const serialized = JSON.stringify(merged);
  if (!parseVerifiedPhysicalPackageSpecs(serialized)) {
    throw new Error("Verified physical package values exceed supported carrier limits.");
  }
  return serialized;
}

export function physicalPackageFields(
  specs: VerifiedPhysicalPackageSpecs,
): Required<PhysicalSkuFields> {
  return {
    package_weight_oz: specs.weight_oz,
    package_length_in: specs.length_in,
    package_width_in: specs.width_in,
    package_height_in: specs.height_in,
  };
}

/** A measurement proof belongs to the exact persisted SKU values. Any drift is
 * a hard stop rather than permission to silently replace one side. */
export function physicalPackageSpecsMatchSku(
  sku: PhysicalSkuFields,
  specs: VerifiedPhysicalPackageSpecs,
): boolean {
  return (
    sku.package_weight_oz === specs.weight_oz &&
    sku.package_length_in === specs.length_in &&
    sku.package_width_in === specs.width_in &&
    sku.package_height_in === specs.height_in
  );
}
