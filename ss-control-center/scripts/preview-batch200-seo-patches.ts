import { open, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";

import { MARKETPLACE_ID, spApiGet } from "../src/lib/amazon-sp-api/client";
import { patchListing, type ListingPatch } from "../src/lib/amazon-sp-api/listings";
import { sha256 } from "../src/lib/amazon-sp-api/uncrustables-order-history";

const PLAN_SCHEMA = "uncrustables-batch200-seo-surgical-plan/v1";
const PREVIEW_SCHEMA = "uncrustables-batch200-seo-validation-preview/v1";

interface PlanEntry {
  sku: string;
  asin: string;
  productType: string;
  eligible: boolean;
  current: Record<string, unknown>;
  desired: {
    generic_keyword: string;
    flavor: string;
    size: string;
    specialty: string;
    item_form: string;
    number_of_pieces: number;
  };
}

interface Plan {
  schemaVersion: string;
  canarySkus: string[];
  entries: PlanEntry[];
  policy: { mutationMethod?: unknown; genericPutForbidden?: unknown };
}

type Selection = "CANARY" | "ROLLOUT_REMAINDER";

function fail(message: string): never {
  throw new Error(message);
}

function exactArg(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1 || args.indexOf(name, index + 1) >= 0) {
    return fail(`${name} is required exactly once`);
  }
  const value = args[index + 1];
  if (!value || value !== value.trim() || value.startsWith("--")) {
    return fail(`${name} must have one exact value`);
  }
  return value;
}

function optionalArg(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (index === args.length - 1 || args.indexOf(name, index + 1) >= 0) {
    return fail(`${name} must appear at most once with one value`);
  }
  const value = args[index + 1];
  if (!value || value !== value.trim() || value.startsWith("--")) {
    return fail(`${name} must have one exact value`);
  }
  return value;
}

