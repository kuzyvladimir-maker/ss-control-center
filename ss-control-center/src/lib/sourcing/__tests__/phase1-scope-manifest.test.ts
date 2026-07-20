import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { createClient } from "@libsql/client";

import {
  PHASE1_SCOPE_BUILDER_POLICY_VERSION,
  PHASE1_SCOPE_DISPOSITION_VERSION,
  PHASE1_SCOPE_MANIFEST_VERSION,
  buildPhase1ScopeManifest,
  parsePhase1DelimitedText,
  renderPhase1ScopeManifestCsv,
  renderPhase1ScopeManifestJson,
  renderPhase1Sha256Manifest,
  sha256Hex,
  stableJsonStringify,
  validatePhase1ScopeManifestV3Policy,
  type BuildPhase1ScopeManifestInput,
  type Phase1Channel,
  type Phase1LocalReportInput,
  type Phase1ScopeDispositionDocument,
  type Phase1ScopeDispositionEntry,
} from "../phase1-scope-manifest";
import { importAuthoritativePhase1ListingScopes } from "../product-truth-listing-scope-registry";
import { makeTestConnectedStoreCensus } from "./phase1-connected-store-census-fixture";

const execFileAsync = promisify(execFile);
const AS_OF = "2026-07-18T22:00:00.000Z";
const CAPTURED_AT = "2026-07-18T20:00:00.000Z";

const amazonReport = [
  "item-name\tseller-sku\tasin1\tstatus\tfulfillment-channel",
  "Acme Active Item\tAMZ-1\tB000000001\tActive\tDEFAULT",
  "Acme Inactive Item\tAMZ-OFF\tB000000002\tInactive\tAMAZON_NA",
].join("\n");

const walmartReport = [
  "SKU,Item ID,Product Name,Published Status,Lifecycle Status",
  'WM-1,12345,"Acme Item, Family Size",Published,Active',
  "WM-OFF,67890,Acme Draft,Unpublished,Active",
].join("\n");

function decision(id: string) {
  return {
    authority: "OWNER" as const,
    decisionId: id,
    decidedBy: "Vladimir",
    decidedAt: "2026-07-18T19:00:00Z",
    reason: `Explicit account disposition ${id}`,
  };
}

function inScope(
  channel: Phase1Channel,
  scopeKey: string,
  content: string,
  overrides: Partial<Phase1ScopeDispositionEntry> = {},
): Phase1ScopeDispositionEntry {
  return {
    channel,
    scopeKey,
    storeIndex: Number(scopeKey.replace(/^store/, "")),
    accountId: `${channel}-account-${scopeKey}`,
    storeId: `${channel}-store-${scopeKey}`,
    marketplaceId: channel === "amazon" ? "ATVPDKIKX0DER" : null,
    disposition: "IN_SCOPE",
    decision: decision(`${channel}-${scopeKey}`),
    report: {
      reportType:
        channel === "amazon"
          ? "GET_MERCHANT_LISTINGS_ALL_DATA"
          : "ITEM_CATALOG",
      reportId: `${channel}-report-${scopeKey}`,
      capturedAt: CAPTURED_AT,
      expectedRowCount: parsePhase1DelimitedText(content).rows.length,
      expectedContentSha256: sha256Hex(content),
    },
    ...overrides,
  };
}

function excluded(
  channel: Phase1Channel,
  scopeKey: string,
): Phase1ScopeDispositionEntry {
  return {
    channel,
    scopeKey,
    storeIndex: Number(scopeKey.replace(/^store/, "")),
    accountId: `${channel}-account-${scopeKey}`,
    storeId: `${channel}-store-${scopeKey}`,
    marketplaceId: channel === "amazon" ? "ATVPDKIKX0DER" : null,
    disposition: "EXCLUDED_OWNER_CONFIRMED",
    decision: decision(`${channel}-${scopeKey}-excluded`),
  };
}

function report(
  channel: Phase1Channel,
  scopeKey: string,
  content: string,
): Phase1LocalReportInput {
  return {
    channel,
    scopeKey,
    sourceName: `${channel}-${scopeKey}.${channel === "amazon" ? "tsv" : "csv"}`,
    content,
  };
}

