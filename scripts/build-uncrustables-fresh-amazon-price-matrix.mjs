#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PROJECT_ROOT = process.cwd();
const MARKETPLACE_ID = "ATVPDKIKX0DER";

const INPUTS = {
  amazonSnapshot:
    "data/repairs/rollback/uncrustables-owner-relaxed-main-24-live-20260719-v2/UAPS-20260719T030109596Z-46a80e727880-b91e0e79732b.json",
  targetMatrixCsv:
    "data/audits/uncrustables-price-action-matrix-20260719-v1/uncrustables-price-action-matrix-20260719-v1.csv",
  targetMatrixJson:
    "data/audits/uncrustables-price-action-matrix-20260719-v1/uncrustables-price-action-matrix-20260719-v1.json",
  promoProposal:
    "data/repairs/launch-pricing/manifests-v4-proposal/uncrustables-launch-pricing-20260718T181103000Z-75cebdca9037.json",
  channelmaxMassPrewrite:
    "data/repairs/rollback/channelmax-canonical-164-20260719T024515583Z-6a2e9b3211b4/prewrite.json",
  channelmaxMassPostwrite:
    "data/repairs/rollback/channelmax-canonical-164-20260719T024515583Z-6a2e9b3211b4/postwrite.json",
  channelmaxVcCanary:
    "data/repairs/rollback/channelmax-vc-canary-20260719/postwrite.json",
  channelmaxBdCanary:
    "data/repairs/rollback/channelmax-bd-default-canary-20260719/postwrite.json",
  channelmaxQxCanary:
    "data/repairs/rollback/channelmax-qx-fence-recovery-20260719/postwrite.json",
  channelmaxWave1:
    "data/repairs/rollback/channelmax-wave1-effective-price-20260719/postwrite.json",
};

const OUTPUT_DIR =
  "data/audits/uncrustables-fresh-amazon-price-matrix-20260719-v2";
const OUTPUT_BASENAME = "uncrustables-fresh-amazon-price-matrix-20260719-v2";

function fail(message) {
  throw new Error(message);
}

function readBytes(relativePath) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath));
}

function readJson(relativePath) {
  return JSON.parse(readBytes(relativePath).toString("utf8"));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fileEvidence(relativePath) {
  const bytes = readBytes(relativePath);
  let schemaVersion = null;
  let bodySha256 = null;
  if (relativePath.endsWith(".json")) {
    const parsed = JSON.parse(bytes.toString("utf8"));
    schemaVersion = parsed.schema_version ?? null;
    bodySha256 = parsed.body_sha256 ?? parsed.sha256 ?? null;
  }
  return {
    path: relativePath,
    file_sha256: sha256(bytes),
    schema_version: schemaVersion,
    embedded_body_sha256: bodySha256,
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function parseCsv(text) {
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field.replace(/\r$/, ""));
      if (record.some((value) => value !== "")) records.push(record);
      record = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) fail("Unterminated quoted CSV field.");
  if (field !== "" || record.length > 0) {
    record.push(field.replace(/\r$/, ""));
    records.push(record);
  }
  const [header, ...rows] = records;
  if (!header) fail("CSV is empty.");
  return rows.map((values, rowIndex) => {
    if (values.length !== header.length) {
      fail(
        `CSV row ${rowIndex + 2} has ${values.length} columns; expected ${header.length}.`,
      );
    }
    return Object.fromEntries(header.map((name, index) => [name, values[index]]));
  });
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeCsv(rows, columns) {
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
  ].join("\n") + "\n";
}

function asNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) fail(`${label} is not numeric: ${value}`);
  return number;
}

function money(value, label) {
  return Math.round(asNumber(value, label) * 100) / 100;
}

function moneyEqual(left, right) {
  return Math.round(Number(left) * 100) === Math.round(Number(right) * 100);
}

function only(items, label) {
  if (!Array.isArray(items) || items.length !== 1) {
    fail(`${label} must contain exactly one item; found ${items?.length ?? "non-array"}.`);
  }
  return items[0];
}

function scheduleMoney(container, label) {
  const outer = only(container, label);
  const schedule = only(outer.schedule, `${label}.schedule`);
  return money(schedule.value_with_tax, `${label}.value_with_tax`);
}

function splitCodes(value) {
  return String(value ?? "")
    .split("|")
    .map((code) => code.trim())
    .filter(Boolean);
}

