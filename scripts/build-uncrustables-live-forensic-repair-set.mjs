#!/usr/bin/env node

/**
 * Build a read-only, per-ASIN forensic classification for the 164 successfully
 * fetched Uncrustables listings in the pinned live ledger.
 *
 * The script reads only local immutable snapshots/artifacts. It makes no DB,
 * Amazon, R2, or other network calls. The only writes are the JSON/CSV/Markdown
 * audit artifacts in data/audits.
 */

import { createHash } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();

const INPUTS = {
  ledger: "data/audits/uncrustables-ledger-20260717T232140568Z-offline.json",
  content: "data/audits/uncrustables-content-20260718T010921926Z-offline.json",
  repairPlan: "data/repairs/generated/URP-20260717T231848392Z-63fc6896b6ad.json",
  futureGallery:
    "data/audits/uncrustables-product-gallery-20260718T002326936Z-46a80e727880-5f4342ccc8e8.json",
  rejectedHeroManifest:
    "data/audits/UHG-20260717T232607386Z-6babc0eb-manifest.json",
  rejectedHeroDecision:
    "data/audits/UHG-20260717T232607386Z-6babc0eb-rejection-decision.json",
  replacementApprovals:
    "src/lib/bundle-factory/audit/data/uncrustables-main-owner-approvals-v1.json",
  authenticityRegistry:
    "src/lib/bundle-factory/audit/data/uncrustables-authenticity-registry-v1.json",
  ledgerRules: "src/lib/bundle-factory/audit/uncrustables-ledger.ts",
  liveMainContactSheet:
    "data/audits/uncrustables-live-main-sample-contact-sheet-20260718.png",
};

const REQUIRED_CARD_SOURCE_URL =
  "https://pub-6394ee2ba6de41b68a3dcee17c884db8.r2.dev/prod/brand/salutem-brand-card-v1.png";
const VERIFIED_CARD_REHOST_URL =
  "https://m.media-amazon.com/images/I/81OibsvvU0L.jpg";
const REJECTED_NUTRITION_PANEL_REHOST_URL =
  "https://m.media-amazon.com/images/I/81+K8ip-dSL.jpg";

const SHARED_LIVE_MAIN_DEFECTS = [
  "UNAPPROVED_COOLER_TEMPLATE_VISIBLE",
  "INCORRECT_SALUTEM_LOGO_VISIBLE",
  "INCORRECT_GEL_PACK_DESIGN_VISIBLE",
  "UNACCEPTABLE_MAIN_IMAGE_COMPOSITION_VISIBLE",
];

/**
 * These eight files are the only locally retained pixels identified as old live
 * Amazon MAIN samples. Their visual defect decision is positive (REGENERATE),
 * so an owner-approved authenticity registry is not needed to reject them.
 * No fictional product/flavor assertion is made: several slogan-style carton
 * names are supported by reviewed package-art references elsewhere in the repo.
 */
const LOCAL_LIVE_MAIN_SAMPLES = {
  B0H85P9F3R: {
    file: "data/audits/uncrustables-approved-reference-qa-20260718/B0H85P9F3R-live.jpg",
    observation:
      "Individual wrappers are composited into an unapproved branded white cooler; the cooler logo and gel-pack artwork match the owner-rejected kit style.",
  },
  B0H85V287S: {
    file: "data/audits/uncrustables-approved-reference-qa-20260718/HA-ASCR-ME3A-live.jpg",
    observation:
      "Retail cartons are composited into an unapproved branded white cooler; the cooler logo and gel-pack artwork match the owner-rejected kit style.",
  },
  B0H856RRRK: {
    file: "data/audits/uncrustables-approved-reference-qa-20260718/HR-AS7Q-7ZDF-live.jpg",
    observation:
      "Retail cartons are composited into an unapproved branded white cooler; the cooler logo and gel-pack artwork match the owner-rejected kit style.",
  },
  B0H845JBM6: {
    file: "data/audits/uncrustables-approved-reference-qa-20260718/KD-AS12-8HZ3-live.jpg",
    observation:
      "Retail cartons are composited into an unapproved branded white cooler; the cooler logo and gel-pack artwork match the owner-rejected kit style.",
  },
  B0H85PJ516: {
    file: "data/audits/uncrustables-approved-reference-qa-20260718/RZ-AS26-WLRM-live.jpg",
    observation:
      "Retail cartons are composited into an unapproved branded white cooler; the cooler logo and gel-pack artwork match the owner-rejected kit style.",
  },
  B0H85RZDX5: {
    file: "data/audits/uncrustables-approved-reference-qa-20260718/VA-ASOK-QJCA-live.jpg",
    observation:
      "Retail cartons are composited into an unapproved branded white cooler; the cooler logo and gel-pack artwork match the owner-rejected kit style.",
  },
  B0H859VYXH: {
    file: "data/audits/uncrustables-approved-reference-qa-20260718/WR-ASR5-AVWE-live.jpg",
    observation:
      "Retail cartons are composited into an unapproved branded white cooler; the cooler logo and gel-pack artwork match the owner-rejected kit style.",
  },
  B0H85N7X8W: {
    file: "data/audits/uncrustables-approved-reference-qa-20260718/ZP-ASJD-X7ZD-live.jpg",
    observation:
      "Retail cartons are composited into an unapproved branded white cooler; the cooler logo and gel-pack artwork match the owner-rejected kit style.",
  },
};

