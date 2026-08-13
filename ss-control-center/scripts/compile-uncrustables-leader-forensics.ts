import { open, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, normalize } from "node:path";

import { sha256 } from "../src/lib/amazon-sp-api/uncrustables-order-history";

const CAPTURE_SCHEMA = "uncrustables-leader-forensics-capture/v1";
const OUTPUT_SCHEMA = "uncrustables-leader-forensics-analysis/v1";

interface EvidenceBinding {
  status: string;
  file?: string;
  sha256?: string;
  byteLength?: number;
  error?: string;
}

interface SalesEvidence {
  sku: string;
  asin: string;
  preferredTitle: string | null;
  units: number;
  distinctOrders: number;
  grossRevenue: number;
  firstOrderAt: string;
  lastOrderAt: string;
  snapshotDisposition?: string;
  springCleanupCandidate?: boolean;
  channelMax: { isSelling: boolean | null; addedAt: string | null } | null;
}

interface CaptureEntry {
  ordinal: number;
  observedAt: string;
  sales: SalesEvidence;
  catalog: EvidenceBinding;
  listingContribution: EvidenceBinding;
  images: Array<Record<string, unknown>>;
}

interface Capture {
  schemaVersion: string;
  capturedAt: string;
  source: { analysisPath: string; analysisSha256: string; targetLimit: number };
  counts: Record<string, number>;
  claims: Record<string, number>;
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

async function readBoundJson(
  captureDir: string,
  binding: EvidenceBinding,
): Promise<Record<string, unknown> | null> {
  if (binding.status !== "CAPTURED") return null;
  if (!binding.file || basename(binding.file) !== binding.file || !binding.sha256) {
    fail("captured evidence lacks a safe file/hash binding");
  }
  const bytes = await readFile(join(captureDir, binding.file));
  if (bytes.length !== binding.byteLength || sha256(bytes) !== binding.sha256) {
    fail(`evidence binding failed for ${binding.file}`);
  }
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`evidence JSON is not an object: ${binding.file}`);
  }
  return parsed as Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function arrayOfObjects(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(objectValue).filter((row) => row !== null) : [];
}

function attributeRows(
  document: Record<string, unknown> | null,
  name: string,
): Array<Record<string, unknown>> {
  const attributes = objectValue(document?.attributes);
  return arrayOfObjects(attributes?.[name]);
}

function attributeStrings(document: Record<string, unknown> | null, name: string): string[] {
  return attributeRows(document, name)
    .map((row) => row.value)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
}