function countBy(values) {
  return Object.fromEntries(
    [...values.reduce((counts, value) => {
      counts.set(value, (counts.get(value) ?? 0) + 1);
      return counts;
    }, new Map()).entries()].sort(([left], [right]) =>
      String(left).localeCompare(String(right)),
    ),
  );
}

function uniqueBy(items, key, label) {
  const map = new Map();
  for (const item of items) {
    const value = item[key];
    if (map.has(value)) fail(`Duplicate ${label} ${value}.`);
    map.set(value, item);
  }
  return map;
}

function priceSchedule(value) {
  return [{ schedule: [{ value_with_tax: value }] }];
}

function exactDiscountSchedule(allOffer, capturedAt, sku) {
  if (!Object.prototype.hasOwnProperty.call(allOffer, "discounted_price")) {
    return {
      present: false,
      active_at_capture: false,
      value_with_tax: null,
      start_at: null,
      end_at: null,
      exact_value_sha256: null,
    };
  }
  const outer = only(allOffer.discounted_price, `${sku} discounted_price`);
  const schedule = only(outer.schedule, `${sku} discounted_price.schedule`);
  const value = money(
    schedule.value_with_tax,
    `${sku} discounted_price.value_with_tax`,
  );
  const start = Date.parse(schedule.start_at);
  const end = Date.parse(schedule.end_at);
  const observed = Date.parse(capturedAt);
  if (![start, end, observed].every(Number.isFinite)) {
    fail(`${sku} has an invalid discounted_price window or captured_at.`);
  }
  return {
    present: true,
    active_at_capture: observed >= start && observed <= end,
    value_with_tax: value,
    start_at: schedule.start_at,
    end_at: schedule.end_at,
    exact_value_sha256: sha256(stableJson(allOffer.discounted_price)),
  };
}

const amazonSnapshot = readJson(INPUTS.amazonSnapshot);
const targetMatrixJson = readJson(INPUTS.targetMatrixJson);
const targetRows = parseCsv(readBytes(INPUTS.targetMatrixCsv).toString("utf8"));
const promoProposal = readJson(INPUTS.promoProposal);
const channelmaxPrewrite = readJson(INPUTS.channelmaxMassPrewrite);
const channelmaxPostwrite = readJson(INPUTS.channelmaxMassPostwrite);
const channelmaxVc = readJson(INPUTS.channelmaxVcCanary);
const channelmaxBd = readJson(INPUTS.channelmaxBdCanary);
const channelmaxQx = readJson(INPUTS.channelmaxQxCanary);
const channelmaxWave1 = readJson(INPUTS.channelmaxWave1);

if (amazonSnapshot.schema_version !== "uncrustables-amazon-prechange-snapshot/v1") {
  fail(`Unexpected Amazon snapshot schema ${amazonSnapshot.schema_version}.`);
}
if (amazonSnapshot.capture_mode !== "LIVE_SP_API" || amazonSnapshot.external_mutations) {
  fail("Amazon source must be a read-only LIVE_SP_API snapshot.");
}
if (amazonSnapshot.entries.length !== 164 || targetRows.length !== 164) {
  fail(
    `Expected 164 Amazon and target rows; found ${amazonSnapshot.entries.length} and ${targetRows.length}.`,
  );
}
if (promoProposal.decision?.revision_status !== "PROPOSED_OWNER_APPROVAL_REQUIRED") {
  fail("Promo proposal no longer has the expected unapproved status.");
}
if (channelmaxPostwrite.summary?.result !== "PASS") {
  fail("ChannelMAX mass postwrite is not PASS.");
}

const targetBySku = uniqueBy(targetRows, "sku", "target SKU");
const amazonBySku = uniqueBy(amazonSnapshot.entries, "sku", "Amazon SKU");
const promoBySku = uniqueBy(promoProposal.rows, "sku", "promo SKU");
const holdsBySku = uniqueBy(
  channelmaxPostwrite.identity_holds,
  "sku",
  "ChannelMAX identity hold SKU",
);
const expectedHoldSkus = ["SZ-ASPI-JFAT", "TY-AST2-JE9P", "VN-AS1A-D572"];
if (
  stableJson([...holdsBySku.keys()].sort()) !== stableJson(expectedHoldSkus.slice().sort())
) {
  fail(`Unexpected ChannelMAX identity hold set: ${[...holdsBySku.keys()].join(", ")}.`);
}

for (const sku of targetBySku.keys()) {
  if (!amazonBySku.has(sku)) fail(`Amazon snapshot is missing target SKU ${sku}.`);
}
for (const sku of amazonBySku.keys()) {
  if (!targetBySku.has(sku)) fail(`Amazon snapshot contains unknown SKU ${sku}.`);
}

