// UPC принадлежит ТОВАРУ, а не магазину: одна и та же коробка в Target и в
// Walmart несёт один штрихкод. Переносим его внутри каталога между сетями для
// совпадающей пары «вкус × фасовка». Стейджинг требует UPC производителя, и
// без него свежедобытые доноры (BJ's, Sam's, Publix) роняли публикацию.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { UNCRUSTABLES_DONOR_QUALIFIERS } from "../src/lib/bundle-factory/uncrustables-donor-resolver";

const sizeOf = (t: string): number | null => {
  const m = t.match(/(\d+)\s*(?:ct\b|count\b|pk\b|pack\b)/i);
  return m ? Number(m[1]) : null;
};
const key = (t: string): string | null => {
  const low = t.toLowerCase();
  const size = sizeOf(t);
  if (!size) return null;
  const quals = UNCRUSTABLES_DONOR_QUALIFIERS.filter((q) => low.includes(q)).sort();
  if (!quals.length) return null;
  return `${quals.join("+")}|${size}`;
};

async function main() {
  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const rows = await prisma.donorProduct.findMany({
    where: { OR: [{ title: { contains: "Uncrustable" } }, { productLine: "Uncrustables" }] },
    select: { id: true, title: true, upc: true, gtin: true, bestRetailer: true },
  });
  const donor = new Map<string, string>();
  for (const r of rows) {
    const k = key(r.title ?? ""); if (!k) continue;
    const code = r.upc || r.gtin;
    if (code && !donor.has(k)) donor.set(k, code);
  }
  let filled = 0; const missing = new Map<string, string>();
  for (const r of rows) {
    if (r.upc || r.gtin) continue;
    const k = key(r.title ?? ""); if (!k) continue;
    const code = donor.get(k);
    if (!code) { missing.set(k, r.title ?? ""); continue; }
    await prisma.donorProduct.update({ where: { id: r.id }, data: { upc: code } });
    console.log(`  ✓ ${(r.bestRetailer ?? "—").padEnd(9)} ${code}  ${(r.title ?? "").slice(0, 62)}`);
    filled++;
  }
  console.log(`\nпроставлено UPC: ${filled} | пар без UPC во всём каталоге: ${missing.size}`);
  for (const [k, t] of missing) console.log(`  ✗ ${k.padEnd(34)} ${t.slice(0, 60)}`);
  await prisma.$disconnect(); process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
