import { readFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
process.env.SS_VISION_PROVIDER = "auto";
async function main() {
  const t0 = Date.now();
  const vision = await import("./src/lib/sourcing/vision.ts");
  const url = "https://target.scene7.com/is/image/Target/GUEST_e7fd7173-3e5f-4dfc-a197-2449ce0793e6";
  console.log("calling qualifyDonorFront...");
  const r = await vision.qualifyDonorFront(url, "Lay's Barbecue Party Size 12.5oz");
  console.log("took", ((Date.now() - t0) / 1000).toFixed(1) + "s →", JSON.stringify(r).slice(0, 130));
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.message); process.exit(1); });
