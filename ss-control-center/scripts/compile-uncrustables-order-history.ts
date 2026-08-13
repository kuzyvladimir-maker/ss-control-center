import { open, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, normalize } from "node:path";

import {
  aggregateUncrustablesSales,
  parseAmazonAllOrdersReport,
  parseChannelMaxInventory,
  sha256,
  type ChannelMaxListingIdentity,
  type HistoricalOrderLine,
  type UncrustablesSalesAggregate,
} from "../src/lib/amazon-sp-api/uncrustables-order-history";

const CAPTURE_SCHEMA = "uncrustables-amazon-order-capture/v1";
const OUTPUT_SCHEMA = "uncrustables-historical-sales-analysis/v1";

interface CaptureWindow {
  id: string;
  startTime: string;
  endTime: string;
  status: string;
  reportId?: string;
  rawFile?: string;
  rawSha256?: string;
  rawBytes?: number;
  dataRows?: number;
}

interface CaptureState {
  schemaVersion: string;
  storeIndex: number;
  marketplaceId: string;
  startTime: string;
  endTime: string;
  source: Record<string, unknown>;
  windows: CaptureWindow[];
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

function csvField(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function markdownCell(value: unknown): string {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function formatMoney(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const PERIODS = [
  { id: "2024-H2", start: "2024-07-01T00:00:00.000Z", end: "2025-01-01T00:00:00.000Z" },
  { id: "2025-H1", start: "2025-01-01T00:00:00.000Z", end: "2025-07-01T00:00:00.000Z" },
  { id: "2025-H2", start: "2025-07-01T00:00:00.000Z", end: "2026-01-01T00:00:00.000Z" },
  { id: "2026-H1", start: "2026-01-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z" },
  { id: "2026-H2-to-date", start: "2026-07-01T00:00:00.000Z", end: "9999-12-31T23:59:59.999Z" },
] as const;

function snapshotDisposition(row: UncrustablesSalesAggregate): string {
  if (row.channelMax?.isSelling === true) return "SELLING_IN_2026_06_CHANNELMAX_SNAPSHOT";
  if (row.channelMax?.isSelling === false) return "NOT_SELLING_IN_2026_06_CHANNELMAX_SNAPSHOT";
  return "ABSENT_FROM_2026_06_CHANNELMAX_SNAPSHOT";
}

function springCleanupCandidate(row: UncrustablesSalesAggregate): boolean {
  return row.channelMax?.isSelling !== true
    && row.lastOrderAt >= "2026-03-01T00:00:00.000Z"
    && row.lastOrderAt < "2026-06-01T00:00:00.000Z";
}

function channelMaxAddedYear(row: ChannelMaxListingIdentity): number | null {
  if (!row.addedAt) return null;
  const match = row.addedAt.match(/(20\d{2})/u);
  return match ? Number(match[1]) : null;
}

function buildCsv(rows: UncrustablesSalesAggregate[]): string {
  const headers = [
    "rank", "sku", "asin", "preferred_title", "first_order_at", "last_order_at",
    "distinct_orders", "units", "cancelled_units", "item_revenue", "shipping_revenue",
    "promotion_discount", "gross_revenue", "currency", "channelmax_is_selling",
    "channelmax_added_at", "channelmax_title", "title_variant_count",
  ];
  const body = rows.map((row, index) => [
    index + 1,
    row.sku,
    row.asin,
    row.preferredTitle,
    row.firstOrderAt,
    row.lastOrderAt,
    row.distinctOrders,
    row.units,
    row.cancelledUnits,
    row.itemRevenue.toFixed(2),
    row.shippingRevenue.toFixed(2),
    row.promotionDiscount.toFixed(2),
    row.grossRevenue.toFixed(2),
    row.currency,
    row.channelMax?.isSelling,
    row.channelMax?.addedAt,
    row.channelMax?.title,
    row.titleVariants.length,
  ].map(csvField).join(","));
  return `${headers.join(",")}\n${body.join("\n")}\n`;
}

function buildMarkdown(
  state: CaptureState,
  inventory: ChannelMaxListingIdentity[],
  rows: UncrustablesSalesAggregate[],
  rawLineCount: number,
  zeroSalesInventory: ChannelMaxListingIdentity[],
): string {
  const totalUnits = rows.reduce((sum, row) => sum + row.units, 0);
  const totalRevenue = rows.reduce((sum, row) => sum + row.grossRevenue, 0);
  const totalOrders = rows.reduce((sum, row) => sum + row.distinctOrders, 0);
  const withAsin = inventory.filter((row) => row.asin).length;
  const pre2026 = inventory.filter((row) => (channelMaxAddedYear(row) ?? 9999) < 2026);
  const pre2026WithSales = new Set(
    rows.filter((row) => (channelMaxAddedYear(row.channelMax ?? {
      sku: "", asin: null, title: null, isSelling: null, addedAt: null, thumbnailUrl: null,
    }) ?? 9999) < 2026).map((row) => row.sku),
  ).size;
  const nonSellingOrAbsent = rows.filter((row) => row.channelMax?.isSelling !== true);
  const cleanupCandidates = rows.filter(springCleanupCandidate);
  const lines = [
    "# Uncrustables historical Amazon order analysis",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Scope: store${state.storeIndex}, ${state.startTime} — ${state.endTime}`,
    "",
    "## Coverage",
    "",
    `- Amazon order report windows: ${state.windows.length}; all captured or Amazon-confirmed no-data.`,
    `- Raw Amazon order lines parsed: ${rawLineCount.toLocaleString("en-US")}.`,
    `- ChannelMAX Uncrustables identities: ${inventory.length} (${withAsin} with ASIN).`,
    `- ChannelMAX identities added before 2026: ${pre2026.length}; ${pre2026WithSales} matched non-cancelled/cancelled Amazon order history.`,
    `- Matched sales identities: ${rows.length}; ChannelMAX identities with zero matched orders in this window: ${zeroSalesInventory.length}.`,
    `- Identities not selling or absent in the 2026-06 ChannelMAX snapshot: ${nonSellingOrAbsent.length}; order-timeline spring-cleanup candidates: ${cleanupCandidates.length}.`,
    "",
    "## Totals",
    "",
    `- Distinct-order sum by SKU: ${totalOrders.toLocaleString("en-US")} (an order containing multiple Uncrustables SKUs is counted once per SKU).`,
    `- Non-cancelled units: ${totalUnits.toLocaleString("en-US")}.`,
    `- Net order-line turnover: ${formatMoney(totalRevenue)} (item + shipping + gift wrap − order-report promotions; returns/refunds are not deducted).`,
    "",
    "## Leaders by order-line turnover",
    "",
    "| Rank | ASIN | SKU | Units | Orders | Turnover | First order | Last order | ChannelMAX live | Title |",
    "|---:|---|---|---:|---:|---:|---|---|---|---|",
    ...rows.slice(0, 30).map((row, index) => [
      `| ${index + 1}`,
      markdownCell(row.asin),
      markdownCell(row.sku),
      row.units,
      row.distinctOrders,
      formatMoney(row.grossRevenue),
      row.firstOrderAt.slice(0, 10),
      row.lastOrderAt.slice(0, 10),
      row.channelMax?.isSelling == null ? "unknown" : row.channelMax.isSelling ? "yes" : "no",
      `${markdownCell(row.preferredTitle)} |`,
    ].join(" | ")),
    "",
    "## Highest-turnover identities lost from the ChannelMAX selling snapshot",
    "",
    "| Rank | ASIN | SKU | Units | Turnover | Last order | Snapshot disposition | Title |",
    "|---:|---|---|---:|---:|---|---|---|",
    ...nonSellingOrAbsent.slice(0, 25).map((row, index) => [
      `| ${index + 1}`,
      markdownCell(row.asin),
      markdownCell(row.sku),
      row.units,
      formatMoney(row.grossRevenue),
      row.lastOrderAt.slice(0, 10),
      snapshotDisposition(row),
      `${markdownCell(row.preferredTitle)} |`,
    ].join(" | ")),
    "",
    "## Interpretation boundary",
    "",
    "This report establishes which SKU/ASIN identities produced orders and turnover. It does not by itself prove why a listing won, reconstruct historical listing bytes, include refunds/returns, or prove the date/reason Amazon removed a contribution. Those require the sealed listing/content/image forensic phase and, for gaps, a Vico catalog/order export.",
    "",
  ];
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Compile captured Amazon All Orders reports into PII-free Uncrustables aggregates.\n"
      + "Required: --capture-dir /ABS/PATH --channelmax-inventory /ABS/FILE",
    );
    return;
  }
  const allowed = new Set(["--capture-dir", "--channelmax-inventory"]);
  if (args.some((arg) => arg.startsWith("--") && !allowed.has(arg))) fail("unknown argument");
  const captureDir = exactArg(args, "--capture-dir");
  const inventoryPath = exactArg(args, "--channelmax-inventory");
  for (const [name, path] of [["--capture-dir", captureDir], ["--channelmax-inventory", inventoryPath]]) {
    if (!isAbsolute(path) || normalize(path) !== path) fail(`${name} must be a normalized absolute path`);
  }
  if (!(await stat(captureDir)).isDirectory()) fail("--capture-dir must be a directory");
  if (!(await stat(inventoryPath)).isFile()) fail("--channelmax-inventory must be a file");

  const stateBytes = await readFile(join(captureDir, "capture-state.json"));
  const state = JSON.parse(stateBytes.toString("utf8")) as CaptureState;
  if (state.schemaVersion !== CAPTURE_SCHEMA) fail("capture-state schema is unsupported");
  const nonTerminal = state.windows.filter((window) => !["DONE", "NO_DATA"].includes(window.status));
  if (nonTerminal.length > 0) fail(`capture is incomplete: ${nonTerminal.length} windows are non-terminal`);

  const allLines: HistoricalOrderLine[] = [];
  for (const window of state.windows.filter((candidate) => candidate.status === "DONE")) {
    if (!window.rawFile || basename(window.rawFile) !== window.rawFile || !window.rawSha256) {
      fail(`captured window ${window.id} lacks a safe raw-file binding`);
    }
    const rawBytes = await readFile(join(captureDir, window.rawFile));
    if (sha256(rawBytes) !== window.rawSha256 || rawBytes.length !== window.rawBytes) {
      fail(`captured window ${window.id} failed hash/length verification`);
    }
    const parsed = parseAmazonAllOrdersReport(rawBytes.toString("utf8"));
    if (parsed.length !== window.dataRows) fail(`captured window ${window.id} row count drifted`);
    allLines.push(...parsed);
  }

  const inventoryBytes = await readFile(inventoryPath);
  const inventory = parseChannelMaxInventory(inventoryBytes.toString("utf8"));
  const rows = aggregateUncrustablesSales(allLines, inventory);
  const periodMaps = new Map(PERIODS.map((period) => [
    period.id,
    new Map(aggregateUncrustablesSales(
      allLines.filter((line) => line.purchaseDate >= period.start && line.purchaseDate < period.end),
      inventory,
    ).map((row) => [row.key, row])),
  ]));
  const enrichedRows = rows.map((row) => ({
    ...row,
    snapshotDisposition: snapshotDisposition(row),
    springCleanupCandidate: springCleanupCandidate(row),
    periods: Object.fromEntries(PERIODS.map((period) => {
      const periodRow = periodMaps.get(period.id)?.get(row.key);
      return [period.id, {
        units: periodRow?.units ?? 0,
        distinctOrders: periodRow?.distinctOrders ?? 0,
        cancelledOrders: periodRow?.cancelledOrders ?? 0,
        grossRevenue: periodRow?.grossRevenue ?? 0,
        firstOrderAt: periodRow?.firstOrderAt ?? null,
        lastOrderAt: periodRow?.lastOrderAt ?? null,
      }];
    })),
  }));
  const matchedSkus = new Set(rows.map((row) => row.sku));
  const matchedAsins = new Set(rows.flatMap((row) => row.asin ? [row.asin] : []));
  const zeroSalesInventory = inventory.filter((row) =>
    !matchedSkus.has(row.sku) && (!row.asin || !matchedAsins.has(row.asin)));
  const generatedAt = new Date().toISOString();
  const result = {
    schemaVersion: OUTPUT_SCHEMA,
    generatedAt,
    scope: {
      storeIndex: state.storeIndex,
      marketplaceId: state.marketplaceId,
      startTime: state.startTime,
      endTime: state.endTime,
    },
    sources: {
      captureStateSha256: sha256(stateBytes),
      channelMaxInventoryPath: inventoryPath,
      channelMaxInventorySha256: sha256(inventoryBytes),
      rawReportWindows: state.windows.length,
      rawAmazonOrderLines: allLines.length,
      marketplaceMutations: 0,
    },
    coverage: {
      channelMaxUncrustablesRows: inventory.length,
      channelMaxWithAsin: inventory.filter((row) => row.asin).length,
      matchedSalesIdentities: rows.length,
      zeroMatchedOrderIdentities: zeroSalesInventory.length,
      notSellingOrAbsentFromChannelMaxSnapshot: rows.filter((row) =>
        row.channelMax?.isSelling !== true).length,
      springCleanupCandidates: rows.filter(springCleanupCandidate).length,
    },
    totals: {
      units: rows.reduce((sum, row) => sum + row.units, 0),
      grossRevenue: Math.round(rows.reduce((sum, row) => sum + row.grossRevenue, 0) * 100) / 100,
    },
    periods: PERIODS,
    salesByIdentity: enrichedRows,
    zeroMatchedOrderInventory: zeroSalesInventory,
    limitations: [
      "Order reports do not deduct returns or refunds.",
      "ChannelMAX IsSelling is a 2026-06-15 snapshot, not the exact Amazon deletion date.",
      "Revenue is order-line turnover, not profit, contribution margin, or disbursed cash.",
      "Listing content and image reconstruction is a separate forensic phase.",
    ],
  };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  const csv = buildCsv(rows);
  const markdown = buildMarkdown(state, inventory, rows, allLines.length, zeroSalesInventory);
  const jsonName = "uncrustables-sales-by-identity.json";
  const csvName = "uncrustables-sales-by-identity.csv";
  const mdName = "uncrustables-sales-summary.md";
  await writeExclusive(join(captureDir, jsonName), json);
  await writeExclusive(join(captureDir, csvName), csv);
  await writeExclusive(join(captureDir, mdName), markdown);
  await writeExclusive(
    join(captureDir, "analysis.sha256"),
    `${sha256(json)}  ${jsonName}\n${sha256(csv)}  ${csvName}\n${sha256(markdown)}  ${mdName}\n`,
  );
  console.log(JSON.stringify({
    status: "COMPILED",
    captureDir,
    rawAmazonOrderLines: allLines.length,
    channelMaxUncrustablesRows: inventory.length,
    matchedSalesIdentities: rows.length,
    units: result.totals.units,
    grossRevenue: result.totals.grossRevenue,
    outputs: [jsonName, csvName, mdName, "analysis.sha256"],
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
