// Audit every listing we changed LIVE during Wave 1 (WalmartListingRemediation
// ok=1). Checks BOTH the image we pushed (vision-classify the R2 tile) and the
// text (brand-voice + Walmart rules). Produces a verdict per listing so we know
// exactly which of the ~195 are bad and why. READ-ONLY.
//
//   npx tsx scripts/walmart-audit-live.ts            # all live listings
//   npx tsx scripts/walmart-audit-live.ts 25         # first 25 (sample)

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" }); loadEnv({ path: ".env" });
import { createClient } from "@libsql/client";
import { writeFileSync } from "fs";
import { assertMeteredProviderCall } from "@/lib/sourcing/metered-call-guard";

throw new Error("LEGACY_METERED_SCRIPT_DISABLED: direct paid audit transports are quarantined");

const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
const OKEY = process.env.OPENAI_API_KEY!;
const BKEY = process.env.BLUECART_API_KEY!;
const LIMIT = Number(process.argv.find((a) => /^\d+$/.test(a)) || 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Live PDP content (title, bullets, description) as the BUYER sees it now. */
async function liveContent(buyerItemId: string) {
  assertMeteredProviderCall({ provider: "bluecart", operation: "detail" });
  try {
    const j: any = await (await fetch(`https://api.bluecartapi.com/request?api_key=${BKEY}&type=product&item_id=${buyerItemId}&walmart_domain=walmart.com`)).json();
    const p = j?.product || {};
    const bullets = Array.isArray(p.feature_bullets) ? p.feature_bullets.length : 0;
    return { title: p.title || "", bullets, descLen: (p.description || "").replace(/<[^>]+>/g, "").length, mainImage: p.main_image || "" };
  } catch { return null; }
}

// Brand-voice red flags (from CLAUDE.md) — text must NOT contain these.
const PROMO = ["ultimate","perfect","delightful","delicious","ideal","amazing","incredible","premium","exclusive","must-have","best","finest","exceptional","outstanding","magnificent","wonderful","fantastic","superior","top-quality","world-class","awesome"];
const HEALTH = ["cure","treat","prevent","boost","weight loss","detox","heal"];
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}✅❌]/u;

async function classifyImage(url: string) {
  const body = {
    model: "gpt-4o-mini", max_tokens: 60,
    messages: [{ role: "user", content: [
      { type: "text", text: 'This is a marketplace MAIN product image (often a grid of the SAME photo repeated to show a multipack). Judge the underlying photo. JSON only: {"kind":"front|back|nutrition|lifestyle|promo|other","acceptable_main":true|false}. acceptable_main=true only if it is a clean product shot (front of the product, plain/white background) — NOT a nutrition-facts/back/lifestyle/promo image.' },
      { type: "image_url", image_url: { url } }] }],
  };
  assertMeteredProviderCall({ provider: "openai", operation: "vision" });
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + OKEY }, body: JSON.stringify(body) });
    const j: any = await r.json();
    let t = j?.choices?.[0]?.message?.content || "";
    t = t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1);
    return JSON.parse(t);
  } catch { return { kind: "error", acceptable_main: null }; }
}

function auditText(title: string, bullets: number, descLen: number) {
  const issues: string[] = [];
  const low = (title || "").toLowerCase();
  if (EMOJI.test(title || "")) issues.push("emoji in title");
  const promo = PROMO.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(title || ""));
  if (promo.length) issues.push("promo words: " + promo.join(","));
  const health = HEALTH.filter((w) => low.includes(w));
  if (health.length) issues.push("health claims: " + health.join(","));
  if ((title || "").length < 25) issues.push("title too short");
  if ((title || "").length > 200) issues.push("title too long");
  if (!/pack of \d|\d+[- ]?pack|\bcount\b|\b\d+ ct\b/i.test(title || "")) issues.push("no pack/qty in title");
  if (bullets === 0) issues.push("no bullets");
  if (descLen < 100) issues.push("description too short/empty");
  return issues;
}

(async () => {
  const rows = (await db.execute(
    `SELECT sku, buyerItemId, mainImageUrl, newTitle, bulletsCount, descriptionLength, MAX(runAt) runAt
     FROM WalmartListingRemediation WHERE ok=1 GROUP BY sku ORDER BY runAt DESC` + (LIMIT ? ` LIMIT ${LIMIT}` : "")
  )).rows as any[];
  console.log(`auditing ${rows.length} live listings…\n`);

  const report: any[] = [];
  let badImg = 0, badTxt = 0, ok = 0, n = 0;
  for (const r of rows) {
    n++;
    const img = r.mainImageUrl ? await classifyImage(r.mainImageUrl) : { kind: "no-image", acceptable_main: false };
    await sleep(500); // OpenAI rate-limit guard
    // Live PDP text (what the buyer sees now), NOT our log.
    const live = r.buyerItemId ? await liveContent(String(r.buyerItemId)) : null;
    const txt = live ? auditText(live.title, live.bullets, live.descLen) : ["live content unavailable"];
    const imgBad = img.acceptable_main === false;
    const txtBad = txt.length > 0 && !txt.includes("live content unavailable");
    if (imgBad) badImg++; if (txtBad) badTxt++; if (!imgBad && !txtBad && live) ok++;
    report.push({ sku: r.sku, url: r.buyerItemId ? `https://www.walmart.com/ip/${r.buyerItemId}` : null, imageKind: img.kind, imageOk: !imgBad, liveTitle: live?.title?.slice(0, 70), textIssues: txt });
    const flag = (imgBad ? "🖼BAD" : "🖼ok ") + " " + (txtBad ? "📝BAD" : "📝ok ");
    console.log(`${String(n).padStart(3)} ${flag}  ${r.sku.padEnd(13)} img:${String(img.kind).padEnd(9)} ${txtBad ? "| " + txt.join("; ") : ""}`);
    await sleep(300);
  }
  console.log(`\n=== SUMMARY: ${rows.length} live | image-bad ${badImg} | text-bad ${badTxt} | both-ok ${ok} ===`);
  writeFileSync("../audit-live-listings.json", JSON.stringify(report, null, 2));
  console.log("full report → ../audit-live-listings.json");
})().then(() => process.exit(0)).catch((e) => { console.error(e?.message); process.exit(1); });
