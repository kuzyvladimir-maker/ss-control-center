// Diagnostic — full marketplaceParticipations response for one store.
// Pass store index as argv (default 2).

import "dotenv/config";
import { spApiGet, MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";

async function main() {
  const idx = Number(process.argv[2] ?? 2);
  console.log(`Expected MARKETPLACE_ID: ${MARKETPLACE_ID}`);
  console.log(`Probing store${idx}\n`);

  const r = await spApiGet("/sellers/v1/marketplaceParticipations", {
    storeId: `store${idx}`,
  });
  console.log("Raw response:");
  console.log(JSON.stringify(r, null, 2));

  const list = Array.isArray(r?.payload) ? r.payload : Array.isArray(r) ? r : [];
  console.log(`\n${list.length} marketplace(s) returned. Looking for ${MARKETPLACE_ID}…`);

  const usHit = list.find((p: any) => p?.marketplace?.id === MARKETPLACE_ID);
  if (!usHit) {
    console.log("❌ US (ATVPDKIKX0DER) NOT in the response.");
    console.log("Marketplaces in response:");
    for (const p of list) {
      const id = p?.marketplace?.id;
      const country = p?.marketplace?.countryCode;
      const name = p?.marketplace?.name;
      const isP = p?.participation?.isParticipating;
      console.log(`  · ${id}  ${country}  "${name}"  isParticipating=${isP}`);
    }
  } else {
    console.log("✅ US present:");
    console.log(JSON.stringify(usHit, null, 2));
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
