import { open, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";

import { MARKETPLACE_ID } from "../src/lib/amazon-sp-api/client";
import { sha256 } from "../src/lib/amazon-sp-api/uncrustables-order-history";
import { buildSearchTerms } from "../src/lib/bundle-factory/attributes/search-terms";

const CAPTURE_SCHEMA = "uncrustables-batch200-amazon-listings-capture/v1";
const PLAN_SCHEMA = "uncrustables-batch200-seo-surgical-plan/v1";

interface StagedRow {
  slug: string;
  sku: string;
  channel_sku_id: string;
  pack_count: number;
  title: string;
  comps: Array<{ flavor: string; qty: number }>;
}

interface CaptureEntry {
  status: string;
  sku: string;
  channelSkuId: string;
  asin: string;
  productType: string;
  listingStatus: string[];
  errorIssueCount: number;
  rawFile: string;
  rawSha256: string;
}

interface Capture {
  schemaVersion: string;
  counts: { captured: number; failed: number; withAsin: number };
  entries: CaptureEntry[];
}

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

function attributeValue(attributes: Record<string, unknown>, name: string): unknown {
  const rows = attributes[name];
  return Array.isArray(rows) && rows[0] && typeof rows[0] === "object"
    ? (rows[0] as Record<string, unknown>).value ?? null
    : null;
}

function uniqueFlavors(row: StagedRow): string[] {
  return [...new Set(row.comps.map((component) => component.flavor.trim()).filter(Boolean))];
}

function csvField(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Build an offline, exact-snapshot-bound batch-200 SEO PATCH plan.\n"
      + "Required: --capture-dir /ABS/DIR --capture-sha256 SHA --staged /ABS/JSON --out-dir /ABS/EXISTING",
    );
    return;
  }
  const allowed = new Set(["--capture-dir", "--capture-sha256", "--staged", "--out-dir"]);
  if (args.some((arg) => arg.startsWith("--") && !allowed.has(arg))) fail("unknown argument");
  const captureDir = exactArg(args, "--capture-dir");
  const expectedCaptureSha = exactArg(args, "--capture-sha256").toLowerCase();
  const stagedPath = exactArg(args, "--staged");
  const outDir = exactArg(args, "--out-dir");
  for (const [name, path] of [["--capture-dir", captureDir], ["--staged", stagedPath], ["--out-dir", outDir]]) {
    if (!isAbsolute(path) || normalize(path) !== path) fail(`${name} must be a normalized absolute path`);
  }
  if (await realpath(outDir) !== outDir || await realpath(dirname(stagedPath)) !== dirname(stagedPath)) {
    fail("input/output parents must be real paths");
  }
  const captureBytes = await readFile(join(await realpath(captureDir), "capture.json"));
  if (sha256(captureBytes) !== expectedCaptureSha) fail("capture SHA-256 mismatch");
  const capture = JSON.parse(captureBytes.toString("utf8")) as Capture;
  if (
    capture.schemaVersion !== CAPTURE_SCHEMA
    || capture.counts.captured !== 200
    || capture.counts.failed !== 0
    || capture.counts.withAsin !== 200
    || capture.entries.length !== 200
  ) fail("capture is not a complete batch-200 observation");
  const stagedBytes = await readFile(await realpath(stagedPath));
  const staged = JSON.parse(stagedBytes.toString("utf8")) as StagedRow[];
  if (!Array.isArray(staged) || staged.length !== 200) fail("staged input is not exact batch-200");
  const stagedBySku = new Map(staged.map((row) => [row.sku, row]));

  const entries = [];
  for (const captureEntry of capture.entries) {
    const stagedRow = stagedBySku.get(captureEntry.sku);
    if (!stagedRow || stagedRow.channel_sku_id !== captureEntry.channelSkuId) {
      fail(`staged/capture identity mismatch for ${captureEntry.sku}`);
    }
    const rawBytes = await readFile(join(captureDir, captureEntry.rawFile));
    if (sha256(rawBytes) !== captureEntry.rawSha256) fail(`raw listing hash mismatch for ${captureEntry.sku}`);
    const raw = JSON.parse(rawBytes.toString("utf8")) as { attributes?: Record<string, unknown> };
    const attributes = raw.attributes ?? {};
    const flavors = uniqueFlavors(stagedRow);
    if (flavors.length < 1 || !Number.isInteger(stagedRow.pack_count) || stagedRow.pack_count < 1) {
      fail(`staged recipe facts are invalid for ${captureEntry.sku}`);
    }
    const exactSearchSeed = [
      "Uncrustables",
      ...flavors,
      "Sandwich",
      `${stagedRow.pack_count} Count`,
      "Frozen",
      stagedRow.title,
    ].join(" ");
    const desired = {
      generic_keyword: buildSearchTerms(exactSearchSeed, "Uncrustables"),
      flavor: flavors.join(", "),
      size: `${stagedRow.pack_count} Count`,
      specialty: "Frozen",
      item_form: "Sandwich",
      number_of_pieces: stagedRow.pack_count,
    };
    const eligible =
      captureEntry.status === "CAPTURED"
      && captureEntry.productType === "FOOD"
      && captureEntry.errorIssueCount === 0
      && captureEntry.listingStatus.includes("BUYABLE")
      && captureEntry.listingStatus.includes("DISCOVERABLE");
    entries.push({
      ordinal: entries.length + 1,
      slug: stagedRow.slug,
      sku: stagedRow.sku,
      channelSkuId: stagedRow.channel_sku_id,
      asin: captureEntry.asin,
      productType: captureEntry.productType,
      listingStatus: captureEntry.listingStatus,
      sourceRawFile: captureEntry.rawFile,
      sourceRawSha256: captureEntry.rawSha256,
      recipe: { packCount: stagedRow.pack_count, flavors, kind: flavors.length === 1 ? "single" : "mixed" },
      current: {
        generic_keyword: attributeValue(attributes, "generic_keyword"),
        flavor: attributeValue(attributes, "flavor"),
        size: attributeValue(attributes, "size"),
        specialty: attributeValue(attributes, "specialty"),
        item_form: attributeValue(attributes, "item_form"),
        number_of_pieces: attributeValue(attributes, "number_of_pieces"),
      },
      desired,
      eligible,
      blockerCodes: [
        ...(captureEntry.productType === "FOOD" ? [] : ["PRODUCT_TYPE_NOT_FOOD"]),
        ...(captureEntry.errorIssueCount === 0 ? [] : ["LIVE_ERROR_PRESENT"]),
        ...(captureEntry.listingStatus.includes("BUYABLE") ? [] : ["NOT_BUYABLE"]),
        ...(captureEntry.listingStatus.includes("DISCOVERABLE") ? [] : ["NOT_DISCOVERABLE"]),
      ],
    });
  }
  const eligibleSingles = entries.filter((entry) => entry.eligible && entry.recipe.kind === "single");
  const eligibleMixed = entries.filter((entry) => entry.eligible && entry.recipe.kind === "mixed");
  const singleCanaryCount = Math.min(5, eligibleSingles.length);
  const mixedCanaryCount = 10 - singleCanaryCount;
  const canarySkus = [
    ...eligibleSingles.slice(0, singleCanaryCount),
    ...eligibleMixed.slice(0, mixedCanaryCount),
  ].map((entry) => entry.sku);
  if (canarySkus.length !== 10) fail("could not construct an exact 10-SKU canary");
  const plan = {
    schemaVersion: PLAN_SCHEMA,
    generatedAt: new Date().toISOString(),
    scope: { storeIndex: 1, marketplaceId: MARKETPLACE_ID, targets: 200 },
    sources: {
      capturePath: join(captureDir, "capture.json"),
      captureSha256: expectedCaptureSha,
      stagedPath,
      stagedSha256: sha256(stagedBytes),
    },
    policy: {
      mutationMethod: "SURGICAL_ATTRIBUTE_PATCH_ONLY",
      titleMutation: false,
      offerMutation: false,
      imageMutation: false,
      formFactorOmittedBecauseCurrentFoodSchemaDoesNotExposeIt: true,
      genericPutForbidden: true,
      realPatchRequiresFreshPreReadAndAmbiguityFence: true,
    },
    counts: {
      targets: entries.length,
      eligible: entries.filter((entry) => entry.eligible).length,
      blocked: entries.filter((entry) => !entry.eligible).length,
      singleFlavor: entries.filter((entry) => entry.recipe.kind === "single").length,
      mixedFlavor: entries.filter((entry) => entry.recipe.kind === "mixed").length,
      canary: canarySkus.length,
    },
    canarySkus,
    entries,
  };
  const planJson = `${JSON.stringify(plan, null, 2)}\n`;
  const csvHeaders = [
    "sku", "asin", "eligible", "kind", "pack_count", "flavors", "current_keyword",
    "desired_keyword", "desired_flavor", "desired_size", "desired_specialty",
    "desired_item_form", "desired_number_of_pieces", "blockers",
  ];
  const csvRows = entries.map((entry) => [
    entry.sku,
    entry.asin,
    entry.eligible,
    entry.recipe.kind,
    entry.recipe.packCount,
    entry.recipe.flavors.join(" + "),
    entry.current.generic_keyword,
    entry.desired.generic_keyword,
    entry.desired.flavor,
    entry.desired.size,
    entry.desired.specialty,
    entry.desired.item_form,
    entry.desired.number_of_pieces,
    entry.blockerCodes.join(" + "),
  ].map(csvField).join(","));
  const csv = `${csvHeaders.join(",")}\n${csvRows.join("\n")}\n`;
  const markdown = [
    "# Batch-200 SEO surgical patch plan",
    "",
    `Generated: ${plan.generatedAt}`,
    "",
    `Eligible: ${plan.counts.eligible}/200; blocked: ${plan.counts.blocked}; maximum-balanced canary: ${singleCanaryCount} single-flavor + ${mixedCanaryCount} mixed.`,
    "",
    "The plan replaces only generic_keyword and adds exact recipe-bound flavor, count size, Frozen specialty, Sandwich item form, and number_of_pieces. It does not change title, offer, price, coupon, inventory, images, or use generic PUT. form_factor is omitted because the current FOOD schema does not expose it.",
    "",
    `Canary SKUs: ${canarySkus.join(", ")}`,
    "",
  ].join("\n");
  await Promise.all([
    writeNew(join(outDir, "seo-patch-plan.json"), planJson),
    writeNew(join(outDir, "seo-patch-plan.csv"), csv),
    writeNew(join(outDir, "seo-patch-plan.md"), markdown),
    writeNew(join(outDir, "seo-patch-plan.sha256"), `${sha256(planJson)}\n`),
  ]);
  console.log(JSON.stringify({
    status: "SEO_PATCH_PLAN_READY",
    outDir,
    planSha256: sha256(planJson),
    ...plan.counts,
    marketplaceCalls: 0,
    databaseWrites: 0,
    marketplaceMutations: 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
