// Минт расширения реестра подлинности v3: пары «вкус × фасовка», утверждённые
// владельцем 2026-08-15 по галерее «Коробки-на-утверждение».
// Каждое фото скачивается в аудит-папку и пинится своим SHA-256 — реестр
// требует reviewed-artifact с проверяемым байтовым доказательством.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { UNCRUSTABLES_FLAVORS } from "../src/lib/bundle-factory/uncrustables-box-planner";
import { resolveMergedUncrustablesPackageArt } from "../src/lib/bundle-factory/audit/uncrustables-authenticity-merged";
import { fetchImageBuffer } from "../src/lib/walmart/multipack/composite";

const DIR = "data/audits/uncrustables-owner-art-review-20260815";
const OUT = "src/lib/bundle-factory/audit/data/uncrustables-authenticity-registry-v3-extension.json";

async function main() {
  mkdirSync(DIR, { recursive: true });
  const screened: any[] = JSON.parse(readFileSync("data/batch300/art-screen.json", "utf8"));
  const approved = screened.filter((r) => r.winner);
  const byFlavor = new Map<string, any>();

  for (const r of approved) {
    const base = resolveMergedUncrustablesPackageArt(r.flavor, "retail-carton");
    if (!base) { console.log(`✗ ${r.flavor}: не удалось определить flavor_id`); continue; }
    const buf = await fetchImageBuffer(r.winner.url);
    const sha = createHash("sha256").update(buf).digest("hex");
    const slug = `${base.flavor_id}-${r.size}ct`;
    const file = `${DIR}/${slug}.jpg`;
    writeFileSync(file, buf);
    const entry = byFlavor.get(base.flavor_id) ?? { flavor_id: base.flavor_id, art: [] };
    entry.art.push({
      art_id: `${base.flavor_id}-carton-us-${r.size}ct-2026-v3`,
      pack_mode: "retail-carton",
      retail_pack_size: r.size,
      market: "US",
      brand_marks: ["Smucker's", "Uncrustables"],
      evidence: [{ kind: "reviewed-artifact", locator: file, sha256: sha }],
    });
    byFlavor.set(base.flavor_id, entry);
    console.log(`  ✓ ${UNCRUSTABLES_FLAVORS[r.flavor].titleName.padEnd(22)} ${String(r.size).padStart(2)}ct  ${sha.slice(0, 12)}…`);
  }

  const ext = {
    schema_version: "uncrustables-authenticity-registry-extension/v3",
    immutable: true,
    registry_id: "uncrustables-us-reviewed-package-art-v3-extension",
    reviewed_at: "2026-08-15",
    reviewed_by: "owner",
    review_method: "human-visual-with-source-evidence",
    review_note:
      "Owner reviewed the machine-screened gallery (Коробки-на-утверждение.html) " +
      "on 2026-08-15 and confirmed every card: genuine Uncrustables packaging, " +
      "correct flavor, correct printed count. Candidates carrying a retailer " +
      "overlay banner or a loose sandwich beside the carton were rejected by " +
      "screenPackageArt before reaching the owner.",
    flavors: [...byFlavor.values()],
  };
  writeFileSync(OUT, JSON.stringify(ext, null, 2) + "\n");
  console.log(`\nвкусов в расширении: ${ext.flavors.length}, художек: ${ext.flavors.reduce((s: number, f: any) => s + f.art.length, 0)} → ${OUT}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