function input(
  overrides: Partial<BuildPhase1ScopeManifestInput> = {},
): BuildPhase1ScopeManifestInput {
  const disposition: Phase1ScopeDispositionDocument = {
    schemaVersion: PHASE1_SCOPE_DISPOSITION_VERSION,
    scopes: [
      inScope("amazon", "store1", amazonReport),
      inScope("walmart", "store1", walmartReport),
    ],
  };
  const connectedStoreCensus = makeTestConnectedStoreCensus();
  return {
    asOf: AS_OF,
    disposition,
    reports: [
      report("amazon", "store1", amazonReport),
      report("walmart", "store1", walmartReport),
    ],
    ...overrides,
    connectedStoreCensus: overrides.connectedStoreCensus ?? connectedStoreCensus,
  };
}

function blockerCodes(manifest: ReturnType<typeof buildPhase1ScopeManifest>): string[] {
  return manifest.blockers.map((blocker) => blocker.code);
}

test("builds an authoritative deterministic manifest only from active/published rows", () => {
  const manifest = buildPhase1ScopeManifest(input());
  assert.equal(manifest.schemaVersion, PHASE1_SCOPE_MANIFEST_VERSION);
  assert.equal(
    manifest.policy.builderPolicyVersion,
    PHASE1_SCOPE_BUILDER_POLICY_VERSION,
  );
  assert.deepEqual(validatePhase1ScopeManifestV3Policy(manifest), []);
  assert.equal(manifest.authoritative, true);
  assert.equal(manifest.counts.sourceRows, 4);
  assert.equal(manifest.counts.liveListings, 2);
  assert.equal(manifest.counts.amazonLiveListings, 1);
  assert.equal(manifest.counts.walmartLiveListings, 1);
  assert.deepEqual(
    manifest.listings.map((listing) => [
      listing.channel,
      listing.listingKey,
      listing.listingId,
      listing.sourceStatus,
      listing.sourceLifecycleStatus,
      listing.phase1Status,
    ]),
    [
      ["amazon", "amazon:1:AMZ-1", "B000000001", "ACTIVE", null, "NOT_STARTED"],
      ["walmart", "walmart:1:WM-1", "12345", "PUBLISHED", "ACTIVE", "NOT_STARTED"],
    ],
  );
  assert.equal(manifest.sourceReports[0].contentSha256, sha256Hex(amazonReport));
  assert.equal(manifest.sourceReports[1].contentSha256, sha256Hex(walmartReport));
});

test("v3 policy binding rejects a relabeled or internally tampered manifest", () => {
  const valid = buildPhase1ScopeManifest(input());

  const relabeled = structuredClone(valid) as unknown as Record<string, unknown>;
  const relabeledPolicy = relabeled.policy as Record<string, unknown>;
  delete relabeledPolicy.builderPolicyVersion;
  assert.ok(
    validatePhase1ScopeManifestV3Policy(relabeled).some((error) =>
      error.includes("builderPolicyVersion")
    ),
  );

  const dispositionTamper = structuredClone(valid);
  dispositionTamper.scopeDispositions[0].reason = "Unbound owner decision";
  assert.ok(
    validatePhase1ScopeManifestV3Policy(dispositionTamper).some((error) =>
      error.includes("dispositionInputSha256")
    ),
  );

  const scopeTamper = structuredClone(valid);
  scopeTamper.requiredScopes.amazon.push("store2");
  assert.ok(
    validatePhase1ScopeManifestV3Policy(scopeTamper).some((error) =>
      error.includes("requiredScopesSha256")
    ),
  );
});

