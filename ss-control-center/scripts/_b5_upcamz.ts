// Недостающие UPC берём из каталога Amazon (Catalog Items → identifiers).
// Свой канал, бесплатный и авторитетный: штрихкод там принадлежит карточке
// производителя, а не перепаковке.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { spApiGet, MARKETPLACE_ID } from "../src/lib/amazon-sp-api/client";

const WANT: { q: string; re: RegExp; size: number; label: string }[] = [
  { q: "Uncrustables Chocolate Flavored Hazelnut Spread Sandwiches 15 Count", re: /hazelnut/i, size: 15, label: "Шоколадный орех 15" },
  { q: "Uncrustables Chocolate Flavored Hazelnut Spread Sandwiches 18 Count", re: /hazelnut/i, size: 18, label: "Шоколадный орех 18" },
  { q: "Smucker's Uncrustables Peanut Butter Grape Jelly Sandwiches 15 Count", re: /grape/i, size: 15, label: "Виноград 15" },
  { q: "Smucker's Uncrustables Peanut Butter Grape Jelly Sandwiches 18 Count", re: /grape/i, size: 18, label: "Виноград 18" },
  { q: "Smucker's Uncrustables Peanut Butter Grape Jelly Sandwiches 24 Count", re: /grape/i, size: 24, label: "Виноград 24" },
  { q: "Smucker's Uncrustables Peanut Butter Strawberry Jam Sandwiches 15 Count", re: /strawberry/i, size: 15, label: "Клубника 15" },
  { q: "Smucker's Uncrustables Peanut Butter Strawberry Jam Sandwiches 24 Count", re: /strawberry/i, size: 24, label: "Клубника 24" },
];

async function main() {
  const found: Record<string, string> = {};
  for (const w of WANT) {
    try {
      const res = (await spApiGet("/catalog/2022-04-01/items", {
        storeId: "store1",
        params: { marketplaceIds: MARKETPLACE_ID, keywords: w.q,
          includedData: "summaries,identifiers", pageSize: "20" },
      })) as any;
      for (const it of res.items ?? []) {
        const s = it.summaries?.find((x: any) => x.marketplaceId === MARKETPLACE_ID) ?? it.summaries?.[0];
        const name: string = s?.itemName ?? "";
        if (!/uncrustable/i.test(name) || !w.re.test(name)) continue;
        if (/variety pack|pack of \d/i.test(name)) continue;
        const m = name.match(/(\d+)\s*(?:ct\b|count\b|pk\b)/i);
        if (!m || Number(m[1]) !== w.size) continue;
        const ids = it.identifiers?.find((x: any) => x.marketplaceId === MARKETPLACE_ID)?.identifiers ?? [];
        const upc = ids.find((x: any) => /^(UPC|EAN|GTIN)$/i.test(x.identifierType))?.identifier;
        if (upc) { found[w.label] = upc; console.log(`  ✓ ${w.label.padEnd(22)} ${upc}  ${name.slice(0, 55)}`); break; }
      }
      if (!found[w.label]) console.log(`  ✗ ${w.label.padEnd(22)} не нашёлся`);
    } catch (e: any) { console.log(`  ! ${w.label}: ${String(e?.message).slice(0, 80)}`); }
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(`\nнайдено ${Object.keys(found).length} из ${WANT.length}`);
  require("node:fs").writeFileSync("data/batch300/upc-found.json", JSON.stringify(found, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
