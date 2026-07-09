// A/B: does sending a DOWNSCALED image to vision change the QC verdict?
// Run twice with different SS_VISION_MAX_PX (0 = original bytes, 1536 = new default),
// then diff the verdicts. Ground truth comes from _ab_cases.json (expect PASS/FAIL).
// Retries on transient "error" reasons so contention with the drip doesn't pollute results.
import { readFileSync, writeFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
process.env.SS_VISION_PROVIDER = "auto";
process.env.SS_VISION_MAX_PX = process.argv[3] ?? "1536"; // must be set BEFORE importing vision.ts

const label = process.argv[2] || "run";
const isErr = (s: string) => /error/i.test(s || "");

async function main() {
  const vision = await import("./src/lib/sourcing/vision.ts");
  const cases: any[] = JSON.parse(readFileSync("_ab_cases.json", "utf8"));
  console.log(`[${label}] SS_VISION_MAX_PX=${process.env.SS_VISION_MAX_PX} · ${cases.length} кейсов`);
  const out: any[] = [];
  for (const c of cases) {
    let v: any = null;
    for (let a = 0; a < 4; a++) {
      v = await vision.qualifyTiledMain(c.url, c.title, c.qty);
      if (!isErr(v.reason)) break;
      await new Promise((r) => setTimeout(r, 2500 * (a + 1)));
    }
    const verdict = isErr(v.reason) ? "ERR" : (v.pass ? "PASS" : "FAIL");
    const ok = verdict === c.expect;
    out.push({ sku: c.sku, qty: c.qty, expect: c.expect, verdict, ok, reason: (v.reason || "").slice(0, 90) });
    console.log(`  ${ok ? "✓" : "✗"} ${c.sku} q${c.qty}  ожидали ${c.expect} → получили ${verdict}`);
  }
  writeFileSync(`_ab_${label}.json`, JSON.stringify(out, null, 1));
  const agree = out.filter((x) => x.ok).length;
  console.log(`[${label}] совпало с истиной: ${agree}/${out.length}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