test("v3 runtime validation rejects a deleted required scope even after attacker reseals hashes and counts", () => {
  const tampered = structuredClone(buildPhase1ScopeManifest(input()));
  tampered.scopeDispositions = tampered.scopeDispositions.filter(
    (scope) => scope.channel !== "amazon",
  );
  tampered.sourceReports = tampered.sourceReports.filter(
    (report) => report.channel !== "amazon",
  );
  tampered.listings = tampered.listings.filter(
    (listing) => listing.channel !== "amazon",
  );
  tampered.counts.inScopeReports = tampered.sourceReports.length;
  tampered.counts.sourceRows = tampered.sourceReports.reduce(
    (sum, report) => sum + report.totalRows,
    0,
  );
  tampered.counts.liveListings = tampered.listings.length;
  tampered.counts.amazonLiveListings = 0;

  const remainingDisposition = tampered.scopeDispositions[0];
  const remainingReport = tampered.sourceReports[0];
  tampered.policy.dispositionInputSha256 = sha256Hex(
    `${stableJsonStringify({
      schemaVersion: PHASE1_SCOPE_DISPOSITION_VERSION,
      scopes: [{
        channel: remainingDisposition.channel,
        scopeKey: remainingDisposition.scopeKey,
        storeIndex: remainingDisposition.storeIndex,
        accountId: remainingDisposition.accountId,
        storeId: remainingDisposition.storeId,
        marketplaceId: remainingDisposition.marketplaceId,
        disposition: remainingDisposition.disposition,
        decision: {
          authority: "OWNER",
          decisionId: remainingDisposition.decisionId,
          decidedBy: remainingDisposition.decidedBy,
          decidedAt: remainingDisposition.decidedAt,
          reason: remainingDisposition.reason,
        },
        report: {
          reportType: remainingReport.reportType,
          reportId: remainingReport.reportId,
          capturedAt: remainingReport.capturedAt,
          expectedRowCount: remainingReport.expectedRowCount,
          expectedContentSha256: remainingReport.contentSha256,
        },
      }],
    }, 0)}\n`,
  );
  const resealedJson = renderPhase1ScopeManifestJson(tampered);
  assert.match(sha256Hex(resealedJson), /^[a-f0-9]{64}$/);

  const errors = validatePhase1ScopeManifestV3Policy(tampered);
  assert.ok(
    errors.includes(
      "scopeDispositions must contain exactly one disposition for required scope amazon:store1",
    ),
    errors.join("\n"),
  );
});

test("v3 runtime validation rejects duplicate/unexpected scope identities and reduced live listing coverage", () => {
  const valid = buildPhase1ScopeManifest(input());

  const duplicate = structuredClone(valid);
  duplicate.scopeDispositions.push(structuredClone(duplicate.scopeDispositions[0]));
  assert.ok(
    validatePhase1ScopeManifestV3Policy(duplicate).some((error) =>
      error.includes("exactly one disposition for required scope amazon:store1")
    ),
  );

  const unexpected = structuredClone(valid);
  unexpected.scopeDispositions.push({
    ...structuredClone(unexpected.scopeDispositions[0]),
    scopeKey: "store9",
    storeIndex: 9,
  });
  assert.ok(
    validatePhase1ScopeManifestV3Policy(unexpected).includes(
      "scopeDispositions contains unexpected scope amazon:store9",
    ),
  );

  const reduced = structuredClone(valid);
  reduced.listings = reduced.listings.filter((listing) => listing.channel !== "amazon");
  reduced.counts.liveListings = reduced.listings.length;
  reduced.counts.amazonLiveListings = 0;
  const errors = validatePhase1ScopeManifestV3Policy(reduced);
  assert.ok(
    errors.includes("listings do not contain every live row from source report amazon:store1"),
    errors.join("\n"),
  );
});

test("accepts an explicitly owner-excluded required account but never a missing disposition", () => {
  const base = input();
  const withExclusion = buildPhase1ScopeManifest({
    ...base,
    connectedStoreCensus: makeTestConnectedStoreCensus({ amazonConnected: [1, 2] }),
    disposition: {
      ...(base.disposition as Phase1ScopeDispositionDocument),
      scopes: [
        ...(base.disposition as Phase1ScopeDispositionDocument).scopes,
        excluded("amazon", "store2"),
      ],
    },
  });
  assert.equal(withExclusion.authoritative, true);
  assert.equal(withExclusion.scopeDispositions[1].disposition, "EXCLUDED_OWNER_CONFIRMED");

  const missing = buildPhase1ScopeManifest({
    ...base,
    connectedStoreCensus: makeTestConnectedStoreCensus({ amazonConnected: [1, 2] }),
  });
  assert.equal(missing.authoritative, false);
  assert.ok(blockerCodes(missing).includes("MISSING_ACCOUNT_DISPOSITION"));
});

test("rejects a competing manual denominator even when it equals the census", () => {
  const manifest = buildPhase1ScopeManifest({
    ...input(),
    requiredScopes: { amazon: ["store1"], walmart: ["store1"] },
  });
  assert.equal(manifest.authoritative, false);
  assert.ok(blockerCodes(manifest).includes("MANUAL_REQUIRED_SCOPES_FORBIDDEN"));
  assert.deepEqual(manifest.requiredScopes, {
    amazon: ["store1"],
    walmart: ["store1"],
  });
});

