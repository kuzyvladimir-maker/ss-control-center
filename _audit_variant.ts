// AUDIT: did we tile a DONOR whose variant does not match the LIVE LISTING?
//
// FaisalX-1196 exposed the gap: the listing is "Sara Lee Whole Wheat Bread", the donor
// record is titled "Sara Lee Honey Whole Wheat", and the donor IMAGE actually shows
// "Honey Wheat". It passed tile-QC and is published. Two causes:
//   1) tile-QC compares the tile against donorTitle, NOT the real listing title, so a
//      bad donor pick is validated against its own (wrong) label;
//   2) the gate is non-deterministic on one-word differences.
//
// This audit needs no vision: for every SKU we PUBLISHED, compare the significant tokens
// of the donor title vs the live listing title (from the nightly WalmartCatalogItem
// mirror). Tokens present in one and missing in the other are variant-bearing words
// ("Whole", "Honey", "XXTRA", "Zero", "Rice", "Pasta"…) and flag a likely mismatch.
import { readFileSync, writeFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }

// words that never carry variant meaning — packaging, filler, plural noise
const STOP = new Set(["oz","ounce","ounces","lb","lbs","g","gram","grams","ct","count","pack","packs","of","the","a","an","and","with","in","by","x","fl","pre","sliced","slice","loaf","loaves","bread","bag","bags","box","case","each","total","size","net","wt","inch","new","free","made","flavor","flavored","style","soft","fresh","great","value"]);

/** net weight tokens, e.g. "12.5oz", "15.25 oz", "16.75oz" → ["12.5","15.25"] */
function sizes(s: string): Set<string> {
  const out = new Set<string>();
  const re = /(\d+(?:\.\d+)?)\s*(oz|ounce|ounces|lb|lbs|g)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s || "")) !== null) out.add(m[1]);
  return out;
}

/** variant-bearing words: strip sizes first, then numbers, packaging, filler */
function sig(s: string): Set<string> {
  const noSize = (s || "").replace(/(\d+(?:\.\d+)?)\s*(oz|ounce|ounces|lb|lbs|g)\b/gi, " ");
  return new Set(
    noSize.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
}

async function main() {
  const gen: Record<string, any> = JSON.parse(readFileSync("_gen_enriched_state.json", "utf8"));
  const pub: Record<string, any> = JSON.parse(readFileSync("_publish_gen_state.json", "utf8"));
  const applied = Object.keys(pub).filter((k) => pub[k].status === "applied");

  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });

  const titles = new Map<string, string>();
  for (let i = 0; i < applied.length; i += 200) {
    const chunk = applied.slice(i, i + 200);
    const rows = (await db.execute({ sql: `SELECT sku,title FROM WalmartCatalogItem WHERE sku IN (${chunk.map(() => "?").join(",")})`, args: chunk })).rows;
    for (const r of rows) titles.set(String(r.sku), String(r.title || ""));
  }

  const flagged: any[] = [];
  let checked = 0, noTitle = 0, noDonor = 0;
  for (const sku of applied) {
    const donorTitle = gen[sku]?.donorTitle;
    const listing = titles.get(sku);
    if (!donorTitle) { noDonor++; continue; }
    if (!listing) { noTitle++; continue; }
    checked++;
    const d = sig(donorTitle), l = sig(listing);
    const missingInDonor = [...l].filter((w) => !d.has(w));   // listing says it, donor doesn't
    const extraInDonor = [...d].filter((w) => !l.has(w));     // donor says it, listing doesn't
    const ds = sizes(donorTitle), ls = sizes(listing);
    // size mismatch only when BOTH declare a size and they share none
    const sizeBad = ds.size > 0 && ls.size > 0 && ![...ds].some((x) => ls.has(x));
    const wordBad = missingInDonor.length > 0 || extraInDonor.length > 0;
    if (sizeBad || wordBad) {
      flagged.push({ sku, listing, donorTitle, missingInDonor, extraInDonor, sizeBad,
        donorSize: [...ds].join("/"), listingSize: [...ls].join("/"),
        score: missingInDonor.length + extraInDonor.length + (sizeBad ? 1 : 0) });
    }
  }
  flagged.sort((a, b) => a.score - b.score); // smallest diffs first = subtlest, most dangerous
  writeFileSync("_audit_variant.json", JSON.stringify(flagged, null, 1));

  const sizeOnly = flagged.filter((f) => f.sizeBad && !f.missingInDonor.length && !f.extraInDonor.length);
  const wordFlags = flagged.filter((f) => f.missingInDonor.length || f.extraInDonor.length);
  console.log(`опубликовано: ${applied.length} · сверено: ${checked} · нет в зеркале: ${noTitle}`);
  console.log(`ПОДОЗРИТЕЛЬНЫХ ВСЕГО: ${flagged.length}`);
  console.log(`  · только размер не тот: ${sizeOnly.length}`);
  console.log(`  · расходятся слова варианта: ${wordFlags.length}\n`);
  console.log("=== 10 самых тонких (различие в 1 слове — самые опасные) ===");
  for (const f of wordFlags.slice(0, 10)) {
    console.log(`\n  ${f.sku}  (diff ${f.score})${f.sizeBad ? "  [+размер " + f.donorSize + " vs " + f.listingSize + "]" : ""}`);
    console.log(`    листинг: ${f.listing.slice(0, 70)}`);
    console.log(`    донор:   ${f.donorTitle.slice(0, 70)}`);
    if (f.missingInDonor.length) console.log(`    в листинге есть, у донора НЕТ: ${f.missingInDonor.join(", ")}`);
    if (f.extraInDonor.length) console.log(`    у донора лишнее: ${f.extraInDonor.join(", ")}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
