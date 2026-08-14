// Какая художка нужна, чтобы открыть остальные одновкусовые вариации и
// восстановление исторических листингов. Реестр подлинности хранит ровно
// ОДНУ фасовку на вкус — это и есть настоящий потолок, а не код.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { writeFileSync } from "node:fs";
import { UNCRUSTABLES_FLAVORS, rationalBandFor, RENDER_LIMITS } from "../src/lib/bundle-factory/uncrustables-box-planner";
import { resolveMergedUncrustablesPackageArt } from "../src/lib/bundle-factory/audit/uncrustables-authenticity-merged";
import { resolveUncrustablesDonor } from "../src/lib/bundle-factory/uncrustables-donor-resolver";

const variantsFor = (size: number) => {
  const out: number[] = [];
  for (let n = 1; n <= RENDER_LIMITS.maxCartons; n++) {
    if (Math.ceil(n / RENDER_LIMITS.maxCartonsPerRow) > RENDER_LIMITS.maxRows) break;
    const t = n * size;
    if (t >= 24 && t <= 135 && rationalBandFor(t)) out.push(t);
  }
  return out;
};

async function main() {
  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const sr: any = await import("../src/lib/bundle-factory/uncrustables-studio-run");
  const donors = await sr.loadUncrustablesDonorPool();

  const gaps: any[] = [];
  for (const flavor of Object.keys(UNCRUSTABLES_FLAVORS)) {
    const art = resolveMergedUncrustablesPackageArt(flavor, "retail-carton");
    const have = art?.retail_pack_size ?? null;
    const haveTotals = new Set(have ? variantsFor(have) : []);
    for (const size of [4, 8, 10, 15]) {
      if (size === have) continue;
      const d = resolveUncrustablesDonor(donors, flavor, size);
      if (!d?.mainImageUrl) continue;
      const re = new RegExp(`(?:^|[^0-9])${size}\\s*(?:ct\\b|count\\b)`, "i");
      if (!re.test(d.title ?? "")) continue;   // донор именно этой фасовки
      const unlocked = variantsFor(size).filter((t) => !haveTotals.has(t));
      if (!unlocked.length) continue;
      gaps.push({ flavor, titleName: UNCRUSTABLES_FLAVORS[flavor].titleName, size,
        have, unlocked, donorTitle: d.title, image: d.mainImageUrl });
    }
  }
  gaps.sort((a, b) => b.unlocked.length - a.unlocked.length);
  writeFileSync("data/batch300/art-gap.json", JSON.stringify(gaps, null, 1));
  const totalNew = gaps.reduce((s, g) => s + g.unlocked.length, 0);
  console.log(`фото к утверждению: ${gaps.length} | открывают ещё ${totalNew} одновкусовых\n`);
  for (const g of gaps) {
    console.log(`${g.titleName.padEnd(26)} ${String(g.size).padStart(2)}ct (сейчас ${g.have}ct) → +${g.unlocked.length}: ${g.unlocked.join(", ")}`);
  }
  await prisma.$disconnect();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