test("fails closed for a missing report, unresolved disposition, and unexpected report", () => {
  const base = input();
  const scopes = (base.disposition as Phase1ScopeDispositionDocument).scopes;
  const unresolved = {
    ...scopes[0],
    disposition: "UNRESOLVED" as const,
    report: null,
  };
  const manifest = buildPhase1ScopeManifest({
    ...base,
    disposition: {
      schemaVersion: PHASE1_SCOPE_DISPOSITION_VERSION,
      scopes: [unresolved, scopes[1]],
    },
  });
  assert.equal(manifest.authoritative, false);
  assert.ok(blockerCodes(manifest).includes("UNRESOLVED_ACCOUNT_DISPOSITION"));
  assert.ok(blockerCodes(manifest).includes("UNEXPECTED_LOCAL_REPORT"));

  const noWalmartReport = buildPhase1ScopeManifest({
    ...base,
    reports: [report("amazon", "store1", amazonReport)],
  });
  assert.ok(blockerCodes(noWalmartReport).includes("MISSING_LOCAL_REPORT"));
});

test("validates report timestamps, row count, type, and attested content hash", () => {
  const base = input();
  const scopes = (base.disposition as Phase1ScopeDispositionDocument).scopes;
  const badAmazon: Phase1ScopeDispositionEntry = {
    ...scopes[0],
    report: {
      ...scopes[0].report!,
      reportType: "LISTINGS_ITEMS_PAGE",
      capturedAt: "2026-07-15T20:00:00Z",
      expectedRowCount: 999,
      expectedContentSha256: "0".repeat(64),
    },
  };
  const manifest = buildPhase1ScopeManifest({
    ...base,
    disposition: {
      schemaVersion: PHASE1_SCOPE_DISPOSITION_VERSION,
      scopes: [badAmazon, scopes[1]],
    },
  });
  const codes = blockerCodes(manifest);
  assert.ok(codes.includes("REPORT_TYPE_MISMATCH"));
  assert.ok(codes.includes("REPORT_STALE"));
  assert.ok(codes.includes("REPORT_ROW_COUNT_MISMATCH"));
  assert.ok(codes.includes("REPORT_CONTENT_HASH_MISMATCH"));
});

test("requires an exact content hash in every in-scope report attestation", () => {
  const base = input();
  const scopes = (base.disposition as Phase1ScopeDispositionDocument).scopes;
  const reportWithoutHash: Record<string, unknown> = { ...scopes[0].report! };
  delete reportWithoutHash.expectedContentSha256;
  const manifest = buildPhase1ScopeManifest({
    ...base,
    disposition: {
      schemaVersion: PHASE1_SCOPE_DISPOSITION_VERSION,
      scopes: [{ ...scopes[0], report: reportWithoutHash }, scopes[1]],
    },
  });
  assert.equal(manifest.authoritative, false);
  assert.ok(blockerCodes(manifest).includes("INVALID_SOURCE_REPORT_ATTESTATION"));
});

test("rejects non-canonical report formats and ambiguous required columns", () => {
  const tabWalmart = [
    "SKU\tItem ID\tProduct Name\tPublished Status\tLifecycle Status",
    "WM-1\t12345\tAcme Item Family Size\tPublished\tActive",
    "WM-OFF\t67890\tAcme Draft\tUnpublished\tActive",
  ].join("\n");
  const validTabWalmart = buildPhase1ScopeManifest({
    ...input(),
    disposition: {
      schemaVersion: PHASE1_SCOPE_DISPOSITION_VERSION,
      scopes: [
        inScope("amazon", "store1", amazonReport),
        inScope("walmart", "store1", tabWalmart),
      ],
    },
    reports: [
      report("amazon", "store1", amazonReport),
      report("walmart", "store1", tabWalmart),
    ],
  });
  assert.equal(validTabWalmart.authoritative, true);

  const commaAmazon = amazonReport.replace(/\t/g, ",");
  const commaManifest = buildPhase1ScopeManifest({
    ...input(),
    disposition: {
      schemaVersion: PHASE1_SCOPE_DISPOSITION_VERSION,
      scopes: [
        inScope("amazon", "store1", commaAmazon),
        inScope("walmart", "store1", walmartReport),
      ],
    },
    reports: [
      report("amazon", "store1", commaAmazon),
      report("walmart", "store1", walmartReport),
    ],
  });
  assert.ok(blockerCodes(commaManifest).includes("REPORT_FORMAT_MISMATCH"));

  const ambiguousAmazon = [
    "item-name\tseller-sku\tmerchant-sku\tasin1\tstatus",
    "Acme Active Item\tAMZ-1\tAMZ-1\tB000000001\tActive",
  ].join("\n");
  const ambiguousManifest = buildPhase1ScopeManifest({
    ...input(),
    disposition: {
      schemaVersion: PHASE1_SCOPE_DISPOSITION_VERSION,
      scopes: [
        inScope("amazon", "store1", ambiguousAmazon),
        inScope("walmart", "store1", walmartReport),
      ],
    },
    reports: [
      report("amazon", "store1", ambiguousAmazon),
      report("walmart", "store1", walmartReport),
    ],
  });
  assert.ok(blockerCodes(ambiguousManifest).includes("AMBIGUOUS_REQUIRED_COLUMN"));
});

