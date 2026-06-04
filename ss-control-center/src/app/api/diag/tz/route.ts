// GET /api/diag/tz
//
// Timezone diagnostic — for every awaiting-fulfillment order this returns:
//   - orderNumber, channel
//   - raw `dispatch_date` and `due_date` Veeqo gave us (UTC ISO)
//   - their Eastern (Miami) calendar day after our utcToEasternYMD conversion
//   - the timeBucket the dashboard would assign (today/tomorrow/etc.)
//   - server-side "now" in Eastern + in UTC
//
// Used to compare against Veeqo's own UI when a count discrepancy shows up
// ("Veeqo says 34 Today, our app says 1 Today" — look at one specific order
// and see exactly where the disagreement is).
//
// Optional query params:
//   ?channel=amazon       filter to a channel kind (amazon/walmart/tiktok/ebay)
//   ?order=NUMBER         filter to a single orderNumber (substring match)
//   ?bucket=today         filter to one bucket (today/tomorrow/dayafter/later/overdue)

import { NextRequest, NextResponse } from "next/server";
import { fetchAllOrders } from "@/lib/veeqo/client";
import { utcToEasternYMD, todayNY } from "@/lib/shipping/dates";

type ShipByBucket =
  | "overdue"
  | "today"
  | "tomorrow"
  | "dayafter"
  | "later";

function shipByBucket(iso: string | null): ShipByBucket | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const dStr = utcToEasternYMD(d);
  const nowStr = todayNY();
  const diffDays = Math.round(
    (new Date(dStr + "T00:00:00Z").getTime() -
      new Date(nowStr + "T00:00:00Z").getTime()) /
      86_400_000,
  );
  if (diffDays < 0) return "overdue";
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "tomorrow";
  if (diffDays === 2) return "dayafter";
  return "later";
}

function classifyChannel(name: string): string {
  const n = (name || "").toLowerCase();
  if (n.includes("walmart")) return "walmart";
  if (n.includes("tiktok")) return "tiktok";
  if (n.includes("ebay")) return "ebay";
  if (n.includes("amazon") || n.startsWith("amz")) return "amazon";
  return "other";
}

export async function GET(req: NextRequest) {
  const channelFilter = req.nextUrl.searchParams.get("channel");
  const orderFilter = req.nextUrl.searchParams.get("order");
  const bucketFilter = req.nextUrl.searchParams.get("bucket");

  const orders = await fetchAllOrders();

  const rows = orders
    .map((o: {
      id: number | string;
      number?: string;
      dispatch_date?: string | null;
      due_date?: string | null;
      channel?: { name?: string };
      channel_name?: string;
    }) => {
      const channelName =
        o.channel?.name ?? o.channel_name ?? "(unknown)";
      const channelKind = classifyChannel(channelName);
      const dispatchRaw = o.dispatch_date ?? null;
      const dueRaw = o.due_date ?? null;
      const shipByRaw = dispatchRaw ?? dueRaw;
      const shipByEastern = shipByRaw
        ? utcToEasternYMD(shipByRaw)
        : null;
      const bucket = shipByBucket(shipByRaw);
      return {
        orderNumber: String(o.number ?? o.id),
        channelName,
        channelKind,
        dispatch_date_raw: dispatchRaw,
        due_date_raw: dueRaw,
        shipByRawUsed: shipByRaw,
        shipByEastern,
        bucket,
      };
    })
    .filter((r) => {
      if (channelFilter && r.channelKind !== channelFilter) return false;
      if (orderFilter && !r.orderNumber.includes(orderFilter)) return false;
      if (bucketFilter && r.bucket !== bucketFilter) return false;
      return true;
    });

  // Summary counts so the response is skim-able without scrolling.
  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    const key = r.bucket ?? "no-shipBy";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({
    nowUtcIso: new Date().toISOString(),
    nowEastern: todayNY(),
    filters: {
      channel: channelFilter,
      order: orderFilter,
      bucket: bucketFilter,
    },
    totalOrders: orders.length,
    matched: rows.length,
    bucketCounts: counts,
    rows,
  });
}
