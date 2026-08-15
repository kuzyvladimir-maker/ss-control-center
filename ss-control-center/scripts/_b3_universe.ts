// ВСЕЛЕННАЯ Uncrustables: что Smucker's вообще выпускает — каждый вкус в каждой
// розничной фасовке, как оно лежит на полках. Владелец 2026-08-15: «сколько в
// природе вообще существует … в Walmart, в Target, Sam's Club, в Costco, в BJ's».
// Это НЕ наш каталог Amazon: там перепаковки реселлеров, а не заводские коробки.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { unwrangleSearch } from "../src/lib/sourcing/retail-fetch";

const RETAILERS = ["walmart", "target", "samsclub", "costco"] as const;
const QUERIES = ["uncrustables", "uncrustables sandwiches", "smuckers uncrustables frozen"];

const OUT = "data/batch300/universe-raw.json";

async function main() {
  const acc: any[] = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : [];
  const seen = new Set(acc.map((r) => `${r.retailer}|${r.retailerProductId}`));
  for (const retailer of RETAILERS) {
    for (const q of QUERIES) {
      try {
        const res = await unwrangleSearch(retailer, q);
        let added = 0;
        for (const o of res.offers) {
          const k = `${o.retailer}|${o.retailerProductId}`;
          if (seen.has(k)) continue;
          seen.add(k);
          acc.push({ retailer: o.retailer, retailerProductId: o.retailerProductId,
            title: o.title, price: o.price, url: o.productUrl, images: o.images ?? [] });
          added++;
        }
        console.log(`${retailer.padEnd(9)} «${q}» → +${added} (всего ${acc.length}) | кредитов осталось ${res.creditsRemaining ?? "?"}${res.trialExhausted ? " ИСЧЕРПАНО" : ""}`);
        writeFileSync(OUT, JSON.stringify(acc, null, 1));
        if (res.trialExhausted) { console.log("  кредиты кончились — останавливаюсь"); return; }
      } catch (e: any) {
        console.log(`${retailer.padEnd(9)} «${q}» ✗ ${String(e?.message).slice(0, 110)}`);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  console.log(`\nсырых карточек с полок: ${acc.length} → ${OUT}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
