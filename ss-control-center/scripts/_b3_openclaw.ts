import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { openClawEnabled, openClawSearch } from "../src/lib/sourcing/openclaw-fetch";
async function main() {
  console.log("openclaw включён:", openClawEnabled());
  if (!openClawEnabled()) return;
  for (const r of ["bjs", "publix", "aldi"] as const) {
    try {
      const res = await openClawSearch(r, "uncrustables");
      console.log(`${r}: ${res.offers.length} карточек`);
      for (const o of res.offers.slice(0, 8)) console.log(`   ${String(o.title).slice(0, 90)}`);
    } catch (e: any) { console.log(`${r}: ✗ ${String(e?.message).slice(0, 100)}`); }
  }
}
main();
