import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { openClawSearch } from "../src/lib/sourcing/openclaw-fetch";
async function main() {
  for (const q of ["Smucker's Uncrustables", "uncrustables mega pack", "uncrustables grape jelly 24"]) {
    const res = await openClawSearch("bjs", q);
    const hits = res.offers.filter((o) => /uncrustable/i.test(o.title ?? ""));
    console.log(`«${q}» → всего ${res.offers.length}, из них Uncrustables: ${hits.length}`);
    for (const o of hits) console.log(`   ${o.title} | $${o.price} | img:${o.imageUrls?.[0] ? "есть" : "нет"} | ${o.productUrl ?? ""}`);
  }
}
main().catch((e) => console.log("✗", e?.message));
