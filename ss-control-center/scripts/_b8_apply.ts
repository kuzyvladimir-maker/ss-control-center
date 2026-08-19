import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { readFileSync } from "node:fs";
import { UNCRUSTABLES_DONOR_QUALIFIERS } from "../src/lib/bundle-factory/uncrustables-donor-resolver";
async function main() {
  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const found: any[] = JSON.parse(readFileSync("data/batch300/upc-manufacturer.json", "utf8"));
  const rows = await prisma.donorProduct.findMany({
    where: { OR: [{ title: { contains: "Uncrustable" } }, { productLine: "Uncrustables" }] },
    select: { id: true, title: true, upc: true, gtin: true },
  });
  let n = 0;
  for (const f of found) {
    const fl = f.flavor.toLowerCase();
    const words = fl.replace(/[^a-z0-9]+/g, " ").split(" ").filter((x: string) => x.length >= 3);
    const ban = UNCRUSTABLES_DONOR_QUALIFIERS.filter((q) => !fl.includes(q));
    for (const r of rows) {
      if (r.upc || r.gtin) continue;
      const t = (r.title ?? "").toLowerCase();
      const m = t.match(/(\d+)\s*(?:ct\b|count\b|pk\b|pack\b)/i);
      if (!m || Number(m[1]) !== f.size) continue;
      if (!words.every((w: string) => t.includes(w))) continue;
      if (ban.some((q) => t.includes(q))) continue;
      await prisma.donorProduct.update({ where: { id: r.id }, data: { upc: f.upc } });
      console.log(`  ✓ ${f.upc}  ${(r.title ?? "").slice(0, 66)}`);
      n++;
    }
  }
  console.log(`проставлено: ${n}`);
  await prisma.$disconnect(); process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
