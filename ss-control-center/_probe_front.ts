import { readFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
process.env.SS_VISION_PROVIDER = "auto";
async function main() {
  const vision = await import("./src/lib/sourcing/vision.ts");
  const main = "https://target.scene7.com/is/image/Target/GUEST_e7fd7173-3e5f-4dfc-a197-2449ce0793e6";
  const title = "Lay's Barbecue Flavor Party Size Potato Chips - 12.5oz";
  console.log("classifyProductPhoto(main):");
  console.log("  ", JSON.stringify(await (vision as any).classifyProductPhoto(main)));
  console.log("qualifyDonorFront(main, title):");
  console.log("  ", JSON.stringify(await vision.qualifyDonorFront(main, title)));
  console.log("pickBestFront([main], {preferUrl:main}) — NO title (donor-first shortcut):");
  console.log("  ", JSON.stringify(await vision.pickBestFront([main], { preferUrl: main })));
  console.log("pickBestFront([main], {listingTitle:title}) — variant path:");
  console.log("  ", JSON.stringify(await vision.pickBestFront([main], { listingTitle: title, preferUrl: main })));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
