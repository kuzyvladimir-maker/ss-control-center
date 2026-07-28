// For every LIVE tile the re-QC marked BAD (image shows a different product than the
// listing), look for a BETTER donor that ALREADY EXISTS in our DonorProduct catalog.
//
// This is read-only over the shared catalog — no retail search, no Unwrangle credits.
// It does not re-link anything: it produces a suggestion list for the COGS chat, whose
// job is the recipe. Purpose is to turn "re-source 250 SKUs" into "confirm 250 matches".
//
// Scoring: a candidate must agree on every MODIFIER word (diet/whole/zero/…) — those
// flip the product outright — then ranks by significant-token overlap with the listing.
import { readFileSync, writeFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }

const MODIFIERS = ["diet", "zero", "decaf", "caffeine", "whole", "honey", "xxtra", "flamin", "unsweetened", "lite", "reduced", "gluten", "organic", "spicy", "original", "classic", "smoked", "toasted", "seedless", "multigrain", "oatmeal", "pumpernickel", "rye", "sesame", "butter", "hamburger", "hotdog"];
const STOP = new Set(["oz","ounce","ounces","lb","g","ct","count","pack","packs","of","the","and","with","in","by","fl","pre","sliced","bag","bags","box","case","each","size","net","wt","new","free","made","flavor","flavored","style","soft","fresh","loaf","loaves","bottle","can","cans","jar","liter","l","quantity"]);
const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
const sig = (s: string) => new Set(norm(s).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d/.test(w)));
const mods = (s: string) => new Set(norm(s).filter((w) => MODIFIERS.includes(w)));
const jacc = (a: Set<string>, b: Set<string>) => { const i = [...a].filter((x) => b.has(x)).length; const u = new Set([...a, ...b]).size; return u ? i / u : 0; };
/** net weights, e.g. "12.5oz", "15.25 oz" → {"12.5","15.25"} */
const sizes = (s: string) => { const out = new Set<string>(); const re = /(\d+(?:\.\d+)?)\s*(oz|ounce|ounces|lb|lbs|g|l|liter|liters)\b/gi; let m: RegExpExecArray | null; while ((m = re.exec(s || "")) !== null) out.add(m[1]); return out; };
const sizesAgree = (a: Set<string>, b: Set<string>) => a.size === 0 || b.size === 0 || [...a].some((x) => b.has(x));
/** every significant word of the listing must appear in the candidate — this is what
 *  separates "100% Whole WHEAT" from "15 GRAIN": both are "Whole Grain Thin Sliced". */
const covers = (listing: Set<string>, cand: Set<string>) => [...listing].every((w) => cand.has(w));

async function main() {
  const bad: any[] = Object.values(JSON.parse(readFileSync("_reqc_state.json", "utf8"))).filter((x: any) => x.verdict === "BAD");
  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });

  // pull the donor catalog once (title + a usable gallery)
  const donors = (await db.execute(`SELECT id,title,mainImageUrl,imageUrls FROM DonorProduct WHERE imageUrls IS NOT NULL AND imageUrls != '[]'`)).rows
    .map((r: any) => ({ id: String(r.id), title: String(r.title || ""), main: String(r.mainImageUrl || "") }))
    .filter((d) => d.title);
  console.log(`BAD SKU: ${bad.length} · доноров в каталоге: ${donors.length}\n`);

  const pre = donors.map((d) => ({ ...d, sig: sig(d.title), mods: mods(d.title), sz: sizes(d.title) }));
  const out: any[] = [];
  let found = 0, none = 0;
  for (const b of bad) {
    const L = sig(b.listing), LM = mods(b.listing), LS = sizes(b.listing);
    const cands = pre
      .filter((d) => { for (const m of MODIFIERS) if (LM.has(m) !== d.mods.has(m)) return false; return true; }) // modifiers must agree exactly
      .filter((d) => sizesAgree(LS, d.sz))   // a 12.5oz donor is not a 15.25oz listing
      .filter((d) => covers(L, d.sig))       // candidate must contain EVERY listing word
      .map((d) => ({ id: d.id, title: d.title, main: d.main, score: jacc(L, d.sig) }))
      .sort((a, b2) => b2.score - a.score)
      .slice(0, 2);
    if (cands.length) { found++; out.push({ sku: b.sku, listing: b.listing, currentDonor: b.donorTitle, suggestions: cands }); }
    else { none++; out.push({ sku: b.sku, listing: b.listing, currentDonor: b.donorTitle, suggestions: [] }); }
  }
  writeFileSync("_suggested_donors.json", JSON.stringify(out, null, 1));
  console.log(`нашёлся кандидат в НАШЕЙ базе: ${found} · нужен новый харвест: ${none}\n`);
  console.log("=== 8 примеров ===");
  for (const o of out.filter((x) => x.suggestions.length).slice(0, 8)) {
    console.log(`\n  ${o.sku}`);
    console.log(`    листинг:      ${o.listing.slice(0, 68)}`);
    console.log(`    сейчас донор: ${o.currentDonor.slice(0, 68)}`);
    console.log(`    ПРЕДЛАГАЮ:    ${o.suggestions[0].title.slice(0, 68)}  (score ${o.suggestions[0].score.toFixed(2)})`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