const massRows = channelmaxPostwrite.waves.flatMap((wave) => wave.rows);
const massBySku = uniqueBy(massRows, "sku", "ChannelMAX mass postwrite SKU");
if (massRows.length !== 152) fail(`Expected 152 ChannelMAX mass rows; found ${massRows.length}.`);

const earlierConfirmed = new Map();
earlierConfirmed.set(channelmaxVc.row.sku, {
  sku: channelmaxVc.row.sku,
  asin: channelmaxVc.row.asin,
  price: money(targetBySku.get(channelmaxVc.row.sku).target_regular, "VC target price"),
  minimum_price: money(channelmaxVc.readback.minimum_price, "VC minimum"),
  maximum_price: money(channelmaxVc.readback.maximum_price, "VC maximum"),
  evidence: "VC_CANARY_PLUS_MASS_PREWRITE_ALREADY_CANONICAL",
});
for (const canary of [channelmaxBd, channelmaxQx]) {
  earlierConfirmed.set(canary.row.sku, {
    sku: canary.row.sku,
    asin: canary.row.asin,
    price: money(canary.after.price, `${canary.row.sku} ChannelMAX price`),
    minimum_price: money(
      canary.after.minimum_price,
      `${canary.row.sku} ChannelMAX minimum`,
    ),
    maximum_price: money(
      canary.after.maximum_price,
      `${canary.row.sku} ChannelMAX maximum`,
    ),
    evidence: "INLINE_CANARY_READBACK_PLUS_MASS_PREWRITE_ALREADY_CANONICAL",
  });
}
for (const row of channelmaxWave1.rows) {
  earlierConfirmed.set(row.sku, {
    ...row,
    evidence: "WAVE1_READBACK_PLUS_MASS_PREWRITE_ALREADY_CANONICAL",
  });
}
if (earlierConfirmed.size !== 9) {
  fail(`Expected nine pre-confirmed ChannelMAX rows; found ${earlierConfirmed.size}.`);
}

const nonHeldSkus = [...targetBySku.keys()].filter((sku) => !holdsBySku.has(sku));
const massOrEarlier = new Set([...massBySku.keys(), ...earlierConfirmed.keys()]);
if (
  massOrEarlier.size !== 161 ||
  nonHeldSkus.some((sku) => !massOrEarlier.has(sku))
) {
  fail("ChannelMAX evidence does not reconcile to exactly 161 non-held rows.");
}

const promoExclusionBySku = new Map([
  ...promoProposal.exclusions.map((entry) => [entry.sku, entry]),
  ...promoProposal.pre_assignment_exclusions.map((entry) => [entry.sku, entry]),
]);

