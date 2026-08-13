import { createHash } from "node:crypto";

export const AMAZON_ALL_ORDERS_REPORT_TYPE =
  "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL";

export interface HistoricalWindow {
  id: string;
  startTime: string;
  endTime: string;
}

export interface ChannelMaxListingIdentity {
  sku: string;
  asin: string | null;
  title: string | null;
  isSelling: boolean | null;
  addedAt: string | null;
  thumbnailUrl: string | null;
}

export interface HistoricalOrderLine {
  amazonOrderId: string;
  purchaseDate: string;
  lastUpdatedDate: string | null;
  orderStatus: string;
  itemStatus: string;
  fulfillmentChannel: string | null;
  productName: string;
  sku: string;
  asin: string;
  quantity: number;
  currency: string | null;
  itemPrice: number;
  shippingPrice: number;
  giftWrapPrice: number;
  itemPromotionDiscount: number;
  shipPromotionDiscount: number;
  isBusinessOrder: boolean | null;
}

export interface UncrustablesSalesAggregate {
  key: string;
  sku: string;
  asin: string | null;
  preferredTitle: string | null;
  titleVariants: string[];
  firstOrderAt: string;
  lastOrderAt: string;
  distinctOrders: number;
  cancelledOrders: number;
  nonCancelledLines: number;
  cancelledLines: number;
  units: number;
  cancelledUnits: number;
  itemRevenue: number;
  shippingRevenue: number;
  giftWrapRevenue: number;
  promotionDiscount: number;
  grossRevenue: number;
  currency: string | null;
  fulfillmentChannels: string[];
  channelMax: ChannelMaxListingIdentity | null;
}

