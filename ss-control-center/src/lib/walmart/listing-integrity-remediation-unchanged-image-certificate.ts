/**
 * Evidence-only certificate for a repair that does not write MAIN or gallery.
 *
 * Image-changing repairs still require the full source/rights/vision certificate.
 * This smaller certificate proves that the target repeats the exact baseline
 * image projection, so the surgical payload must omit every image field.
 */

import {
  walmartListingIntegritySha256,
} from "./listing-integrity-audit.ts";
import type {
  SealedWalmartListingRepairPlan,
  WalmartListingRepairTargetImage,
} from "./listing-integrity-remediation-qualification.ts";

export const WALMART_LISTING_REPAIR_UNCHANGED_IMAGE_CERTIFICATE_SCHEMA =
  "walmart-listing-repair-unchanged-image-certificate/v1" as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_CERTIFICATE_TTL_MS = 24 * 60 * 60 * 1_000;

type JsonRecord = Record<string, unknown>;

export interface SealedWalmartListingRepairUnchangedImageCertificate {
  schema_version:
    typeof WALMART_LISTING_REPAIR_UNCHANGED_IMAGE_CERTIFICATE_SCHEMA;
  certificate_id: string;
  created_at: string;
  expires_at: string;
  plan: {
    plan_id: string;
    plan_body_sha256: string;
    target_sha256: string;
    baseline_images_sha256: string;
  };
  listing: {
    channel: "WALMART_US";
    store_index: number;
    sku: string;
    listing_key: string;
    item_id: string;
  };
  frozen_review: {
    compilation_request_file_sha256: string;
    compilation_request_body_sha256: string;
    proposal_file_sha256: string;
    review_certification_file_sha256: string;
  };
  images: WalmartListingRepairTargetImage[];
  policy: {
    images_changed: false;
    main_write_allowed: false;
    gallery_write_allowed: false;
    exact_baseline_target_equality_verified: true;
    image_bytes_bound_by_sha256: true;
    authority: "EVIDENCE_ONLY_NOT_WRITE_AUTHORITY";
    owner_permit_must_bind_certificate_sha256: true;
  };
  body_sha256: string;
}

