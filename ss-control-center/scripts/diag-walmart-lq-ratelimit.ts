// Probe the listingQuality/items rate bucket + max page size. Direct fetch so
// we can read the rate-limit headers (the client hides them).
//   npx tsx scripts/diag-walmart-lq-ratelimit.ts
import "dotenv/config";
import { randomUUID } from "crypto";
import { getWalmartClient } from "@/lib/walmart/client";

const BASE = "https://marketplace.walmartapis.com";

async function call(token: string, limit: number, cursor?: string) {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (cursor) qs.set("nextCursor", cursor);
  const url = `${BASE}/v3/insights/items/listingQuality/items?${qs}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "WM_SEC.ACCESS_TOKEN": token,
      "WM_QOS.CORRELATION_ID": randomUUID(),
      "WM_SVC.NAME": "Walmart Marketplace",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: "{}",
  });
  const tokens = res.headers.get("x-current-token-count");
  const replenish = res.headers.get("x-next-replenish-time");
  const retryAfter = res.headers.get("retry-after");
  let count: number | string = "?";
  let total: number | string = "?";
  let next = "";
  if (res.ok) {
    const j = (await res.json()) as any;
    count = Array.isArray(j?.payload) ? j.payload.length : "?";
    total = j?.totalItems ?? "?";
    next = j?.nextCursor ? "yes" : "no";
  }
  const nowMs = Date.now();
  const replMs = replenish ? Number(replenish) - nowMs : null;
  console.log(
    `limit=${limit} → ${res.status} | items=${count}/${total} nextCursor=${next} | tokensLeft=${tokens} replenishIn=${replMs !== null ? Math.round(replMs / 1000) + "s" : "?"} retryAfter=${retryAfter ?? "-"}`
  );
}

async function main() {
  const client = getWalmartClient(1);
  const t = (await client.getAccessToken()).accessToken;
  // Two paced calls at the known-good page size to read the bucket cadence.
  await call(t, 200);
  await new Promise((r) => setTimeout(r, 12000));
  await call(t, 200);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
