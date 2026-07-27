// Probe the Insights "Unpublished Items" API for STARFITSTORE (Walmart store 1)
// to capture the live response schema + the actual unpublishedReasonCode values
// (compliance / trust & safety removals show up here).
//   npx tsx scripts/diag-walmart-unpublished.ts
import "dotenv/config";
import { getWalmartClient } from "@/lib/walmart/client";

async function main() {
  const client = getWalmartClient(1);
  // Wide window — go back ~2 years so historical removals are included.
  const fromDate = "2024-01-01";

  console.log("### COUNTS  GET /insights/items/unpublished/counts ###");
  const counts = await client.requestRaw("GET", "/insights/items/unpublished/counts", {
    params: { fromDate },
  });
  console.log("status", counts.status, "ok", counts.ok);
  console.log(JSON.stringify(counts.body, null, 2)?.slice(0, 4000));

  console.log("\n### ITEMS  GET /insights/items/unpublished/items ###");
  const items = await client.requestRaw("GET", "/insights/items/unpublished/items", {
    params: { fromDate, limit: 50 },
  });
  console.log("status", items.status, "ok", items.ok);
  const b = items.body as Record<string, unknown>;
  // Print envelope keys + first 3 rows verbatim so we can model exact fields.
  console.log("top-level keys:", b && typeof b === "object" ? Object.keys(b) : b);
  const payload =
    (b?.payload as unknown[]) ??
    (b?.items as unknown[]) ??
    (b?.elements as unknown[]) ??
    [];
  console.log("payload length:", Array.isArray(payload) ? payload.length : "n/a");
  console.log(JSON.stringify(Array.isArray(payload) ? payload.slice(0, 3) : b, null, 2)?.slice(0, 6000));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e?.message || e); process.exit(1); });