const rows = targetRows
  .map((targetRaw) => {
    const ordinal = asNumber(targetRaw.ordinal, `${targetRaw.sku} ordinal`);
    const target = {
      tier_count: asNumber(targetRaw.tier_count, `${targetRaw.sku} tier_count`),
      regular_base: money(targetRaw.target_regular, `${targetRaw.sku} target regular`),
      minimum: money(targetRaw.target_minimum, `${targetRaw.sku} target minimum`),
      maximum: money(targetRaw.target_maximum, `${targetRaw.sku} target maximum`),
      b2b: money(targetRaw.target_regular, `${targetRaw.sku} target B2B`),
    };
    const entry = amazonBySku.get(targetRaw.sku);
    const allOffer = only(
      entry.listing.attributes.purchasable_offer.filter(
        (offer) =>
          offer.audience === "ALL" && offer.marketplace_id === MARKETPLACE_ID,
      ),
      `${entry.sku} Amazon ALL offer selector`,
    );
    const topB2c = only(
      entry.listing.offers.filter(
        (offer) =>
          offer.marketplaceId === MARKETPLACE_ID &&
          (offer.offerType === "B2C" || offer.audience?.value === "ALL"),
      ),
      `${entry.sku} top-level B2C offer`,
    );
    const topB2b = only(
      entry.listing.offers.filter(
        (offer) =>
          offer.marketplaceId === MARKETPLACE_ID &&
          (offer.offerType === "B2B" || offer.audience?.value === "B2B"),
      ),
      `${entry.sku} top-level B2B offer`,
    );
    const regular = scheduleMoney(allOffer.our_price, `${entry.sku} our_price`);
    const minimum = scheduleMoney(
      allOffer.minimum_seller_allowed_price,
      `${entry.sku} minimum_seller_allowed_price`,
    );
    const maximum = scheduleMoney(
      allOffer.maximum_seller_allowed_price,
      `${entry.sku} maximum_seller_allowed_price`,
    );
    const b2b = money(topB2b.price.amount, `${entry.sku} B2B offer`);
    const liveB2c = money(topB2c.price.amount, `${entry.sku} B2C offer`);
    const discountedPrice = exactDiscountSchedule(allOffer, entry.captured_at, entry.sku);
    const listPriceRaw = entry.listing.attributes.list_price?.[0]?.value;
    const listPrice = listPriceRaw == null
      ? null
      : money(listPriceRaw, `${entry.sku} list_price`);

    const fieldStatus = {
      regular_base: moneyEqual(regular, target.regular_base) ? "MATCH" : "MISMATCH",
      minimum: moneyEqual(minimum, target.minimum) ? "MATCH" : "MISMATCH",
      maximum: moneyEqual(maximum, target.maximum) ? "MATCH" : "MISMATCH",
      b2b: moneyEqual(b2b, target.b2b) ? "MATCH" : "MISMATCH",
    };
    const mismatchFields = Object.entries(fieldStatus)
      .filter(([, status]) => status === "MISMATCH")
      .map(([field]) => field);
    const identityHold = holdsBySku.get(entry.sku) ?? null;
    const historicalHoldCodes = [
      ...splitCodes(targetRaw.failure_codes),
      ...splitCodes(targetRaw.blocker_codes),
    ].filter((code) =>
      code.includes("IDENTITY") || code.includes("8541"),
    );
    const identityReasonCodes = [...new Set([
      ...(identityHold ? [identityHold.reason] : []),
      ...historicalHoldCodes,
    ])].sort();

    const mergeAll = {
      marketplace_id: MARKETPLACE_ID,
      currency: "USD",
      audience: "ALL",
    };
    if (fieldStatus.regular_base === "MISMATCH") {
      mergeAll.our_price = priceSchedule(target.regular_base);
    }
    if (fieldStatus.minimum === "MISMATCH") {
      mergeAll.minimum_seller_allowed_price = priceSchedule(target.minimum);
    }
    if (fieldStatus.maximum === "MISMATCH") {
      mergeAll.maximum_seller_allowed_price = priceSchedule(target.maximum);
    }
    const mergeValue = [];
    if (Object.keys(mergeAll).length > 3) mergeValue.push(mergeAll);
    if (fieldStatus.b2b === "MISMATCH") {
      mergeValue.push({
        marketplace_id: MARKETPLACE_ID,
        currency: "USD",
        audience: "B2B",
        our_price: priceSchedule(target.b2b),
      });
    }
    if (stableJson(mergeValue).includes("discounted_price")) {
      fail(`${entry.sku} surgical diff unexpectedly contains discounted_price.`);
    }

    const patchDisposition = identityHold
      ? "HOLD_IDENTITY"
      : mismatchFields.length > 0
        ? "PATCH_REQUIRED"
        : "NO_PATCH";
    const listingEffectiveAfterPatch =
      discountedPrice.active_at_capture &&
      discountedPrice.value_with_tax < target.regular_base
        ? discountedPrice.value_with_tax
        : target.regular_base;
    const promo = promoBySku.get(entry.sku) ?? null;
    const promoExclusion = promoExclusionBySku.get(entry.sku) ?? null;
    const promoState = identityHold
      ? "IDENTITY_HELD_NO_EXECUTION"
      : promoExclusion
        ? "IDENTITY_EXCLUDED_NO_EXECUTION"
      : promo
        ? "V4_PROPOSED_OWNER_APPROVAL_REQUIRED"
        : "PRE_ASSIGNMENT_EXCLUDED_NO_EXECUTION";

    let channelmax;
    if (identityHold) {
      channelmax = {
        status: "HOLD_IDENTITY",
        hold_asin: identityHold.asin,
        reason: identityHold.reason,
        confirmed_at: channelmaxPostwrite.confirmed_at,
      };
    } else {
      const exact = massBySku.get(entry.sku) ?? earlierConfirmed.get(entry.sku);
      if (!exact) fail(`Missing ChannelMAX evidence for ${entry.sku}.`);
      const exactPrice = money(exact.price, `${entry.sku} ChannelMAX price`);
      const exactMinimum = money(
        exact.minimum_price,
        `${entry.sku} ChannelMAX minimum`,
      );
      const exactMaximum = money(
        exact.maximum_price,
        `${entry.sku} ChannelMAX maximum`,
      );
      if (
        !moneyEqual(exactPrice, target.regular_base) ||
        !moneyEqual(exactMinimum, target.minimum) ||
        !moneyEqual(exactMaximum, target.maximum)
      ) {
        fail(`${entry.sku} ChannelMAX evidence is not canonical.`);
      }
      channelmax = {
        status: "CANONICAL_CONFIRMED",
        price: exactPrice,
        minimum: exactMinimum,
        maximum: exactMaximum,
        evidence: massBySku.has(entry.sku)
          ? "MASS_WAVE_INDEPENDENT_READBACK"
          : exact.evidence,
        confirmed_at: channelmaxPostwrite.confirmed_at,
      };
    }

    return {
      ordinal,
      listing_key: `amazon:${entry.store_index}:${entry.sku}`,
      store_index: entry.store_index,
      sku: entry.sku,
      asin: entry.asin,
      target_asin: targetRaw.asin,
      captured_at: entry.captured_at,
      identity: {
        status: identityHold ? "HOLD_IDENTITY" : "EXACT_SCOPE_MATCH",
        amazon_asin_matches_target: entry.asin === targetRaw.asin,
        channelmax_hold_asin: identityHold?.asin ?? null,
        amazon_asin_matches_channelmax_hold_asin: identityHold
          ? entry.asin === identityHold.asin
          : null,
        reason_codes: identityReasonCodes,
      },
      target,
      amazon: {
        regular_base: regular,
        minimum_seller_allowed_price: minimum,
        maximum_seller_allowed_price: maximum,
        b2b_price: b2b,
        live_b2c_effective_price: liveB2c,
        list_price: listPrice,
        discounted_price: discountedPrice,
        issue_codes: (entry.listing.issues ?? []).map((issue) => issue.code).sort(),
      },
      promo_strategy: {
        source_status: promoState,
        owner_approval_status: promoProposal.decision.revision_status,
        arm: promo?.arm ?? null,
        lever: promo?.lever ?? null,
        discount_percent: promo?.discount_percent ?? null,
        proposed_effective_price: promo?.effective_price ?? null,
        proposed_sale_price_schedule: promo?.sale_price_schedule ?? null,
        exclusion_reason: promoExclusion?.reason ?? null,
        live_coupon_application_evidence:
          promo?.arm === "A" ? "UNKNOWN_NOT_EXPOSED_BY_SOURCE_SNAPSHOT" : "NOT_APPLICABLE",
        execution_proposed_by_this_audit: false,
      },
      channelmax,
      comparison: {
        field_status: fieldStatus,
        mismatch_fields: mismatchFields,
        listing_effective_after_base_patch: listingEffectiveAfterPatch,
        listing_effective_after_base_patch_source:
          discountedPrice.active_at_capture &&
          discountedPrice.value_with_tax < target.regular_base
            ? "PRESERVED_ACTIVE_DISCOUNTED_PRICE"
            : "TARGET_REGULAR_BASE",
        live_b2c_vs_expected_after_patch: moneyEqual(
          liveB2c,
          listingEffectiveAfterPatch,
        )
          ? "MATCH"
          : "MISMATCH",
      },
      surgical_base_patch: {
        disposition: patchDisposition,
        mismatch_fields: mismatchFields,
        patch:
          patchDisposition === "PATCH_REQUIRED"
            ? {
                op: "merge",
                path: "/attributes/purchasable_offer",
                value: mergeValue,
              }
            : null,
        preserve_discounted_price_exactly: true,
        discounted_price_member_present_in_patch: false,
        list_price_action: "UNCHANGED_OUT_OF_SCOPE",
        promo_action: "UNCHANGED_SEPARATE_OWNER_GATE",
      },
    };
  })
  .sort((left, right) => left.ordinal - right.ordinal);

