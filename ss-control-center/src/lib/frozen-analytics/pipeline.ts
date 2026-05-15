// Nightly pipeline: pull upcoming Veeqo orders, filter to frozen, look up
// weather + climate, evaluate rules, upsert FrozenRiskAlert rows.
//
// Triggered from n8n via POST /api/frozen/run-analysis. Also callable from
// the "Run analysis now" button on the Today's Risk tab.
//
// Mapping divergences from the original prompt are documented in
// docs/dev-log/frozen-v2-progress.md (sections #1, #2, #9, #10).

import { prisma } from "@/lib/prisma";
import { fetchAllOrders, getProduct } from "@/lib/veeqo";
import { resolveZip } from "./geocoding-zip";
import {
  fetchForecast,
  fetchClimateNormals,
  type WeatherDay,
} from "./weather-open-meteo";
import { evaluateRisk, type RuleContext } from "./rules-engine";
import { buildRecommendations } from "./recommendations";

const ORIGIN_LAT = parseFloat(process.env.ORIGIN_LAT || "27.9506");
const ORIGIN_LON = parseFloat(process.env.ORIGIN_LON || "-82.4572");
const LOOKAHEAD_DAYS = parseInt(
  process.env.FROZEN_LOOKAHEAD_DAYS || "3",
  10,
);

export interface PipelineResult {
  processed: number; // all orders fetched
  frozenOrders: number; // those classified as frozen
  alertsCreated: number;
  alertsUpdated: number;
  skipped: number; // missing zip, no SKU, etc.
  errors: number;
  errorDetails: string[];
  durationMs: number;
}

// Loose Veeqo shape (same defensive pattern as orders-procurement.ts).
type VeeqoOrder = Record<string, unknown> & {
  id?: string | number;
  number?: string;
  channel?: { type_code?: string; name?: string };
  delivery_method?: { name?: string };
  dispatch_date?: string;
  expected_dispatch_date?: string;
  expected_delivery_days?: number;
  due_date?: string;
  deliver_to?: VeeqoAddress;
  shipping_address?: VeeqoAddress;
  line_items?: VeeqoLineItem[];
};

type VeeqoAddress = {
  zip?: string;
  postcode?: string;
  postal_code?: string;
  city?: string;
  state?: string;
  state_code?: string;
};

type VeeqoLineItem = {
  id?: string | number;
  quantity?: number;
  sellable?: {
    sku_code?: string;
    sku?: string;
    title?: string;
    product_title?: string;
    product?: { id?: number; title?: string; name?: string };
  };
};

function pickShipDate(order: VeeqoOrder, today: string): string {
  const raw =
    order.dispatch_date ??
    order.expected_dispatch_date ??
    order.due_date ??
    null;
  if (!raw) return today;
  return raw.slice(0, 10);
}

function pickDestZip(order: VeeqoOrder): string | null {
  const addr = order.deliver_to ?? order.shipping_address;
  if (!addr) return null;
  const raw = addr.zip ?? addr.postcode ?? addr.postal_code ?? null;
  if (typeof raw !== "string") return null;
  const m = raw.match(/\d{5}/);
  return m ? m[0] : null;
}

function pickFirstLine(order: VeeqoOrder): VeeqoLineItem | null {
  const lines = order.line_items;
  if (!Array.isArray(lines) || lines.length === 0) return null;
  return lines[0];
}

function pickSku(line: VeeqoLineItem): string {
  return line.sellable?.sku_code ?? line.sellable?.sku ?? "UNKNOWN";
}

function pickProductTitle(line: VeeqoLineItem): string | null {
  return (
    line.sellable?.product?.title ??
    line.sellable?.product?.name ??
    line.sellable?.title ??
    line.sellable?.product_title ??
    null
  );
}

