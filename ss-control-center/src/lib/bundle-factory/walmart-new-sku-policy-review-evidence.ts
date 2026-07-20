import {
  WALMART_ACCOUNT_EVIDENCE_MAX_AGE_MS,
  WALMART_POLICY_SOURCES,
  WALMART_POLICY_VERSION,
  WALMART_SKU_POLICY_REVIEW_MAX_AGE_MS,
  type WalmartApprovalScope,
} from "./validation/walmart-prepublication-policy";

export const WALMART_NEW_SKU_POLICY_REVIEW_EVIDENCE_SCHEMA =
  "walmart-new-sku-policy-review-evidence/1.0.0" as const;

const FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;
const PLACEHOLDER_TEXT =
  /(?:^|[^A-Z0-9])(?:TODO|TBD)(?:$|[^A-Z0-9])|PLACEHOLDER|TO_FILL|REPLACE_ME|UNKNOWN_EVIDENCE/i;
export const WALMART_NEW_SKU_REQUIRED_POLICY_SOURCE_IDS = [
  "food-products",
  "product-claims",
  "prohibited-products-overview",
  "recalled-products",
  "resold-products",
  "restricted-illegal-products",
] as const;
export const WALMART_NEW_SKU_REQUIRED_POLICY_REVIEW_DOMAIN_IDS = [
  "category-preapproval",
  "condition-resale-rights",
  "food-labeling-prohibited",
  "product-claims",
  "recall-safety",
  "territory-legal-sanctions",
] as const;
const POLICY_SOURCES_BY_ID = new Map<string, string>(
  WALMART_POLICY_SOURCES.map((source) => [source.id, source.url] as const),
);
const REQUIRED_DOMAIN_SOURCES = new Map<string, readonly string[]>([
  ["category-preapproval", ["prohibited-products-overview"]],
  ["condition-resale-rights", ["resold-products"]],
  ["food-labeling-prohibited", ["food-products", "prohibited-products-overview"]],
  ["product-claims", ["product-claims"]],
  ["recall-safety", ["recalled-products"]],
  [
    "territory-legal-sanctions",
    ["prohibited-products-overview", "restricted-illegal-products"],
  ],
]);
const APPROVAL_SCOPES = new Set<WalmartApprovalScope>([
  "INGESTIBLE_PRODUCTS",
  "TOPICAL_PRODUCTS",
  "MEDICAL_DEVICES",
  "FRAGRANCES",
  "LUXURY_BRANDS",
  "SOFTWARE",
  "SEASONAL_PRODUCTS",
  "CUSTOM_CONTENT",
  "JEWELRY_PRECIOUS_GOODS",
  "PET",
  "BABY",
]);

export interface WalmartNewSkuPolicyReviewBinding {
  wave_id: string;
  plan_sha256: string;
  stage_sha256: string;
  candidate_key: string;
  candidate_sha256: string;
  store_index: number;
  business_seller_account_fingerprint_sha256: string;
  sku: string;
  upc: string;
  donor_product_id: string;
  canonical_variant_id: string;
  product_type: string;
}

export interface WalmartNewSkuPolicyReviewEvidence {
  schema_version: typeof WALMART_NEW_SKU_POLICY_REVIEW_EVIDENCE_SCHEMA;
  binding: WalmartNewSkuPolicyReviewBinding;
  policy_version: typeof WALMART_POLICY_VERSION;
  reviewed_at: string;
  reviewer: {
    reviewer_id: string;
    role: "HUMAN_COMPLIANCE_REVIEWER" | "OWNER";
  };
  decision: "CLEARED" | "BLOCKED";
  official_sources: Array<{
    source_id: string;
    url: string;
    captured_at: string;
    checked_at: string;
  }>;
  findings: Array<{
    finding_id: string;
    disposition:
      | "CLEARED"
      | "REQUIRES_APPROVAL"
      | "PROHIBITED"
      | "UNRESOLVED";
    summary: string;
    policy_source_ids: string[];
    required_approval_scopes: WalmartApprovalScope[];
  }>;
  required_category_approvals: Array<{
    scope: WalmartApprovalScope;
    status: "APPROVED";
    verified_at: string;
    evidence_ref: string;
  }>;
}

