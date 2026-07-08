// PROMO-BANNER SWEEP over every REBUILT_OK tile before publishing. The Sweet Hawaiian
// case showed the qual gate passes donors that carry marketing ribbons/size flags
// baked into the image ("SLIDERS SWEET HAWAIIAN 15oz") — repeated ×N they look spammy
// and violate Walmart's product-only main-image policy. One cheap vision question per
// rebuilt image (Gemini/Codex lanes, Claude reserve): clean → publish pile; bannered →
// re-source pile. Incremental: skips already-checked SKUs (_bannercheck_state.json).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
process.env.SS_VISION_PROVIDER = "auto";
const CONC = 3;
const STATE = "_bannercheck_state.json";
async function main() {
  const vision = await import("./src/lib/sourcing/vision.ts");
  const pipe = JSON.parse(readFileSync("_pipeline_state.json", "utf8"));
  const state: Record<string, any> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
  // re-ask rows whose lane response lacked the verdict fields ("no verdict")
  const todo = Object.values(pipe).filter((x: any) => x.status === "REBUILT_OK" && x.newUrl && (!state[x.sku] || state[x.sku].what === "no verdict"));
  console.log(`banner-checking ${todo.length} rebuilt tiles (${Object.keys(state).length} already done)\n`);
  const prompt = `This is a marketplace MAIN image: one product package tiled several times on white.
Answer STRICT JSON: {"clean": true|false, "what": "<=10 words>"}.
"clean" = the image shows ONLY the physical product package(s). Answer FALSE if there are promotional/marketing graphics that are NOT part of the physical package itself: ribbons/flags/banners with product name or size (e.g. a color ribbon saying "SLIDERS 15oz"), size/count callout badges, arrows, "NEW!" flashes, watermarks, retailer logos, or any overlay text floating outside the package. Printed text ON the physical package itself is fine.`;
  let done = 0;
  const check = async (x: any) => {
    // a verdict is only valid when the "clean" field is an actual boolean (some lane
    // responses parse but lack the fields — those must count as NULL, not "bannered")
    let j: any = null;
    for (let a = 0; a < 3; a++) {
      j = await vision.askVisionJson([x.newUrl], prompt);
      const c = j?.clean;
      if (c === true || c === "true" || c === false || c === "false") break;
      j = null; await new Promise((r) => setTimeout(r, 1500 * (a + 1)));
    }
    const c = j?.clean;
    state[x.sku] = { sku: x.sku, clean: c === true || c === "true" ? true : c === false || c === "false" ? false : null, what: j?.what || "no verdict", url: x.newUrl };
    writeFileSync(STATE, JSON.stringify(state, null, 1));
    done++;
    if (!state[x.sku].clean) console.log(`  [${done}/${todo.length}] ${x.sku} → ${state[x.sku].clean === false ? "BANNERED: " + state[x.sku].what : "NO VERDICT"}`);
    else if (done % 25 === 0) console.log(`  [${done}/${todo.length}] …`);
  };
  for (let i = 0; i < todo.length; i += CONC) await Promise.all(todo.slice(i, i + CONC).map(check));
  const all = Object.values(state);
  const clean = all.filter((x: any) => x.clean === true).length;
  const bad = all.filter((x: any) => x.clean === false);
  const unk = all.filter((x: any) => x.clean === null).length;
  console.log(`\n=== BANNER CHECK: clean ${clean} · bannered ${bad.length} · no-verdict ${unk} ===`);
  for (const b of bad) console.log(`  ${b.sku}: ${b.what}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