function pickCarrierService(order: VeeqoOrder): {
  carrier: string | null;
  service: string | null;
} {
  // Veeqo exposes a chosen-method name on the order before purchase.
  // We don't have a strict carrier code here — best-effort parse.
  const name = order.delivery_method?.name ?? "";
  const lower = name.toLowerCase();
  let carrier: string | null = null;
  if (lower.includes("ups")) carrier = "ups";
  else if (lower.includes("fedex")) carrier = "fedex";
  else if (lower.includes("usps")) carrier = "usps";
  return { carrier, service: name || null };
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function getStoreIndex(order: VeeqoOrder): number | null {
  const name = order.channel?.name ?? "";
  const m = name.match(/\bstore\s*(\d+)\b/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

// Classify Frozen via local override → Veeqo tags. Cached per productId
// across the run so a multi-line order with the same product doesn't refetch.
async function isFrozenProduct(
  productId: number,
  cache: Map<number, boolean>,
): Promise<boolean> {
  if (cache.has(productId)) return cache.get(productId)!;
  // Local override first.
  const override = await prisma.productTypeOverride.findUnique({
    where: { productId },
  });
  if (override) {
    const v = override.type === "Frozen";
    cache.set(productId, v);
    return v;
  }
  try {
    const product = (await getProduct(productId)) as
      | { tags?: Array<string | { name?: string }> }
      | null;
    const tagNames = (product?.tags ?? []).map((t) =>
      (typeof t === "string" ? t : t.name ?? "").toLowerCase(),
    );
    const v = tagNames.some((t) => t.includes("frozen"));
    cache.set(productId, v);
    return v;
  } catch {
    cache.set(productId, false);
    return false;
  }
}

export async function runFrozenAnalysisPipeline(): Promise<PipelineResult> {
  const start = Date.now();
  const result: PipelineResult = {
    processed: 0,
    frozenOrders: 0,
    alertsCreated: 0,
    alertsUpdated: 0,
    skipped: 0,
    errors: 0,
    errorDetails: [],
    durationMs: 0,
  };

  try {
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const endStr = addDays(todayStr, LOOKAHEAD_DAYS);

    // 1. Pull awaiting_fulfillment orders from Veeqo (existing client).
    const orders = (await fetchAllOrders("awaiting_fulfillment")) as VeeqoOrder[];
    result.processed = orders.length;

    // 2. Pre-fetch origin weather for the whole horizon — one call, reused.
    let originForecast: WeatherDay[] = [];
    try {
      originForecast = await fetchForecast(
        ORIGIN_LAT,
        ORIGIN_LON,
        todayStr,
        endStr,
      );
    } catch (err) {
      result.errorDetails.push(
        `origin forecast failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const originByDate = new Map(originForecast.map((d) => [d.date, d]));

    const originNormals = await fetchClimateNormals(
      ORIGIN_LAT,
      ORIGIN_LON,
      todayStr,
      endStr,
    );
    const originNormalByDate = new Map(
      originNormals.map((n) => [n.date, n.meanTempF]),
    );

    const frozenCache = new Map<number, boolean>();
    const destForecastCache = new Map<string, WeatherDay | null>(); // zip+date → day
    const destNormalCache = new Map<string, number | null>();

    // 3. Walk each order.
    for (const order of orders) {
      try {
        const shipDate = pickShipDate(order, todayStr);
        if (shipDate < todayStr || shipDate > endStr) {
          result.skipped++;
          continue;
        }

        const line = pickFirstLine(order);
        if (!line) {
          result.skipped++;
          continue;
        }
        const productId = line.sellable?.product?.id;
        if (!productId) {
          result.skipped++;
          continue;
        }
        const frozen = await isFrozenProduct(productId, frozenCache);
        if (!frozen) {
          result.skipped++;
          continue;
        }
        result.frozenOrders++;

        const destZip = pickDestZip(order);
        if (!destZip) {
          result.errorDetails.push(
            `order ${order.number}: missing destination ZIP`,
          );
          result.skipped++;
          continue;
        }
        const destLoc = await resolveZip(destZip);
        if (!destLoc) {
          result.errorDetails.push(`order ${order.number}: ZIP ${destZip} unresolved`);
          result.skipped++;
          continue;
        }

        const transitDays = Math.max(
          1,
          Number(order.expected_delivery_days ?? 3),
        );
        const edd = addDays(shipDate, transitDays);
        const sku = pickSku(line);
        const productName = pickProductTitle(line);
        const { carrier, service } = pickCarrierService(order);

        // Per-destination forecast — cache (zip, edd) so neighbouring orders
        // to the same buyer share the API call.
        const destCacheKey = `${destLoc.zip}|${edd}`;
        let destDay = destForecastCache.get(destCacheKey);
        if (destDay === undefined) {
          try {
            const arr = await fetchForecast(
              destLoc.lat,
              destLoc.lon,
              edd,
              edd,
            );
            destDay = arr[0] ?? null;
          } catch {
            destDay = null;
          }
          destForecastCache.set(destCacheKey, destDay);
        }
        let destNormal = destNormalCache.get(destCacheKey);
        if (destNormal === undefined) {
          const norms = await fetchClimateNormals(
            destLoc.lat,
            destLoc.lon,
            edd,
            edd,
          );
          destNormal = norms[0]?.meanTempF ?? null;
          destNormalCache.set(destCacheKey, destNormal);
        }

        const originDay = originByDate.get(shipDate);
        const originNormal = originNormalByDate.get(shipDate);

        // SKU history — fed into M3 modifier.
        const skuProfile = await prisma.skuRiskProfile.findUnique({
          where: { sku },
        });

        const ctx: RuleContext = {
          originTempF: originDay?.tempMaxF ?? null,
          destTempF: destDay?.tempMaxF ?? null,
          originAnomalyF:
            originDay && originNormal != null
              ? originDay.tempMaxF - originNormal
              : null,
          destAnomalyF:
            destDay && destNormal != null
              ? destDay.tempMaxF - destNormal
              : null,
          transitDays,
          carrier,
          service,
          sku,
          skuRiskLevel: skuProfile?.riskLevel ?? null,
        };

        const evalResult = await evaluateRisk(ctx);
        const recommendations = buildRecommendations(
          ctx,
          evalResult,
          skuProfile?.thawedCount,
        );

        // Skip noiseless "ok" — no need to clutter the table.
        if (evalResult.riskLevel === "ok") {
          result.skipped++;
          continue;
        }

        const channelTypeCode =
          order.channel?.type_code?.toLowerCase() ?? "amazon";
        const channelLabel = channelTypeCode.includes("walmart")
          ? "Walmart"
          : "Amazon";

        const created = await prisma.frozenRiskAlert.upsert({
          where: {
            orderId_shipDate: {
              orderId: order.number ?? String(order.id ?? ""),
              shipDate,
            },
          },
          create: {
            orderId: order.number ?? String(order.id ?? ""),
            veeqoOrderId: order.id != null ? String(order.id) : null,
            storeIndex: getStoreIndex(order),
            storeName: order.channel?.name ?? null,
            channel: channelLabel,
            sku,
            productName,
            shipDate,
            edd,
            transitDays,
            plannedCarrier: carrier,
            plannedService: service,
            destZip: destLoc.zip,
            destCity: destLoc.city,
            destState: destLoc.state,
            destLat: destLoc.lat,
            destLon: destLoc.lon,
            originTempF: originDay?.tempMaxF ?? null,
            originFeelsLikeF: originDay?.feelsLikeMaxF ?? null,
            originTempMaxF: originDay?.tempMaxF ?? null,
            originNormalF: originNormal ?? null,
            originAnomalyF: ctx.originAnomalyF,
            originWeatherDesc: originDay?.weatherDesc ?? null,
            destTempF: destDay?.tempMaxF ?? null,
            destFeelsLikeF: destDay?.feelsLikeMaxF ?? null,
            destTempMaxF: destDay?.tempMaxF ?? null,
            destNormalF: destNormal ?? null,
            destAnomalyF: ctx.destAnomalyF,
            destWeatherDesc: destDay?.weatherDesc ?? null,
            riskLevel: evalResult.riskLevel,
            riskScore: evalResult.riskScore,
            triggeredRules: JSON.stringify(evalResult.triggeredRules),
            recommendations: JSON.stringify(recommendations),
            status: "pending",
          },
          update: {
            // Re-evaluation for an unchanged shipDate just refreshes weather
            // + recommendations. We DO NOT reset status — if the operator
            // already applied/ignored the alert we don't want to undo that.
            originTempF: originDay?.tempMaxF ?? null,
            originTempMaxF: originDay?.tempMaxF ?? null,
            originNormalF: originNormal ?? null,
            originAnomalyF: ctx.originAnomalyF,
            originWeatherDesc: originDay?.weatherDesc ?? null,
            destTempF: destDay?.tempMaxF ?? null,
            destTempMaxF: destDay?.tempMaxF ?? null,
            destNormalF: destNormal ?? null,
            destAnomalyF: ctx.destAnomalyF,
            destWeatherDesc: destDay?.weatherDesc ?? null,
            riskLevel: evalResult.riskLevel,
            riskScore: evalResult.riskScore,
            triggeredRules: JSON.stringify(evalResult.triggeredRules),
            recommendations: JSON.stringify(recommendations),
          },
        });

        if (
          created.createdAt &&
          created.updatedAt &&
          created.createdAt.getTime() === created.updatedAt.getTime()
        ) {
          result.alertsCreated++;
        } else {
          result.alertsUpdated++;
        }
      } catch (err) {
        result.errors++;
        result.errorDetails.push(
          `order ${order.number ?? "?"}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  } catch (err) {
    result.errors++;
    result.errorDetails.push(
      `pipeline fatal: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  result.durationMs = Date.now() - start;
  return result;
}
