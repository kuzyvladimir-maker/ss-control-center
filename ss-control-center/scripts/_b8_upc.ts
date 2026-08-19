// Добыча недостающих UPC производителя из каталога Amazon.
// ГЛАВНЫЙ ФИЛЬТР: принимаем только префикс 051500 — это код изготовителя
// Smucker's. Ранее поиск возвращал 0756441…, баркод перепаковщика; записать
// такой как UPC производителя значит подложить в каталог чужой товар.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { writeFileSync } from "node:fs";
import { spApiGet, MARKETPLACE_ID } from "../src/lib/amazon-sp-api/client";

const SMUCKER_PREFIX = /^0?051500/;
const WANT = [
  { flavor: "Peanut Butter & Strawberry Jam", size: 15, q: "Smucker's Uncrustables Peanut Butter Strawberry Jam Sandwiches 15 Count Frozen", re: /strawberry/i, ban: /whole wheat|protein|grape|raspberry/i },
  { flavor: "Peanut Butter & Strawberry Jam", size: 24, q: "Smucker's Uncrustables Peanut Butter Strawberry Jam Sandwiches 24 Count Frozen", re: /strawberry/i, ban: /whole wheat|protein|grape|raspberry/i },
  { flavor: "Peanut Butter & Grape Jelly", size: 15, q: "Smucker's Uncrustables Peanut Butter Grape Jelly Sandwiches 15 Count Frozen", re: /grape/i, ban: /whole wheat|protein|strawberry/i },
  { flavor: "Peanut Butter & Grape Jelly", size: 18, q: "Smucker's Uncrustables Peanut Butter Grape Jelly Sandwiches 18 Count Frozen", re: /grape/i, ban: /whole wheat|protein|strawberry/i },
  { flavor: "Peanut Butter & Grape Jelly", size: 24, q: "Smucker's Uncrustables Peanut Butter Grape Jelly Sandwiches 24 Count Frozen", re: /grape/i, ban: /whole wheat|protein|strawberry/i },
];

async function main() {
  const found: any[] = [];
  for (const w of WANT) {
    let hit: any = null;
    try {
      const res = (await spApiGet("/catalog/2022-04-01/items", {
        storeId: "store1",
        params: { marketplaceIds: MARKETPLACE_ID, keywords: w.q,
          includedData: "summaries,identifiers", pageSize: "20" },
      })) as any;
      for (const it of res.items ?? []) {
        const s = it.summaries?.find((x: any) => x.marketplaceId === MARKETPLACE_ID) ?? it.summaries?.[0];
        const name: string = s?.itemName ?? "";
        if (!/uncrustable/i.test(name) || !w.re.test(name) || w.ban.test(name)) continue;
        if (/variety pack|pack of \d|bundle/i.test(name)) continue;
        // Заводской заголовок пишет счёт по-разному: «15 Count», «15 ct»,
        // «Sandwiches, 15 (Frozen)». Ловим все три, иначе карточка
        // производителя молча не находится (замер 2026-08-19).
        const m = name.match(/(\d+)\s*(?:ct\b|count\b|pk\b)/i)
          ?? name.match(/,\s*(\d+)\s*(?:\(|\||$)/);
        if (!m || Number(m[1]) !== w.size) continue;
        const ids = it.identifiers?.find((x: any) => x.marketplaceId === MARKETPLACE_ID)?.identifiers ?? [];
        const upc = ids.map((x: any) => String(x.identifier)).find((v: string) => SMUCKER_PREFIX.test(v));
        if (!upc) continue;
        hit = { ...w, asin: it.asin, upc: upc.replace(/^0(?=051500)/, ""), name: name.slice(0, 62) };
        break;
      }
    } catch (e: any) { console.log(`  ! ${w.flavor} ${w.size}: ${String(e?.message).slice(0, 60)}`); }
    if (hit) { found.push(hit); console.log(`  ✓ ${String(w.size).padStart(2)}шт ${hit.upc}  ${hit.name}`); }
    else console.log(`  ✗ ${String(w.size).padStart(2)}шт ${w.flavor} — производительского UPC не нашлось`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  writeFileSync("data/batch300/upc-manufacturer.json", JSON.stringify(found, null, 1));
  console.log(`\nнайдено ${found.length} из ${WANT.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