export interface WalmartNewSkuPolicyReviewValidationContext {
  expected_binding: WalmartNewSkuPolicyReviewBinding;
  certification_policy_review: {
    status: "CLEARED";
    reviewed_at: string;
    evidence_ref: string;
  };
  certification_category_approvals: Array<{
    scope: string;
    status: "APPROVED" | "NOT_REQUIRED";
    verified_at: string;
    evidence_ref: string;
  }>;
  artifact: {
    ref: string;
    captured_at: string;
    source_url: string | null;
  };
  now: Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
  failures: string[],
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    failures.push(`${label}_FIELDS_INVALID`);
  }
}

function hasText(value: unknown, minimum = 1): value is string {
  return (
    typeof value === "string" &&
    value.trim().length >= minimum &&
    value.length <= 2_048 &&
    !PLACEHOLDER_TEXT.test(value)
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function parsedTime(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : null;
}

function isSortedUniqueStrings(value: unknown[]): value is string[] {
  return (
    value.every((item) => typeof item === "string") &&
    value.every((item, index) => index === 0 || String(value[index - 1]) < item)
  );
}

function isFreshPastIso(value: unknown, maxAgeMs: number, now: Date): boolean {
  const parsed = parsedTime(value);
  return (
    parsed !== null &&
    parsed <= now.getTime() + FUTURE_TOLERANCE_MS &&
    now.getTime() - parsed <= maxAgeMs
  );
}

function isEvidenceReference(value: unknown): value is string {
  if (!hasText(value, 12)) return false;
  return /^(?:https:\/\/|[a-z][a-z0-9+.-]{1,31}:)\S+$/i.test(value.trim());
}

function isOfficialWalmartPolicyUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4_096) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      [
        "marketplacelearn.walmart.com",
        "developer.walmart.com",
        "sellerhelp.walmart.com",
        "corporate.walmart.com",
      ].includes(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Walmart policy review evidence invalid: POLICY_REVIEW_UTF8_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Walmart policy review evidence invalid: POLICY_REVIEW_JSON_INVALID");
  }
  if (!isRecord(parsed)) {
    throw new Error("Walmart policy review evidence invalid: POLICY_REVIEW_ROOT_INVALID");
  }
  if (text !== `${JSON.stringify(parsed, null, 2)}\n`) {
    throw new Error(
      "Walmart policy review evidence invalid: POLICY_REVIEW_JSON_NONCANONICAL",
    );
  }
  return parsed;
}

/** Lightweight pre-seal check. It accepts unresolved/TODO review decisions but
 * requires the exact schema/policy and immutable plan-stage-candidate binding
 * in the same bytes that the sealer hashes. */