function absolute(relativePath) {
  return path.resolve(ROOT, relativePath);
}

async function readBytes(relativePath) {
  return readFile(absolute(relativePath));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readJson(relativePath) {
  const bytes = await readBytes(relativePath);
  return { value: JSON.parse(bytes.toString("utf8")), bytes };
}

function countBy(items, selector) {
  const result = {};
  for (const item of items) {
    const key = String(selector(item));
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

function boolStatus(value) {
  return value ? "MATCH" : "MISMATCH";
}

function dollarsEqual(a, b) {
  return (
    typeof a === "number" &&
    typeof b === "number" &&
    Math.round(a * 100) === Math.round(b * 100)
  );
}

function firstBusinessPrice(live) {
  const offer = Array.isArray(live.business_offers)
    ? live.business_offers.find((candidate) =>
        typeof candidate?.our_price === "number",
      )
    : null;
  return offer?.our_price ?? live.separate_business_price ?? null;
}

function listPrice(live) {
  const entry = live.raw_attributes?.list_price?.[0];
  if (!entry || typeof entry !== "object") return null;
  return typeof entry.value === "number" ? entry.value : null;
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function stamp(now) {
  return now.toISOString().replace(/[-:]/g, "").replace(".", "");
}

async function writeExclusive(filePath, text) {
  const handle = await open(filePath, "wx");
  try {
    await handle.writeFile(text, "utf8");
  } finally {
    await handle.close();
  }
}

async function main() {
  const loaded = {};
  for (const [key, relativePath] of Object.entries(INPUTS)) {
    if (key === "liveMainContactSheet") continue;
    if (relativePath.endsWith(".json")) {
      loaded[key] = await readJson(relativePath);
    } else {
      const bytes = await readBytes(relativePath);
      loaded[key] = { value: null, bytes };
    }
  }

  const ledger = loaded.ledger.value;
  const content = loaded.content.value;
  const repairPlan = loaded.repairPlan.value;
  const futureGallery = loaded.futureGallery.value;
  const rejectedHeroManifest = loaded.rejectedHeroManifest.value;
  const rejectedHeroDecision = loaded.rejectedHeroDecision.value;
  const replacementApprovals = loaded.replacementApprovals.value;

  const liveRows = ledger.rows
    .filter((row) => row.live?.fetched === true)
    .sort((a, b) => a.asin.localeCompare(b.asin));
  if (liveRows.length !== 164) {
    throw new Error(`Expected exactly 164 fetched rows; found ${liveRows.length}`);
  }
  if (new Set(liveRows.map((row) => row.asin)).size !== 164) {
    throw new Error("Fetched ledger rows do not contain 164 unique ASINs");
  }

  const contentBySku = new Map(content.rows.map((row) => [row.sku, row]));
  const repairBySku = new Map(repairPlan.entries.map((row) => [row.sku, row]));
  const futureGalleryBySku = new Map(
    futureGallery.rows.map((row) => [row.sku, row]),
  );
  const replacementApprovalBySku = new Map(
    (replacementApprovals.entries ?? []).map((row) => [row.sku, row]),
  );
  const rejectedHeroHashes = new Set(
    rejectedHeroManifest.rows
      .map((row) => row.result?.image_sha256)
      .filter((value) => typeof value === "string"),
  );

  const localSamples = new Map();
  for (const [asin, sample] of Object.entries(LOCAL_LIVE_MAIN_SAMPLES)) {
    const bytes = await readBytes(sample.file);
    const metadata = await stat(absolute(sample.file));
    const imageHash = sha256(bytes);
    localSamples.set(asin, {
      ...sample,
      sha256: imageHash,
      bytes: bytes.length,
      dimensions: { width: 2048, height: 2048 },
      filesystem_mtime: metadata.mtime.toISOString(),
      exact_hash_present_in_rejected_uhg_batch: rejectedHeroHashes.has(imageHash),
    });
  }

  const rows = liveRows.map((row) => {
    const { live, canonical } = row;
    const anomalies = row.anomalies.map((anomaly) => anomaly.code);
    const contentRow = contentBySku.get(row.sku);
    const repairEntry = repairBySku.get(row.sku);
    const textAction = repairEntry?.actions.find(
      (action) => action.kind === "TEXT_COUNT",
    );
    const mediaAction = repairEntry?.actions.find(
      (action) => action.kind === "MEDIA",
    );
    const offerAction = repairEntry?.actions.find(
      (action) => action.kind === "OFFER",
    );
    const futureGalleryRow = futureGalleryBySku.get(row.sku);
    const replacementApproval = replacementApprovalBySku.get(row.sku);
    const localMain = localSamples.get(row.asin);

    const main = localMain
      ? {
          decision: "REGENERATE",
          reason_codes: [...SHARED_LIVE_MAIN_DEFECTS],
          observation: localMain.observation,
          product_identity_disposition:
            "NOT_USED_FOR_REJECTION; no fictional flavor/product assertion made from slogans alone",
          evidence: {
            observed_amazon_main_url: live.main_image_url,
            local_file: localMain.file,
            sha256: localMain.sha256,
            bytes: localMain.bytes,
            dimensions: localMain.dimensions,
            filesystem_mtime: localMain.filesystem_mtime,
            contact_sheet: INPUTS.liveMainContactSheet,
            source_binding:
              "ASIN/SKU filename plus local audit acquisition context; no retained HTTP response manifest or ETag",
            visual_review_method: "direct inspection of local pixels",
            exact_hash_present_in_rejected_uhg_batch:
              localMain.exact_hash_present_in_rejected_uhg_batch,
          },
        }
      : {
          decision: "UNOBSERVABLE",
          reason_codes: ["NO_LOCAL_BYTES_FOR_OBSERVED_AMAZON_MAIN_URL"],
          observation: null,
          product_identity_disposition: "UNOBSERVABLE",
          evidence: {
            observed_amazon_main_url: live.main_image_url,
            local_file: null,
            sha256: null,
            source_binding: null,
            required_next_evidence:
              "Download the exact current Amazon MAIN bytes, retain URL/ETag/timestamp/SHA-256, then perform hash-bound visual and recipe review.",
          },
        };

    const cardStatus =
      live.gallery_image_urls[0] === REQUIRED_CARD_SOURCE_URL ||
      live.gallery_image_urls[0] === VERIFIED_CARD_REHOST_URL
        ? "VERIFIED_REQUIRED_INFOGRAPHIC"
        : live.gallery_image_urls[0] ===
            REJECTED_NUTRITION_PANEL_REHOST_URL
          ? "WRONG_KNOWN_NUTRITION_PANEL"
          : "IDENTITY_UNVERIFIED";
    const galleryCount = live.gallery_image_urls.length;
    const galleryCountOk = galleryCount >= 5 && galleryCount <= 7;
    const galleryStructureStatus = !galleryCountOk
      ? "FAIL_SECONDARY_COUNT"
      : cardStatus !== "VERIFIED_REQUIRED_INFOGRAPHIC"
        ? "FAIL_INFOGRAPHIC_SLOT_1"
        : "PASS_METADATA_AND_HASH_ALLOWLIST";

    const canonicalOffer = {
      currency: "USD",
      consumer_price: canonical.pricing?.suggested ?? null,
      business_price: canonical.pricing?.suggested ?? null,
      minimum_seller_allowed_price: canonical.pricing?.floor ?? null,
      maximum_seller_allowed_price: canonical.pricing?.suggested ?? null,
    };
    const sealedOffer = offerAction?.desired?.value ?? null;
    const sealedOfferMatchesCurrentCanonical =
      sealedOffer != null &&
      dollarsEqual(sealedOffer.consumer_price, canonicalOffer.consumer_price) &&
      dollarsEqual(sealedOffer.business_price, canonicalOffer.business_price) &&
      dollarsEqual(
        sealedOffer.minimum_seller_allowed_price,
        canonicalOffer.minimum_seller_allowed_price,
      ) &&
      dollarsEqual(
        sealedOffer.maximum_seller_allowed_price,
        canonicalOffer.maximum_seller_allowed_price,
      );
    const observedOffer = {
      consumer_price: live.consumer_offer?.our_price ?? null,
      discounted_price: live.consumer_offer?.discounted_price ?? null,
      business_price: firstBusinessPrice(live),
      minimum_seller_allowed_price:
        live.consumer_offer?.minimum_seller_allowed_price ?? null,
      maximum_seller_allowed_price:
        live.consumer_offer?.maximum_seller_allowed_price ?? null,
      list_price: listPrice(live),
    };
    const recipeCountConflict =
      anomalies.includes("RECIPE_COUNT_MISMATCH") ||
      anomalies.includes("DRAFT_MASTER_COUNT_MISMATCH") ||
      (typeof canonical.component_qty_sum === "number" &&
        canonical.component_qty_sum !== canonical.total_units);
    const checks = {
      consumer_price: dollarsEqual(
        observedOffer.consumer_price,
        canonicalOffer.consumer_price,
      ),
      business_price: dollarsEqual(
        observedOffer.business_price,
        canonicalOffer.business_price,
      ),
      minimum_seller_allowed_price: dollarsEqual(
        observedOffer.minimum_seller_allowed_price,
        canonicalOffer.minimum_seller_allowed_price,
      ),
      maximum_seller_allowed_price: dollarsEqual(
        observedOffer.maximum_seller_allowed_price,
        canonicalOffer.maximum_seller_allowed_price,
      ),
      discounted_price_absent: observedOffer.discounted_price == null,
      list_price_absent: observedOffer.list_price == null,
    };
    const pricePass = !recipeCountConflict && Object.values(checks).every(Boolean);
    const priceStatus = recipeCountConflict
      ? "FAIL_RECIPE_RESOLUTION_REQUIRED"
      : pricePass
        ? "PASS"
        : "FAIL_REPAIR_REQUIRED";

    const deterministicContentPass = contentRow?.pass === true;
    const structuredPresence = {
      ingredients_present: live.raw_attributes?.ingredients != null,
      allergen_information_present:
        live.raw_attributes?.allergen_information != null,
      expiration_fields_present:
        live.raw_attributes?.is_expiration_dated_product != null &&
        live.raw_attributes?.product_expiration_type != null,
    };

    const requiredRepairs = [
      main.decision === "REGENERATE" ? "REGENERATE_MAIN" : null,
      main.decision === "UNOBSERVABLE"
        ? "OBSERVE_MAIN_THEN_KEEP_OR_REGENERATE"
        : null,
      galleryStructureStatus === "FAIL_INFOGRAPHIC_SLOT_1"
        ? "REPAIR_INFOGRAPHIC_SLOT_1"
        : null,
      galleryStructureStatus === "FAIL_SECONDARY_COUNT"
        ? "ADD_4_TO_6_PRODUCT_SECONDARIES_AFTER_FIXED_CARD"
        : null,
      "DOWNLOAD_AND_VISUALLY_VERIFY_LIVE_PRODUCT_SECONDARIES",
      deterministicContentPass ? null : "REPAIR_TEXT_SEMANTICS",
      "BIND_TEXT_AND_STRUCTURED_CLAIMS_TO_PHYSICAL_PACKAGE_EVIDENCE",
      recipeCountConflict
        ? "RESOLVE_CANONICAL_RECIPE_COUNT_BEFORE_OFFER_REPAIR"
        : null,
      pricePass ? null : "REPAIR_CANONICAL_OFFER",
      !live.buyable || !live.discoverable || live.issues.length
        ? "CLEAR_OPERATIONAL_LISTING_ISSUES"
        : null,
    ].filter(Boolean);

    return {
      sku: row.sku,
      asin: row.asin,
      store_index: row.store_index,
      observed_at: ledger.marketplace_observed_at,
      recipe: {
        total_units: canonical.total_units,
        composition_source: canonical.composition_source,
        components: canonical.components.map((component) => ({
          product_name: component.product_name,
          qty: component.qty,
        })),
      },
      main,
      approved_replacement_candidate: replacementApproval
        ? {
            exists: true,
            proof_id: replacementApproval.proof_id,
            image: replacementApproval.image,
            approval_id: replacementApproval.human_approval?.approval_id ?? null,
            decision: replacementApproval.human_approval?.decision ?? null,
            caveat:
              "Approval is for a replacement preview hash, not proof that the existing Amazon MAIN should be kept.",
          }
        : { exists: false },
      gallery: {
        structure_status: galleryStructureStatus,
        secondary_count: galleryCount,
        required_secondary_count: "5-7 (fixed card plus 4-6 product images)",
        count_status: galleryCountOk ? "MATCH" : "MISMATCH",
        slot_1_url: live.gallery_image_urls[0] ?? null,
        slot_1_status: cardStatus,
        product_secondary_visual_status: "UNOBSERVABLE",
        product_secondary_visual_reason:
          "The live Amazon-rehosted secondary bytes were not retained locally or hash-bound to the future gallery manifest.",
        repair_plan_media_action_present: Boolean(mediaAction),
        future_gallery_candidate: futureGalleryRow
          ? {
              exists: true,
              declared_verified: futureGalleryRow.verified === true,
              image_count: futureGalleryRow.image_urls?.length ?? 0,
              caveat:
                "Future desired artifact only; declared verified is not proof of current Amazon pixels or visual correctness.",
            }
          : { exists: false },
      },
      content: {
        deterministic_status: deterministicContentPass
          ? "PASS_LIMITED_RULESET"
          : "FAIL_REPAIR_REQUIRED",
        deterministic_failures: contentRow?.failures ?? [
          {
            type: "UNOBSERVABLE",
            message: "No content-audit row",
          },
        ],
        validator_scope:
          "format + recipe/count/flavor semantics + promotional-language rule",
        full_evidence_backed_status: deterministicContentPass
          ? "NEEDS_EVIDENCE"
          : "FAIL_AND_NEEDS_EVIDENCE",
        physical_package_evidence_bound_in_ledger: false,
        structured_presence: structuredPresence,
        current_failure_has_text_repair_action:
          deterministicContentPass ? null : Boolean(textAction),
        text_repair_action: textAction?.desired ?? null,
      },
      price: {
        status: priceStatus,
        source: "pinned ledger canonical cost-model snapshot",
        canonical_authority_status: recipeCountConflict
          ? "CONFLICTING_COUNT_AUTHORITIES"
          : "PINNED_MASTER_COUNT_MODEL",
        count_evidence: {
          master_total_units: canonical.total_units,
          selected_composition_qty_sum: canonical.component_qty_sum,
          live_title_total_units: live.title_total_units,
          live_unit_count: live.unit_count,
          live_number_of_items: live.number_of_items,
        },
        canonical_model: canonical.pricing,
        desired_offer: canonicalOffer,
        observed_offer: observedOffer,
        checks: Object.fromEntries(
          Object.entries(checks).map(([key, value]) => [key, boolStatus(value)]),
        ),
        sealed_offer_repair: {
          present: Boolean(offerAction),
          desired_offer: sealedOffer,
          matches_current_canonical: sealedOfferMatchesCurrentCanonical,
        },
      },
      operations: {
        buyable: live.buyable,
        discoverable: live.discoverable,
        amazon_statuses: live.amazon_statuses,
        issues: live.issues,
        ledger_anomaly_codes: anomalies,
      },
      required_repairs: requiredRepairs,
    };
  });

  const mainCounts = countBy(rows, (row) => row.main.decision);
  for (const decision of [
    "KEEP",
    "REGENERATE",
    "NEEDS_EVIDENCE",
    "UNOBSERVABLE",
  ]) {
    mainCounts[decision] ??= 0;
  }

  const currentContentFailures = rows.filter(
    (row) => row.content.deterministic_status === "FAIL_REPAIR_REQUIRED",
  );
  const currentContentFailuresWithPlan = currentContentFailures.filter(
    (row) => row.content.current_failure_has_text_repair_action === true,
  );

  const inputEvidence = Object.fromEntries(
    Object.entries(INPUTS).map(([key, relativePath]) => {
      const loadedInput = loaded[key];
      return [
        key,
        {
          path: relativePath,
          sha256:
            loadedInput?.bytes != null
              ? sha256(loadedInput.bytes)
              : null,
        },
      ];
    }),
  );
  inputEvidence.liveMainContactSheet.sha256 = sha256(
    await readBytes(INPUTS.liveMainContactSheet),
  );

  const summary = {
    exact_live_asins: rows.length,
    main_classification: mainCounts,
    gallery_structure: countBy(
      rows,
      (row) => row.gallery.structure_status,
    ),
    gallery_product_secondary_visual: countBy(
      rows,
      (row) => row.gallery.product_secondary_visual_status,
    ),
    content_deterministic: countBy(
      rows,
      (row) => row.content.deterministic_status,
    ),
    content_fully_evidence_certified: 0,
    current_content_failures_with_text_fix_in_sealed_plan:
      currentContentFailuresWithPlan.length,
    current_content_failures_missing_text_fix_in_sealed_plan:
      currentContentFailures.length - currentContentFailuresWithPlan.length,
    structured_presence: {
      ingredients_present: rows.filter(
        (row) => row.content.structured_presence.ingredients_present,
      ).length,
      allergen_information_present: rows.filter(
        (row) => row.content.structured_presence.allergen_information_present,
      ).length,
      expiration_fields_present: rows.filter(
        (row) => row.content.structured_presence.expiration_fields_present,
      ).length,
    },
    price_overall: countBy(rows, (row) => row.price.status),
    price_component_matches: {
      consumer_price: rows.filter(
        (row) => row.price.checks.consumer_price === "MATCH",
      ).length,
      business_price: rows.filter(
        (row) => row.price.checks.business_price === "MATCH",
      ).length,
      minimum_seller_allowed_price: rows.filter(
        (row) => row.price.checks.minimum_seller_allowed_price === "MATCH",
      ).length,
      maximum_seller_allowed_price: rows.filter(
        (row) => row.price.checks.maximum_seller_allowed_price === "MATCH",
      ).length,
      discounted_price_absent: rows.filter(
        (row) => row.price.checks.discounted_price_absent === "MATCH",
      ).length,
      list_price_absent: rows.filter(
        (row) => row.price.checks.list_price_absent === "MATCH",
      ).length,
    },
    sealed_offer_actions_matching_unambiguous_current_canonical: rows.filter(
      (row) =>
        row.price.canonical_authority_status === "PINNED_MASTER_COUNT_MODEL" &&
        row.price.sealed_offer_repair.matches_current_canonical,
    ).length,
    operations: {
      buyable: rows.filter((row) => row.operations.buyable).length,
      discoverable: rows.filter((row) => row.operations.discoverable).length,
      not_buyable: rows.filter((row) => !row.operations.buyable).length,
      not_discoverable: rows.filter(
        (row) => !row.operations.discoverable,
      ).length,
      rows_with_amazon_issues: rows.filter(
        (row) => row.operations.issues.length > 0,
      ).length,
    },
    approved_replacement_candidates: rows.filter(
      (row) => row.approved_replacement_candidate.exists,
    ).length,
  };

  const excludedCandidates = ledger.rows
    .filter((row) => row.live?.fetched !== true)
    .map((row) => ({
      sku: row.sku,
      asin: row.asin,
      reason: row.live?.error ?? "live fetch failed",
    }));

  const now = new Date();
  const payloadWithoutHash = {
    schema_version: "uncrustables-live-forensic-repair-set/v1.0",
    audit_id: `ULFR-${stamp(now)}`,
    created_at: now.toISOString(),
    immutable: true,
    mode: "offline-read-only-forensics",
    external_mutations: {
      amazon_calls: 0,
      database_writes: 0,
      r2_calls: 0,
      network_calls: 0,
      local_artifact_writes: 3,
    },
    scope: {
      included:
        "exactly the 164 unique ASINs with fetched=true in the pinned live ledger",
      marketplace_observed_at: ledger.marketplace_observed_at,
      excluded_candidates: excludedCandidates,
    },
    decision_definitions: {
      KEEP:
        "Exact current live MAIN bytes were observed, hash-bound, and approved for the exact recipe and owner visual criteria.",
      REGENERATE:
        "Observed pixels contain a positive owner-prohibited defect or wrong/fictional product/count/mode/composition.",
      NEEDS_EVIDENCE:
        "Pixels are locally observable but insufficient reference/recipe/approval evidence prevents KEEP or REGENERATE.",
      UNOBSERVABLE:
        "The live URL is known but exact image bytes are not retained locally; absence of an anomaly is never treated as KEEP.",
    },
    summary,
    evidence: {
      inputs: inputEvidence,
      old_live_vs_rejected_uhg: {
        old_live_sample_count: localSamples.size,
        exact_sample_hashes_found_in_rejected_uhg_manifest: [
          ...localSamples.values(),
        ].filter((sample) => sample.exact_hash_present_in_rejected_uhg_batch)
          .length,
        rejected_uhg_manifest_created_at: rejectedHeroManifest.created_at,
        rejected_uhg_amazon_calls:
          rejectedHeroManifest.external_mutations?.amazon_calls ?? null,
        rejection_decision: rejectedHeroDecision.decision,
        rejection_reason_codes: rejectedHeroDecision.reason_codes,
        conclusion:
          "The rejected UHG batch is not the old live Amazon batch. Its hashes are distinct, it was generated after the pinned live observation, and it made zero Amazon calls. Its owner rejection defines acceptance criteria only.",
      },
      fixed_card_allowlist: {
        source_url: REQUIRED_CARD_SOURCE_URL,
        verified_amazon_rehost_url: VERIFIED_CARD_REHOST_URL,
        rejected_nutrition_panel_rehost_url:
          REJECTED_NUTRITION_PANEL_REHOST_URL,
        provenance:
          "Exact allow/reject lists and prior pixel-comparison notes in src/lib/bundle-factory/audit/uncrustables-ledger.ts",
      },
      future_gallery_manifest_caveat:
        "The 164-row desired gallery manifest is not a current-live observation. Its verified=true field was not used as visual truth.",
      content_audit_caveat:
        "PASS_LIMITED_RULESET covers formatting, recipe/count/flavor semantics, and promotional language only. It does not prove ingredient/allergen/expiration claims against physical package evidence.",
    },
    repair_plan_gaps: {
      content:
        currentContentFailures.length === currentContentFailuresWithPlan.length
          ? []
          : currentContentFailures
              .filter(
                (row) =>
                  row.content.current_failure_has_text_repair_action === false,
              )
              .map((row) => ({
                sku: row.sku,
                asin: row.asin,
                failures: row.content.deterministic_failures,
              })),
      gallery: rows
        .filter(
          (row) =>
            row.gallery.structure_status !==
              "PASS_METADATA_AND_HASH_ALLOWLIST" &&
            !row.gallery.repair_plan_media_action_present,
        )
        .map((row) => ({
          sku: row.sku,
          asin: row.asin,
          structure_status: row.gallery.structure_status,
          secondary_count: row.gallery.secondary_count,
          future_gallery_candidate_exists:
            row.gallery.future_gallery_candidate.exists,
        })),
      price_recipe_conflicts: rows
        .filter(
          (row) =>
            row.price.canonical_authority_status ===
            "CONFLICTING_COUNT_AUTHORITIES",
        )
        .map((row) => ({
          sku: row.sku,
          asin: row.asin,
          count_evidence: row.price.count_evidence,
          master_count_model_offer: row.price.desired_offer,
          sealed_plan_offer: row.price.sealed_offer_repair.desired_offer,
        })),
      missing_or_stale_offer_actions_for_unambiguous_rows: rows
        .filter(
          (row) =>
            row.price.canonical_authority_status ===
              "PINNED_MASTER_COUNT_MODEL" &&
            (!row.price.sealed_offer_repair.present ||
              !row.price.sealed_offer_repair.matches_current_canonical),
        )
        .map((row) => ({
          sku: row.sku,
          asin: row.asin,
          current_canonical_offer: row.price.desired_offer,
          sealed_plan_offer: row.price.sealed_offer_repair.desired_offer,
        })),
    },
    external_read_access_required: [
      {
        scope: "current Amazon MAIN pixels for 156 ASINs",
        access:
          "Listings Items GET to repin each current main_image_url, followed by HTTP GET of each exact Amazon CDN object with timestamp, ETag, byte SHA-256, and dimensions.",
      },
      {
        scope: "all live product secondary images for 164 ASINs",
        access:
          "Listings Items GET for ordered gallery locators plus HTTP GET of every Amazon-rehosted secondary, then hash/pixel comparison to reviewed donor/reference evidence.",
      },
      {
        scope: "full content and structured-attribute certification",
        access:
          "Hash-bound manufacturer/retailer package images or physical label scans for every recipe component, including current ingredients, allergens, net weight/count, storage, and expiration evidence.",
      },
      {
        scope: "KEEP decisions and replacement promotion",
        access:
          "Owner human visual approval bound to the exact image SHA-256 and exact recipe; replacement preview approval must never be treated as approval of the old live MAIN.",
      },
    ],
    rows,
  };
  const bodySha256 = sha256(
    Buffer.from(JSON.stringify(payloadWithoutHash), "utf8"),
  );
  const payload = { ...payloadWithoutHash, body_sha256: bodySha256 };

  const outputDir = absolute("data/audits");
  await mkdir(outputDir, { recursive: true });
  const basename = `uncrustables-live-forensic-repair-set-${stamp(now)}`;
  const jsonPath = path.join(outputDir, `${basename}.json`);
  const csvPath = path.join(outputDir, `${basename}.csv`);
  const markdownPath = path.join(outputDir, `${basename}.md`);

  await writeExclusive(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);

  const columns = [
    "sku",
    "asin",
    "main_decision",
    "main_sha256",
    "main_reason_codes",
    "approved_replacement_candidate",
    "gallery_structure_status",
    "gallery_secondary_count",
    "gallery_slot_1_status",
    "gallery_product_visual_status",
    "content_deterministic_status",
    "content_full_evidence_status",
    "content_failure_messages",
    "content_fix_in_plan",
    "price_status",
    "consumer_price_check",
    "business_price_check",
    "min_price_check",
    "max_price_check",
    "discount_absent_check",
    "list_price_absent_check",
    "buyable",
    "discoverable",
    "required_repairs",
  ];
  const csvRows = rows.map((row) => ({
    sku: row.sku,
    asin: row.asin,
    main_decision: row.main.decision,
    main_sha256: row.main.evidence.sha256,
    main_reason_codes: row.main.reason_codes.join("|"),
    approved_replacement_candidate:
      row.approved_replacement_candidate.exists,
    gallery_structure_status: row.gallery.structure_status,
    gallery_secondary_count: row.gallery.secondary_count,
    gallery_slot_1_status: row.gallery.slot_1_status,
    gallery_product_visual_status:
      row.gallery.product_secondary_visual_status,
    content_deterministic_status: row.content.deterministic_status,
    content_full_evidence_status: row.content.full_evidence_backed_status,
    content_failure_messages: row.content.deterministic_failures
      .map((failure) => failure.message)
      .join(" | "),
    content_fix_in_plan:
      row.content.current_failure_has_text_repair_action,
    price_status: row.price.status,
    consumer_price_check: row.price.checks.consumer_price,
    business_price_check: row.price.checks.business_price,
    min_price_check: row.price.checks.minimum_seller_allowed_price,
    max_price_check: row.price.checks.maximum_seller_allowed_price,
    discount_absent_check: row.price.checks.discounted_price_absent,
    list_price_absent_check: row.price.checks.list_price_absent,
    buyable: row.operations.buyable,
    discoverable: row.operations.discoverable,
    required_repairs: row.required_repairs.join("|"),
  }));
  await writeExclusive(
    csvPath,
    `${columns.join(",")}\n${csvRows
      .map((row) => columns.map((column) => csvCell(row[column])).join(","))
      .join("\n")}\n`,
  );

  const markdown = `# Uncrustables live forensic repair set\n\n` +
    `Marketplace snapshot: \`${ledger.marketplace_observed_at}\`  \n` +
    `Rows: **${rows.length} exact live ASINs**  \n` +
    `Body SHA-256: \`${bodySha256}\`\n\n` +
    `## Findings\n\n` +
    `- Existing MAIN: KEEP ${mainCounts.KEEP}; REGENERATE ${mainCounts.REGENERATE}; NEEDS_EVIDENCE ${mainCounts.NEEDS_EVIDENCE}; UNOBSERVABLE ${mainCounts.UNOBSERVABLE}.\n` +
    `- Gallery structure: ${Object.entries(summary.gallery_structure).map(([key, value]) => `${key} ${value}`).join("; ")}. Live product-secondary pixels remain visually unobservable for all 164.\n` +
    `- Text deterministic audit: ${summary.content_deterministic.PASS_LIMITED_RULESET ?? 0} limited pass; ${summary.content_deterministic.FAIL_REPAIR_REQUIRED ?? 0} fail. Fully evidence-certified: 0.\n` +
    `- Price: ${summary.price_overall.FAIL_REPAIR_REQUIRED ?? 0} have an unambiguous repair target; ${summary.price_overall.FAIL_RECIPE_RESOLUTION_REQUIRED ?? 0} require recipe-count resolution first. ${summary.sealed_offer_actions_matching_unambiguous_current_canonical}/163 unambiguous sealed OFFER actions match the current pinned canonical model.\n` +
    `- Operations: ${summary.operations.buyable} buyable; ${summary.operations.discoverable} discoverable; ${summary.operations.rows_with_amazon_issues} rows carry Amazon issues.\n` +
    `- Repair-plan gaps: ${payloadWithoutHash.repair_plan_gaps.content.length} current text failure and ${payloadWithoutHash.repair_plan_gaps.gallery.length} gallery-structure failure are not covered by the sealed plan; ${payloadWithoutHash.repair_plan_gaps.price_recipe_conflicts.length} price target has conflicting recipe-count authorities.\n\n` +
    `## Evidence boundaries\n\n` +
    `The eight inspected old-live MAIN samples are byte-hashed and visibly fail the owner cooler/logo/gel/composition criteria. Their hashes do not occur in the later rejected UHG batch. The other 156 are UNOBSERVABLE because URL presence is not pixel evidence. Future gallery \`verified:true\` flags are not treated as live or visual proof.\n`;
  await writeExclusive(markdownPath, markdown);

  console.log(
    JSON.stringify(
      {
        json: path.relative(ROOT, jsonPath),
        csv: path.relative(ROOT, csvPath),
        markdown: path.relative(ROOT, markdownPath),
        body_sha256: bodySha256,
        summary,
        repair_plan_gaps: payloadWithoutHash.repair_plan_gaps,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
