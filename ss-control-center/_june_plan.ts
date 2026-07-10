// FREE remediation planning for the June-16 broken cohort (282 live tiles showing the
// wrong product). For each, look for a correct donor ALREADY in DonorProduct: brand+size
// overlap, every significant listing word covered, all modifiers agree, not frozen.
// Read-only over the shared catalog — no vision, no retail search, no Unwrangle, no publish.
// Output _june_plan.json so a go-decision + Walmart recovery can act instantly.
import { readFileSync, writeFileSync } from "node:fs";
import { modifierMismatch, frozenDonorMismatch } from "./_gatewords.ts";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }

const STOP = new Set(["oz","ounce","ounces","lb","lbs","g","ct","count","pack","packs","of","the","and","with","in","by","fl","pre","sliced","bag","bags","box","case","each","size","net","wt","new","free","made","flavor","flavored","style","soft","fresh","loaf","loaves","bottle","can","cans","jar","liter","l","quantity","pop","soda","drink"]);
const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
const sig = (s: string) => new Set(norm(s).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d/.test(w)));
const sizes = (s: string) => { const out = new Set<string>(); const re = /(\d+(?:\.\d+)?)\s*(oz|ounce|ounces|lb|lbs|g|l|liter|liters)\b/gi; let m; while ((m = re.exec(s || "")) !== null) out.add(m[1]); return out; };
const sizesAgree = (a: Set<string>, b: Set<string>) => a.size === 0 || b.size === 0 || [...a].some((x) => b.has(x));
const covers = (L: Set<string>, c: Set<string>) => [...L].every((w) => c.has(w));
const jacc = (a: Set<string>, b: Set<string>) => { const i = [...a].filter((x) => b.has(x)).length; const u = new Set([...a, ...b]).size; return u ? i / u : 0; };

async function main() {
  const june: any[] = JSON.parse(readFileSync("_june_broken.json", "utf8")).filter((x: any) => x.sku !== "13941264614"); // drop own-brand STARFIT
  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });

  // current listing titles (mirror; the June rows carry a stale title)
  const skus = june.map((x) => x.sku);
  const listing = new Map<string, string>();
  for (let i = 0; i < skus.length; i += 200) {
    const c = skus.slice(i, i + 200);
    for (const r of (await db.execute({ sql: `SELECT sku,title FROM WalmartCatalogItem WHERE sku IN (${c.map(() => "?").join(",")})`, args: c })).rows) if (r.title) listing.set(String(r.sku), String(r.title));
  }
  const donors = (await db.execute(`SELECT id,title,mainImageUrl FROM DonorProduct WHERE imageUrls IS NOT NULL AND imageUrls != '[]'`)).rows
    .map((r: any) => ({ id: String(r.id), title: String(r.title || "") })).filter((d) => d.title)
    .map((d) => ({ ...d, sig: sig(d.title), sz: sizes(d.title) }));
  console.log(`июньских (без own-brand): ${june.length} · доноров в каталоге: ${donors.length}\n`);

  const out: any[] = []; let found = 0, none = 0, noTitle = 0;
  for (const j of june) {
    const L = listing.get(j.sku);
    if (!L) { noTitle++; continue; }
    const LS = sig(L), LZ = sizes(L);
    const cand = donors
      .filter((d) => !modifierMismatch(L, d.title) && !frozenDonorMismatch(L, d.title))
      .filter((d) => sizesAgree(LZ, d.sz))
      .filter((d) => covers(LS, d.sig))
      .map((d) => ({ id: d.id, title: d.title, score: jacc(LS, d.sig) }))
      .sort((a, b) => b.score - a.score).slice(0, 2);
    if (cand.length) { found++; out.push({ sku: j.sku, listing: L, pack: j.pack, was: j.liveFail, donorId: cand[0].id, donorTitle: cand[0].title, score: cand[0].score }); }
    else none++;
  }
  writeFileSync("_june_plan.json", JSON.stringify(out, null, 1));
  console.log(`чинятся из каталога (0 кредитов): ${found}`);
  console.log(`нужен новый харвест (в очередь COGS):  ${none}`);
  console.log(`нет заголовка листинга:                ${noTitle}`);
  console.log(`\n=== 6 примеров готовых к починке ===`);
  for (const o of out.slice(0, 6)) console.log(`  ${o.sku} q${o.pack}\n    листинг: ${o.listing.slice(0, 60)}\n    донор:   ${o.donorTitle.slice(0, 60)} (${o.score.toFixed(2)})`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
