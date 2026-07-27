/**
 * Conservative, read-only contradiction detector for a live Walmart listing
 * whose canonical Product Truth is not ready yet.
 *
 * This detector never establishes truth and never authorizes a repair. It only
 * reports facts that the listing declares about itself but its exact
 * buyer-facing images contradict (or that the images contradict each other).
 * The result is therefore useful for triage and enrichment prioritization while
 * remaining strictly weaker than the Product Truth based integrity detector.
 */

import {
  BLIND_OBSERVATION_SCHEMA,
  parseBlindResponse,
  type BlindObservation,
  type ImageSlot,
} from "./catalog-visual-audit.ts";
import { extractTitleOuterCountEvidence } from "./catalog-visual-truth-preflight.ts";
import {
  projectWalmartListingSurfaceFromBuyerPdp,
  walmartListingIntegrityImageId,
  walmartListingIntegritySha256,
} from "./listing-integrity-audit.ts";
import type { SealedWalmartBuyerSnapshot } from "./buyer-facing-snapshot.ts";

export const WALMART_LISTING_DECLARED_CONSISTENCY_SCHEMA =
  "walmart-listing-declared-consistency/v1" as const;

export interface WalmartListingDeclaredConsistencyFinding {
  severity: "CONTRADICTION" | "REVIEW";
  code: string;
  slot: ImageSlot | null;
  evidence: string[];
}

export interface SealedWalmartListingDeclaredConsistency {
  schema_version: typeof WALMART_LISTING_DECLARED_CONSISTENCY_SCHEMA;
  listing_key: string;
  captured_at: string;
  authority: {
    establishes_product_truth: false;
    authorizes_repair: false;
    basis: "LIVE_LISTING_SELF_CONSISTENCY_ONLY";
  };
  declared_outer_units: {
    status: "NONE" | "EXACT" | "AMBIGUOUS";
    value: number | null;
    phrases: string[];
  };
  verdict: "CONTRADICTION" | "REVIEW" | "NO_CONTRADICTION_FOUND";
  findings: WalmartListingDeclaredConsistencyFinding[];
  next_step: "ENRICH_EXACT_PRODUCT_TRUTH";
  body_sha256: string;
}

const GENERIC_IDENTITY_WORDS = new Set([
  "and", "bag", "box", "bundle", "case", "count", "ct", "each", "for",
  "from", "item", "multipack", "of", "pack", "package", "pk", "product",
  "quantity", "set", "the", "unit", "with",
]);

/**
 * Narrow same-head product classes that are mutually exclusive in one grocery
 * listing. This is intentionally conservative: it does not try to infer a
 * product taxonomy or choose the correct class. It only catches two explicit
 * live declarations such as "hot dog buns" versus "hamburger buns".
 */
const EXCLUSIVE_PRODUCT_CLASS_FAMILIES = [
  [
    "hot dog buns",
    "hamburger buns",
    "burger buns",
    "slider buns",
    "hoagie buns",
  ],
] as const;

function normalize(value: string): string {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/&/gu, " and ")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function identityTokens(value: string | null): string[] {
  if (!value) return [];
  return [...new Set(normalize(value).split(" ").filter((token) =>
    token.length >= 2
    && !/^\d+$/u.test(token)
    && !GENERIC_IDENTITY_WORDS.has(token)
  ))];
}

function overlapRatio(needle: readonly string[], haystack: ReadonlySet<string>): number {
  if (!needle.length) return 0;
  return needle.filter((token) => haystack.has(token)).length / needle.length;
}

function detectorSlot(
  slot: SealedWalmartBuyerSnapshot["assets"][number]["slot"],
): ImageSlot {
  return slot === "MAIN"
    ? "main"
    : `gallery-${Number(slot.slice("GALLERY_".length))}`;
}

function addFinding(
  findings: WalmartListingDeclaredConsistencyFinding[],
  finding: WalmartListingDeclaredConsistencyFinding,
): void {
  const key = `${finding.severity}\n${finding.code}\n${finding.slot ?? ""}`;
  if (!findings.some((current) =>
    `${current.severity}\n${current.code}\n${current.slot ?? ""}` === key
  )) {
    findings.push(finding);
  }
}

function explicitExclusiveProductClasses(value: string): string[] {
  const normalized = ` ${normalize(value)} `;
  return EXCLUSIVE_PRODUCT_CLASS_FAMILIES.flatMap((family) => (
    family.filter((phrase) => normalized.includes(` ${phrase} `))
  ));
}

/**
 * Detect only contradictions against live declared text and between exact
 * buyer-facing images. Absence of a contradiction is explicitly not PASS.
 */