test("preserves exact raw SKU grain by blocking whitespace/control normalization", () => {
  const paddedSkuReport = amazonReport.replace("\tAMZ-1\t", "\t AMZ-1 \t");
  const manifest = buildPhase1ScopeManifest({
    ...input(),
    disposition: {
      schemaVersion: PHASE1_SCOPE_DISPOSITION_VERSION,
      scopes: [
        inScope("amazon", "store1", paddedSkuReport),
        inScope("walmart", "store1", walmartReport),
      ],
    },
    reports: [
      report("amazon", "store1", paddedSkuReport),
      report("walmart", "store1", walmartReport),
    ],
  });
  assert.equal(manifest.authoritative, false);
  assert.ok(blockerCodes(manifest).includes("INVALID_RAW_SKU"));
  assert.equal(
    manifest.listings.some((listing) => listing.listingKey.includes("AMZ-1")),
    false,
  );
});

test("blocks unclassified marketplace statuses instead of silently dropping rows", () => {
  const unknownStatusReport = amazonReport.replace("\tInactive\t", "\tStandby\t");
  const manifest = buildPhase1ScopeManifest({
    ...input(),
    disposition: {
      schemaVersion: PHASE1_SCOPE_DISPOSITION_VERSION,
      scopes: [
        inScope("amazon", "store1", unknownStatusReport),
        inScope("walmart", "store1", walmartReport),
      ],
    },
    reports: [
      report("amazon", "store1", unknownStatusReport),
      report("walmart", "store1", walmartReport),
    ],
  });
  assert.equal(manifest.authoritative, false);
  assert.ok(blockerCodes(manifest).includes("UNKNOWN_SOURCE_STATUS"));
});

test("one source report id cannot be reused across account scopes", () => {
  const store2Report = amazonReport
    .replace(/AMZ-1/g, "AMZ-2")
    .replace(/AMZ-OFF/g, "AMZ-2-OFF")
    .replace(/B000000001/g, "B000000003")
    .replace(/B000000002/g, "B000000004");
  const store1Disposition = inScope("amazon", "store1", amazonReport);
  const store2Disposition = inScope("amazon", "store2", store2Report, {
    report: {
      ...inScope("amazon", "store2", store2Report).report!,
      reportId: store1Disposition.report!.reportId,
    },
  });
  const manifest = buildPhase1ScopeManifest({
    ...input(),
    connectedStoreCensus: makeTestConnectedStoreCensus({ amazonConnected: [1, 2] }),
    disposition: {
      schemaVersion: PHASE1_SCOPE_DISPOSITION_VERSION,
      scopes: [
        store1Disposition,
        store2Disposition,
        inScope("walmart", "store1", walmartReport),
      ],
    },
    reports: [
      report("amazon", "store1", amazonReport),
      report("amazon", "store2", store2Report),
      report("walmart", "store1", walmartReport),
    ],
  });
  assert.equal(manifest.authoritative, false);
  assert.ok(blockerCodes(manifest).includes("DUPLICATE_SOURCE_REPORT_ID"));
});