function fail(message: string): never {
  throw new Error(message);
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalInstant(value: string, label: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail(`${label} is not a valid instant`);
  return new Date(milliseconds).toISOString();
}

function utcDateId(value: string): string {
  return value.slice(0, 10).replaceAll("-", "");
}

/**
 * Amazon's All Orders report accepts at most 30 days per request. End times are
 * exclusive so adjacent windows neither overlap nor leave gaps.
 */
export function buildHistoricalWindows(
  startTime: string,
  endTime: string,
  maximumDays = 30,
): HistoricalWindow[] {
  const start = canonicalInstant(startTime, "startTime");
  const end = canonicalInstant(endTime, "endTime");
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (startMs >= endMs) fail("startTime must be earlier than endTime");
  if (!Number.isInteger(maximumDays) || maximumDays < 1 || maximumDays > 30) {
    fail("maximumDays must be an integer from 1 through 30");
  }
  const windowMs = maximumDays * 24 * 60 * 60 * 1_000;
  const windows: HistoricalWindow[] = [];
  for (let cursor = startMs; cursor < endMs; cursor += windowMs) {
    const windowEnd = Math.min(endMs, cursor + windowMs);
    const exactStart = new Date(cursor).toISOString();
    const exactEnd = new Date(windowEnd).toISOString();
    windows.push({
      id: `${utcDateId(exactStart)}-${utcDateId(exactEnd)}`,
      startTime: exactStart,
      endTime: exactEnd,
    });
  }
  return windows;
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function parseTabRows(content: string): Array<Record<string, string>> {
  const lines = stripBom(content).split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0].split("\t");
  if (new Set(headers).size !== headers.length) fail("TSV header contains duplicates");
  return lines.slice(1).map((line, rowIndex) => {
    const values = line.split("\t");
    if (values.length > headers.length) {
      fail(`TSV row ${rowIndex + 2} has more fields than the header`);
    }
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

function requiredHeader(rows: Array<Record<string, string>>, content: string, names: string[]): void {
  const firstLine = stripBom(content).split(/\r?\n/u, 1)[0] ?? "";
  const headers = new Set(firstLine.split("\t"));
  for (const name of names) {
    if (!headers.has(name)) fail(`required TSV column is missing: ${name}`);
  }
  if (rows.length === 0 && firstLine.length === 0) fail("TSV is empty");
}

function nullable(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function money(value: string | undefined, label: string): number {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return 0;
  const parsed = Number(trimmed.replaceAll(",", ""));
  if (!Number.isFinite(parsed)) fail(`${label} is not numeric: ${trimmed}`);
  return parsed;
}

function nonNegativeInteger(value: string | undefined, label: string): number {
  const parsed = Number(value ?? "");
  if (!Number.isInteger(parsed) || parsed < 0) fail(`${label} is not a non-negative integer`);
  return parsed;
}

function parseBoolean(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (["true", "yes", "y", "1", "x"].includes(normalized)) return true;
  if (["false", "no", "n", "0"].includes(normalized)) return false;
  return null;
}

export function parseChannelMaxInventory(content: string): ChannelMaxListingIdentity[] {
  const rows = parseTabRows(content);
  requiredHeader(rows, content, ["ASIN", "IsSelling", "ItemName", "SKU", "WhenAddedToCMax"]);
  const identities = rows
    .map((row) => ({
      sku: row.SKU.trim(),
      asin: nullable(row.ASIN),
      title: nullable(row.ItemName),
      isSelling: parseBoolean(row.IsSelling),
      addedAt: nullable(row.WhenAddedToCMax),
      thumbnailUrl: nullable(row.ItemThumbnail),
    }))
    .filter((identity) => identity.sku.length > 0)
    .filter((identity) => /uncrustables/i.test(identity.title ?? ""));
  identities.sort((left, right) => left.sku.localeCompare(right.sku));
  return identities;
}

export function parseAmazonAllOrdersReport(content: string): HistoricalOrderLine[] {
  const rows = parseTabRows(content);
  requiredHeader(rows, content, [
    "amazon-order-id",
    "purchase-date",
    "order-status",
    "product-name",
    "sku",
    "asin",
    "item-status",
    "quantity",
    "item-price",
  ]);
  return rows.map((row, rowIndex) => {
    const purchaseDate = canonicalInstant(row["purchase-date"], `row ${rowIndex + 2} purchase-date`);
    return {
      amazonOrderId: row["amazon-order-id"].trim(),
      purchaseDate,
      lastUpdatedDate: nullable(row["last-updated-date"])
        ? canonicalInstant(row["last-updated-date"], `row ${rowIndex + 2} last-updated-date`)
        : null,
      orderStatus: row["order-status"].trim(),
      itemStatus: row["item-status"].trim(),
      fulfillmentChannel: nullable(row["fulfillment-channel"]),
      productName: row["product-name"].trim(),
      sku: row.sku.trim(),
      asin: row.asin.trim(),
      quantity: nonNegativeInteger(row.quantity, `row ${rowIndex + 2} quantity`),
      currency: nullable(row.currency),
      itemPrice: money(row["item-price"], `row ${rowIndex + 2} item-price`),
      shippingPrice: money(row["shipping-price"], `row ${rowIndex + 2} shipping-price`),
      giftWrapPrice: money(row["gift-wrap-price"], `row ${rowIndex + 2} gift-wrap-price`),
      itemPromotionDiscount: money(
        row["item-promotion-discount"],
        `row ${rowIndex + 2} item-promotion-discount`,
      ),
      shipPromotionDiscount: money(
        row["ship-promotion-discount"],
        `row ${rowIndex + 2} ship-promotion-discount`,
      ),
      isBusinessOrder: parseBoolean(row["is-business-order"]),
    };
  });
}

function moneyRounded(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function identityKey(sku: string, asin: string): string {
  return sku || `ASIN:${asin}`;
}

export function aggregateUncrustablesSales(
  lines: HistoricalOrderLine[],
  channelMaxRows: ChannelMaxListingIdentity[],
): UncrustablesSalesAggregate[] {
  const inventoryBySku = new Map(channelMaxRows.map((row) => [row.sku, row]));
  const inventoryAsins = new Set(channelMaxRows.flatMap((row) => row.asin ? [row.asin] : []));
  const mutable = new Map<string, {
    sku: string;
    asin: string | null;
    titles: Map<string, number>;
    firstOrderAt: string;
    lastOrderAt: string;
    orders: Set<string>;
    cancelledOrders: Set<string>;
    nonCancelledLines: number;
    cancelledLines: number;
    units: number;
    cancelledUnits: number;
    itemRevenue: number;
    shippingRevenue: number;
    giftWrapRevenue: number;
    promotionDiscount: number;
    currencies: Set<string>;
    fulfillmentChannels: Set<string>;
  }>();

  for (const line of lines) {
    const inInventory = inventoryBySku.has(line.sku) || inventoryAsins.has(line.asin);
    if (!inInventory && !/uncrustables/i.test(line.productName)) continue;
    if (!line.sku && !line.asin) continue;
    const key = identityKey(line.sku, line.asin);
    const current = mutable.get(key) ?? {
      sku: line.sku,
      asin: line.asin || null,
      titles: new Map<string, number>(),
      firstOrderAt: line.purchaseDate,
      lastOrderAt: line.purchaseDate,
      orders: new Set<string>(),
      cancelledOrders: new Set<string>(),
      nonCancelledLines: 0,
      cancelledLines: 0,
      units: 0,
      cancelledUnits: 0,
      itemRevenue: 0,
      shippingRevenue: 0,
      giftWrapRevenue: 0,
      promotionDiscount: 0,
      currencies: new Set<string>(),
      fulfillmentChannels: new Set<string>(),
    };
    if (line.asin && !current.asin) current.asin = line.asin;
    if (line.productName) {
      current.titles.set(line.productName, (current.titles.get(line.productName) ?? 0) + 1);
    }
    current.firstOrderAt = current.firstOrderAt < line.purchaseDate
      ? current.firstOrderAt
      : line.purchaseDate;
    current.lastOrderAt = current.lastOrderAt > line.purchaseDate
      ? current.lastOrderAt
      : line.purchaseDate;
    if (line.currency) current.currencies.add(line.currency);
    if (line.fulfillmentChannel) current.fulfillmentChannels.add(line.fulfillmentChannel);
    const cancelled = /cancel/i.test(`${line.orderStatus} ${line.itemStatus}`);
    if (cancelled) {
      if (line.amazonOrderId) current.cancelledOrders.add(line.amazonOrderId);
      current.cancelledLines += 1;
      current.cancelledUnits += line.quantity;
    } else {
      if (line.amazonOrderId) current.orders.add(line.amazonOrderId);
      current.nonCancelledLines += 1;
      current.units += line.quantity;
      current.itemRevenue += line.itemPrice;
      current.shippingRevenue += line.shippingPrice;
      current.giftWrapRevenue += line.giftWrapPrice;
      current.promotionDiscount += line.itemPromotionDiscount + line.shipPromotionDiscount;
    }
    mutable.set(key, current);
  }

  return [...mutable.entries()].map(([key, row]) => {
    const inventory = inventoryBySku.get(row.sku) ?? null;
    const titles = [...row.titles.entries()]
      .sort(([leftTitle, leftCount], [rightTitle, rightCount]) =>
        rightCount - leftCount || leftTitle.localeCompare(rightTitle))
      .map(([title]) => title);
    const currency = row.currencies.size === 1 ? [...row.currencies][0] : null;
    return {
      key,
      sku: row.sku,
      asin: row.asin ?? inventory?.asin ?? null,
      preferredTitle: titles[0] ?? inventory?.title ?? null,
      titleVariants: titles,
      firstOrderAt: row.firstOrderAt,
      lastOrderAt: row.lastOrderAt,
      distinctOrders: row.orders.size,
      cancelledOrders: row.cancelledOrders.size,
      nonCancelledLines: row.nonCancelledLines,
      cancelledLines: row.cancelledLines,
      units: row.units,
      cancelledUnits: row.cancelledUnits,
      itemRevenue: moneyRounded(row.itemRevenue),
      shippingRevenue: moneyRounded(row.shippingRevenue),
      giftWrapRevenue: moneyRounded(row.giftWrapRevenue),
      promotionDiscount: moneyRounded(row.promotionDiscount),
      grossRevenue: moneyRounded(
        row.itemRevenue + row.shippingRevenue + row.giftWrapRevenue
          - row.promotionDiscount,
      ),
      currency,
      fulfillmentChannels: [...row.fulfillmentChannels].sort(),
      channelMax: inventory,
    };
  }).sort((left, right) =>
    right.grossRevenue - left.grossRevenue
      || right.units - left.units
      || left.key.localeCompare(right.key));
}