if (rows.length !== 164) fail(`Output row count is ${rows.length}, not 164.`);
if (rows.some((row) => row.asin !== row.target_asin)) {
  fail("Fresh Amazon ASIN scope no longer matches the target matrix.");
}
if (rows.some((row) => row.surgical_base_patch.discounted_price_member_present_in_patch)) {
  fail("At least one patch proposes changing discounted_price.");
}

const patchRows = rows.filter(
  (row) => row.surgical_base_patch.disposition === "PATCH_REQUIRED",
);
const noPatchRows = rows.filter(
  (row) => row.surgical_base_patch.disposition === "NO_PATCH",
);
const holdRows = rows.filter(
  (row) => row.surgical_base_patch.disposition === "HOLD_IDENTITY",
);
const rawMismatchRows = rows.filter(
  (row) => row.comparison.mismatch_fields.length > 0,
);
const activeSaleRows = rows.filter(
  (row) => row.amazon.discounted_price.active_at_capture,
);
const issueCodes = rows.flatMap((row) => row.amazon.issue_codes);
const mismatchFieldCounts = Object.fromEntries(
  ["regular_base", "minimum", "maximum", "b2b"].map((field) => [
    field,
    rows.filter((row) => row.comparison.field_status[field] === "MISMATCH").length,
  ]),
);
const eligibleMismatchFieldCounts = Object.fromEntries(
  ["regular_base", "minimum", "maximum", "b2b"].map((field) => [
    field,
    patchRows.filter((row) => row.comparison.field_status[field] === "MISMATCH").length,
  ]),
);