function fail(message: string): never {
  throw new Error(`Walmart unchanged-image certificate rejected: ${message}`);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function text(value: unknown, label: string, maximum = 4_096): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be a non-empty exact string`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  if (!SHA256.test(parsed)) fail(`${label} must be lowercase SHA-256`);
  return parsed;
}

function instant(value: unknown, label: string): string {
  const parsed = text(value, label, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(parsed)
    || new Date(parsed).toISOString() !== parsed) {
    fail(`${label} must be canonical UTC milliseconds`);
  }
  return parsed;
}

function exactImages(
  value: unknown,
  label: string,
): WalmartListingRepairTargetImage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    fail(`${label} must contain 1..20 images`);
  }
  return value.map((entry, index) => {
    const row = record(entry, `${label}[${index}]`);
    const keys = Object.keys(row).sort();
    if (keys.join(",") !== "sha256,slot,source_url") {
      fail(`${label}[${index}] has missing or extra fields`);
    }
    const expectedSlot = index === 0 ? "main" : `gallery-${index}`;
    if (row.slot !== expectedSlot) {
      fail(`${label} must be ordered main, gallery-1..N`);
    }
    const sourceUrl = text(row.source_url, `${label}[${index}].source_url`);
    let parsed: URL;
    try {
      parsed = new URL(sourceUrl);
    } catch {
      return fail(`${label}[${index}].source_url must be absolute`);
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password
      || parsed.search || parsed.hash || parsed.toString() !== sourceUrl) {
      fail(`${label}[${index}].source_url must be canonical query-free HTTPS`);
    }
    return {
      slot: expectedSlot as WalmartListingRepairTargetImage["slot"],
      source_url: sourceUrl,
      sha256: digest(row.sha256, `${label}[${index}].sha256`),
    };
  });
}

function verifyBody(
  raw: JsonRecord,
  plan: SealedWalmartListingRepairPlan,
  at: Date,
): SealedWalmartListingRepairUnchangedImageCertificate {
  const planBody = { ...plan } as unknown as JsonRecord;
  delete planBody.body_sha256;
  if (!SHA256.test(plan.body_sha256)
    || walmartListingIntegritySha256(planBody) !== plan.body_sha256) {
    fail("repair plan body SHA mismatch");
  }
  if (raw.schema_version
      !== WALMART_LISTING_REPAIR_UNCHANGED_IMAGE_CERTIFICATE_SCHEMA) {
    fail("schema_version is unsupported");
  }
  const claimedBodySha = digest(raw.body_sha256, "body_sha256");
  const body = { ...raw };
  delete body.body_sha256;
  if (walmartListingIntegritySha256(body) !== claimedBodySha) {
    fail("body SHA mismatch");
  }
  const createdAt = instant(raw.created_at, "created_at");
  const expiresAt = instant(raw.expires_at, "expires_at");
  const createdMs = Date.parse(createdAt);
  const expiresMs = Date.parse(expiresAt);
  const atMs = at.getTime();
  if (expiresMs <= createdMs || expiresMs - createdMs > MAX_CERTIFICATE_TTL_MS
    || atMs < createdMs || atMs >= expiresMs
    || createdMs < Date.parse(plan.created_at)
    || expiresMs > Date.parse(plan.expires_at)) {
    fail("certificate is stale, future, too wide, or outside the plan");
  }
  const planBinding = record(raw.plan, "plan");
  if (planBinding.plan_id !== plan.plan_id
    || planBinding.plan_body_sha256 !== plan.body_sha256
    || planBinding.target_sha256 !== plan.target.target_sha256
    || planBinding.baseline_images_sha256 !== plan.baseline.images_sha256) {
    fail("plan binding differs from the exact repair plan");
  }
  const listing = record(raw.listing, "listing");
  if (listing.channel !== plan.listing.channel
    || listing.store_index !== plan.listing.store_index
    || listing.sku !== plan.listing.sku
    || listing.listing_key !== plan.listing.listing_key
    || listing.item_id !== plan.listing.item_id) {
    fail("listing binding differs from the exact repair plan");
  }
  const review = record(raw.frozen_review, "frozen_review");
  for (const field of [
    "compilation_request_file_sha256",
    "compilation_request_body_sha256",
    "proposal_file_sha256",
    "review_certification_file_sha256",
  ]) {
    digest(review[field], `frozen_review.${field}`);
  }
  const images = exactImages(raw.images, "images");
  if (plan.changed_fields.includes("main") || plan.changed_fields.includes("gallery")) {
    fail("unchanged-image certificate cannot authorize an image-changing plan");
  }
  if (walmartListingIntegritySha256(images) !== plan.baseline.images_sha256
    || walmartListingIntegritySha256(images)
      !== walmartListingIntegritySha256(plan.target.images)) {
    fail("baseline and target image projections are not byte-identical");
  }
  const policy = record(raw.policy, "policy");
  if (policy.images_changed !== false
    || policy.main_write_allowed !== false
    || policy.gallery_write_allowed !== false
    || policy.exact_baseline_target_equality_verified !== true
    || policy.image_bytes_bound_by_sha256 !== true
    || policy.authority !== "EVIDENCE_ONLY_NOT_WRITE_AUTHORITY"
    || policy.owner_permit_must_bind_certificate_sha256 !== true) {
    fail("policy differs from the exact unchanged-image contract");
  }
  return raw as unknown as SealedWalmartListingRepairUnchangedImageCertificate;
}

export function certifyWalmartListingRepairUnchangedImages(input: {
  plan: SealedWalmartListingRepairPlan;
  created_at: string;
  expires_at: string;
  compilation_request_file_sha256: string;
  compilation_request_body_sha256: string;
  proposal_file_sha256: string;
  review_certification_file_sha256: string;
  baseline_images: WalmartListingRepairTargetImage[];
}): SealedWalmartListingRepairUnchangedImageCertificate {
  const createdAt = instant(input.created_at, "created_at");
  const body = {
    schema_version:
      WALMART_LISTING_REPAIR_UNCHANGED_IMAGE_CERTIFICATE_SCHEMA,
    certificate_id:
      `unchanged-images-${input.plan.listing.store_index}-${input.plan.listing.sku}-`
        + `${input.plan.body_sha256.slice(0, 16)}`,
    created_at: createdAt,
    expires_at: instant(input.expires_at, "expires_at"),
    plan: {
      plan_id: input.plan.plan_id,
      plan_body_sha256: input.plan.body_sha256,
      target_sha256: input.plan.target.target_sha256,
      baseline_images_sha256: input.plan.baseline.images_sha256,
    },
    listing: {
      channel: input.plan.listing.channel,
      store_index: input.plan.listing.store_index,
      sku: input.plan.listing.sku,
      listing_key: input.plan.listing.listing_key,
      item_id: input.plan.listing.item_id,
    },
    frozen_review: {
      compilation_request_file_sha256: digest(
        input.compilation_request_file_sha256,
        "compilation_request_file_sha256",
      ),
      compilation_request_body_sha256: digest(
        input.compilation_request_body_sha256,
        "compilation_request_body_sha256",
      ),
      proposal_file_sha256: digest(
        input.proposal_file_sha256,
        "proposal_file_sha256",
      ),
      review_certification_file_sha256: digest(
        input.review_certification_file_sha256,
        "review_certification_file_sha256",
      ),
    },
    images: exactImages(input.baseline_images, "baseline_images"),
    policy: {
      images_changed: false as const,
      main_write_allowed: false as const,
      gallery_write_allowed: false as const,
      exact_baseline_target_equality_verified: true as const,
      image_bytes_bound_by_sha256: true as const,
      authority: "EVIDENCE_ONLY_NOT_WRITE_AUTHORITY" as const,
      owner_permit_must_bind_certificate_sha256: true as const,
    },
  };
  const sealed = {
    ...body,
    body_sha256: walmartListingIntegritySha256(body),
  };
  return verifyBody(sealed, input.plan, new Date(createdAt));
}

export function verifyWalmartListingRepairUnchangedImageCertificateBytes(input: {
  certificate_bytes: Uint8Array;
  plan: SealedWalmartListingRepairPlan;
  at: Date;
}): SealedWalmartListingRepairUnchangedImageCertificate {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      input.certificate_bytes,
    ));
  } catch {
    return fail("certificate bytes must be exact UTF-8 JSON");
  }
  return verifyBody(record(value, "certificate"), input.plan, input.at);
}
