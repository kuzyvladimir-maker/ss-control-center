/**
 * Owner/Codex-only recovery for one already-canonical donor whose paid detail
 * response returned but could not be persisted. It materializes one immutable
 * exact content observation from a bounded direct Target HTML artifact.
 *
 * The command performs no provider, paid, model, marketplace, procurement, or
 * seller-catalog action. It never creates a product/variant/decision and relies
 * on the Product Truth writer to recheck the exact Target offer, URL, title,
 * manufacturer GTIN, base-unit status and existing canonical alias.
 */
import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createClient } from "@libsql/client";

import {
  persistCompleteExactContentObservation,
} from "../src/lib/sourcing/donor-catalog";
import {
  renderProductTruthOperationalJson,
} from "../src/lib/sourcing/product-truth-operational-run-contract";
import {
  resolveProductTruthDatabaseTarget,
} from "../src/lib/sourcing/product-truth-database-target";

type Options = {
  url: string;
  allowRemote: boolean;
  authTokenEnv: string;
  evidencePath: string;
  evidenceSha256: string;
  confirmation: string;
  outDir: string;
};

const PRODUCT_TRUTH_DIRECT_TARGET_CONTENT_EVIDENCE_VERSION =
  "product-truth-direct-target-content-evidence/1.0.0" as const;

interface ProductTruthDirectTargetContentEvidence {
  schemaVersion: typeof PRODUCT_TRUTH_DIRECT_TARGET_CONTENT_EVIDENCE_VERSION;
  donorProductId: string;
  offerId: string;
  capturedAt: string;
  retailerContent: {
    retailer: "target";
    retailerProductId: string;
    productUrl: string;
    finalUrl: string;
    httpStatus: 200;
    fetchedAt: string;
    htmlFile: string;
    htmlSha256: string;
    normalizedGtin14: string;
    title: string;
    description: string;
    bullets: string[];
    attributes: string[];
    nutritionFacts: Record<string, unknown>;
    ingredients: string;
    allergens: string;
    mainImageUrl: string;
    imageUrls: string[];
    category: string;
    classificationEvidence: {
      departmentName: string;
      productTypeName: string;
      itemTypeName: string;
      storageClass: "Shelf Stable";
      storageRuleVersion: "target-grocery-crackers-shelf-stable/1.0.0";
    };
  };
  safety: {
    modelCalls: 0;
    providerCalls: 0;
    paidCalls: 0;
    retailerReads: 1;
    databaseWrites: 0;
    walmartWrites: 0;
  };
}

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactSha(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) fail("SHA256_INVALID", label);
  return normalized;
}

function parseOptions(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  let allowRemote = false;
  const valued = new Set([
    "--url",
    "--auth-token-env",
    "--evidence",
    "--evidence-sha256",
    "--confirm",
    "--out",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--allow-remote") {
      if (allowRemote) fail("CLI_ARGUMENT_DUPLICATE", flag);
      allowRemote = true;
      continue;
    }
    if (!valued.has(flag)) fail("CLI_ARGUMENT_UNKNOWN", flag);
    if (values.has(flag)) fail("CLI_ARGUMENT_DUPLICATE", flag);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail("CLI_ARGUMENT_VALUE_REQUIRED", flag);
    values.set(flag, value);
    index += 1;
  }
  const required = (flag: string): string => {
    const value = values.get(flag)?.trim();
    if (!value) fail("CLI_ARGUMENT_REQUIRED", flag);
    return value;
  };
  const evidencePath = required("--evidence");
  const outDir = required("--out");
  if (!isAbsolute(evidencePath) || !isAbsolute(outDir)) {
    fail("ABSOLUTE_PATH_REQUIRED", "--evidence and --out must be absolute");
  }
  return {
    url: required("--url"),
    allowRemote,
    authTokenEnv: required("--auth-token-env"),
    evidencePath,
    evidenceSha256: exactSha(required("--evidence-sha256"), "--evidence-sha256"),
    confirmation: required("--confirm"),
    outDir,
  };
}

function exactText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    fail("DIRECT_TARGET_CONTENT_INVALID", `${label} must be non-empty text`);
  }
  return value.trim();
}

