// Fix the 6 "24-in-title / 12-in-recipe" Uncrustables listings: their recipe
// dropped the second flavor (all missing "Peanut Butter & Mixed Berry"). Add a
// Mixed Berry component (qty 12), cloned from the KNOWN-GOOD component in
// B0H85P9F3R so the structure/donor are valid. Recipe-only; regen + republish
// happen in later steps.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });

const GOOD_DRAFT = "cmrbhyood006g04ju4cqerjhn"; // B0H85P9F3R (has real Mixed Berry)
const DRAFTS = [
  "cmrbhrmu1002s04jutzzxgtdx", // PJ-ASDX-E8LW  B0H85MGP35  Honey
  "cmrbh7yra001504l7xfclfn12", // KD-AS12-8HZ3  B0H845JBM6  Strawberry Jam Protein
  "cmrbhl6u9001e04jug3r1qet2", // TY-AST2-JE9P  B0H84WQRXB  Raspberry
  "cmrbhth8n004004ju7r8tgchz", // VH-ASHZ-TJEE  B0H856VWD6  WW Strawberry Jam
  "cmrbhwwn4005404ju6wq4lc5w", // ZE-AS5W-FKH3  B0H8531B8B  Peanut Butter
  "cmrbhy9sv006404ju35bjwlok", // VA-ASOK-QJCA  B0H85RZDX5  Apple Cinnamon Jelly
];
const APPLY = process.env.BF_DRY !== "1";

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const g = await prisma.bundleDraft.findUnique({ where: { id: GOOD_DRAFT }, select: { variation_matrix: { select: { selected_variant_idx: true, variants_json: true } } } });
  const gcomp = JSON.parse(g!.variation_matrix!.variants_json)[g!.variation_matrix!.selected_variant_idx!].composition;
  const mbTemplate = gcomp.find((c: any) => /mixed berry/i.test(c.product_name));
  if (!mbTemplate) throw new Error("no Mixed Berry template in good draft");
  const mixedBerry = { ...mbTemplate, qty: 12 };
  console.log("Mixed Berry component to add:", JSON.stringify(mixedBerry), "\n");

  for (const id of DRAFTS) {
    const d = await prisma.bundleDraft.findUnique({ where: { id }, select: { draft_name: true, variation_matrix: { select: { id: true, selected_variant_idx: true, variants_json: true } } } });
    if (!d?.variation_matrix || d.variation_matrix.selected_variant_idx == null) { console.log("skip (no variant):", id); continue; }
    const variants = JSON.parse(d.variation_matrix.variants_json);
    const idx = d.variation_matrix.selected_variant_idx;
    const comp = variants[idx].composition as any[];
    if (comp.some((c) => /mixed berry/i.test(c.product_name))) { console.log("already has Mixed Berry, skip:", d.draft_name?.slice(0, 40)); continue; }
    const before = comp.reduce((a, c) => a + c.qty, 0);
    comp.push({ ...mixedBerry });
    variants[idx].composition = comp;
    const after = comp.reduce((a, c) => a + c.qty, 0);
    console.log(`${id}: ${d.draft_name?.slice(0, 45)}  total ${before} → ${after}  (${comp.map((c) => c.product_name.replace(/smucker'?s |uncrustables |frozen /gi, "").slice(0, 20)).join(" + ")})`);
    if (APPLY) await prisma.variationMatrix.update({ where: { id: d.variation_matrix.id }, data: { variants_json: JSON.stringify(variants) } });
  }
  console.log(APPLY ? "\napplied." : "\nDRY — not saved.");
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
