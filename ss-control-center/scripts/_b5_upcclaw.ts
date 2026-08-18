// UPC берём через box worker с розничных страниц: у ритейлеров штрихкод лежит
// в спецификациях товара и принадлежит производителю, а не перепаковщику.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { openClawSearch, type OpenClawRetailer } from "../src/lib/sourcing/openclaw-fetch";
async function main() {
  const QS = [
    "Smucker's Uncrustables grape jelly 15", "Smucker's Uncrustables strawberry jam 15",
    "Smucker's Uncrustables chocolate hazelnut 15", "uncrustables mega pack 24",
    "Smucker's Uncrustables grape jelly 18",
  ];
  for (const r of ["publix", "bjs"] as OpenClawRetailer[]) {
    for (const q of QS) {
      try {
        const res = await openClawSearch(r, q);
        for (const o of res.offers) {
          if (!/uncrustable/i.test(o.title ?? "")) continue;
          const anyO = o as unknown as Record<string, unknown>;
          const upc = anyO.upc ?? anyO.gtin ?? anyO.barcode ?? null;
          if (upc) console.log(`  ${r} | ${String(upc)} | ${String(o.title).slice(0, 62)}`);
        }
      } catch { /* пропускаем */ }
      await new Promise((x) => setTimeout(x, 700));
    }
  }
  console.log("готово");
}
main().catch((e) => { console.error(e); process.exit(1); });