const generatedAt = new Date().toISOString();
const artifactWithoutHash = {
  schema_version: "uncrustables-fresh-amazon-price-matrix/v1",
  immutable: true,
  generated_at: generatedAt,
  read_only: true,
  external_mutations: 0,
  scope: {
    expected_rows: 164,
    amazon_rows: amazonSnapshot.entries.length,
    target_rows: targetRows.length,
    output_rows: rows.length,
    unique_skus: new Set(rows.map((row) => row.sku)).size,
    unique_asins: new Set(rows.map((row) => row.asin)).size,
    store_indices: [...new Set(rows.map((row) => row.store_index))].sort(),
    marketplace_id: MARKETPLACE_ID,
    amazon_snapshot_id: amazonSnapshot.snapshot_id,
    amazon_snapshot_completed_at: amazonSnapshot.completed_at,
  },
  semantics: {
    canonical_target:
      "The per-row regular/minimum/maximum targets come from the sealed 70%-ROI target matrix and are independently reconciled to the ChannelMAX canonical postwrite.",
    regular_base:
      "Amazon ALL.audience purchasable_offer.our_price is the Standard/regular base price. It is not list_price and is not inferred from the lower live B2C offer.",
    b2b:
      "Amazon Business price is read from the marketplace-observed top-level B2B offer because Listings Items attributes omit most B2B selectors. Canon requires B2B equal to regular base.",
    discounted_price:
      "discounted_price is an independent Sales Price schedule. Every proposed base-price merge omits this member, so an existing schedule is preserved byte-for-byte and no absent schedule is removed or created.",
    list_price:
      "list_price is recorded only to keep it distinct from regular base and Sales Price; this audit proposes no list_price mutation.",
    coupon:
      "Coupon application is not exposed by this Listings Items snapshot. Coupon fields are copied only from the unapproved v4 strategy proposal and remain UNKNOWN live; this audit proposes no coupon action.",
    promo_gate:
      "The v4 coupon/Sales Price manifest remains PROPOSED_OWNER_APPROVAL_REQUIRED. Existing live Sales Price schedules are current evidence and are not revised to v4 by this audit.",
    patch_rule:
      "A non-identity-held row requires one selector-aware /attributes/purchasable_offer merge when regular base, min, max, or B2B differs from target. Only mismatched members are included; discounted_price, list_price, quantities, metadata, and promo state are omitted.",
  },
  sources: Object.fromEntries(
    Object.entries(INPUTS).map(([name, relativePath]) => [name, fileEvidence(relativePath)]),
  ),
  source_assertions: {
    amazon_snapshot_internal_sha256: amazonSnapshot.sha256,
    target_matrix_v1_status: targetMatrixJson.semantics?.v4_status ?? null,
    promo_revision_status: promoProposal.decision.revision_status,
    channelmax_postwrite_result: channelmaxPostwrite.summary.result,
    channelmax_postwrite_confirmed_at: channelmaxPostwrite.confirmed_at,
    amazon_snapshot_completed_after_channelmax_seconds:
      (Date.parse(amazonSnapshot.completed_at) -
        Date.parse(channelmaxPostwrite.confirmed_at)) /
      1000,
    channelmax_final_candidate_mismatches:
      channelmaxPostwrite.summary.final_candidate_mismatches,
  },
  summary: {
    disposition: countBy(
      rows.map((row) => row.surgical_base_patch.disposition),
    ),
    raw_amazon_offer_mismatch_rows: rawMismatchRows.length,
    eligible_surgical_base_patch_rows: patchRows.length,
    identity_hold_rows: holdRows.length,
    no_patch_rows: noPatchRows.length,
    mismatch_fields_all_rows: mismatchFieldCounts,
    mismatch_fields_eligible_rows: eligibleMismatchFieldCounts,
    eligible_patch_field_combinations: countBy(
      patchRows.map((row) => row.comparison.mismatch_fields.join("|")),
    ),
    discounted_price: {
      present_rows: rows.filter((row) => row.amazon.discounted_price.present).length,
      active_at_capture_rows: activeSaleRows.length,
      active_sale_rows_requiring_base_patch: patchRows.filter(
        (row) => row.amazon.discounted_price.active_at_capture,
      ).length,
      active_sale_rows_held_for_identity: holdRows.filter(
        (row) => row.amazon.discounted_price.active_at_capture,
      ).length,
      patch_rows_that_change_or_remove_discounted_price: 0,
    },
    live_b2c_effect_after_patch: countBy(
      rows.map((row) => row.comparison.live_b2c_vs_expected_after_patch),
    ),
    promo_strategy: {
      owner_approval_status: promoProposal.decision.revision_status,
      arm: countBy(rows.map((row) => row.promo_strategy.arm ?? "NONE")),
      source_status: countBy(rows.map((row) => row.promo_strategy.source_status)),
      coupon_live_application_proven: 0,
      promo_mutations_proposed: 0,
    },
    channelmax: {
      canonical_confirmed_rows: rows.filter(
        (row) => row.channelmax.status === "CANONICAL_CONFIRMED",
      ).length,
      identity_hold_rows: rows.filter(
        (row) => row.channelmax.status === "HOLD_IDENTITY",
      ).length,
      final_candidate_mismatches:
        channelmaxPostwrite.summary.final_candidate_mismatches,
    },
    amazon_issue_codes: countBy(issueCodes),
  },
  action_index: {
    patch_required: {
      count: patchRows.length,
      ordinals: patchRows.map((row) => row.ordinal),
      skus: patchRows.map((row) => row.sku),
    },
    no_patch: {
      count: noPatchRows.length,
      ordinals: noPatchRows.map((row) => row.ordinal),
      skus: noPatchRows.map((row) => row.sku),
    },
    hold_identity: {
      count: holdRows.length,
      rows: holdRows.map((row) => ({
        ordinal: row.ordinal,
        sku: row.sku,
        asin: row.asin,
        channelmax_hold_asin: row.identity.channelmax_hold_asin,
        reason_codes: row.identity.reason_codes,
        raw_mismatch_fields: row.comparison.mismatch_fields,
      })),
    },
  },
  rows,
};
const artifact = {
  ...artifactWithoutHash,
  body_sha256: sha256(stableJson(artifactWithoutHash)),
};

