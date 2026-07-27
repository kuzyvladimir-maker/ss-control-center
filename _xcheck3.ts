// Cross-check 3 Codex "FAIL" verdicts on paid Sonnet — is Codex over-rejecting, or
// are these mains genuinely the wrong product?
import { readFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
process.env.SS_VISION_PROVIDER = "anthropic"; // force paid Sonnet
async function main() {
  const { createClient } = await import("@libsql/client");
  const vision = await import("./src/lib/sourcing/vision.ts");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const skus = ["FaisalX-1269", "FaisalX-1191", "FaisalX-1171"];
  for (const sku of skus) {
    const r = (await db.execute({ sql: `SELECT packCount, mainImageUrl, newTitle FROM WalmartListingRemediation WHERE sku=? AND mainImageUrl LIKE '%f50%' ORDER BY runAt DESC LIMIT 1`, args: [sku] })).rows[0] as any;
    if (!r) { console.log(`${sku}: no row`); continue; }
    const title = String(r.newTitle || "").replace(/\s*—.*$/, "").trim();
    const v = await vision.qualifyTiledMain(r.mainImageUrl, title, Number(r.packCount) || 0);
    console.log(`${sku} (${title.slice(0,40)}) Sonnet: ${v.pass ? "PASS" : "FAIL"} [id${+v.identity} cell${+v.eachCellSingle}] ${v.reason}`);
  }
  db.close();
}
main().catch(e => { console.error(e); process.exit(1); });
