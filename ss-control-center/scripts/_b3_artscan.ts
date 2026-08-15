// Полная инвентаризация донорских фото: что ещё МОЖНО подать владельцу на
// один разбор, чтобы больше не возвращаться. Отдельно коробки, отдельно
// индивидуальные упаковки (россыпь даёт ЛЮБОЙ каунт — 25, 26, 27, 29).
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { UNCRUSTABLES_FLAVORS } from "../src/lib/bundle-factory/uncrustables-box-planner";
import { resolveMergedUncrustablesPackageArt } from "../src/lib/bundle-factory/audit/uncrustables-authenticity-merged";

async function main() {
  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const donors = await prisma.donorProduct.findMany({
    where: { OR: [{ brand: { contains: "Uncrustable" } }, { title: { contains: "Uncrustable" } }] },
    select: { title: true, mainImageUrl: true },
  });
  console.log(`донорских карточек Uncrustables с фото: ${donors.filter((d: any) => d.mainImageUrl).length} из ${donors.length}\n`);
  console.log("вкус                                 коробка(утв)  упаковка(утв)  фасовки с фото в каталоге");
  for (const flavor of Object.keys(UNCRUSTABLES_FLAVORS)) {
    const carton = resolveMergedUncrustablesPackageArt(flavor, "retail-carton");
    const wrap = resolveMergedUncrustablesPackageArt(flavor, "individual-wrapper");
    const words = flavor.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length >= 3);
    const sizes = new Set<number>();
    for (const d of donors) {
      if (!d.mainImageUrl) continue;
      const t = (d.title ?? "").toLowerCase();
      if (!words.every((w) => t.includes(w))) continue;
      const m = t.match(/(\d+)\s*(?:ct|count)/);
      if (m) sizes.add(Number(m[1]));
    }
    console.log(
      `${UNCRUSTABLES_FLAVORS[flavor].titleName.padEnd(26)} ${String(carton?.retail_pack_size ?? "—").padStart(9)}  ${(wrap ? "есть" : "—").padStart(11)}  ${[...sizes].sort((a, b) => a - b).join(", ") || "—"}`,
    );
  }
  await prisma.$disconnect(); process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