async function writeNew(path: string, value: string): Promise<void> {
  try {
    await stat(path);
    fail(`output already exists: ${path}`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const handle = await open(path, "wx", 0o400);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
    await handle.chmod(0o400);
  } finally {
    await handle.close();
  }
}

function currentValue(attributes: Record<string, unknown>, name: string): unknown {
  const rows = attributes[name];
  return Array.isArray(rows) && rows[0] && typeof rows[0] === "object"
    ? (rows[0] as Record<string, unknown>).value ?? null
    : null;
}

function patches(entry: PlanEntry): ListingPatch[] {
  const localized = (value: string) => [{
    value,
    language_tag: "en_US",
    marketplace_id: MARKETPLACE_ID,
  }];
  return [
    {
      op: "replace",
      path: "/attributes/generic_keyword",
      value: localized(entry.desired.generic_keyword),
    },
    { op: "add", path: "/attributes/flavor", value: localized(entry.desired.flavor) },
    { op: "add", path: "/attributes/size", value: localized(entry.desired.size) },
    { op: "add", path: "/attributes/specialty", value: localized(entry.desired.specialty) },
    { op: "add", path: "/attributes/item_form", value: localized(entry.desired.item_form) },
    {
      op: "add",
      path: "/attributes/number_of_pieces",
      value: [{ value: entry.desired.number_of_pieces, marketplace_id: MARKETPLACE_ID }],
    },
  ];
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Run Amazon VALIDATION_PREVIEW for the batch-200 SEO canary or remaining eligible rollout.\n"
      + "Required: --plan /ABS/JSON --plan-sha256 SHA --out /ABS/NEW.json\n"
      + "Optional: --selection CANARY|ROLLOUT_REMAINDER (default CANARY)\n"
      + "This performs fresh GET + non-mutating validation-preview PATCH only.",
    );
    return;
  }
  const allowed = new Set(["--plan", "--plan-sha256", "--out", "--selection"]);
  if (args.some((arg) => arg.startsWith("--") && !allowed.has(arg))) fail("unknown argument");
  const planPath = exactArg(args, "--plan");
  const expectedPlanSha = exactArg(args, "--plan-sha256").toLowerCase();
  const outPath = exactArg(args, "--out");
  const selection = optionalArg(args, "--selection", "CANARY") as Selection;
  if (!["CANARY", "ROLLOUT_REMAINDER"].includes(selection)) fail("--selection is invalid");
  for (const [name, path] of [["--plan", planPath], ["--out", outPath]]) {
    if (!isAbsolute(path) || normalize(path) !== path) fail(`${name} must be a normalized absolute path`);
  }
  if (await realpath(dirname(outPath)) !== dirname(outPath)) fail("output parent must be a real path");
  const planBytes = await readFile(await realpath(planPath));
  if (sha256(planBytes) !== expectedPlanSha) fail("plan SHA-256 mismatch");
  const plan = JSON.parse(planBytes.toString("utf8")) as Plan;
  if (
    plan.schemaVersion !== PLAN_SCHEMA
    || plan.policy.mutationMethod !== "SURGICAL_ATTRIBUTE_PATCH_ONLY"
    || plan.policy.genericPutForbidden !== true
    || !Array.isArray(plan.canarySkus)
    || plan.canarySkus.length !== 10
  ) fail("plan contract is invalid");
  const entryBySku = new Map(plan.entries.map((entry) => [entry.sku, entry]));
  const targetSkus = selection === "CANARY"
    ? plan.canarySkus
    : plan.entries.filter((entry) =>
      entry.eligible && entry.productType === "FOOD" && !plan.canarySkus.includes(entry.sku))
      .map((entry) => entry.sku);
  if (targetSkus.length < 1 || new Set(targetSkus).size !== targetSkus.length) {
    fail("selected target set is empty or not unique");
  }
  const sellerId = process.env.AMAZON_SP_SELLER_ID_STORE1?.trim();
  if (!sellerId) fail("AMAZON_SP_SELLER_ID_STORE1 is required");
  const results = [];
  let amazonGetCalls = 0;
  let validationPreviewCalls = 0;
  for (const sku of targetSkus) {
    const entry = entryBySku.get(sku);
    if (!entry?.eligible || entry.productType !== "FOOD") fail(`canary entry is ineligible: ${sku}`);
    const fresh = await spApiGet(
      `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`,
      {
        storeId: "store1",
        params: { marketplaceIds: MARKETPLACE_ID, includedData: "summaries,attributes,issues,offers" },
        retries: 1,
        signal: AbortSignal.timeout(30_000),
        beforeRequest: () => { amazonGetCalls += 1; },
      },
    ) as { summaries?: Array<Record<string, unknown>>; attributes?: Record<string, unknown> };
    const summary = fresh.summaries?.[0];
    const liveAsin = typeof summary?.asin === "string" ? summary.asin : null;
    const liveProductType = typeof summary?.productType === "string" ? summary.productType : null;
    const statuses = Array.isArray(summary?.status) ? summary.status : [];
    if (
      liveAsin !== entry.asin
      || liveProductType !== "FOOD"
      || !statuses.includes("BUYABLE")
      || !statuses.includes("DISCOVERABLE")
    ) fail(`fresh listing identity/status drift for ${sku}`);
    const attributes = fresh.attributes ?? {};
    for (const name of ["generic_keyword", "flavor", "size", "specialty", "item_form", "number_of_pieces"]) {
      if (currentValue(attributes, name) !== entry.current[name]) {
        fail(`fresh attribute drift for ${sku}:${name}`);
      }
    }
    validationPreviewCalls += 1;
    const response = await patchListing(
      1,
      sellerId,
      sku,
      "FOOD",
      patches(entry),
      { validationPreview: true, retries: 1, signal: AbortSignal.timeout(30_000) },
    ) as Record<string, unknown>;
    results.push({
      sku,
      asin: entry.asin,
      freshObservedAt: new Date().toISOString(),
      freshListingSha256: sha256(`${JSON.stringify(fresh)}\n`),
      patches: patches(entry),
      response,
      accepted: response.status === "VALID" || response.status === "ACCEPTED",
    });
    await sleep(250);
  }
  const preview = {
    schemaVersion: PREVIEW_SCHEMA,
    completedAt: new Date().toISOString(),
    selection,
    plan: { path: planPath, sha256: expectedPlanSha },
    counts: {
      targets: results.length,
      accepted: results.filter((result) => result.accepted).length,
      rejected: results.filter((result) => !result.accepted).length,
    },
    claims: {
      amazonGetCalls,
      validationPreviewCalls,
      realPatchCalls: 0,
      genericPutCalls: 0,
      marketplaceMutations: 0,
      databaseWrites: 0,
    },
    results,
  };
  const previewJson = `${JSON.stringify(preview, null, 2)}\n`;
  await writeNew(outPath, previewJson);
  await writeNew(`${outPath}.sha256`, `${sha256(previewJson)}\n`);
  console.log(JSON.stringify({
    status: preview.counts.rejected === 0 ? "VALIDATION_PREVIEW_ACCEPTED" : "VALIDATION_PREVIEW_REJECTED",
    out: outPath,
    previewSha256: sha256(previewJson),
    ...preview.counts,
    ...preview.claims,
  }, null, 2));
  if (preview.counts.rejected > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
