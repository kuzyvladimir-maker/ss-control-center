import { open, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

import { sha256 } from "../src/lib/amazon-sp-api/uncrustables-order-history";

const SALES_SCHEMA = "uncrustables-historical-sales-analysis/v1";
const VEEQO_SCHEMA = "uncrustables-veeqo-historical-catalog-capture/v1";
const FORENSICS_SCHEMA = "uncrustables-leader-forensics-analysis/v1";
const OUTPUT_SCHEMA = "uncrustables-historical-identity-registry/v1";

type JsonObject = Record<string, unknown>;

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

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function objects(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(objectValue).filter((row) => row !== null) : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function csvField(value: unknown): string {
  const rendered = value == null ? "" : String(value);
  return /[",\r\n]/u.test(rendered) ? `"${rendered.replaceAll('"', '""')}"` : rendered;
}

function md(value: unknown): string {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function money(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

async function readJson(path: string, schema: string): Promise<{ bytes: Buffer; value: JsonObject }> {
  if (!(await stat(path)).isFile()) fail(`source is not a file: ${path}`);
  const bytes = await readFile(path);
  const value = JSON.parse(bytes.toString("utf8")) as JsonObject;
  if (value.schemaVersion !== schema) fail(`unsupported schema for ${path}`);
  return { bytes, value };
}

function statusFor(
  catalog404: boolean,
  veeqoInactiveAt: string | null,
  channelMaxSelling: boolean | null,
): string {
  if (catalog404) return "CURRENT_AMAZON_CATALOG_404";
  if (veeqoInactiveAt) return "VEEQO_AMAZON_CHANNEL_INACTIVE";
  if (channelMaxSelling === false) return "NOT_SELLING_IN_CHANNELMAX_2026_06_SNAPSHOT";
  if (channelMaxSelling === null) return "ABSENT_FROM_CHANNELMAX_2026_06_SNAPSHOT";
  return "SELLING_IN_CHANNELMAX_2026_06_SNAPSHOT";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Join sealed Amazon sales, Veeqo retained catalog, and current Amazon forensics into one historical identity registry.\n"
      + "Required: --sales ABS --veeqo ABS --forensics ABS --out-dir ABS",
    );
    return;
  }
  const allowed = new Set(["--sales", "--veeqo", "--forensics", "--out-dir"]);
  if (args.some((arg) => arg.startsWith("--") && !allowed.has(arg))) fail("unknown argument");
  const salesPath = exactArg(args, "--sales");
  const veeqoPath = exactArg(args, "--veeqo");
  const forensicsPath = exactArg(args, "--forensics");
  const outDir = exactArg(args, "--out-dir");
  for (const [name, path] of [
    ["--sales", salesPath], ["--veeqo", veeqoPath], ["--forensics", forensicsPath], ["--out-dir", outDir],
  ]) {
    if (!isAbsolute(path) || normalize(path) !== path) fail(`${name} must be a normalized absolute path`);
  }
  if (!(await stat(outDir)).isDirectory()) fail("--out-dir must be an existing directory");
  const [salesSource, veeqoSource, forensicsSource] = await Promise.all([
    readJson(salesPath, SALES_SCHEMA),
    readJson(veeqoPath, VEEQO_SCHEMA),
    readJson(forensicsPath, FORENSICS_SCHEMA),
  ]);
  const salesRows = objects(salesSource.value.salesByIdentity);
  const veeqoBySku = new Map(objects(veeqoSource.value.entries)
    .map((entry) => [text(objectValue(entry.sales)?.sku), entry] as const)
    .filter((pair): pair is [string, JsonObject] => pair[0] !== null));
  const forensicBySku = new Map(objects(forensicsSource.value.rows)
    .map((entry) => [text(objectValue(entry.sales)?.sku), entry] as const)
    .filter((pair): pair is [string, JsonObject] => pair[0] !== null));

  const rows = salesRows.map((sales, index) => {
    const sku = text(sales.sku) ?? fail(`sales row ${index} lacks SKU`);
    const asin = text(sales.asin);
    const channelMax = objectValue(sales.channelMax);
    const channelMaxSelling = booleanOrNull(channelMax?.isSelling);
    const veeqo = veeqoBySku.get(sku);
    const amazonChannels = objects(veeqo?.amazonChannels);
    const exactChannel = amazonChannels.find((channel) =>
      channel.remoteId === asin || objects(channel.channelSellables).some((item) => item.remoteSku === sku));
    const veeqoInactiveAt = text(exactChannel?.inactiveAfter);
    const veeqoProduct = objectValue(veeqo?.product);
    const forensic = forensicBySku.get(sku);
    const deletionEvidence = objectValue(forensic?.deletionEvidence);
    const currentObservation = objectValue(forensic?.currentObservation);
    const catalog404 = deletionEvidence?.catalogNotFoundNow === true;
    const currentCatalogChecked = forensic !== undefined;
    return {
      rank: index + 1,
      asin,
      sku,
      historicalTitle: text(sales.preferredTitle),
      firstOrderAt: text(sales.firstOrderAt),
      lastOrderAt: text(sales.lastOrderAt),
      nonCancelledOrders: number(sales.distinctOrders),
      nonCancelledUnits: number(sales.units),
      cancelledOrders: number(sales.cancelledOrders),
      cancelledUnits: number(sales.cancelledUnits),
      grossOrderLineTurnover: number(sales.grossRevenue),
      channelMaxSelling202606: channelMaxSelling,
      channelMaxAddedAt: text(channelMax?.addedAt),
      veeqoProductRetained: veeqo?.status === "CAPTURED",
      veeqoTitle: text(veeqoProduct?.title),
      veeqoDescriptionRetained: text(veeqoProduct?.description) !== null,
      veeqoMainImageRetained: objectValue(veeqo?.cachedMainImage)?.status === "CAPTURED",
      veeqoAmazonChannelStatus: text(exactChannel?.status),
      veeqoAmazonChannelInactiveAt: veeqoInactiveAt,
      currentCatalogChecked,
      currentAmazonCatalog404: currentCatalogChecked ? catalog404 : null,
      currentSellerContributionAvailable: currentCatalogChecked
        ? currentObservation?.sellerContributionAvailable === true : null,
      status: statusFor(catalog404, veeqoInactiveAt, channelMaxSelling),
      evidenceTier: catalog404
        ? "A_CURRENT_AMAZON_404"
        : veeqoInactiveAt ? "B_VEEQO_INACTIVE_TIMESTAMP"
          : channelMaxSelling !== true ? "C_CHANNELMAX_SNAPSHOT_ONLY" : "D_SELLING_SNAPSHOT",
    };
  });

  const aprilRows = rows.filter((row) => row.veeqoAmazonChannelInactiveAt?.startsWith("2026-04-30"));
  const current404Rows = rows.filter((row) => row.currentAmazonCatalog404 === true);
  const result = {
    schemaVersion: OUTPUT_SCHEMA,
    generatedAt: new Date().toISOString(),
    source: {
      salesPath,
      salesSha256: sha256(salesSource.bytes),
      veeqoPath,
      veeqoSha256: sha256(veeqoSource.bytes),
      forensicsPath,
      forensicsSha256: sha256(forensicsSource.bytes),
      marketplaceMutations: 0,
    },
    coverage: {
      identityRows: rows.length,
      uniqueAsins: new Set(rows.flatMap((row) => row.asin ? [row.asin] : [])).size,
      currentCatalogChecked: rows.filter((row) => row.currentCatalogChecked).length,
      currentAmazonCatalog404: current404Rows.length,
      veeqoProductsRetained: rows.filter((row) => row.veeqoProductRetained).length,
      veeqoApril30InactiveIdentityRows: aprilRows.length,
      veeqoApril30InactiveUniqueAsins: new Set(aprilRows.map((row) => row.asin)).size,
    },
    totals: {
      units: rows.reduce((sum, row) => sum + row.nonCancelledUnits, 0),
      grossOrderLineTurnover: Math.round(rows.reduce((sum, row) => sum + row.grossOrderLineTurnover, 0) * 100) / 100,
      april30InactiveUnits: aprilRows.reduce((sum, row) => sum + row.nonCancelledUnits, 0),
      april30InactiveTurnover: Math.round(aprilRows.reduce((sum, row) => sum + row.grossOrderLineTurnover, 0) * 100) / 100,
      current404Units: current404Rows.reduce((sum, row) => sum + row.nonCancelledUnits, 0),
      current404Turnover: Math.round(current404Rows.reduce((sum, row) => sum + row.grossOrderLineTurnover, 0) * 100) / 100,
    },
    interpretationBoundary: [
      "Amazon All Orders proves order-line history, not profit or refund-adjusted revenue.",
      "Veeqo inactive_after proves when Veeqo marked the Amazon channel product inactive; it is not an Amazon reason code.",
      "Current Amazon Catalog 404 proves current absence in the marketplace catalog, not the historical deletion reason.",
      "Rows not checked against the current Catalog API retain a lower evidence tier and are not silently called deleted.",
    ],
    rows,
  };
  const headers = [
    "rank", "asin", "sku", "historical_title", "first_order_at", "last_order_at",
    "non_cancelled_orders", "non_cancelled_units", "cancelled_orders", "cancelled_units",
    "gross_order_line_turnover", "channelmax_selling_2026_06", "veeqo_product_retained",
    "veeqo_description_retained", "veeqo_main_image_retained", "veeqo_amazon_channel_inactive_at",
    "current_catalog_checked", "current_amazon_catalog_404", "status", "evidence_tier",
  ];
  const csv = `${headers.join(",")}\n${rows.map((row) => [
    row.rank, row.asin, row.sku, row.historicalTitle, row.firstOrderAt, row.lastOrderAt,
    row.nonCancelledOrders, row.nonCancelledUnits, row.cancelledOrders, row.cancelledUnits,
    row.grossOrderLineTurnover.toFixed(2), row.channelMaxSelling202606, row.veeqoProductRetained,
    row.veeqoDescriptionRetained, row.veeqoMainImageRetained, row.veeqoAmazonChannelInactiveAt,
    row.currentCatalogChecked, row.currentAmazonCatalog404, row.status, row.evidenceTier,
  ].map(csvField).join(",")).join("\n")}\n`;
  const summary = [
    "# Historical Uncrustables ASIN/SKU registry",
    "",
    `Generated: ${result.generatedAt}`,
    "",
    "## Coverage",
    "",
    `- ${result.coverage.identityRows} ASIN/SKU identities (${result.coverage.uniqueAsins} unique ASINs).`,
    `- ${result.totals.units.toLocaleString("en-US")} non-cancelled units; ${money(result.totals.grossOrderLineTurnover)} gross order-line turnover.`,
    `- ${result.coverage.veeqoApril30InactiveIdentityRows} identities (${result.coverage.veeqoApril30InactiveUniqueAsins} ASINs) were marked inactive in Veeqo on 2026-04-30: ${result.totals.april30InactiveUnits} units and ${money(result.totals.april30InactiveTurnover)} historical turnover.`,
    `- Current Amazon Catalog was checked for the top ${result.coverage.currentCatalogChecked}; ${result.coverage.currentAmazonCatalog404} now return 404, representing ${result.totals.current404Units} units and ${money(result.totals.current404Turnover)} historical turnover.`,
    `- Veeqo retained product records for ${result.coverage.veeqoProductsRetained} identities.`,
    "",
    "## Highest-turnover identities marked inactive on 2026-04-30",
    "",
    "| Overall rank | ASIN | SKU | Units | Turnover | Last order | Current Amazon 404 | Title |",
    "|---:|---|---|---:|---:|---|---|---|",
    ...aprilRows.slice(0, 20).map((row) => [
      `| ${row.rank}`, row.asin, row.sku, row.nonCancelledUnits, money(row.grossOrderLineTurnover),
      row.lastOrderAt?.slice(0, 10), row.currentAmazonCatalog404 === null ? "not checked" : row.currentAmazonCatalog404 ? "yes" : "no",
      `${md(row.historicalTitle)} |`,
    ].join(" | ")),
    "",
    "## Evidence rules",
    "",
    ...result.interpretationBoundary.map((line) => `- ${line}`),
    "",
  ].join("\n");
  const json = `${JSON.stringify(result, null, 2)}\n`;
  await writeExclusive(join(outDir, "historical-uncrustables-registry.json"), json);
  await writeExclusive(join(outDir, "historical-uncrustables-registry.csv"), csv);
  await writeExclusive(join(outDir, "historical-uncrustables-registry.md"), summary);
  await writeExclusive(
    join(outDir, "historical-uncrustables-registry.sha256"),
    `${sha256(json)}  historical-uncrustables-registry.json\n${sha256(csv)}  historical-uncrustables-registry.csv\n${sha256(summary)}  historical-uncrustables-registry.md\n`,
  );
  console.log(JSON.stringify({ status: "COMPILED", ...result.coverage, ...result.totals }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
