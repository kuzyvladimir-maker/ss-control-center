// Create "Fast Three Day" shipping template (UNASSIGNED — no customer impact
// until items are assigned; deletable). Walmart STANDARD allows transit only
// 3/4/5 (2-day needs the TwoDay program enrollment), so the achievable fast
// template = STANDARD transit 3 (vs the slow 6-day VALUE many SKUs sit on).
// We CLONE the Default template's working STANDARD config (valid region codes)
// and set transit 3. Does NOT assign any item. Readback to verify.
//   npx tsx scripts/walmart-create-fl-template.ts
import "dotenv/config";
import { getWalmartClient } from "@/lib/walmart/client";

/* eslint-disable @typescript-eslint/no-explicit-any */

async function main() {
  const c = getWalmartClient(1);
  const list: any = (await c.requestRaw("GET", "/settings/shipping/templates")).body;

  // Idempotent: don't create a duplicate.
  const dup = (list.shippingTemplates ?? []).find((t: any) => t.name === "Fast Three Day");
  if (dup) { console.log(`already exists: ${dup.id} (${dup.name})`); return; }

  const def = (list.shippingTemplates ?? []).find((t: any) => t.type === "DEFAULT");
  const d: any = (await c.requestRaw("GET", `/settings/shipping/templates/${def.id}`)).body;
  const std = (d.shippingMethods ?? []).find((m: any) => m.shipMethod === "STANDARD");
  const baseCfg = std.configurations[0];

  const body = {
    name: "Fast Three Day",
    type: "CUSTOM",
    rateModelType: "PER_SHIPMENT_PRICING",
    status: "ACTIVE",
    shippingMethods: [
      {
        shipMethod: "STANDARD",
        status: "ACTIVE",
        configurations: [
          {
            regions: baseCfg.regions, // exact valid national taxonomy from Default
            addressTypes: baseCfg.addressTypes ?? ["STREET"],
            transitTime: 3, // STANDARD min allowed
            perShippingCharge: baseCfg.perShippingCharge,
            tieredShippingCharges: [],
          },
        ],
      },
    ],
  };

  const res = await c.requestRaw("POST", "/settings/shipping/templates", {
    body,
    headers: { "Content-Type": "application/json" },
  });
  console.log(`→ POST status ${res.status}`);
  if (!res.ok) { console.log("response:", JSON.stringify(res.body)?.slice(0, 600)); return; }

  const list2: any = (await c.requestRaw("GET", "/settings/shipping/templates")).body;
  const mine = (list2.shippingTemplates ?? []).find((t: any) => t.name === "Fast Three Day");
  if (mine) {
    const det: any = (await c.requestRaw("GET", `/settings/shipping/templates/${mine.id}`)).body;
    const cf = det.shippingMethods?.[0]?.configurations?.[0];
    const stateCount = (cf?.regions ?? []).flatMap((r: any) => (r.subRegions ?? []).flatMap((sr: any) => sr.states ?? [])).length;
    console.log(`✅ Created id=${mine.id} "${mine.name}" (UNASSIGNED). STANDARD transit=${cf?.transitTime}d, ${stateCount} states covered, free shipping.`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e.message); process.exit(1); });