export function compileWalmartListingDeclaredConsistency(input: {
  listing_key: string;
  buyer_snapshot: SealedWalmartBuyerSnapshot;
  buyer_pdp_payload: unknown;
  blind_observations: readonly BlindObservation[];
}): SealedWalmartListingDeclaredConsistency {
  const { buyer_snapshot: buyer } = input;
  if (!/^walmart:[1-9]\d*:/u.test(input.listing_key)
    || buyer.target.sku !== input.listing_key.split(":").slice(2).join(":")
    || buyer.identity.exact_sku_match !== true
    || buyer.identity.exact_item_id_match !== true
    || buyer.identity.buyer_facing_verified !== true
    || buyer.identity.seller.published_status !== "PUBLISHED"
    || buyer.identity.seller.lifecycle_status !== "ACTIVE") {
    throw new Error("declared consistency requires one exact active published Walmart listing");
  }
  const surface = projectWalmartListingSurfaceFromBuyerPdp(
    input.buyer_pdp_payload,
    buyer.target,
  );
  const slots = buyer.assets.map((asset) => detectorSlot(asset.slot));
  const imageIds = buyer.assets.map((asset, index) => (
    walmartListingIntegrityImageId(asset.sha256, slots[index]!, input.listing_key)
  ));
  const observations = parseBlindResponse({
    schema_version: BLIND_OBSERVATION_SCHEMA,
    observations: [...input.blind_observations],
  }, imageIds);
  const titleOuter = extractTitleOuterCountEvidence(surface.title);
  const surfaceText = [
    surface.title,
    surface.description ?? "",
    ...surface.bullets,
    ...surface.attribute_claims.flatMap((claim) => (
      "text" in claim ? [claim.text] : []
    )),
  ].join("\n");
  const surfaceTokens = new Set(identityTokens(surfaceText));
  const findings: WalmartListingDeclaredConsistencyFinding[] = [];
  const typedProducts = surface.attribute_claims.flatMap((claim) => (
    claim.kind === "product" ? [claim.text] : []
  ));
  const declaredProductClasses = [...new Set(
    explicitExclusiveProductClasses([
      surface.title,
      ...typedProducts,
    ].join("\n")),
  )];
  if (declaredProductClasses.length > 1) {
    addFinding(findings, {
      severity: "CONTRADICTION",
      code: "LIVE_TITLE_AND_TYPED_ATTRIBUTES_DECLARE_DIFFERENT_PRODUCT_CLASSES",
      slot: null,
      evidence: [
        `title=${surface.title}`,
        ...typedProducts.map((value) => `attribute=${value}`),
      ],
    });
  } else if (declaredProductClasses.length === 1) {
    const declared = declaredProductClasses[0]!;
    for (const [index, bullet] of surface.bullets.entries()) {
      const bulletClasses = [...new Set(explicitExclusiveProductClasses(bullet))];
      if (bulletClasses.some((value) => value !== declared)) {
        addFinding(findings, {
          severity: "CONTRADICTION",
          code: "LIVE_BULLET_PRODUCT_CLASS_CONTRADICTS_TITLE_OR_ATTRIBUTE",
          slot: null,
          evidence: [
            `declared=${declared}`,
            `bullet[${index}]=${bullet}`,
          ],
        });
      }
    }
  }

  if (titleOuter.status !== "EXACT") {
    addFinding(findings, {
      severity: "REVIEW",
      code: titleOuter.status === "AMBIGUOUS"
        ? "LIVE_TITLE_HAS_AMBIGUOUS_OUTER_QUANTITY"
        : "LIVE_TITLE_HAS_NO_EXPLICIT_OUTER_QUANTITY",
      slot: null,
      evidence: titleOuter.claims.map((claim) => claim.phrase),
    });
  }

  const typedOuter = [...new Set(surface.attribute_claims.flatMap((claim) => (
    claim.kind === "outer_units" ? [claim.value] : []
  )))];
  if (typedOuter.length > 1
    || (titleOuter.status === "EXACT" && typedOuter.some((value) => value !== titleOuter.value))) {
    addFinding(findings, {
      severity: "CONTRADICTION",
      code: "LIVE_TITLE_AND_TYPED_ATTRIBUTES_DISAGREE_ON_OUTER_QUANTITY",
      slot: null,
      evidence: [
        `title=${titleOuter.value ?? "unknown"}`,
        `attributes=${typedOuter.join(",") || "none"}`,
      ],
    });
  }

  const clearBrands: Array<{ slot: ImageSlot; tokens: string[]; text: string }> = [];
  const clearProducts: Array<{ slot: ImageSlot; tokens: string[]; text: string }> = [];
  for (const [index, observation] of observations.entries()) {
    const slot = slots[index]!;
    const brandTokens = identityTokens(observation.visible_brand_text);
    const productTokens = identityTokens(observation.visible_product_text);
    const variantTokens = identityTokens(observation.visible_variant_text);
    const clear = observation.readable_identity === "clear";

    if (brandTokens.length) {
      clearBrands.push({
        slot,
        tokens: brandTokens,
        text: observation.visible_brand_text!,
      });
      if (clear && overlapRatio(brandTokens, surfaceTokens) < 1) {
        addFinding(findings, {
          severity: "CONTRADICTION",
          code: "IMAGE_BRAND_CONTRADICTS_LIVE_LISTING_TEXT",
          slot,
          evidence: [observation.visible_brand_text!, surface.title],
        });
      }
    }
    if (productTokens.length) {
      clearProducts.push({
        slot,
        tokens: productTokens,
        text: observation.visible_product_text!,
      });
      const ratio = overlapRatio(productTokens, surfaceTokens);
      if (clear && productTokens.length >= 2 && ratio < 0.34) {
        addFinding(findings, {
          severity: "CONTRADICTION",
          code: "IMAGE_PRODUCT_CONTRADICTS_LIVE_LISTING_TEXT",
          slot,
          evidence: [observation.visible_product_text!, surface.title],
        });
      } else if (ratio === 0) {
        addFinding(findings, {
          severity: "REVIEW",
          code: "IMAGE_PRODUCT_NOT_CORROBORATED_BY_LIVE_LISTING_TEXT",
          slot,
          evidence: [observation.visible_product_text!, surface.title],
        });
      }
    }
    if (variantTokens.length && overlapRatio(variantTokens, surfaceTokens) === 0) {
      addFinding(findings, {
        severity: clear ? "CONTRADICTION" : "REVIEW",
        code: "IMAGE_VARIANT_NOT_CORROBORATED_BY_LIVE_LISTING_TEXT",
        slot,
        evidence: [observation.visible_variant_text!, surface.title],
      });
    }
    if (observation.multiple_distinct_products === "yes"
      && (slot === "main" || observation.visual_role === "mixed_products")) {
      addFinding(findings, {
        severity: "CONTRADICTION",
        code: "IMAGE_SHOWS_MULTIPLE_DISTINCT_PRODUCTS",
        slot,
        evidence: [...observation.evidence],
      });
    }
    if (slot === "main" && titleOuter.status === "EXACT") {
      const count = observation.external_package_count;
      const mismatch = (count.mode === "exact" && count.value !== titleOuter.value)
        || (count.mode === "range"
          && (count.min! > titleOuter.value! || count.max! < titleOuter.value!));
      if (mismatch) {
        addFinding(findings, {
          severity: "CONTRADICTION",
          code: "MAIN_VISIBLE_OUTER_QUANTITY_CONTRADICTS_LIVE_TITLE",
          slot,
          evidence: [
            `title=${titleOuter.value}`,
            count.mode === "exact"
              ? `visible=${count.value}`
              : `visible=${count.min}-${count.max}`,
          ],
        });
      } else if (count.mode === "unknown" && titleOuter.value! > 1) {
        addFinding(findings, {
          severity: "REVIEW",
          code: "MAIN_VISIBLE_OUTER_QUANTITY_UNREADABLE",
          slot,
          evidence: [...observation.unclear_quantity_claims],
        });
      }
    }
  }

  for (let left = 0; left < clearBrands.length; left += 1) {
    for (let right = left + 1; right < clearBrands.length; right += 1) {
      const a = clearBrands[left]!;
      const b = clearBrands[right]!;
      if (!a.tokens.some((token) => b.tokens.includes(token))) {
        addFinding(findings, {
          severity: "CONTRADICTION",
          code: "BUYER_IMAGES_SHOW_DIFFERENT_BRANDS",
          slot: b.slot,
          evidence: [`${a.slot}=${a.text}`, `${b.slot}=${b.text}`],
        });
      }
    }
  }
  for (let left = 0; left < clearProducts.length; left += 1) {
    for (let right = left + 1; right < clearProducts.length; right += 1) {
      const a = clearProducts[left]!;
      const b = clearProducts[right]!;
      if (a.tokens.length >= 2 && b.tokens.length >= 2
        && !a.tokens.some((token) => b.tokens.includes(token))) {
        addFinding(findings, {
          severity: "CONTRADICTION",
          code: "BUYER_IMAGES_SHOW_DIFFERENT_PRODUCTS",
          slot: b.slot,
          evidence: [`${a.slot}=${a.text}`, `${b.slot}=${b.text}`],
        });
      }
    }
  }

  findings.sort((left, right) =>
    left.severity.localeCompare(right.severity)
    || (left.slot ?? "").localeCompare(right.slot ?? "")
    || left.code.localeCompare(right.code)
  );
  const verdict: SealedWalmartListingDeclaredConsistency["verdict"] =
    findings.some((finding) => finding.severity === "CONTRADICTION")
    ? "CONTRADICTION"
    : findings.length
      ? "REVIEW"
      : "NO_CONTRADICTION_FOUND";
  const body = {
    schema_version: WALMART_LISTING_DECLARED_CONSISTENCY_SCHEMA,
    listing_key: input.listing_key,
    captured_at: buyer.captured_at,
    authority: {
      establishes_product_truth: false as const,
      authorizes_repair: false as const,
      basis: "LIVE_LISTING_SELF_CONSISTENCY_ONLY" as const,
    },
    declared_outer_units: {
      status: titleOuter.status,
      value: titleOuter.value,
      phrases: titleOuter.claims.map((claim) => claim.phrase),
    },
    verdict,
    findings,
    next_step: "ENRICH_EXACT_PRODUCT_TRUTH" as const,
  };
  return {
    ...body,
    body_sha256: walmartListingIntegritySha256(body),
  };
}
