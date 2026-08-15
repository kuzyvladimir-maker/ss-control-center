// Обход клубных/локальных сетей по КАЖДОМУ вкусу и занесение в справочный
// донорский каталог. Владелец 2026-08-15: «мне важно, чтобы в нашем каталоге
// просто были на все эти СКЮ, была полная информация. Все картинки были самих
// розничных упаковок».
//
// Урок 2026-08-15: запрос «uncrustables» по BJ's возвращает промо-сетку (бананы,
// мандарины) — сеть отдаёт дефолтную выдачу. Спрашивать надо ПОВКУСОВО.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { openClawSearch, type OpenClawRetailer } from "../src/lib/sourcing/openclaw-fetch";

const FLAVOR_QUERIES = [
  "Smucker's Uncrustables grape jelly", "Smucker's Uncrustables strawberry jam",
  "Smucker's Uncrustables raspberry", "Smucker's Uncrustables honey",
  "Smucker's Uncrustables chocolate hazelnut", "Smucker's Uncrustables peanut butter only",
  "Smucker's Uncrustables blackberry", "Smucker's Uncrustables mixed berry",
  "Smucker's Uncrustables blueberry protein", "Smucker's Uncrustables whole wheat",
  "uncrustables mega pack", "uncrustables 18 ct", "uncrustables reduced sugar",
];

async function main() {
  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const found = new Map<string, any>();

  for (const retailer of ["bjs", "publix"] as OpenClawRetailer[]) {
    for (const q of FLAVOR_QUERIES) {
      try {
        const res = await openClawSearch(retailer, q);
        for (const o of res.offers) {
          if (!/uncrustable/i.test(o.title ?? "")) continue;
          const url = (o.productUrl ?? "").replace(/^https:\/\/www\.bjs\.com(?=https:)/, "");
          const k = `${retailer}|${o.retailerProductId}`;
          if (!found.has(k)) found.set(k, { ...o, productUrl: url });
        }
      } catch (e: any) { console.log(`  ✗ ${retailer} «${q}»: ${String(e?.message).slice(0, 70)}`); }
      await new Promise((r) => setTimeout(r, 800));
    }
    console.log(`${retailer}: накоплено ${found.size}`);
  }

  // разбор фасовки: «24 ct.», «18 ct./2.8 oz», «, 4 Count»
  const sizeOf = (t: string): number | null => {
    const m = t.match(/(\d+)\s*(?:ct\b|count\b|pk\b|pack\b)/i);
    return m ? Number(m[1]) : null;
  };
  let ok = 0, skipped = 0;
  for (const o of found.values()) {
    const size = sizeOf(o.title);
    if (!size || ![4, 8, 10, 15, 18, 24].includes(size)) { skipped++; continue; }
    const identityKey = `uncrustables|${o.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 90)}|${size}`;
    const img = o.imageUrls?.[0] ?? null;
    await prisma.donorProduct.upsert({
      where: { identityKey },
      create: {
        identityKey, brand: "Smucker's", productLine: "Uncrustables",
        title: o.title, containerType: "box", size: `${size} count`,
        unitMeasure: "count", unitAmount: size, category: "Frozen",
        mainImageUrl: img, imageUrls: JSON.stringify(o.imageUrls ?? []),
        description: o.description ?? null,
        bullets: JSON.stringify(o.keyFeatures ?? []),
        bestPrice: o.price ?? null, bestRetailer: o.retailer,
        pricePerMeasure: o.price ? o.price / size : null,
        identityStatus: "candidate", needsReview: !img,
      },
      update: {
        title: o.title, mainImageUrl: img ?? undefined,
        imageUrls: JSON.stringify(o.imageUrls ?? []),
        bestPrice: o.price ?? undefined, bestRetailer: o.retailer,
        pricePerMeasure: o.price ? o.price / size : undefined,
        needsReview: !img,
      },
    });
    console.log(`  ✓ ${String(size).padStart(2)}шт $${String(o.price).padStart(6)} ${o.retailer.padEnd(7)} ${o.title.slice(0, 68)}`);
    ok++;
  }
  console.log(`\nзанесено/обновлено: ${ok} | пропущено без фасовки: ${skipped}`);
  await prisma.$disconnect(); process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