test("blocks the known Amazon 1000-row ceiling even when attested row count matches", () => {
  const rows = ["item-name\tseller-sku\tasin1\tstatus"];
  for (let index = 0; index < 1000; index += 1) {
    rows.push(`Item ${index}\tSKU-${index}\tB${String(index).padStart(9, "0")}\tInactive`);
  }
  const capped = rows.join("\n");
  const base = input();
  const scopes = (base.disposition as Phase1ScopeDispositionDocument).scopes;
  const manifest = buildPhase1ScopeManifest({
    ...base,
    disposition: {
      schemaVersion: PHASE1_SCOPE_DISPOSITION_VERSION,
      scopes: [inScope("amazon", "store1", capped), scopes[1]],
    },
    reports: [
      report("amazon", "store1", capped),
      report("walmart", "store1", walmartReport),
    ],
  });
  assert.ok(blockerCodes(manifest).includes("SUSPICIOUS_KNOWN_ROW_CAP"));
  assert.equal(manifest.authoritative, false);
});

test("does not silently merge raw SKU collisions across channels or account scopes", () => {
  const collidingWalmart = walmartReport.replace(/WM-1/g, "AMZ-1");
  const base = input();
  const scopes = (base.disposition as Phase1ScopeDispositionDocument).scopes;
  const manifest = buildPhase1ScopeManifest({
    ...base,
    disposition: {
      schemaVersion: PHASE1_SCOPE_DISPOSITION_VERSION,
      scopes: [scopes[0], inScope("walmart", "store1", collidingWalmart)],
    },
    reports: [
      report("amazon", "store1", amazonReport),
      report("walmart", "store1", collidingWalmart),
    ],
  });
  assert.equal(manifest.listings.length, 2);
  assert.equal(manifest.authoritative, true);
  assert.equal(blockerCodes(manifest).includes("RAW_SKU_COLLISION"), false);
  assert.deepEqual(manifest.collisions[0], {
    type: "RAW_SKU",
    key: "AMZ-1",
    blocking: false,
    listingKeys: ["amazon:1:AMZ-1", "walmart:1:AMZ-1"],
    rawSkus: ["AMZ-1"],
  });
});

test("requires a positive storeIndex and blocks ambiguous scope mappings", () => {
  const base = input();
  const scopes = (base.disposition as Phase1ScopeDispositionDocument).scopes;
  const bad = buildPhase1ScopeManifest({
    ...base,
    disposition: {
      schemaVersion: PHASE1_SCOPE_DISPOSITION_VERSION,
      scopes: [{ ...scopes[0], storeIndex: 3 }, scopes[1]],
    },
  });
  assert.equal(bad.authoritative, false);
  assert.ok(blockerCodes(bad).includes("SCOPE_STORE_INDEX_MISMATCH"));
});

test("parses quoted CSV fields and flags malformed row widths", () => {
  const parsed = parsePhase1DelimitedText(
    'SKU,Item ID,Product Name\nA,1,"Title, with comma"\nB,2,"line one\nline two"',
  );
  assert.equal(parsed.delimiter, "comma");
  assert.deepEqual(parsed.rows, [
    ["A", "1", "Title, with comma"],
    ["B", "2", "line one\nline two"],
  ]);
  assert.deepEqual(parsed.errors, []);

  const malformed = parsePhase1DelimitedText("a,b\n1,2,3");
  assert.match(malformed.errors[0], /3 cells; expected 2/);
});

test("JSON, CSV, and checksum output stay byte-deterministic when input order changes", () => {
  const firstInput = input();
  const first = buildPhase1ScopeManifest(firstInput);
  const reversed = buildPhase1ScopeManifest({
    ...firstInput,
    disposition: {
      ...(firstInput.disposition as Phase1ScopeDispositionDocument),
      scopes: [...(firstInput.disposition as Phase1ScopeDispositionDocument).scopes].reverse(),
    },
    reports: [...firstInput.reports].reverse(),
  });
  const firstJson = renderPhase1ScopeManifestJson(first);
  const secondJson = renderPhase1ScopeManifestJson(reversed);
  const firstCsv = renderPhase1ScopeManifestCsv(first);
  assert.equal(firstJson, secondJson);
  assert.equal(firstCsv, renderPhase1ScopeManifestCsv(reversed));

  const checksum = renderPhase1Sha256Manifest([
    { fileName: "scope.json", content: firstJson },
    { fileName: "scope.csv", content: firstCsv },
  ]);
  assert.equal(
    checksum,
    `${sha256Hex(firstCsv)}  scope.csv\n${sha256Hex(firstJson)}  scope.json\n`,
  );
  assert.match(firstCsv, /"Acme Item, Family Size"/);
});

