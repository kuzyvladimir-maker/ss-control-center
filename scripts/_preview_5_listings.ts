// PREVIEW-ONLY (owner 2026-07-22): compose 5 NEW box-composable Uncrustables
// listings end-to-end — recipe from real catalog donors, canonical Layer-A
// price, the REAL image-pipeline prompt + reviewed-art plan, and a REAL MAIN
// render via the production generator (Codex worker + R2). NOTHING touches
// Amazon or the DB: no drafts, no SKUs, no publishes. Output feeds the owner's
// preview gallery.
//
// The 5 recipes deliberately mix REAL carton sizes (4/8/10) across flavors —
// the owner's matrix-expansion rule: every real pack size is a building block.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { writeFileSync } from "node:fs";

type Comp = { flavor: string; qty: number; boxes: string };

const RECIPES: Array<{
  slug: string; total: number; comps: Comp[];
  title: string; bullets: string[]; description: string;
}> = [
  {
    slug: "honey-choc-strawberry-28",
    total: 28,
    comps: [
      { flavor: "Peanut Butter & Honey Spread", qty: 10, boxes: "1 × 10ct" },
      { flavor: "Peanut Butter & Chocolate Flavored Spread", qty: 10, boxes: "1 × 10ct" },
      { flavor: "Peanut Butter & Strawberry Jam", qty: 8, boxes: "2 × 4ct" },
    ],
    title: "Smucker's Uncrustables Frozen Sandwich Variety Pack, Peanut Butter & Honey, Peanut Butter & Chocolate Flavored Spread and Peanut Butter & Strawberry Jam, 28 Count",
    bullets: [
      "Includes 28 individually wrapped frozen sandwiches: 10 Peanut Butter & Honey Spread, 10 Peanut Butter & Chocolate Flavored Spread, and 8 Peanut Butter & Strawberry Jam.",
      "Packed in original retail boxes: one 10-count box of Honey Spread, one 10-count box of Chocolate Flavored Spread, and two 4-count boxes of Strawberry Jam.",
      "Each sandwich is sealed in its original individual wrapper on soft crustless bread.",
      "Keep frozen. Thaw at room temperature for 30 to 60 minutes before eating; once thawed, consume within 8 hours. Do not refreeze.",
      "An insulated foam cooler and frozen gel packs accompany the sandwiches as cold-pack components.",
    ],
    description:
      "This variety pack contains 28 individually wrapped Smucker's Uncrustables frozen sandwiches in three flavors: 10 Peanut Butter & Honey Spread, 10 Peanut Butter & Chocolate Flavored Spread, and 8 Peanut Butter & Strawberry Jam.\n\nThe sandwiches arrive in their original retail boxes: one 10-count box of each 10-count flavor and two 4-count boxes of Strawberry Jam. Each sandwich is made on soft crustless bread and sealed in its own wrapper by the original manufacturer.\n\nKeep frozen. Thaw at room temperature for 30 to 60 minutes before eating and consume within 8 hours of thawing. An insulated foam cooler with frozen gel packs is included as packaging.",
  },
  {
    slug: "grape-raspberry-24",
    total: 24,
    comps: [
      { flavor: "Peanut Butter & Grape Jelly", qty: 12, boxes: "3 × 4ct" },
      { flavor: "Peanut Butter & Raspberry Spread", qty: 12, boxes: "3 × 4ct" },
    ],
    title: "Smucker's Uncrustables Frozen Sandwich Variety Pack, Peanut Butter & Grape Jelly and Peanut Butter & Raspberry Spread, 24 Count",
    bullets: [
      "Includes 24 individually wrapped frozen sandwiches: 12 Peanut Butter & Grape Jelly and 12 Peanut Butter & Raspberry Spread.",
      "Packed in original retail boxes: three 4-count boxes of each flavor.",
      "Each sandwich is sealed in its original individual wrapper on soft crustless bread.",
      "Keep frozen. Thaw at room temperature for 30 to 60 minutes before eating; once thawed, consume within 8 hours. Do not refreeze.",
      "An insulated foam cooler and frozen gel packs accompany the sandwiches as cold-pack components.",
    ],
    description:
      "This variety pack contains 24 individually wrapped Smucker's Uncrustables frozen sandwiches in two flavors: 12 Peanut Butter & Grape Jelly and 12 Peanut Butter & Raspberry Spread, packed as three original 4-count retail boxes of each flavor.\n\nEach sandwich is made on soft crustless bread and sealed in its own wrapper by the original manufacturer.\n\nKeep frozen. Thaw at room temperature for 30 to 60 minutes before eating and consume within 8 hours of thawing. An insulated foam cooler with frozen gel packs is included as packaging.",
  },
  {
    slug: "honey-hazelnut-grape-30",
    total: 30,
    comps: [
      { flavor: "Peanut Butter & Honey Spread", qty: 10, boxes: "1 × 10ct" },
      { flavor: "Chocolate Flavored Hazelnut Spread", qty: 12, boxes: "3 × 4ct" },
      { flavor: "Peanut Butter & Grape Jelly", qty: 8, boxes: "2 × 4ct" },
    ],
    title: "Smucker's Uncrustables Frozen Sandwich Variety Pack, Peanut Butter & Honey, Chocolate Flavored Hazelnut Spread and Peanut Butter & Grape Jelly, 30 Count",
    bullets: [
      "Includes 30 individually wrapped frozen sandwiches: 10 Peanut Butter & Honey Spread, 12 Chocolate Flavored Hazelnut Spread, and 8 Peanut Butter & Grape Jelly.",
      "Packed in original retail boxes: one 10-count box of Honey Spread, three 4-count boxes of Hazelnut Spread, and two 4-count boxes of Grape Jelly.",
      "Each sandwich is sealed in its original individual wrapper on soft crustless bread.",
      "Keep frozen. Thaw at room temperature for 30 to 60 minutes before eating; once thawed, consume within 8 hours. Do not refreeze.",
      "An insulated foam cooler and frozen gel packs accompany the sandwiches as cold-pack components.",
    ],
    description:
      "This variety pack contains 30 individually wrapped Smucker's Uncrustables frozen sandwiches in three flavors: 10 Peanut Butter & Honey Spread, 12 Chocolate Flavored Hazelnut Spread, and 8 Peanut Butter & Grape Jelly.\n\nThe sandwiches arrive in their original retail boxes: one 10-count box, three 4-count boxes, and two 4-count boxes respectively. Each sandwich is made on soft crustless bread and sealed in its own wrapper by the original manufacturer.\n\nKeep frozen. Thaw at room temperature for 30 to 60 minutes before eating and consume within 8 hours of thawing. An insulated foam cooler with frozen gel packs is included as packaging.",
  },
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

  // donor lookup: per flavor → cheapest matching donor (image + unit price)
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
        _donor_title: d?.title ?? null,
      };
    });
    const variant = {
      idx: 0, name: r.title, composition,
      cost_cents: composition.reduce((s: number, c: any) => s + c.qty * c.unit_price_cents, 0),
      suggested_price_cents: Math.round(model.suggested * 100),
      margin_cents: 0, margin_pct: 0,
    };
    let prompt = "";
    let promptError: string | null = null;
    try {
      prompt = buildImagePrompt({
        brand: "Uncrustables",
        variant,
        composition_type: composition.length > 1 ? "MIXED_FLAVOR" : "SINGLE_FLAVOR",
        category: "FROZEN",
        uncrustables_image_mode: "retail_boxes",
      });
    } catch (e: any) {
      promptError = String(e?.message ?? e);
    }
    const referenceUrls = [
      frozenAnchorUrls()[0],
      ...composition.map((c: any) => c._donor_image).filter(Boolean),
    ].slice(0, 5);
    out.push({
      ...r,
      price: model.suggested,
      floor: model.floor,
      landed: model.landed,
      cooler: model.cooler,
      cost_cents: variant.cost_cents,
      prompt, promptError, referenceUrls,
      donor_images: composition.map((c: any) => ({ flavor: c.flavor, url: c._donor_image })),
      main_image_url: null,
    });
  }

  // Render MAINs sequentially through the production generator (worker + R2).
  for (const l of out) {
    if (l.promptError) { console.log(`✗ ${l.slug}: prompt blocked — ${l.promptError.slice(0, 120)}`); continue; }
    try {
      const t0 = Date.now();
      const res = await generateMainImage({
        prompt: l.prompt,
        r2_path_slug: `preview-${l.slug}`,
        reference_urls: l.referenceUrls,
      });
      l.main_image_url = res?.image_url ?? null;
      console.log(`✓ ${l.slug}: MAIN за ${Math.round((Date.now() - t0) / 1000)}s → ${l.main_image_url}`);
    } catch (e: any) {
      l.main_error = String(e?.message ?? e).slice(0, 160);
      console.log(`✗ ${l.slug}: ${l.main_error}`);
    }
  }

  writeFileSync(
    "/private/tmp/claude-501/-Users-vladimirkuznetsov-SS-Command-Center/1dbdc77d-9c20-49be-9e0d-c48b604008f6/scratchpad/preview-listings.json",
    JSON.stringify(out, null, 1),
  );
  console.log(`\nготово: ${out.filter((l) => l.main_image_url).length}/5 MAIN отрендерено`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