function exactTargetItemId(value: unknown): string | null {
  try {
    const url = new URL(exactText(value, "Target URL"));
    if (url.protocol !== "https:" || !/(^|\.)target\.com$/i.test(url.hostname)) return null;
    return url.pathname.match(/\/A-(\d+)(?:\/|$)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function validateEvidence(
  value: unknown,
  evidenceJson: string,
  evidenceSha256: string,
): ProductTruthDirectTargetContentEvidence {
  const evidence = value as ProductTruthDirectTargetContentEvidence;
  const content = evidence?.retailerContent;
  const classification = content?.classificationEvidence;
  const expectedItemId = exactTargetItemId(content?.productUrl);
  const finalItemId = exactTargetItemId(content?.finalUrl);
  const images = content?.imageUrls;
  const capturedAt = Date.parse(String(evidence?.capturedAt ?? ""));
  if (
    evidence?.schemaVersion !== PRODUCT_TRUTH_DIRECT_TARGET_CONTENT_EVIDENCE_VERSION
    || renderProductTruthOperationalJson(evidence) !== evidenceJson
    || sha256(evidenceJson) !== evidenceSha256
    || !evidence.donorProductId
    || !evidence.offerId
    || content?.retailer !== "target"
    || content.httpStatus !== 200
    || expectedItemId !== content.retailerProductId
    || finalItemId !== content.retailerProductId
    || content.fetchedAt !== evidence.capturedAt
    || !Number.isFinite(capturedAt)
    || capturedAt > Date.now()
    || Date.now() - capturedAt > 24 * 60 * 60 * 1_000
    || !/^\d{14}$/.test(content.normalizedGtin14)
    || !content.title
    || !content.description
    || !content.bullets?.length
    || !content.attributes?.length
    || !content.ingredients
    || !content.allergens
    || !Object.keys(content.nutritionFacts ?? {}).length
    || !content.mainImageUrl
    || !Array.isArray(images)
    || images.length < 2
    || !images.includes(content.mainImageUrl)
    || content.category !== "Crackers"
    || classification?.departmentName !== "SNACKS"
    || classification.productTypeName !== "GROCERY"
    || classification.itemTypeName !== "Crackers"
    || classification.storageClass !== "Shelf Stable"
    || classification.storageRuleVersion !== "target-grocery-crackers-shelf-stable/1.0.0"
    || evidence.safety.modelCalls !== 0
    || evidence.safety.providerCalls !== 0
    || evidence.safety.paidCalls !== 0
    || evidence.safety.retailerReads !== 1
    || evidence.safety.databaseWrites !== 0
    || evidence.safety.walmartWrites !== 0
  ) {
    fail(
      "DIRECT_TARGET_CONTENT_INVALID",
      "canonical bytes, exact item/GTIN, freshness, full content/gallery/classification, or safety gate failed",
    );
  }
  return evidence;
}

async function writeNew(path: string, value: string): Promise<void> {
  const handle = await open(path, "wx", 0o400);
  try {
    await handle.writeFile(value, "utf8");
  } finally {
    await handle.close();
  }
}

async function run(options: Options): Promise<void> {
  const resolvedEvidencePath = await realpath(options.evidencePath);
  if (resolvedEvidencePath !== resolve(options.evidencePath)) {
    fail("EVIDENCE_PATH_UNSAFE", "evidence path must not traverse a symlink");
  }
  const evidenceJson = (await readFile(resolvedEvidencePath)).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(evidenceJson);
  } catch {
    fail("DIRECT_TARGET_CONTENT_INVALID", "evidence is not JSON");
  }
  const evidence = validateEvidence(parsed, evidenceJson, options.evidenceSha256);
  const htmlName = exactText(evidence.retailerContent.htmlFile, "htmlFile");
  if (basename(htmlName) !== htmlName) fail("EVIDENCE_PATH_UNSAFE", "htmlFile must be a basename");
  const htmlPath = await realpath(resolve(dirname(resolvedEvidencePath), htmlName));
  if (dirname(htmlPath) !== dirname(resolvedEvidencePath)) {
    fail("EVIDENCE_PATH_UNSAFE", "HTML artifact escaped the evidence directory");
  }
  const html = await readFile(htmlPath);
  if (sha256(html) !== exactSha(evidence.retailerContent.htmlSha256, "htmlSha256")) {
    fail("DIRECT_TARGET_CONTENT_INVALID", "HTML SHA-256 mismatch");
  }

  const expectedConfirmation = [
    "ACTIVATE_PRODUCT_TRUTH_DIRECT_TARGET_CONTENT_V1",
    options.evidenceSha256,
    evidence.donorProductId,
  ].join(":");
  if (options.confirmation !== expectedConfirmation) {
    fail("OWNER_CONFIRMATION_INVALID", `expected ${expectedConfirmation}`);
  }

  const target = resolveProductTruthDatabaseTarget(options.url, process.cwd());
  if (target.kind !== "remote" || !options.allowRemote) {
    fail("REMOTE_DATABASE_REQUIRES_EXPLICIT_FLAG", "exact remote Product Truth target required");
  }
  const authToken = process.env[options.authTokenEnv]?.trim();
  if (!authToken) fail("REMOTE_DATABASE_AUTH_REQUIRED", options.authTokenEnv);

  const runId = `direct-target-content:${options.evidenceSha256.slice(0, 24)}`;
  const approvalId = `owner-direct-target-content:${options.evidenceSha256.slice(0, 24)}`;
  const db = createClient({ url: target.clientUrl, authToken });
  let result: Awaited<ReturnType<typeof persistCompleteExactContentObservation>>;
  try {
    result = await persistCompleteExactContentObservation(db, {
      donorProductId: evidence.donorProductId,
      retailer: "target",
      retailerProductId: evidence.retailerContent.retailerProductId,
      sourceUrl: evidence.retailerContent.finalUrl,
      sourceApi: "target_direct_html",
      observedAt: evidence.capturedAt,
      processingNow: new Date().toISOString(),
      provenance: {
        runId,
        approvalId,
        meteredReceiptId: null,
      },
      identityPath: "DIRECT_TARGET_EXACT_GTIN",
      detailIdentity: {
        title: evidence.retailerContent.title,
        retailerProductId: evidence.retailerContent.retailerProductId,
        productUrl: evidence.retailerContent.finalUrl,
      },
      content: {
        description: evidence.retailerContent.description,
        bullets: evidence.retailerContent.bullets,
        attributes: {
          targetObservedAttributes: evidence.retailerContent.attributes,
          targetClassification: evidence.retailerContent.classificationEvidence,
          directTargetContentEvidenceSha256: options.evidenceSha256,
          directTargetHtmlSha256: evidence.retailerContent.htmlSha256,
        },
        nutritionFacts: evidence.retailerContent.nutritionFacts,
        ingredients: evidence.retailerContent.ingredients,
        allergens: evidence.retailerContent.allergens,
        mainImageUrl: evidence.retailerContent.mainImageUrl,
        imageUrls: evidence.retailerContent.imageUrls!,
        upc: evidence.retailerContent.normalizedGtin14,
        category: evidence.retailerContent.category!,
        storage: evidence.retailerContent.classificationEvidence!.storageClass,
      },
      requireBaseUnit: true,
      upcConflictPolicy: "block",
    });
  } finally {
    db.close();
  }

  const receipt = {
    schemaVersion: "product-truth-direct-target-content-activation-receipt/1.0.0",
    activatedAt: new Date().toISOString(),
    databaseTargetFingerprint: target.fingerprint,
    evidenceSha256: options.evidenceSha256,
    htmlSha256: evidence.retailerContent.htmlSha256,
    runId,
    approvalId,
    result,
    safety: {
      databaseWritesMaximum: 1,
      providerCalls: 0,
      paidCalls: 0,
      retailerReads: 0,
      modelCalls: 0,
      walmartWrites: 0,
      marketplaceWrites: 0,
    },
  };
  const receiptJson = renderProductTruthOperationalJson(receipt);
  await mkdir(dirname(options.outDir), { recursive: true, mode: 0o700 });
  await mkdir(options.outDir, { recursive: false, mode: 0o700 });
  await Promise.all([
    writeNew(resolve(options.outDir, "receipt.json"), receiptJson),
    writeNew(resolve(options.outDir, "receipt.sha256"), `${sha256(receiptJson)}\n`),
  ]);
  process.stdout.write(receiptJson);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  await run(parseOptions(argv));
}

const invoked = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