export function assertWalmartNewSkuPolicyReviewEvidenceBindingBytes(input: {
  bytes: Uint8Array;
  expected_binding: WalmartNewSkuPolicyReviewBinding;
}): void {
  const raw = parseJsonObject(input.bytes);
  const failures: string[] = [];
  exactKeys(
    raw,
    [
      "schema_version",
      "binding",
      "policy_version",
      "reviewed_at",
      "reviewer",
      "decision",
      "official_sources",
      "findings",
      "required_category_approvals",
    ],
    "POLICY_REVIEW",
    failures,
  );
  if (raw.schema_version !== WALMART_NEW_SKU_POLICY_REVIEW_EVIDENCE_SCHEMA) {
    failures.push("POLICY_REVIEW_SCHEMA_UNSUPPORTED");
  }
  if (raw.policy_version !== WALMART_POLICY_VERSION) {
    failures.push("POLICY_REVIEW_POLICY_VERSION_MISMATCH");
  }
  if (!isRecord(raw.binding)) {
    failures.push("POLICY_REVIEW_BINDING_INVALID");
  } else {
    exactKeys(
      raw.binding,
      Object.keys(input.expected_binding),
      "POLICY_REVIEW_BINDING",
      failures,
    );
    for (const [key, expected] of Object.entries(input.expected_binding)) {
      if (raw.binding[key] !== expected) {
        failures.push(`POLICY_REVIEW_BINDING_MISMATCH:${key}`);
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Walmart policy review evidence binding invalid: ${[...new Set(failures)].join("; ")}`,
    );
  }
}

/**
 * Parses the exact hashed POLICY_REVIEW artifact bytes and enforces a strict,
 * candidate-bound human/owner review contract. This does not claim that local
 * screening covers Walmart's policy universe; it makes the mandatory reviewed
 * evidence machine-verifiable and fail-closed.
 */
export function parseAndValidateWalmartNewSkuPolicyReviewEvidence(input: {
  bytes: Uint8Array;
  context: WalmartNewSkuPolicyReviewValidationContext;
}): WalmartNewSkuPolicyReviewEvidence {
  const raw = parseJsonObject(input.bytes);
  const failures: string[] = [];
  exactKeys(
    raw,
    [
      "schema_version",
      "binding",
      "policy_version",
      "reviewed_at",
      "reviewer",
      "decision",
      "official_sources",
      "findings",
      "required_category_approvals",
    ],
    "POLICY_REVIEW",
    failures,
  );

  if (raw.schema_version !== WALMART_NEW_SKU_POLICY_REVIEW_EVIDENCE_SCHEMA) {
    failures.push("POLICY_REVIEW_SCHEMA_UNSUPPORTED");
  }
  if (raw.policy_version !== WALMART_POLICY_VERSION) {
    failures.push("POLICY_REVIEW_POLICY_VERSION_MISMATCH");
  }
  if (
    raw.reviewed_at !== input.context.certification_policy_review.reviewed_at ||
    raw.reviewed_at !== input.context.artifact.captured_at ||
    !isFreshPastIso(raw.reviewed_at, WALMART_SKU_POLICY_REVIEW_MAX_AGE_MS, input.context.now)
  ) {
    failures.push("POLICY_REVIEW_REVIEWED_AT_INVALID");
  }
  if (
    input.context.certification_policy_review.status !== "CLEARED" ||
    input.context.certification_policy_review.evidence_ref !== input.context.artifact.ref ||
    raw.decision !== "CLEARED"
  ) {
    failures.push("POLICY_REVIEW_DECISION_INVALID");
  }

  if (!isRecord(raw.binding)) {
    failures.push("POLICY_REVIEW_BINDING_INVALID");
  } else {
    exactKeys(
      raw.binding,
      [
        "wave_id",
        "plan_sha256",
        "stage_sha256",
        "candidate_key",
        "candidate_sha256",
        "store_index",
        "business_seller_account_fingerprint_sha256",
        "sku",
        "upc",
        "donor_product_id",
        "canonical_variant_id",
        "product_type",
      ],
      "POLICY_REVIEW_BINDING",
      failures,
    );
    const expected = input.context.expected_binding as unknown as Record<string, unknown>;
    for (const key of Object.keys(expected)) {
      if (raw.binding[key] !== expected[key]) {
        failures.push(`POLICY_REVIEW_BINDING_MISMATCH:${key}`);
      }
    }
    if (
      !isSha256(raw.binding.plan_sha256) ||
      !isSha256(raw.binding.stage_sha256) ||
      !isSha256(raw.binding.candidate_sha256) ||
      !isSha256(raw.binding.business_seller_account_fingerprint_sha256)
    ) {
      failures.push("POLICY_REVIEW_BINDING_HASH_INVALID");
    }
  }

  if (!isRecord(raw.reviewer)) {
    failures.push("POLICY_REVIEW_REVIEWER_INVALID");
  } else {
    exactKeys(raw.reviewer, ["reviewer_id", "role"], "POLICY_REVIEW_REVIEWER", failures);
    if (
      !hasText(raw.reviewer.reviewer_id, 3) ||
      !["HUMAN_COMPLIANCE_REVIEWER", "OWNER"].includes(String(raw.reviewer.role))
    ) {
      failures.push("POLICY_REVIEW_REVIEWER_INVALID");
    }
  }

  const sourceIds = new Set<string>();
  const sourceUrls = new Set<string>();
  if (!Array.isArray(raw.official_sources)) {
    failures.push("POLICY_REVIEW_OFFICIAL_SOURCES_INVALID");
  } else {
    if (
      raw.official_sources.length !==
        WALMART_NEW_SKU_REQUIRED_POLICY_SOURCE_IDS.length
    ) {
      failures.push("POLICY_REVIEW_OFFICIAL_SOURCES_INVALID");
    }
    const reviewedAt = parsedTime(raw.reviewed_at);
    for (const [index, source] of raw.official_sources.entries()) {
      if (!isRecord(source)) {
        failures.push(`POLICY_REVIEW_SOURCE_${index}_INVALID`);
        continue;
      }
      exactKeys(
        source,
        ["source_id", "url", "captured_at", "checked_at"],
        `POLICY_REVIEW_SOURCE_${index}`,
        failures,
      );
      const capturedAt = parsedTime(source.captured_at);
      const checkedAt = parsedTime(source.checked_at);
      const expectedSourceUrl = typeof source.source_id === "string"
        ? POLICY_SOURCES_BY_ID.get(source.source_id)
        : undefined;
      if (
        !hasText(source.source_id, 3) ||
        !isOfficialWalmartPolicyUrl(source.url) ||
        !expectedSourceUrl ||
        source.url !== expectedSourceUrl ||
        !isFreshPastIso(
          source.captured_at,
          WALMART_SKU_POLICY_REVIEW_MAX_AGE_MS,
          input.context.now,
        ) ||
        !isFreshPastIso(
          source.checked_at,
          WALMART_SKU_POLICY_REVIEW_MAX_AGE_MS,
          input.context.now,
        ) ||
        reviewedAt === null ||
        capturedAt === null ||
        checkedAt === null ||
        capturedAt > checkedAt + FUTURE_TOLERANCE_MS ||
        capturedAt > reviewedAt + FUTURE_TOLERANCE_MS ||
        checkedAt > reviewedAt + FUTURE_TOLERANCE_MS
      ) {
        failures.push(`POLICY_REVIEW_SOURCE_${index}_INVALID`);
      }
      if (typeof source.source_id === "string") {
        if (sourceIds.has(source.source_id)) {
          failures.push(`POLICY_REVIEW_SOURCE_${index}_DUPLICATE_ID`);
        }
        sourceIds.add(source.source_id);
      }
      if (typeof source.url === "string") sourceUrls.add(source.url);
    }
    const orderedIds = raw.official_sources.map((source) =>
      isRecord(source) ? source.source_id : null,
    );
    if (!isSortedUniqueStrings(orderedIds)) {
      failures.push("POLICY_REVIEW_OFFICIAL_SOURCES_ORDER_INVALID");
    }
    if (
      orderedIds.some(
        (sourceId, index) =>
          sourceId !== WALMART_NEW_SKU_REQUIRED_POLICY_SOURCE_IDS[index],
      )
    ) {
      failures.push("POLICY_REVIEW_REQUIRED_SOURCES_INVALID");
    }
    for (const sourceId of WALMART_NEW_SKU_REQUIRED_POLICY_SOURCE_IDS) {
      if (!sourceIds.has(sourceId)) {
        failures.push(`POLICY_REVIEW_REQUIRED_SOURCE_MISSING:${sourceId}`);
      }
    }
  }
  if (
    input.context.artifact.source_url !== null &&
    !sourceUrls.has(input.context.artifact.source_url)
  ) {
    failures.push("POLICY_REVIEW_ARTIFACT_SOURCE_URL_MISMATCH");
  }

  const approvals = new Map<string, Record<string, unknown>>();
  const certificationApprovedScopes = new Map<string, {
    verified_at: string;
    evidence_ref: string;
  }>();
  for (const approval of input.context.certification_category_approvals) {
    if (approval.status !== "APPROVED") {
      failures.push(`POLICY_REVIEW_CERTIFICATION_NOT_REQUIRED_SCOPE_INVALID:${approval.scope}`);
      continue;
    }
    if (certificationApprovedScopes.has(approval.scope)) {
      failures.push(`POLICY_REVIEW_CERTIFICATION_APPROVAL_SCOPE_DUPLICATE:${approval.scope}`);
      continue;
    }
    certificationApprovedScopes.set(approval.scope, {
      verified_at: approval.verified_at,
      evidence_ref: approval.evidence_ref,
    });
  }
  if (
    !Array.isArray(raw.required_category_approvals) ||
    raw.required_category_approvals.length === 0 ||
    raw.required_category_approvals.length > APPROVAL_SCOPES.size
  ) {
    failures.push("POLICY_REVIEW_REQUIRED_APPROVALS_INVALID");
  } else {
    for (const [index, approval] of raw.required_category_approvals.entries()) {
      if (!isRecord(approval)) {
        failures.push(`POLICY_REVIEW_APPROVAL_${index}_INVALID`);
        continue;
      }
      exactKeys(
        approval,
        ["scope", "status", "verified_at", "evidence_ref"],
        `POLICY_REVIEW_APPROVAL_${index}`,
        failures,
      );
      const scope = approval.scope;
      if (
        typeof scope !== "string" ||
        !APPROVAL_SCOPES.has(scope as WalmartApprovalScope) ||
        approval.status !== "APPROVED" ||
        !isFreshPastIso(
          approval.verified_at,
          WALMART_ACCOUNT_EVIDENCE_MAX_AGE_MS,
          input.context.now,
        ) ||
        !isEvidenceReference(approval.evidence_ref)
      ) {
        failures.push(`POLICY_REVIEW_APPROVAL_${index}_INVALID`);
        continue;
      }
      if (approvals.has(scope)) {
        failures.push(`POLICY_REVIEW_APPROVAL_${index}_DUPLICATE_SCOPE`);
      }
      approvals.set(scope, approval);
      const certificationApproval = input.context.certification_category_approvals.find(
        (item) => item.scope === scope,
      );
      if (
        !certificationApproval ||
        certificationApproval.status !== "APPROVED" ||
        certificationApproval.verified_at !== approval.verified_at ||
        certificationApproval.evidence_ref !== approval.evidence_ref
      ) {
        failures.push(`POLICY_REVIEW_APPROVAL_BINDING_MISMATCH:${scope}`);
      }
    }
    const orderedScopes = raw.required_category_approvals.map((approval) =>
      isRecord(approval) ? approval.scope : null,
    );
    if (!isSortedUniqueStrings(orderedScopes)) {
      failures.push("POLICY_REVIEW_REQUIRED_APPROVALS_ORDER_INVALID");
    }
  }
  if (!approvals.has("INGESTIBLE_PRODUCTS")) {
    failures.push("POLICY_REVIEW_INGESTIBLE_APPROVAL_REQUIRED");
  }
  for (const scope of certificationApprovedScopes.keys()) {
    if (!approvals.has(scope)) {
      failures.push(`POLICY_REVIEW_CERTIFICATION_APPROVAL_UNDECLARED:${scope}`);
    }
  }
  for (const scope of approvals.keys()) {
    if (!certificationApprovedScopes.has(scope)) {
      failures.push(`POLICY_REVIEW_DECLARED_APPROVAL_NOT_CERTIFIED:${scope}`);
    }
  }

  const approvalScopesReferencedByFindings = new Set<string>();
  if (
    !Array.isArray(raw.findings) ||
    raw.findings.length !== WALMART_NEW_SKU_REQUIRED_POLICY_REVIEW_DOMAIN_IDS.length
  ) {
    failures.push("POLICY_REVIEW_FINDINGS_INVALID");
  } else {
    const findingIds = new Set<string>();
    for (const [index, finding] of raw.findings.entries()) {
      if (!isRecord(finding)) {
        failures.push(`POLICY_REVIEW_FINDING_${index}_INVALID`);
        continue;
      }
      exactKeys(
        finding,
        [
          "finding_id",
          "disposition",
          "summary",
          "policy_source_ids",
          "required_approval_scopes",
        ],
        `POLICY_REVIEW_FINDING_${index}`,
        failures,
      );
      if (
        !hasText(finding.finding_id, 3) ||
        !hasText(finding.summary, 10) ||
        !["CLEARED", "REQUIRES_APPROVAL", "PROHIBITED", "UNRESOLVED"].includes(
          String(finding.disposition),
        ) ||
        !Array.isArray(finding.policy_source_ids) ||
        finding.policy_source_ids.length === 0 ||
        !isSortedUniqueStrings(finding.policy_source_ids) ||
        finding.policy_source_ids.some(
          (sourceId) => typeof sourceId !== "string" || !sourceIds.has(sourceId),
        ) ||
        !Array.isArray(finding.required_approval_scopes) ||
        !isSortedUniqueStrings(finding.required_approval_scopes) ||
        finding.required_approval_scopes.some(
          (scope) =>
            typeof scope !== "string" ||
            !APPROVAL_SCOPES.has(scope as WalmartApprovalScope) ||
            !approvals.has(scope),
        )
      ) {
        failures.push(`POLICY_REVIEW_FINDING_${index}_INVALID`);
      }
      if (typeof finding.finding_id === "string") {
        if (findingIds.has(finding.finding_id)) {
          failures.push(`POLICY_REVIEW_FINDING_${index}_DUPLICATE_ID`);
        }
        findingIds.add(finding.finding_id);
      }
      const requiredSources = typeof finding.finding_id === "string"
        ? REQUIRED_DOMAIN_SOURCES.get(finding.finding_id)
        : undefined;
      const findingPolicySourceIds = Array.isArray(finding.policy_source_ids)
        ? finding.policy_source_ids
        : [];
      if (
        !requiredSources ||
        requiredSources.some((sourceId) => !findingPolicySourceIds.includes(sourceId))
      ) {
        failures.push(`POLICY_REVIEW_FINDING_${index}_DOMAIN_SOURCE_MISSING`);
      }
      if (
        finding.disposition === "PROHIBITED" ||
        finding.disposition === "UNRESOLVED"
      ) {
        failures.push(`POLICY_REVIEW_FINDING_${index}_NOT_CLEARED`);
      }
      if (
        finding.disposition === "REQUIRES_APPROVAL" &&
        (!Array.isArray(finding.required_approval_scopes) ||
          finding.required_approval_scopes.length === 0)
      ) {
        failures.push(`POLICY_REVIEW_FINDING_${index}_APPROVAL_SCOPE_REQUIRED`);
      }
      if (
        finding.disposition === "REQUIRES_APPROVAL" &&
        Array.isArray(finding.required_approval_scopes)
      ) {
        for (const scope of finding.required_approval_scopes) {
          if (typeof scope === "string") approvalScopesReferencedByFindings.add(scope);
        }
      }
      if (
        finding.disposition === "CLEARED" &&
        Array.isArray(finding.required_approval_scopes) &&
        finding.required_approval_scopes.length > 0
      ) {
        failures.push(`POLICY_REVIEW_FINDING_${index}_CLEARED_SCOPE_INVALID`);
      }
      if (finding.finding_id === "category-preapproval") {
        const declaredScopes = Array.isArray(finding.required_approval_scopes)
          ? finding.required_approval_scopes
          : [];
        if (
          finding.disposition !== "REQUIRES_APPROVAL" ||
          declaredScopes.length !== approvals.size ||
          [...approvals.keys()].some((scope) => !declaredScopes.includes(scope))
        ) {
          failures.push("POLICY_REVIEW_CATEGORY_APPROVAL_DOMAIN_INVALID");
        }
      } else if (
        finding.disposition === "REQUIRES_APPROVAL" ||
        (Array.isArray(finding.required_approval_scopes) &&
          finding.required_approval_scopes.length > 0)
      ) {
        failures.push(`POLICY_REVIEW_FINDING_${index}_APPROVAL_DOMAIN_INVALID`);
      }
    }
    const orderedFindingIds = raw.findings.map((finding) =>
      isRecord(finding) ? finding.finding_id : null,
    );
    if (
      !isSortedUniqueStrings(orderedFindingIds) ||
      orderedFindingIds.some(
        (findingId, index) =>
          findingId !== WALMART_NEW_SKU_REQUIRED_POLICY_REVIEW_DOMAIN_IDS[index],
      )
    ) {
      failures.push("POLICY_REVIEW_REQUIRED_DOMAINS_INVALID");
    }
  }
  for (const scope of approvals.keys()) {
    if (!approvalScopesReferencedByFindings.has(scope)) {
      failures.push(`POLICY_REVIEW_APPROVAL_NOT_REFERENCED_BY_FINDING:${scope}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Walmart policy review evidence invalid: ${[...new Set(failures)].join("; ")}`,
    );
  }
  return raw as unknown as WalmartNewSkuPolicyReviewEvidence;
}
