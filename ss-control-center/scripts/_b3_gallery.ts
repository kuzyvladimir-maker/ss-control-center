// Галерея розничных коробок, ждущих owner-ревью. Реестр подлинности требует
// human-visual review владельцем; подписать это за него нельзя. Страница
// собирает ровно те пары «вкус × фасовка», что есть в каталоге с фото, но ещё
// не утверждены в реестре.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UNCRUSTABLES_FLAVORS } from "../src/lib/bundle-factory/uncrustables-box-planner";
import { resolveMergedUncrustablesPackageArt } from "../src/lib/bundle-factory/audit/uncrustables-authenticity-merged";
import { resolveUncrustablesDonor } from "../src/lib/bundle-factory/uncrustables-donor-resolver";

const SIZES = [4, 8, 10, 15, 18, 24];
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function main() {
  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const donors = await prisma.donorProduct.findMany({
    where: { OR: [{ brand: { contains: "Uncrustable" } }, { title: { contains: "Uncrustable" } }, { productLine: "Uncrustables" }] },
    select: { id: true, title: true, brand: true, productLine: true, flavor: true,
      mainImageUrl: true, bestPrice: true, bestRetailer: true, offers: { select: { price: true, packSizeSeen: true, pricePerUnit: true } } },
  });

  const pending: any[] = [];
  for (const [flavor, meta] of Object.entries(UNCRUSTABLES_FLAVORS)) {
    for (const size of SIZES) {
      if (resolveMergedUncrustablesPackageArt(flavor, "retail-carton", size)) continue; // уже утверждено
      const d = resolveUncrustablesDonor(donors, flavor, size);
      if (!d?.mainImageUrl) continue;
      const re = new RegExp(`(?:^|[^0-9])${size}\\s*(?:ct\\b|count\\b|pk\\b|pack\\b)`, "i");
      if (!re.test(d.title ?? "")) continue;
      const unit = d.bestPrice ? d.bestPrice / size : null;
      pending.push({ flavor, titleName: meta.titleName, size, image: d.mainImageUrl,
        donorTitle: d.title, retailer: d.bestRetailer, unit });
    }
  }
  pending.sort((a, b) => a.titleName.localeCompare(b.titleName) || a.size - b.size);

  const cards = pending.map((g) => `<figure>
  <img src="${esc(g.image)}" alt="${esc(g.donorTitle ?? "")}" loading="lazy">
  <figcaption><b>${esc(g.titleName)} · коробка на ${g.size}</b>
  <span>${esc(g.donorTitle ?? "")}</span>
  <span>${g.retailer ?? "—"}${g.unit ? ` · $${g.unit.toFixed(2)} за штуку` : ""}</span></figcaption></figure>`).join("\n");

  const html = `<!doctype html><meta charset="utf-8">
<title>Коробки на утверждение — ${pending.length}</title>
<style>
:root{--bg:#F6F6F3;--card:#FFF;--ink:#17191D;--dim:#6B7076;--line:#E4E4DF;--ok:#3FA46A}
@media (prefers-color-scheme:dark){:root{--bg:#141618;--card:#1D2023;--ink:#ECEDEE;--dim:#9BA1A6;--line:#2A2E32}}
*{box-sizing:border-box}
body{font:16px/1.55 -apple-system,system-ui,sans-serif;margin:0;background:var(--bg);color:var(--ink)}
.wrap{max-width:1000px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:30px;margin:0 0 6px;letter-spacing:-.02em}
.sub{color:var(--dim);margin:0 0 22px;font-size:15px;max-width:62ch}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px}
.gal{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:20px}
.gal figure{margin:0}
.gal img{width:100%;aspect-ratio:1;object-fit:contain;background:#fff;border:1px solid var(--line);border-radius:10px}
.gal figcaption{font-size:12px;line-height:1.5;margin-top:8px;color:var(--dim)}
.gal figcaption b{display:block;color:var(--ink);font-size:13.5px;margin-bottom:2px}
.gal figcaption span{display:block}
.ask{margin:0 0 20px;padding:14px 16px;border-left:3px solid var(--ok);background:var(--card);border-radius:0 10px 10px 0;font-size:15px}
</style>
<div class="wrap">
<h1>Коробки на утверждение — ${pending.length}</h1>
<p class="sub">Движок рисует только ту коробку, которую вы лично отсмотрели: реестр подлинности
требует человеческого просмотра владельцем, и подписать это за вас нельзя.</p>
<p class="ask">Проверьте по каждой карточке три вещи: это настоящая упаковка Uncrustables,
это тот вкус, и на коробке напечатан именно этот счёт. Скажите слово в чат — внесу в реестр,
и все раскладки с этими коробками станут собираемыми.</p>
<div class="card"><div class="gal">${cards}</div></div>
</div>`;
  const out = join(homedir(), "Desktop", "Коробки-на-утверждение.html");
  writeFileSync(out, html);
  console.log(`${pending.length} коробок ждут ревью → ${out}`);
  for (const g of pending) console.log(`  ${g.titleName.padEnd(24)} ${String(g.size).padStart(2)}шт  ${g.retailer ?? "—"}`);
  await prisma.$disconnect(); process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
