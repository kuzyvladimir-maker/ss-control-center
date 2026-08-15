// РЕАЛЬНАЯ матрица «вкус × фасовка» из каталога Amazon (Catalog Items 2022-04-01).
// Владелец 2026-08-15: «сам производитель создает какие, в принципе, существуют
// виды фасовок для каждого вкуса». Гадать по памяти нельзя — спрашиваем каталог.
// Источник бесплатный: наш собственный SP-API, платные провайдеры не трогаем.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { writeFileSync } from "node:fs";
import { spApiGet, MARKETPLACE_ID } from "../src/lib/amazon-sp-api/client";

type Item = {
  asin: string;
  summaries?: Array<{ marketplaceId?: string; itemName?: string; brand?: string }>;
  images?: Array<{ marketplaceId?: string; images?: Array<{ link?: string; variant?: string; height?: number }> }>;
};

const QUERIES = [
  "Uncrustables peanut butter grape jelly sandwiches",
  "Uncrustables peanut butter strawberry jam sandwiches",
  "Uncrustables whole wheat reduced sugar sandwiches",
  "Uncrustables chocolate hazelnut sandwiches",
  "Uncrustables honey spread sandwiches",
  "Uncrustables raspberry blackberry mixed berry sandwiches",
  "Uncrustables protein sandwiches",
  "Uncrustables 18 count 24 count club",
];

const seen = new Map<string, { title: string; image: string | null; brand: string | null }>();

async function search(keywords: string, token?: string): Promise<string | undefined> {
  const res = (await spApiGet("/catalog/2022-04-01/items", {
    storeId: "store1",
    params: {
      marketplaceIds: MARKETPLACE_ID,
      keywords,
      includedData: "summaries,images",
      pageSize: "20",
      ...(token ? { pageToken: token } : {}),
    },
  })) as { items?: Item[]; pagination?: { nextToken?: string } };
  for (const it of res.items ?? []) {
    const s = it.summaries?.find((x) => x.marketplaceId === MARKETPLACE_ID) ?? it.summaries?.[0];
    const name = s?.itemName ?? "";
    if (!/uncrustable/i.test(name)) continue;
    const set = it.images?.find((i) => i.marketplaceId === MARKETPLACE_ID) ?? it.images?.[0];
    const main = set?.images?.find((im) => im.variant === "MAIN") ?? set?.images?.[0];
    seen.set(it.asin, { title: name, image: main?.link ?? null, brand: s?.brand ?? null });
  }
  return res.pagination?.nextToken;
}

async function main() {
  for (const q of QUERIES) {
    let token: string | undefined;
    for (let page = 0; page < 5; page++) {
      try { token = await search(q, token); } catch (e: any) { console.log(`  ! ${q}: ${String(e?.message).slice(0, 90)}`); break; }
      if (!token) break;
      await new Promise((r) => setTimeout(r, 1200));
    }
    console.log(`«${q}» → накоплено ${seen.size}`);
    await new Promise((r) => setTimeout(r, 1200));
  }
  const rows = [...seen].map(([asin, v]) => {
    const m = v.title.match(/(\d+)\s*(?:ct\b|count\b|-?\s*pack\b)/i);
    return { asin, title: v.title, brand: v.brand, count: m ? Number(m[1]) : null, image: v.image };
  });
  writeFileSync("data/batch300/amazon-uncrustables-catalog.json", JSON.stringify(rows, null, 1));
  console.log(`\nвсего карточек Uncrustables: ${rows.length}`);
  const counts = new Map<number, number>();
  for (const r of rows) if (r.count) counts.set(r.count, (counts.get(r.count) ?? 0) + 1);
  console.log("встречающиеся фасовки:", [...counts].sort((a, b) => a[0] - b[0]).map(([c, n]) => `${c}шт:${n}`).join("  "));
}
main().catch((e) => { console.error(e); process.exit(1); });
