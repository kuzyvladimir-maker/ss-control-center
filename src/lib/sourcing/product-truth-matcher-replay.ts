import {
  CANONICAL_PRODUCT_MATCHER_VERSION,
  matchCanonicalProduct,
  type CanonicalMatchReasonCode,
  type CanonicalMatchVerdict,
  type CanonicalProductIdentity,
} from "./canonical-product-match";
import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "./product-truth-operational-run-contract";

export const PRODUCT_TRUTH_MATCHER_REPLAY_CORPUS_VERSION =
  "product-truth-matcher-replay-corpus/1.0.0" as const;
export const PRODUCT_TRUTH_MATCHER_REPLAY_REPORT_VERSION =
  "product-truth-matcher-replay-report/1.0.0" as const;

export type ProductTruthMatcherReplaySourceKind =
  | "VARIANT_MISMATCH_QUARANTINE"
  | "GOLDEN_POSITIVE";

export interface ProductTruthMatcherReplayCase {
  caseId: string;
  target: CanonicalProductIdentity;
  candidate: CanonicalProductIdentity;
  expectedVerdict: CanonicalMatchVerdict;
}

export interface ProductTruthMatcherReplayCorpus {
  schemaVersion: typeof PRODUCT_TRUTH_MATCHER_REPLAY_CORPUS_VERSION;
  corpusId: string;
  capturedAt: string;
  source: {
    kind: ProductTruthMatcherReplaySourceKind;
    artifactSha256: string;
    declaredCaseCount: number;
  };
  cases: ProductTruthMatcherReplayCase[];
}

export interface ProductTruthMatcherReplayResult {
  ordinal: number;
  caseId: string;
  expectedVerdict: CanonicalMatchVerdict;
  actualVerdict: CanonicalMatchVerdict;
  passed: boolean;
  failureClass: "FALSE_ACCEPT" | "FALSE_REJECT" | "TIER_MISMATCH" | null;
  reasonCodes: CanonicalMatchReasonCode[];
}

export interface ProductTruthMatcherReplayReport {
  schemaVersion: typeof PRODUCT_TRUTH_MATCHER_REPLAY_REPORT_VERSION;
  matcherVersion: typeof CANONICAL_PRODUCT_MATCHER_VERSION;
  corpusId: string;
  corpusSha256: string;
  source: ProductTruthMatcherReplayCorpus["source"];
  requiredCaseCount: number;
  counts: {
    total: number;
    passed: number;
    failed: number;
    falseAccepts: number;
    falseRejects: number;
    tierMismatches: number;
  };
  certification: "PASS" | "FAIL";
  results: ProductTruthMatcherReplayResult[];
  claims: {
    databaseReads: false;
    databaseWrites: false;
    providerCalls: false;
    paidCalls: false;
    modelCalls: false;
  };
  payloadSha256: string;
}

export class ProductTruthMatcherReplayError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthMatcherReplayError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthMatcherReplayError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("MATCHER_REPLAY_CORPUS_INVALID", `${label} keys must be exactly ${expected.join(", ")}`);
  }
}

function exactText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 200) {
    fail("MATCHER_REPLAY_CORPUS_INVALID", `${label} must be exact non-empty text`);
  }
  return value;
}

function canonicalInstant(value: unknown, label: string): string {
  const text = exactText(value, label);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== text) {
    fail("MATCHER_REPLAY_CORPUS_INVALID", `${label} must be a canonical UTC instant`);
  }
  return text;
}

function sha256(value: unknown, label: string): string {
  const text = exactText(value, label);
  if (!/^[a-f0-9]{64}$/.test(text)) {
    fail("MATCHER_REPLAY_CORPUS_INVALID", `${label} must be a lowercase SHA-256`);
  }
  return text;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 1_000_000) {
    fail("MATCHER_REPLAY_CORPUS_INVALID", `${label} must be a positive integer`);
  }
  return Number(value);
}

function identity(value: unknown, label: string): CanonicalProductIdentity {
  if (!isRecord(value)) fail("MATCHER_REPLAY_CORPUS_INVALID", `${label} must be an object`);
  const allowed = ["brand", "productLine", "flavor", "modifiers", "form", "outerPackCount", "size", "title"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    fail("MATCHER_REPLAY_CORPUS_INVALID", `${label} contains unsupported identity fields`);
  }
  return structuredClone(value) as CanonicalProductIdentity;
}

function verdict(value: unknown, label: string): CanonicalMatchVerdict {
  if (
    value !== "EXACT_IDENTITY"
    && value !== "CROSS_SIZE_ESTIMATE"
    && value !== "SIBLING_ESTIMATE"
    && value !== "SIZE_UNKNOWN_ESTIMATE"
    && value !== "REJECT"
  ) {
    fail("MATCHER_REPLAY_CORPUS_INVALID", `${label} is not a canonical matcher verdict`);
  }
  return value;
}

