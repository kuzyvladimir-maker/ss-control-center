// PREVIEW rework runner: render ONLY the two rational-band recipes (48/54)
// that replaced the dead-zone 32/36. Same pipeline as _preview_5_listings.ts.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { writeFileSync } from "node:fs";

type Comp = { flavor: string; qty: number; boxes: string };

const RECIPES: Array<{
  slug: string; total: number; comps: Comp[];
  title: string; bullets: string[]; description: string;
}> = [
  {
    slug: "protein-blueberry-strawberry-grape-48",
    total: 48,
    comps: [
      { flavor: "Morning Protein Peanut Butter & Mixed Berry Spread", qty: 8, boxes: "1 × 8ct" },
      { flavor: "Peanut Butter & Blueberry", qty: 8, boxes: "1 × 8ct" },
      { flavor: "Peanut Butter & Strawberry Jam", qty: 16, boxes: "4 × 4ct" },
      { flavor: "Peanut Butter & Grape Jelly", qty: 16, boxes: "4 × 4ct" },
    ],
    title: "Smucker's Uncrustables Frozen Sandwich Variety Pack, Morning Protein Mixed Berry, Blueberry, Strawberry Jam and Grape Jelly, 48 Count",
    bullets: [
      "Includes 48 individually wrapped frozen sandwiches: 8 Morning Protein Peanut Butter & Mixed Berry Spread with 12g protein per sandwich, 8 Peanut Butter & Blueberry, 16 Peanut Butter & Strawberry Jam, and 16 Peanut Butter & Grape Jelly.",
      "Packed in original retail boxes: one 8-count box of Morning Protein Mixed Berry, one 8-count box of Blueberry, four 4-count boxes of Strawberry Jam, and four 4-count boxes of Grape Jelly.",
      "Each sandwich is sealed in its original individual wrapper on soft crustless bread.",
      "Keep frozen. Thaw at room temperature for 30 to 60 minutes before eating; once thawed, consume within 8 hours. Do not refreeze.",
      "An insulated foam cooler and frozen gel packs accompany the sandwiches as cold-pack components.",
    ],
    description:
      "This variety pack contains 48 individually wrapped Smucker's Uncrustables frozen sandwiches in four varieties: 8 Morning Protein Peanut Butter & Mixed Berry Spread (12g protein per sandwich), 8 Peanut Butter & Blueberry, 16 Peanut Butter & Strawberry Jam, and 16 Peanut Butter & Grape Jelly.\n\nThe sandwiches arrive in their original retail boxes: one 8-count box of each 8-count variety and four 4-count boxes of each 4-count flavor. Each sandwich is made on soft crustless bread and sealed in its own wrapper by the original manufacturer.\n\nKeep frozen. Thaw at room temperature for 30 to 60 minutes before eating and consume within 8 hours of thawing. An insulated foam cooler with frozen gel packs is included as packaging.",
  },
  {
    slug: "honey-berry-quartet-54",
    total: 54,
    comps: [
      { flavor: "Peanut Butter & Honey Spread", qty: 10, boxes: "1 × 10ct" },
      { flavor: "Peanut Butter & Mixed Berry Spread", qty: 16, boxes: "4 × 4ct" },
      { flavor: "Peanut Butter & Blackberry Spread", qty: 16, boxes: "4 × 4ct" },
      { flavor: "Whole Wheat Peanut Butter & Strawberry Jam", qty: 12, boxes: "3 × 4ct" },
    ],
    title: "Smucker's Uncrustables Frozen Sandwich Variety Pack, Honey, Mixed Berry, Blackberry and Whole Wheat Strawberry Jam, 54 Count",
    bullets: [
      "Includes 54 individually wrapped frozen sandwiches: 10 Peanut Butter & Honey Spread, 16 Peanut Butter & Mixed Berry Spread, 16 Peanut Butter & Blackberry Spread, and 12 Whole Wheat Peanut Butter & Strawberry Jam.",
      "Packed in original retail boxes: one 10-count box of Honey Spread, four 4-count boxes of Mixed Berry, four 4-count boxes of Blackberry, and three 4-count boxes of Whole Wheat Strawberry Jam.",
      "Each sandwich is sealed in its original individual wrapper on soft crustless bread.",
      "Keep frozen. Thaw at room temperature for 30 to 60 minutes before eating; once thawed, consume within 8 hours. Do not refreeze.",
      "An insulated foam cooler and frozen gel packs accompany the sandwiches as cold-pack components.",
    ],
    description:
      "This variety pack contains 54 individually wrapped Smucker's Uncrustables frozen sandwiches in four varieties: 10 Peanut Butter & Honey Spread, 16 Peanut Butter & Mixed Berry Spread, 16 Peanut Butter & Blackberry Spread, and 12 Whole Wheat Peanut Butter & Strawberry Jam.\n\nThe sandwiches arrive in their original retail boxes: one 10-count box of Honey Spread, four 4-count boxes of Mixed Berry, four 4-count boxes of Blackberry, and three 4-count boxes of Whole Wheat Strawberry Jam. Each sandwich is made on soft crustless bread and sealed in its own wrapper by the original manufacturer.\n\nKeep frozen. Thaw at room temperature for 30 to 60 minutes before eating and consume within 8 hours of thawing. An insulated foam cooler with frozen gel packs is included as packaging.",
  },
];

