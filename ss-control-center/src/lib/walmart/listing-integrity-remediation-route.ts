import {
  walmartListingIntegrityControlSha256,
} from "./listing-integrity-control-plane";

export const WALMART_LISTING_INTEGRITY_REMEDIATION_ROUTE_SCHEMA =
  "walmart-listing-integrity-remediation-route/v1" as const;

export type WalmartListingIntegrityAutomaticRepairRoute =
  | "DESCRIPTION_BULLETS"
  | "NON_IMAGE"
  | "DESCRIPTION_BULLETS_MAIN"
  | "DESCRIPTION_BULLETS_MAIN_GALLERY";

export interface WalmartListingIntegrityRemediationRoute {
  schema_version: typeof WALMART_LISTING_INTEGRITY_REMEDIATION_ROUTE_SCHEMA;
  listing_key: string;
  sku: string;
  diagnosis_body_sha256: string;
  status: "AUTOMATIC_ROUTE_READY" | "MANUAL_REVIEW_REQUIRED";
  route: WalmartListingIntegrityAutomaticRepairRoute | null;
  changed_fields: Array<
    "title" | "description" | "bullets" | "attributes" | "main" | "gallery"
  >;
  proven_defects: string[];
  blockers: string[];
  safeguards: {
    product_truth_required: true;
    candidate_qualification_required: true;
    exact_owner_package_required: true;
    one_sku_permit_required: true;
    walmart_write_authorized: false;
    price_inventory_repricing_delist_unchanged: true;
    automatic_retry_allowed: false;
    automatic_replay_allowed: false;
  };
  body_sha256: string;
}

/**
 * Temporary owner policy can defer every image-changing route while leaving
 * the already-supported DESCRIPTION_BULLETS route available. The decision is
 * derived only from the sealed route's exact changed-field set.
 */
export function walmartListingIntegrityRouteIsDeferredImageRepair(input: {
  route: WalmartListingIntegrityRemediationRoute;
  defer_image_repairs: boolean;
}): boolean {
  return input.defer_image_repairs
    && input.route.changed_fields.some((field) => field === "main" || field === "gallery");
}