const csvRows = rows.map((row) => ({
  ordinal: row.ordinal,
  listing_key: row.listing_key,
  sku: row.sku,
  asin: row.asin,
  tier_count: row.target.tier_count,
  identity_status: row.identity.status,
  identity_reason_codes: row.identity.reason_codes.join("|"),
  target_regular_base: row.target.regular_base,
  target_minimum: row.target.minimum,
  target_maximum: row.target.maximum,
  target_b2b: row.target.b2b,
  amazon_regular_base: row.amazon.regular_base,
  regular_status: row.comparison.field_status.regular_base,
  amazon_minimum: row.amazon.minimum_seller_allowed_price,
  minimum_status: row.comparison.field_status.minimum,
  amazon_maximum: row.amazon.maximum_seller_allowed_price,
  maximum_status: row.comparison.field_status.maximum,
  amazon_b2b: row.amazon.b2b_price,
  b2b_status: row.comparison.field_status.b2b,
  amazon_live_b2c: row.amazon.live_b2c_effective_price,
  amazon_list_price: row.amazon.list_price,
  discounted_price_present: row.amazon.discounted_price.present,
  discounted_price_active: row.amazon.discounted_price.active_at_capture,
  discounted_price_value: row.amazon.discounted_price.value_with_tax,
  discounted_price_start_at: row.amazon.discounted_price.start_at,
  discounted_price_end_at: row.amazon.discounted_price.end_at,
  promo_arm: row.promo_strategy.arm,
  promo_lever: row.promo_strategy.lever,
  promo_discount_percent: row.promo_strategy.discount_percent,
  promo_owner_approval_status: row.promo_strategy.owner_approval_status,
  coupon_live_application_evidence:
    row.promo_strategy.live_coupon_application_evidence,
  patch_disposition: row.surgical_base_patch.disposition,
  patch_mismatch_fields: row.surgical_base_patch.mismatch_fields.join("|"),
  preserve_discounted_price_exactly:
    row.surgical_base_patch.preserve_discounted_price_exactly,
  expected_listing_effective_after_patch:
    row.comparison.listing_effective_after_base_patch,
  live_b2c_vs_expected_after_patch:
    row.comparison.live_b2c_vs_expected_after_patch,
  channelmax_status: row.channelmax.status,
  amazon_issue_codes: row.amazon.issue_codes.join("|"),
}));
const csvColumns = [
  "ordinal",
  "listing_key",
  "sku",
  "asin",
  "tier_count",
  "identity_status",
  "identity_reason_codes",
  "target_regular_base",
  "target_minimum",
  "target_maximum",
  "target_b2b",
  "amazon_regular_base",
  "regular_status",
  "amazon_minimum",
  "minimum_status",
  "amazon_maximum",
  "maximum_status",
  "amazon_b2b",
  "b2b_status",
  "amazon_live_b2c",
  "amazon_list_price",
  "discounted_price_present",
  "discounted_price_active",
  "discounted_price_value",
  "discounted_price_start_at",
  "discounted_price_end_at",
  "promo_arm",
  "promo_lever",
  "promo_discount_percent",
  "promo_owner_approval_status",
  "coupon_live_application_evidence",
  "patch_disposition",
  "patch_mismatch_fields",
  "preserve_discounted_price_exactly",
  "expected_listing_effective_after_patch",
  "live_b2c_vs_expected_after_patch",
  "channelmax_status",
  "amazon_issue_codes",
];
const csv = writeCsv(csvRows, csvColumns);