export function parseProductTruthMatcherReplayCorpus(
  value: unknown,
): ProductTruthMatcherReplayCorpus {
  if (!isRecord(value)) fail("MATCHER_REPLAY_CORPUS_INVALID", "corpus must be an object");
  exactKeys(value, ["schemaVersion", "corpusId", "capturedAt", "source", "cases"], "corpus");
  if (value.schemaVersion !== PRODUCT_TRUTH_MATCHER_REPLAY_CORPUS_VERSION) {
    fail("MATCHER_REPLAY_CORPUS_INVALID", "unsupported corpus schemaVersion");
  }
  if (!isRecord(value.source)) fail("MATCHER_REPLAY_CORPUS_INVALID", "source must be an object");
  exactKeys(value.source, ["kind", "artifactSha256", "declaredCaseCount"], "source");
  if (value.source.kind !== "VARIANT_MISMATCH_QUARANTINE" && value.source.kind !== "GOLDEN_POSITIVE") {
    fail("MATCHER_REPLAY_CORPUS_INVALID", "source.kind is unsupported");
  }
  if (!Array.isArray(value.cases)) fail("MATCHER_REPLAY_CORPUS_INVALID", "cases must be an array");
  const cases = value.cases.map((raw, ordinal): ProductTruthMatcherReplayCase => {
    if (!isRecord(raw)) fail("MATCHER_REPLAY_CORPUS_INVALID", `cases[${ordinal}] must be an object`);
    exactKeys(raw, ["caseId", "target", "candidate", "expectedVerdict"], `cases[${ordinal}]`);
    return {
      caseId: exactText(raw.caseId, `cases[${ordinal}].caseId`),
      target: identity(raw.target, `cases[${ordinal}].target`),
      candidate: identity(raw.candidate, `cases[${ordinal}].candidate`),
      expectedVerdict: verdict(raw.expectedVerdict, `cases[${ordinal}].expectedVerdict`),
    };
  });
  const declaredCaseCount = positiveInteger(value.source.declaredCaseCount, "source.declaredCaseCount");
  if (cases.length !== declaredCaseCount) {
    fail("MATCHER_REPLAY_CORPUS_INCOMPLETE", "declaredCaseCount differs from the captured cases");
  }
  const caseIds = cases.map((item) => item.caseId);
  if (new Set(caseIds).size !== caseIds.length) {
    fail("MATCHER_REPLAY_CORPUS_INVALID", "caseId values must be unique");
  }
  if (caseIds.some((caseId, index) => index > 0 && caseIds[index - 1].localeCompare(caseId, "en-US") >= 0)) {
    fail("MATCHER_REPLAY_CORPUS_INVALID", "cases must be strictly ordered by caseId");
  }
  if (
    value.source.kind === "VARIANT_MISMATCH_QUARANTINE"
    && cases.some((item) => item.expectedVerdict !== "REJECT")
  ) {
    fail("MATCHER_REPLAY_CORPUS_INVALID", "quarantine cases must all expect REJECT");
  }
  if (
    value.source.kind === "GOLDEN_POSITIVE"
    && cases.some((item) => item.expectedVerdict === "REJECT")
  ) {
    fail("MATCHER_REPLAY_CORPUS_INVALID", "golden positive cases cannot expect REJECT");
  }
  return {
    schemaVersion: PRODUCT_TRUTH_MATCHER_REPLAY_CORPUS_VERSION,
    corpusId: exactText(value.corpusId, "corpusId"),
    capturedAt: canonicalInstant(value.capturedAt, "capturedAt"),
    source: {
      kind: value.source.kind,
      artifactSha256: sha256(value.source.artifactSha256, "source.artifactSha256"),
      declaredCaseCount,
    },
    cases,
  };
}

function failureClass(
  expected: CanonicalMatchVerdict,
  actual: CanonicalMatchVerdict,
): ProductTruthMatcherReplayResult["failureClass"] {
  if (expected === actual) return null;
  if (expected === "REJECT") return "FALSE_ACCEPT";
  if (actual === "REJECT") return "FALSE_REJECT";
  return "TIER_MISMATCH";
}

export function runProductTruthMatcherReplay(input: {
  corpus: unknown;
  requiredCaseCount: number;
}): ProductTruthMatcherReplayReport {
  const corpus = parseProductTruthMatcherReplayCorpus(input.corpus);
  const requiredCaseCount = positiveInteger(input.requiredCaseCount, "requiredCaseCount");
  if (corpus.source.declaredCaseCount !== requiredCaseCount) {
    fail(
      "MATCHER_REPLAY_CORPUS_INCOMPLETE",
      `corpus has ${corpus.source.declaredCaseCount} cases; certification requires ${requiredCaseCount}`,
    );
  }
  const results = corpus.cases.map((item, ordinal): ProductTruthMatcherReplayResult => {
    const match = matchCanonicalProduct(item.target, item.candidate);
    const classification = failureClass(item.expectedVerdict, match.verdict);
    return {
      ordinal,
      caseId: item.caseId,
      expectedVerdict: item.expectedVerdict,
      actualVerdict: match.verdict,
      passed: classification === null,
      failureClass: classification,
      reasonCodes: [...match.reasonCodes],
    };
  });
  const counts = {
    total: results.length,
    passed: results.filter((item) => item.passed).length,
    failed: results.filter((item) => !item.passed).length,
    falseAccepts: results.filter((item) => item.failureClass === "FALSE_ACCEPT").length,
    falseRejects: results.filter((item) => item.failureClass === "FALSE_REJECT").length,
    tierMismatches: results.filter((item) => item.failureClass === "TIER_MISMATCH").length,
  };
  const payload = {
    schemaVersion: PRODUCT_TRUTH_MATCHER_REPLAY_REPORT_VERSION,
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    corpusId: corpus.corpusId,
    corpusSha256: productTruthOperationalSha256(corpus),
    source: corpus.source,
    requiredCaseCount,
    counts,
    certification: counts.failed === 0 ? "PASS" as const : "FAIL" as const,
    results,
    claims: {
      databaseReads: false as const,
      databaseWrites: false as const,
      providerCalls: false as const,
      paidCalls: false as const,
      modelCalls: false as const,
    },
  };
  return { ...payload, payloadSha256: productTruthOperationalSha256(payload) };
}

export function renderProductTruthMatcherReplayReportJson(
  report: ProductTruthMatcherReplayReport,
): string {
  return renderProductTruthOperationalJson(report);
}