type JsonRecord = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(`WALMART_REMEDIATION_ROUTE_INVALID: ${message}`);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactText(value: unknown, label: string, maximum = 768): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be bounded exact text`);
  }
  return value;
}

function exactSha(value: unknown, label: string): string {
  const parsed = exactText(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) fail(`${label} must be lowercase SHA-256`);
  return parsed;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is string => typeof row === "string" && row.length > 0);
}

function verdict(value: JsonRecord, label: string): "PASS" | "REVIEW" | "BAD" {
  if (value.verdict !== "PASS" && value.verdict !== "REVIEW" && value.verdict !== "BAD") {
    fail(`${label}.verdict is unsupported`);
  }
  return value.verdict;
}

function hardFailures(value: JsonRecord): string[] {
  return strings(value.hard_failures);
}

function mainSupportsTextOnly(main: JsonRecord): boolean {
  if (hardFailures(main).length) return false;
  const checks = record(main.checks, "main_decision.checks");
  const packageFacts = record(checks.package_facts, "main_decision.checks.package_facts");
  return checks.external_quantity === "MATCH"
    && checks.single_package_per_cell === "MATCH"
    && checks.front === "MATCH"
    && checks.background === "MATCH"
    && checks.no_mixed_product === "MATCH"
    && packageFacts.net_content === "MATCH";
}

function textChecks(text: JsonRecord): JsonRecord {
  return record(text.checks, "text_decision.checks");
}

function textRequiresSeparateRoute(text: JsonRecord): string[] {
  const checks = textChecks(text);
  const blockers: string[] = [];
  if (checks.title_identity === "MISMATCH"
    || checks.title_outer_units === "MISMATCH"
    || checks.title_package_facts === "MISMATCH") {
    blockers.push("TITLE_CHANGE_REQUIRES_SEPARATE_REVIEWED_ROUTE");
  }
  if (checks.attributes_identity === "MISMATCH"
    || checks.attributes_outer_units === "MISMATCH"
    || checks.attributes_package_facts === "MISMATCH") {
    blockers.push("ATTRIBUTE_CHANGE_REQUIRES_SEPARATE_REVIEWED_ROUTE");
  }
  return blockers;
}

function fieldNeedsRepair(value: unknown, expectedOuterUnits: number): boolean {
  return value !== "MATCH"
    && !(expectedOuterUnits === 1 && value === "NOT_APPLICABLE");
}

function nonImageChangedFields(input: {
  text: JsonRecord;
  expected_outer_units: number;
}): WalmartListingIntegrityRemediationRoute["changed_fields"] {
  const checks = textChecks(input.text);
  const fields: WalmartListingIntegrityRemediationRoute["changed_fields"] = [];
  if ([
    checks.title_identity,
    checks.title_outer_units,
    checks.title_package_facts,
  ].some((value) => fieldNeedsRepair(value, input.expected_outer_units))) {
    fields.push("title");
  }
  if ([
    checks.body_identity,
    checks.body_outer_units,
    checks.body_package_facts,
  ].some((value) => fieldNeedsRepair(value, input.expected_outer_units))) {
    fields.push("description", "bullets");
  }
  if (checks.attributes_identity === "MISMATCH"
    || fieldNeedsRepair(checks.attributes_outer_units, input.expected_outer_units)
    || checks.attributes_package_facts === "MISMATCH") {
    fields.push("attributes");
  }
  return fields;
}

function gallerySupportsNonImage(rows: JsonRecord[]): boolean {
  return rows.every((row) => verdict(row, "gallery_decision") !== "BAD"
    && hardFailures(row).length === 0
    && !row.technical_error
    && !row.missing_reason);
}

function seal(
  body: Omit<WalmartListingIntegrityRemediationRoute, "body_sha256">,
): WalmartListingIntegrityRemediationRoute {
  return Object.freeze({
    ...body,
    changed_fields: Object.freeze([...body.changed_fields]) as typeof body.changed_fields,
    proven_defects: Object.freeze([...body.proven_defects]) as string[],
    blockers: Object.freeze([...body.blockers]) as string[],
    safeguards: Object.freeze({ ...body.safeguards }),
    body_sha256: walmartListingIntegrityControlSha256(body),
  });
}

/**
 * Select only repair routes already supported by the frozen surgical engine.
 * REVIEW is never silently treated as PASS, and a title/attribute mismatch is
 * never hidden inside a description/image repair.
 */
export function compileWalmartListingIntegrityRemediationRoute(input: {
  diagnosis: unknown;
  expected_listing_key: string;
  expected_sku: string;
}): WalmartListingIntegrityRemediationRoute {
  const diagnosis = record(input.diagnosis, "diagnosis");
  if (diagnosis.schema_version !== "walmart-listing-single-process-report/v1") {
    fail("diagnosis schema differs");
  }
  const claimedBodySha = exactSha(diagnosis.body_sha256, "diagnosis.body_sha256");
  const diagnosisBody = { ...diagnosis };
  delete diagnosisBody.body_sha256;
  if (walmartListingIntegrityControlSha256(diagnosisBody) !== claimedBodySha) {
    fail("diagnosis body seal differs");
  }
  const listingKey = exactText(diagnosis.listing_key, "diagnosis.listing_key");
  const detector = record(diagnosis.detector_input, "diagnosis.detector_input");
  const listing = record(detector.listing, "diagnosis.detector_input.listing");
  const sku = exactText(listing.sku, "diagnosis.detector_input.listing.sku", 500);
  if (listingKey !== input.expected_listing_key
    || listing.listing_key !== input.expected_listing_key
    || sku !== input.expected_sku) {
    fail("diagnosis listing identity differs from the active control item");
  }
  const outcome = record(diagnosis.outcome, "diagnosis.outcome");
  const report = record(diagnosis.detector_report, "diagnosis.detector_report");
  if ((outcome.status !== "BAD" && outcome.status !== "REVIEW")
    || (report.overall_verdict !== "BAD" && report.overall_verdict !== "REVIEW")) {
    fail("only an exact BAD or REVIEW diagnosis can enter repair routing");
  }
  const text = record(report.text_decision, "detector_report.text_decision");
  const main = record(report.main_decision, "detector_report.main_decision");
  const galleryRaw = report.gallery_decisions;
  if (!Array.isArray(galleryRaw) || galleryRaw.length < 1) {
    fail("gallery decisions must be a non-empty array");
  }
  const gallery = galleryRaw.map((row, index) => record(row, `gallery_decisions[${index}]`));
  verdict(text, "text_decision");
  const mainVerdict = verdict(main, "main_decision");
  const galleryVerdicts = gallery.map((row, index) => verdict(row, `gallery_decisions[${index}]`));
  const provenDefects = [
    ...strings(outcome.blockers),
    ...strings(report.blocking_reasons),
    ...hardFailures(text).map((row) => `TEXT: ${row}`),
    ...hardFailures(main).map((row) => `MAIN: ${row}`),
    ...gallery.flatMap((row, index) => hardFailures(row).map(
      (failure) => `GALLERY_${index + 1}: ${failure}`,
    )),
  ].filter((row, index, rows) => rows.indexOf(row) === index);
  const blockers = [
    ...gallery.filter((row) => row.technical_error || row.missing_reason).map(
      (_, index) => `GALLERY_${index + 1}_EVIDENCE_INCOMPLETE`,
    ),
  ].filter((row, index, rows) => rows.indexOf(row) === index);

  let route: WalmartListingIntegrityAutomaticRepairRoute | null = null;
  let changedFields: WalmartListingIntegrityRemediationRoute["changed_fields"] = [];
  const galleryBad = galleryVerdicts.includes("BAD")
    || gallery.some((row) => hardFailures(row).length > 0);
  const mainBad = mainVerdict === "BAD" || hardFailures(main).length > 0;
  const expected = record(detector.expected, "diagnosis.detector_input.expected");
  const expectedOuterUnits = Number(expected.outer_units);
  if (!Number.isSafeInteger(expectedOuterUnits) || expectedOuterUnits < 1) {
    fail("diagnosis expected outer_units is invalid");
  }
  const nonImageFields = nonImageChangedFields({
    text,
    expected_outer_units: expectedOuterUnits,
  });
  const separateRouteBlockers = textRequiresSeparateRoute(text);
  if ((galleryBad || mainBad) && separateRouteBlockers.length) {
    blockers.push(...separateRouteBlockers);
  }
  if (!blockers.length && galleryBad) {
    route = "DESCRIPTION_BULLETS_MAIN_GALLERY";
    changedFields = ["description", "bullets", "main", "gallery"];
  } else if (!blockers.length && mainBad) {
    route = "DESCRIPTION_BULLETS_MAIN";
    changedFields = ["description", "bullets", "main"];
  } else if (!blockers.length && nonImageFields.length > 0
    && mainSupportsTextOnly(main) && gallerySupportsNonImage(gallery)) {
    changedFields = nonImageFields;
    route = changedFields.length === 2
        && changedFields[0] === "description" && changedFields[1] === "bullets"
      ? "DESCRIPTION_BULLETS"
      : "NON_IMAGE";
  } else if (!blockers.length) {
    blockers.push("NO_FROZEN_SURGICAL_ROUTE_PROVES_THE_REQUIRED_CHANGE");
  }
  if (route && !provenDefects.length) {
    blockers.push("BAD_DIAGNOSIS_HAS_NO_EXACT_PROVEN_DEFECT");
    route = null;
    changedFields = [];
  }
  return seal({
    schema_version: WALMART_LISTING_INTEGRITY_REMEDIATION_ROUTE_SCHEMA,
    listing_key: listingKey,
    sku,
    diagnosis_body_sha256: claimedBodySha,
    status: route ? "AUTOMATIC_ROUTE_READY" : "MANUAL_REVIEW_REQUIRED",
    route,
    changed_fields: changedFields,
    proven_defects: provenDefects,
    blockers,
    safeguards: {
      product_truth_required: true,
      candidate_qualification_required: true,
      exact_owner_package_required: true,
      one_sku_permit_required: true,
      walmart_write_authorized: false,
      price_inventory_repricing_delist_unchanged: true,
      automatic_retry_allowed: false,
      automatic_replay_allowed: false,
    },
  });
}