function attributeNumbers(document: Record<string, unknown> | null, name: string): number[] {
  return attributeRows(document, name)
    .map((row) => row.value)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function firstString(values: string[]): string | null {
  return values[0] ?? null;
}

function summary(document: Record<string, unknown> | null): Record<string, unknown> | null {
  return arrayOfObjects(document?.summaries)[0] ?? null;
}

function stringField(document: Record<string, unknown> | null, name: string): string | null {
  const value = summary(document)?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function statusValues(document: Record<string, unknown> | null): string[] {
  const value = summary(document)?.status;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function listingContributionAvailable(document: Record<string, unknown> | null): boolean {
  const attributes = objectValue(document?.attributes);
  return summary(document) !== null && attributes !== null && Object.keys(attributes).length > 0;
}

function issueCodes(document: Record<string, unknown> | null): string[] {
  return arrayOfObjects(document?.issues)
    .map((issue) => issue.code)
    .filter((value): value is string => typeof value === "string");
}

const FLAVOR_MARKERS = [
  "raspberry",
  "grape",
  "strawberry",
  "honey",
  "hazelnut",
  "chocolate",
  "blueberry",
  "vanilla",
  "bright-eyed berry",
  "beamin' berry",
  "whole wheat",
  "reduced sugar",
] as const;

function flavorMarkers(text: string | null): string[] {
  const normalized = (text ?? "").toLowerCase();
  return FLAVOR_MARKERS.filter((marker) => normalized.includes(marker));
}

function declaredPieceCount(title: string | null): number | null {
  if (!title) return null;
  const patterns = [
    /total\s+(\d+)\s+(?:pieces?|count|ct)\b/iu,
    /\b(\d+)\s+(?:pieces?|count|ct)\b/iu,
  ];
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

function csvField(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function markdownCell(value: unknown): string {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function money(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function mean(values: number[]): number | null {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 10) / 10 : null;
}

async function writeExclusive(path: string, value: string): Promise<void> {
  const handle = await open(path, "wx", 0o400);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
    await handle.chmod(0o400);
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("Compile a sealed current-state forensic capture for historical Uncrustables leaders.\nRequired: --capture-dir ABS");
    return;
  }
  if (args.some((arg) => arg.startsWith("--") && arg !== "--capture-dir")) fail("unknown argument");
  const captureDir = exactArg(args, "--capture-dir");
  if (!isAbsolute(captureDir) || normalize(captureDir) !== captureDir) {
    fail("--capture-dir must be a normalized absolute path");
  }
  if (!(await stat(captureDir)).isDirectory()) fail("--capture-dir must be a directory");

  const captureBytes = await readFile(join(captureDir, "forensics-capture.json"));
  const capture = JSON.parse(captureBytes.toString("utf8")) as Capture;
  if (capture.schemaVersion !== CAPTURE_SCHEMA || !Array.isArray(capture.entries)) {
    fail("forensics capture schema is invalid");
  }
  const captureSha = sha256(captureBytes);
  const rows = [];
  for (const entry of capture.entries) {
    const catalog = await readBoundJson(captureDir, entry.catalog);
    const listing = await readBoundJson(captureDir, entry.listingContribution);
    const contributionAvailable = listingContributionAvailable(listing);
    const sellerTitle = firstString(attributeStrings(listing, "item_name")) ?? stringField(listing, "itemName");
    const catalogTitle = firstString(attributeStrings(catalog, "item_name")) ?? stringField(catalog, "itemName");
    const currentTitle = sellerTitle ?? catalogTitle;
    const catalogFlavor = attributeStrings(catalog, "flavor");
    const sellerFlavor = attributeStrings(listing, "flavor");
    const effectiveFlavor = sellerFlavor.length ? sellerFlavor : catalogFlavor;
    const titleMarkers = flavorMarkers(currentTitle);
    const attributeMarkers = flavorMarkers(effectiveFlavor.join(" "));
    const titleCount = declaredPieceCount(currentTitle);
    const numberOfPieces = attributeNumbers(listing, "number_of_pieces")[0]
      ?? attributeNumbers(catalog, "number_of_pieces")[0]
      ?? null;
    const bullets = attributeStrings(listing, "bullet_point").length
      ? attributeStrings(listing, "bullet_point")
      : attributeStrings(catalog, "bullet_point");
    const descriptions = attributeStrings(listing, "product_description").length
      ? attributeStrings(listing, "product_description")
      : attributeStrings(catalog, "product_description");
    const images = entry.images.filter((image) => image.status === "CAPTURED");
    const mismatchFlags = [];
    if (titleMarkers.length && attributeMarkers.length
      && !titleMarkers.some((marker) => attributeMarkers.includes(marker))) {
      mismatchFlags.push("TITLE_FLAVOR_VS_FLAVOR_ATTRIBUTE");
    }
    if (titleCount !== null && numberOfPieces !== null && titleCount !== numberOfPieces) {
      mismatchFlags.push("TITLE_COUNT_VS_NUMBER_OF_PIECES");
    }
    if (currentTitle && entry.sales.preferredTitle
      && currentTitle.toLowerCase() !== entry.sales.preferredTitle.toLowerCase()) {
      mismatchFlags.push("ORDER_TITLE_VS_CURRENT_TITLE_CHANGED");
    }
    rows.push({
      rank: entry.ordinal,
      sales: entry.sales,
      historicalEvidence: {
        orderTitle: entry.sales.preferredTitle,
        firstOrderAt: entry.sales.firstOrderAt,
        lastOrderAt: entry.sales.lastOrderAt,
      },
      currentObservation: {
        observedAt: entry.observedAt,
        catalogAvailable: catalog !== null,
        catalogNotFoundNow: entry.catalog.status === "GET_FAILED"
          && entry.catalog.error?.includes("SP-API 404") === true,
        listingDocumentFetched: listing !== null,
        sellerContributionAvailable: contributionAvailable,
        listingIssueCodes: issueCodes(listing),
        listingStatus: statusValues(listing),
        productType: stringField(listing, "productType")
          ?? arrayOfObjects(catalog?.productTypes).map((row) => row.productType)
            .find((value): value is string => typeof value === "string")
          ?? null,
        title: currentTitle,
        titleSource: sellerTitle ? "SELLER_CONTRIBUTION" : catalogTitle ? "CATALOG" : null,
        bulletPoints: bullets,
        bulletCount: bullets.length,
        description: descriptions.join("\n\n") || null,
        descriptionLength: descriptions.join("\n\n").length,
        flavor: effectiveFlavor,
        size: attributeStrings(listing, "size").length
          ? attributeStrings(listing, "size") : attributeStrings(catalog, "size"),
        specialty: attributeStrings(listing, "specialty").length
          ? attributeStrings(listing, "specialty") : attributeStrings(catalog, "specialty"),
        itemForm: attributeStrings(listing, "item_form").length
          ? attributeStrings(listing, "item_form") : attributeStrings(catalog, "item_form"),
        numberOfPieces,
        unitCount: attributeRows(listing, "unit_count").length
          ? attributeRows(listing, "unit_count") : attributeRows(catalog, "unit_count"),
        ingredients: attributeStrings(listing, "ingredients").length
          ? attributeStrings(listing, "ingredients") : attributeStrings(catalog, "ingredients"),
        genericKeyword: attributeStrings(listing, "generic_keyword"),
        imageCount: images.length,
        imageVariants: images.map((image) => image.variant),
        mainImage: images.find((image) => image.variant === "MAIN") ?? null,
        mismatchFlags,
      },
      deletionEvidence: {
        channelMaxSnapshotNotSelling: entry.sales.channelMax?.isSelling !== true,
        sellerContributionMissingNow: !contributionAvailable,
        catalogNotFoundNow: entry.catalog.status === "GET_FAILED"
          && entry.catalog.error?.includes("SP-API 404") === true,
        listingSuppressedBecauseCatalogMissing: issueCodes(listing).includes("13013"),
        springCleanupCandidate: entry.sales.springCleanupCandidate === true,
        deletionDateOrReasonProven: false,
      },
    });
  }

  const present = rows.filter((row) => row.currentObservation.sellerContributionAvailable);
  const missing = rows.filter((row) => !row.currentObservation.sellerContributionAvailable);
  const metrics = (group: typeof rows) => ({
    identities: group.length,
    units: group.reduce((sum, row) => sum + row.sales.units, 0),
    grossRevenue: Math.round(group.reduce((sum, row) => sum + row.sales.grossRevenue, 0) * 100) / 100,
    averageBulletCount: mean(group.map((row) => row.currentObservation.bulletCount)),
    averageDescriptionLength: mean(group.map((row) => row.currentObservation.descriptionLength)),
    averageImageCount: mean(group.map((row) => row.currentObservation.imageCount)),
    currentMismatchCount: group.filter((row) => row.currentObservation.mismatchFlags.length > 0).length,
  });
  const result = {
    schemaVersion: OUTPUT_SCHEMA,
    generatedAt: new Date().toISOString(),
    source: {
      captureSha256: captureSha,
      salesAnalysisPath: capture.source.analysisPath,
      salesAnalysisSha256: capture.source.analysisSha256,
      currentObservationCapturedAt: capture.capturedAt,
      marketplaceMutations: 0,
    },
    interpretationBoundary: [
      "Order titles and order metrics are historical evidence for the order dates.",
      "Catalog, seller-contribution, attributes, and images are current observations captured after the historical orders.",
      "A Catalog Items 404 proves that the ASIN is absent from the current marketplace catalog; it does not prove the deletion date or Amazon's reason.",
      "A Listings Items response containing only issue 13013 is a suppressed orphaned SKU, not an available seller contribution.",
      "Content-feature comparisons are descriptive correlations, not causal proof of conversion performance.",
    ],
    cohorts: {
      all: metrics(rows),
      currentSellerContributionPresent: metrics(present),
      currentSellerContributionMissing: metrics(missing),
      top10: metrics(rows.slice(0, 10)),
      ranks11Plus: metrics(rows.slice(10)),
    },
    rows,
  };
  const csvHeaders = [
    "rank", "asin", "sku", "units", "orders", "gross_revenue", "first_order_at", "last_order_at",
    "channelmax_is_selling", "seller_contribution_available", "catalog_available", "order_title", "current_title",
    "bullet_count", "description_length", "image_count", "flavor", "size", "specialty", "item_form",
    "number_of_pieces", "mismatch_flags",
  ];
  const csvRows = rows.map((row) => [
    row.rank,
    row.sales.asin,
    row.sales.sku,
    row.sales.units,
    row.sales.distinctOrders,
    row.sales.grossRevenue.toFixed(2),
    row.sales.firstOrderAt,
    row.sales.lastOrderAt,
    row.sales.channelMax?.isSelling,
    row.currentObservation.sellerContributionAvailable,
    row.currentObservation.catalogAvailable,
    row.historicalEvidence.orderTitle,
    row.currentObservation.title,
    row.currentObservation.bulletCount,
    row.currentObservation.descriptionLength,
    row.currentObservation.imageCount,
    row.currentObservation.flavor.join("; "),
    row.currentObservation.size.join("; "),
    row.currentObservation.specialty.join("; "),
    row.currentObservation.itemForm.join("; "),
    row.currentObservation.numberOfPieces,
    row.currentObservation.mismatchFlags.join("; "),
  ].map(csvField).join(","));
  const markdown = [
    "# Uncrustables historical leader forensics",
    "",
    `Generated: ${result.generatedAt}`,
    `Historical sales analysis SHA-256: \`${capture.source.analysisSha256}\``,
    `Current-state capture SHA-256: \`${captureSha}\``,
    "",
    "## Evidence boundary",
    "",
    ...result.interpretationBoundary.map((line) => `- ${line}`),
    "",
    "## Cohort comparison",
    "",
    "| Cohort | ASIN/SKU identities | Units | Turnover | Avg bullets | Avg description chars | Avg images | Current mismatches |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...Object.entries(result.cohorts).map(([name, cohort]) => [
      `| ${name}`,
      cohort.identities,
      cohort.units,
      money(cohort.grossRevenue),
      cohort.averageBulletCount ?? "n/a",
      cohort.averageDescriptionLength ?? "n/a",
      cohort.averageImageCount ?? "n/a",
      `${cohort.currentMismatchCount} |`,
    ].join(" | ")),
    "",
    "## Ranked evidence",
    "",
    "| Rank | ASIN | SKU | Units | Turnover | Last order | Current contribution | Images | Mismatch flags | Historical order title |",
    "|---:|---|---|---:|---:|---|---|---:|---|---|",
    ...rows.map((row) => [
      `| ${row.rank}`,
      row.sales.asin,
      row.sales.sku,
      row.sales.units,
      money(row.sales.grossRevenue),
      row.sales.lastOrderAt.slice(0, 10),
      row.currentObservation.sellerContributionAvailable ? "present" : "missing",
      row.currentObservation.imageCount,
      markdownCell(row.currentObservation.mismatchFlags.join(", ")),
      `${markdownCell(row.historicalEvidence.orderTitle)} |`,
    ].join(" | ")),
    "",
    "## Required gap closure",
    "",
    "For identities whose seller contribution is missing, use the Vico/Veeqo catalog export or another date-bound seller-contribution archive to reconstruct historical bullets, descriptions, attributes, and submitted images. The current catalog may reflect contributions from other sellers and must not be relabeled as the historical Salutem listing.",
    "",
  ].join("\n");
  const json = `${JSON.stringify(result, null, 2)}\n`;
  const csv = `${csvHeaders.join(",")}\n${csvRows.join("\n")}\n`;
  await writeExclusive(join(captureDir, "leader-forensics-analysis.json"), json);
  await writeExclusive(join(captureDir, "leader-forensics-analysis.csv"), csv);
  await writeExclusive(join(captureDir, "leader-forensics-summary.md"), markdown);
  await writeExclusive(
    join(captureDir, "leader-forensics-analysis.sha256"),
    `${sha256(json)}  leader-forensics-analysis.json\n${sha256(csv)}  leader-forensics-analysis.csv\n${sha256(markdown)}  leader-forensics-summary.md\n`,
  );
  console.log(JSON.stringify({
    status: "COMPILED",
    captureDir,
    identities: rows.length,
    currentSellerContributions: present.length,
    missingSellerContributions: missing.length,
    currentCatalogs: rows.filter((row) => row.currentObservation.catalogAvailable).length,
    images: rows.reduce((sum, row) => sum + row.currentObservation.imageCount, 0),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