const summaryMarkdown = `# Fresh Amazon Uncrustables price matrix — 2026-07-19\n\n` +
  `Read-only comparison of the 164-row fresh SP-API snapshot against the canonical 70%-ROI targets and the confirmed ChannelMAX state.\n\n` +
  `- Amazon rows: **${rows.length}**\n` +
  `- Surgical base-price patches required: **${patchRows.length}**\n` +
  `- Already exact / no patch: **${noPatchRows.length}**\n` +
  `- Identity holds: **${holdRows.length}** — ${holdRows.map((row) => row.sku).join(", ")}\n` +
  `- Active Sales Price schedules preserved: **${activeSaleRows.length}**\n` +
  `- Proposed patches changing/removing discounted_price: **0**\n` +
  `- ChannelMAX canonical: **${rows.length - holdRows.length}/164**\n` +
  `- Coupon application proven by the Listings snapshot: **0** (not observable in this source)\n` +
  `- Promo v4 status: **${promoProposal.decision.revision_status}**\n\n` +
  `This is an offline audit/diff, not an Amazon execution plan or promo approval.\n`;

const absoluteOutputDir = path.join(PROJECT_ROOT, OUTPUT_DIR);
if (fs.existsSync(absoluteOutputDir)) {
  fail(`Immutable output directory already exists: ${OUTPUT_DIR}`);
}
fs.mkdirSync(absoluteOutputDir, { recursive: false });

const jsonPath = path.join(absoluteOutputDir, `${OUTPUT_BASENAME}.json`);
const csvPath = path.join(absoluteOutputDir, `${OUTPUT_BASENAME}.csv`);
const summaryPath = path.join(absoluteOutputDir, `${OUTPUT_BASENAME}.summary.md`);
const jsonBytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
const csvBytes = Buffer.from(csv, "utf8");
const summaryBytes = Buffer.from(summaryMarkdown, "utf8");
fs.writeFileSync(jsonPath, jsonBytes, { flag: "wx" });
fs.writeFileSync(csvPath, csvBytes, { flag: "wx" });
fs.writeFileSync(summaryPath, summaryBytes, { flag: "wx" });
fs.writeFileSync(`${jsonPath}.sha256`, `${sha256(jsonBytes)}  ${path.basename(jsonPath)}\n`, { flag: "wx" });
fs.writeFileSync(`${csvPath}.sha256`, `${sha256(csvBytes)}  ${path.basename(csvPath)}\n`, { flag: "wx" });
fs.writeFileSync(`${summaryPath}.sha256`, `${sha256(summaryBytes)}  ${path.basename(summaryPath)}\n`, { flag: "wx" });

console.log(JSON.stringify({
  output_dir: OUTPUT_DIR,
  json: path.relative(PROJECT_ROOT, jsonPath),
  json_file_sha256: sha256(jsonBytes),
  csv: path.relative(PROJECT_ROOT, csvPath),
  csv_file_sha256: sha256(csvBytes),
  summary: artifact.summary,
}, null, 2));
