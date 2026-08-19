// Полная карта пробелов: по КАЖДОМУ вкусу — какие фасовки реально существуют
// (есть донорская карточка), что из них утверждено в реестре и у чего есть UPC.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { UNCRUSTABLES_FLAVORS } from "../src/lib/bundle-factory/uncrustables-box-planner";
import { resolveMergedUncrustablesPackageArt } from "../src/lib/bundle-factory/audit/uncrustables-authenticity-merged";
import { UNCRUSTABLES_DONOR_QUALIFIERS } from "../src/lib/bundle-factory/uncrustables-donor-resolver";

const SIZES = [4, 8, 10, 15, 18, 24];
async function main() {
  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const donors = await prisma.donorProduct.findMany({
    where: { OR: [{ title: { contains: "Uncrustable" } }, { productLine: "Uncrustables" }] },
    select: { title: true, upc: true, gtin: true, mainImageUrl: true },
  });
  const has = new Map<string, { img: boolean; upc: boolean }>();
  for (const d of donors) {
    const t = (d.title ?? "").toLowerCase();
    const m = t.match(/(\d+)\s*(?:ct\b|count\b|pk\b|pack\b)/i); if (!m) continue;
    const size = Number(m[1]); if (!SIZES.includes(size)) continue;
    for (const f of Object.keys(UNCRUSTABLES_FLAVORS)) {
      const fl = f.toLowerCase();
      const words = fl.replace(/[^a-z0-9]+/g, " ").split(" ").filter((x) => x.length >= 3);
      if (!words.every((x) => t.includes(x))) continue;
      const ban = UNCRUSTABLES_DONOR_QUALIFIERS.filter((q) => !fl.includes(q));
      if (ban.some((q) => t.includes(q))) continue;
      const k = `${f}|${size}`;
      const cur = has.get(k) ?? { img: false, upc: false };
      if (d.mainImageUrl) cur.img = true;
      if (d.upc || d.gtin) cur.upc = true;
      has.set(k, cur);
    }
  }
  console.log("вкус                        " + SIZES.map((s) => String(s).padStart(6)).join(""));
  console.log("  ✓ готово · A нет художки · U нет штрихкода · · нет товара\n");
  const needArt: string[] = []; const needUpc: string[] = [];
  for (const [flavor, meta] of Object.entries(UNCRUSTABLES_FLAVORS)) {
    let line = meta.titleName.padEnd(28);
    for (const s of SIZES) {
      const h = has.get(`${flavor}|${s}`);
      const art = !!resolveMergedUncrustablesPackageArt(flavor, "retail-carton", s);
      if (!h) { line += "   ·  "; continue; }
      if (!art) { line += "   A  "; needArt.push(`${meta.titleName} ${s}`); continue; }
      if (!h.upc) { line += "   U  "; needUpc.push(`${meta.titleName} ${s}`); continue; }
      line += "   ✓  ";
    }
    console.log(line);
  }
  console.log(`\nнужна художка (${needArt.length}): ${needArt.join(" · ") || "—"}`);
  console.log(`нужен штрихкод (${needUpc.length}): ${needUpc.join(" · ") || "—"}`);
  await prisma.$disconnect(); process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