test("CLI reads census and reports locally, writes four sealed artifacts, and exits 2 for blocked scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "phase1-manifest-test-"));
  const censusPath = join(root, "census.json");
  const blockedCensusPath = join(root, "blocked-census.json");
  const dispositionPath = join(root, "disposition.json");
  const amazonPath = join(root, "amazon.tsv");
  const walmartPath = join(root, "walmart.csv");
  const outDir = join(root, "out");
  const disposition: Phase1ScopeDispositionDocument = {
    schemaVersion: PHASE1_SCOPE_DISPOSITION_VERSION,
    scopes: [
      inScope("amazon", "store1", amazonReport),
      inScope("walmart", "store1", walmartReport),
    ],
  };
  await writeFile(censusPath, makeTestConnectedStoreCensus().content, "utf8");
  await writeFile(
    blockedCensusPath,
    makeTestConnectedStoreCensus({ amazonConnected: [1, 2] }).content,
    "utf8",
  );
  await writeFile(dispositionPath, JSON.stringify(disposition), "utf8");
  await writeFile(amazonPath, amazonReport, "utf8");
  await writeFile(walmartPath, walmartReport, "utf8");

  const scriptPath = join(process.cwd(), "scripts", "build-phase1-scope-manifest.ts");
  const result = await execFileAsync(
    process.execPath,
    [
      "--import",
      "tsx",
      scriptPath,
      "--as-of",
      AS_OF,
      "--census",
      censusPath,
      "--disposition",
      dispositionPath,
      "--amazon",
      `store1=${amazonPath}`,
      "--walmart",
      `store1=${walmartPath}`,
      "--out-dir",
      outDir,
    ],
    { cwd: process.cwd() },
  );
  assert.match(result.stdout, /^AUTHORITATIVE: 2 live listings, 0 blockers\./);
  const json = await readFile(join(outDir, "phase1-scope-manifest.json"), "utf8");
  const csv = await readFile(join(outDir, "phase1-scope-manifest.csv"), "utf8");
  const checksums = await readFile(join(outDir, "phase1-scope-manifest.sha256"), "utf8");
  assert.equal((JSON.parse(json) as { authoritative: boolean }).authoritative, true);
  assert.match(csv, /amazon:1:AMZ-1/);
  assert.match(checksums, new RegExp(sha256Hex(json)));

  let reuseExitCode: number | string | undefined;
  try {
    await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        scriptPath,
        "--as-of",
        AS_OF,
        "--census",
        censusPath,
        "--disposition",
        dispositionPath,
        "--amazon",
        `store1=${amazonPath}`,
        "--walmart",
        `store1=${walmartPath}`,
        "--out-dir",
        outDir,
      ],
      { cwd: process.cwd() },
    );
  } catch (error) {
    reuseExitCode = isExecFailure(error) ? error.code : undefined;
  }
  assert.equal(reuseExitCode, 2);
  assert.equal(
    await readFile(join(outDir, "phase1-scope-manifest.json"), "utf8"),
    json,
  );

  const blockedOut = join(root, "blocked");
  let exitCode: number | string | undefined;
  try {
    await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        scriptPath,
        "--as-of",
        AS_OF,
        "--census",
        blockedCensusPath,
        "--disposition",
        dispositionPath,
        "--amazon",
        `store1=${amazonPath}`,
        "--walmart",
        `store1=${walmartPath}`,
        "--out-dir",
        blockedOut,
      ],
      { cwd: process.cwd() },
    );
  } catch (error) {
    exitCode = isExecFailure(error) ? error.code : undefined;
  }
  assert.equal(exitCode, 2);
  const blocked = JSON.parse(
    await readFile(join(blockedOut, "phase1-scope-manifest.json"), "utf8"),
  ) as { authoritative: boolean; blockers: Array<{ code: string }> };
  assert.equal(blocked.authoritative, false);
  assert.ok(blocked.blockers.some((blocker) => blocker.code === "MISSING_ACCOUNT_DISPOSITION"));
});

function isExecFailure(value: unknown): value is { code: number | string } {
  return typeof value === "object" && value !== null && "code" in value;
}