async function main() {
  const cm: any = await import("../src/lib/pricing/cost-model");
  const ip: any = await import("../src/lib/bundle-factory/image-pipeline");
  const ig: any = await import("../src/lib/bundle-factory/image-generation");
  const p: any = await import("../src/lib/prisma");
  const priceFor = cm.priceFor ?? cm.default?.priceFor;
  const buildImagePrompt = ip.buildImagePrompt ?? ip.default?.buildImagePrompt;
  const frozenAnchorUrls = ip.frozenAnchorUrls ?? ip.default?.frozenAnchorUrls;
  const generateMainImage = ig.generateMainImage ?? ig.default?.generateMainImage;
  const prisma = p.prisma ?? p.default?.prisma;

  const donors = await prisma.donorProduct.findMany({
    where: { OR: [{ brand: { contains: "Uncrustable" } }, { title: { contains: "Uncrustable" } }], needsReview: false },
    select: { id: true, title: true, brand: true, mainImageUrl: true, bestPrice: true },
  });
  const donorFor = (flavor: string) => {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const f = norm(flavor);
    return donors.find((d: any) => norm(d.title ?? "").includes(f))
      ?? donors.find((d: any) => f.split(" ").every((w: string) => norm(d.title ?? "").includes(w)));
  };

  const out: any[] = [];
  for (const r of RECIPES) {
    const model = priceFor(r.total);
    const composition = r.comps.map((c, i) => {
      const d = donorFor(c.flavor);
      return {
        research_pool_id: d?.id ?? `preview-${i}`,
        product_name: c.flavor,
        flavor: c.flavor,
        brand: "Uncrustables",
        qty: c.qty,
        unit_price_cents: Math.round((d?.bestPrice ?? 1) * 100),
        _donor_image: d?.mainImageUrl ?? null,
      };
    });
    const variant = {
      idx: 0, name: r.title, composition,
      cost_cents: composition.reduce((s: number, c: any) => s + c.qty * c.unit_price_cents, 0),
      suggested_price_cents: Math.round(model.suggested * 100),
      margin_cents: 0, margin_pct: 0,
    };
    let prompt = ""; let promptError: string | null = null;
    try {
      prompt = buildImagePrompt({
        brand: "Uncrustables", variant,
        composition_type: "MIXED_FLAVOR", category: "FROZEN",
        uncrustables_image_mode: "retail_boxes",
      });
    } catch (e: any) { promptError = String(e?.message ?? e); }
    const referenceUrls = [frozenAnchorUrls()[0], ...composition.map((c: any) => c._donor_image).filter(Boolean)].slice(0, 5);
    out.push({
      ...r, price: model.suggested, floor: model.floor, landed: model.landed, cooler: model.cooler,
      cost_cents: variant.cost_cents, prompt, promptError, referenceUrls,
      donor_images: composition.map((c: any) => ({ flavor: c.flavor, url: c._donor_image })),
      main_image_url: null,
    });
  }
  for (const l of out) {
    if (l.promptError) { console.log(`✗ ${l.slug}: prompt blocked — ${l.promptError.slice(0, 140)}`); continue; }
    try {
      const t0 = Date.now();
      const res = await generateMainImage({ prompt: l.prompt, r2_path_slug: `preview-${l.slug}`, reference_urls: l.referenceUrls });
      l.main_image_url = res?.image_url ?? null;
      console.log(`✓ ${l.slug}: MAIN за ${Math.round((Date.now() - t0) / 1000)}s → ${l.main_image_url}`);
    } catch (e: any) {
      l.main_error = String(e?.message ?? e).slice(0, 160);
      console.log(`✗ ${l.slug}: ${l.main_error}`);
    }
  }
  writeFileSync("/private/tmp/claude-501/-Users-vladimirkuznetsov-SS-Command-Center/1dbdc77d-9c20-49be-9e0d-c48b604008f6/scratchpad/preview-listings-2.json", JSON.stringify(out, null, 1));
  console.log(`готово: ${out.filter((l) => l.main_image_url).length}/2`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