test("CLI source has no network, database, or enrichment-provider transport", async () => {
  const source = await readFile(
    new URL("../../../../scripts/build-phase1-scope-manifest.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /@libsql|prisma|requestAndWaitForReport|retail-fetch|donor-catalog|vision/i);
  assert.doesNotMatch(source, /https?:\/\/(?:api\.|data\.)/i);
  assert.match(source, /return 2;/);
});

test("mutable mirror baseline is machine-explicitly non-authoritative", async () => {
  const source = await readFile(
    new URL("../../../../scripts/product-truth-baseline.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /authoritative:\s*false/);
  assert.match(source, /authoritativePhase1Manifest:\s*false/);
  assert.match(source, /LEGACY_RAW_SKU_DIAGNOSTIC_ONLY_NOT_EXACT_LISTING_TRUTH/);
  assert.doesNotMatch(source, /authoritative:\s*true/);
});

test("scope registry importer verifies canonical manifest bytes and checksum", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await db.execute(`CREATE TABLE SkuCost (
      id TEXT PRIMARY KEY, sku TEXT NOT NULL, source TEXT NOT NULL,
      evidenceJson TEXT, createdAt DATETIME NOT NULL
    )`);
    const migration = new URL(
      "../../../../prisma/migrations/20260719002000_product_truth_listing_scope/migration.sql",
      import.meta.url,
    );
    await db.executeMultiple(await readFile(migration, "utf8"));
    const manifest = buildPhase1ScopeManifest(input());
    const manifestJson = renderPhase1ScopeManifestJson(manifest);
    const relabeledV2 = structuredClone(manifest);
    delete (relabeledV2.policy as Partial<typeof relabeledV2.policy>)
      .builderPolicyVersion;
    const relabeledJson = renderPhase1ScopeManifestJson(relabeledV2);
    await assert.rejects(
      importAuthoritativePhase1ListingScopes(db, {
        manifest: relabeledV2,
        manifestJson: relabeledJson,
        expectedManifestSha256: sha256Hex(relabeledJson),
        registeredAt: "2026-07-18T22:00:01.000Z",
      }),
      /manifest v3 policy binding is invalid/,
    );
    await assert.rejects(
      importAuthoritativePhase1ListingScopes(db, {
        manifest, manifestJson, expectedManifestSha256: "0".repeat(64),
        registeredAt: "2026-07-18T22:00:01.000Z",
      }),
      /manifest SHA-256 mismatch/,
    );
    const imported = await importAuthoritativePhase1ListingScopes(db, {
      manifest, manifestJson, expectedManifestSha256: sha256Hex(manifestJson),
      registeredAt: "2026-07-18T22:00:01.000Z",
    });
    assert.equal(imported.inserted, 2);
    const repeated = await importAuthoritativePhase1ListingScopes(db, {
      manifest, manifestJson, expectedManifestSha256: sha256Hex(manifestJson),
      registeredAt: "2026-07-18T22:00:02.000Z",
    });
    assert.deepEqual(repeated, {
      manifestSha256: sha256Hex(manifestJson),
      inserted: 0,
      existing: 2,
    });

    const revisedAsOf = "2026-07-18T22:30:00.000Z";
    const revisedManifest = buildPhase1ScopeManifest(input({
      asOf: revisedAsOf,
      connectedStoreCensus: makeTestConnectedStoreCensus({ asOf: revisedAsOf }),
    }));
    const revisedJson = renderPhase1ScopeManifestJson(revisedManifest);
    await assert.rejects(
      importAuthoritativePhase1ListingScopes(db, {
        manifest: revisedManifest,
        manifestJson: revisedJson,
        expectedManifestSha256: sha256Hex(revisedJson),
        registeredAt: "2026-07-18T22:30:01.000Z",
      }),
      /registry immutable manifest binding conflict/,
    );
    assert.equal(
      Number((await db.execute(`SELECT COUNT(*) AS n FROM ProductTruthListingScope`)).rows[0]?.n),
      2,
    );
    await assert.rejects(
      db.execute(`UPDATE ProductTruthListingScope SET sku='OTHER' WHERE listingKey='amazon:1:AMZ-1'`),
      /PRODUCT_TRUTH_LISTING_SCOPE_IMMUTABLE/,
    );
  } finally {
    await db.close();
  }
});
