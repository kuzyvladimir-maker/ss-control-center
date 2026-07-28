// PREVIEW iteration 3 — rework ONLY listings 4 and 5 (owner: iterate to
// perfection). Fixes from my own full check of v2:
//   #4: one strawberry carton went missing in the render; blueberry's true
//       on-box name is "Burstin' Blueberry ... 12G Protein" — texts updated.
//   #5: dense 12-carton mix hid ~5 cartons — prompt gains a CARTON COUNT
//       CONTRACT (exact total, all countable, two tidy rows).
// Listings 1-3 rendered perfectly in v2 and are NOT re-rendered.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { writeFileSync } from "node:fs";

type Comp = { flavor: string; qty: number };

const RECIPES: Array<{ slug: string; total: number; comps: Comp[]; title: string; bullets: string[]; description: string }> = [
  {
    slug: "protein-blueberry-strawberry-grape-48",
    total: 48,
    comps: [
      { flavor: "Morning Protein Peanut Butter & Mixed Berry Spread", qty: 8 },
      { flavor: "Peanut Butter & Blueberry", qty: 8 },
      { flavor: "Peanut Butter & Strawberry Jam", qty: 16 },
      { flavor: "Peanut Butter & Grape Jelly", qty: 16 },
    ],
    title: "Smucker's Uncrustables Frozen Sandwich Variety Pack, Morning Protein Mixed Berry, Burstin' Blueberry, Strawberry Jam and Grape Jelly, 48 Count",
    bullets: [
      "Includes 48 individually wrapped frozen sandwiches: 8 Morning Protein Peanut Butter & Mixed Berry Spread (12g protein per sandwich), 8 Burstin' Blueberry Peanut Butter & Blueberry Spread (12g protein per sandwich), 16 Peanut Butter & Strawberry Jam, and 16 Peanut Butter & Grape Jelly.",
      "Packed in original retail boxes: one 8-count box of Morning Protein Mixed Berry, one 8-count box of Burstin' Blueberry, four 4-count boxes of Strawberry Jam, and four 4-count boxes of Grape Jelly.",
      "Each sandwich is sealed in its original individual wrapper on soft crustless bread.",
      "Keep frozen. Thaw at room temperature for 30 to 60 minutes before eating; once thawed, consume within 8 hours. Do not refreeze.",
      "An insulated foam cooler and frozen gel packs accompany the sandwiches as cold-pack components.",
    ],
    description: "This variety pack contains 48 individually wrapped Smucker's Uncrustables frozen sandwiches in four varieties: 8 Morning Protein Peanut Butter & Mixed Berry Spread (12g protein per sandwich), 8 Burstin' Blueberry Peanut Butter & Blueberry Spread (12g protein per sandwich), 16 Peanut Butter & Strawberry Jam, and 16 Peanut Butter & Grape Jelly.\n\nThe sandwiches arrive in their original retail boxes: one 8-count box of each protein variety and four 4-count boxes of each classic flavor. Each sandwich is made on soft crustless bread and sealed in its own wrapper by the original manufacturer.\n\nKeep frozen. Thaw at room temperature for 30 to 60 minutes before eating and consume within 8 hours of thawing. An insulated foam cooler with frozen gel packs is included as packaging.",
  },
  {
    slug: "honey-berry-quartet-54",
    total: 54,
    comps: [
      { flavor: "Peanut Butter & Honey Spread", qty: 10 },
      { flavor: "Peanut Butter & Mixed Berry Spread", qty: 16 },
      { flavor: "Peanut Butter & Blackberry Spread", qty: 16 },
      { flavor: "Whole Wheat Peanut Butter & Strawberry Jam", qty: 12 },
    ],
    title: "Smucker's Uncrustables Frozen Sandwich Variety Pack, Honey, Berry Burst Mixed Berry, Blackberry Boom and Whole Wheat Strawberry Jam, 54 Count",
    bullets: [
      "Includes 54 individually wrapped frozen sandwiches: 10 Peanut Butter & Honey Spread, 16 Berry Burst Peanut Butter & Mixed Berry Spread, 16 Blackberry Boom Peanut Butter & Blackberry Spread, and 12 Whole Wheat Peanut Butter & Strawberry Jam (reduced sugar).",
      "Packed in original retail boxes: one 10-count box of Honey Spread, four 4-count boxes of Berry Burst Mixed Berry, four 4-count boxes of Blackberry Boom, and three 4-count boxes of Whole Wheat Strawberry Jam.",
      "Each sandwich is sealed in its original individual wrapper on soft crustless bread.",
      "Keep frozen. Thaw at room temperature for 30 to 60 minutes before eating; once thawed, consume within 8 hours. Do not refreeze.",
      "An insulated foam cooler and frozen gel packs accompany the sandwiches as cold-pack components.",
    ],
    description: "This variety pack contains 54 individually wrapped Smucker's Uncrustables frozen sandwiches in four varieties: 10 Peanut Butter & Honey Spread, 16 Berry Burst Peanut Butter & Mixed Berry Spread, 16 Blackberry Boom Peanut Butter & Blackberry Spread, and 12 Whole Wheat Peanut Butter & Strawberry Jam (reduced sugar).\n\nThe sandwiches arrive in their original retail boxes: one 10-count box of Honey Spread, four 4-count boxes of Berry Burst Mixed Berry, four 4-count boxes of Blackberry Boom, and three 4-count boxes of Whole Wheat Strawberry Jam. Each sandwich is made on soft crustless bread and sealed in its own wrapper by the original manufacturer.\n\nKeep frozen. Thaw at room temperature for 30 to 60 minutes before eating and consume within 8 hours of thawing. An insulated foam cooler with frozen gel packs is included as packaging.",
  },
];

const QUALIFIERS = ["whole wheat", "protein", "morning", "reduced sugar", "beamin"];

async function main() {
  const cm: any = await import("../src/lib/pricing/cost-model");
  const ip: any = await import("../src/lib/bundle-factory/image-pipeline");
  const ig: any = await import("../src/lib/bundle-factory/image-generation");
  const dd: any = await import("../src/lib/bundle-factory/donor-dedup");
  const mg: any = await import("../src/lib/bundle-factory/audit/uncrustables-authenticity-merged");
  const p: any = await import("../src/lib/prisma");
  const priceFor = cm.priceFor ?? cm.default?.priceFor;
  const buildImagePrompt = ip.buildImagePrompt ?? ip.default?.buildImagePrompt;
  const frozenAnchorUrls = ip.frozenAnchorUrls ?? ip.default?.frozenAnchorUrls;
  const generateMainImage = ig.generateMainImage ?? ig.default?.generateMainImage;
  const donorUnitPriceCents = dd.donorUnitPriceCents ?? dd.default?.donorUnitPriceCents;
  const resolveArt = mg.resolveMergedUncrustablesPackageArt ?? mg.default?.resolveMergedUncrustablesPackageArt;
  const prisma = p.prisma ?? p.default?.prisma;

  const donors = await prisma.donorProduct.findMany({
    where: { OR: [{ brand: { contains: "Uncrustable" } }, { title: { contains: "Uncrustable" } }], needsReview: false },
    select: {
      id: true, title: true, brand: true, productLine: true, flavor: true,
      mainImageUrl: true, bestPrice: true,
      offers: { where: { isFirstParty: true, via: "direct", price: { gt: 0 } }, select: { price: true, packSizeSeen: true, pricePerUnit: true } },
    },
  });
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const donorFor = (flavor: string) => {
    const f = norm(flavor);
    const wanted = QUALIFIERS.filter((q) => f.includes(q));
    const banned = QUALIFIERS.filter((q) => !f.includes(q));
    const candidates = donors.filter((d: any) => {
      const t = norm(d.title ?? "");
      if (!f.split(" ").every((w: string) => w.length < 3 || t.includes(w))) return false;
      if (banned.some((q) => t.includes(q))) return false;
      if (!wanted.every((q) => t.includes(q))) return false;
      return true;
    });
    candidates.sort((a: any, b: any) => (donorUnitPriceCents(a) ?? 9e9) - (donorUnitPriceCents(b) ?? 9e9));
    return candidates[0] ?? null;
  };

  const out: any[] = [];
  for (const r of RECIPES) {
    const model = priceFor(r.total);
    const composition = r.comps.map((c, i) => {
      const d = donorFor(c.flavor);
      const art = resolveArt(c.flavor, "retail-carton");
      const unit = d ? donorUnitPriceCents(d) : null;
      return {
        research_pool_id: d?.id ?? `preview-${i}`,
        product_name: c.flavor,
        flavor: c.flavor,
        brand: "Uncrustables",
        qty: c.qty,
        unit_price_cents: unit ?? 100,
        _donor_image: d?.mainImageUrl ?? null,
        _donor_title: d?.title ?? null,
        _art: art ? { size: art.retail_pack_size, evidence: art.evidence?.[0]?.locator ?? null } : null,
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

    const refs: string[] = [frozenAnchorUrls()[0]];
    const mapLines: string[] = [
      "REFERENCE MAPPING (follow exactly):",
      "Reference 1 is the Salutem Solutions cooler with gel packs — the scene anchor.",
    ];
    const totalBoxes = composition.reduce((s: number, c: any) => s + (c._art ? c.qty / c._art.size : 0), 0);
    const boxList: string[] = [];
    composition.forEach((c: any) => {
      if (c._donor_image) {
        refs.push(c._donor_image);
        const size = c._art?.size ?? "?";
        const boxes = c._art ? c.qty / c._art.size : "?";
        boxList.push(`${boxes} × ${c.flavor} (${size}-count carton)`);
        mapLines.push(
          `Reference ${refs.length} is the exact ${size}-count retail carton of ${c.flavor}. ` +
          `Draw exactly ${boxes} of THIS carton: same proportions, same artwork, and its genuine printed "${size}" count badge — never any other number on it.`,
        );
      }
    });
    // Iteration-3 addition: dense mixes hid cartons in v2. Hard count contract.
    mapLines.push(
      `CARTON COUNT CONTRACT: the scene contains EXACTLY ${totalBoxes} retail cartons in total — ${boxList.join("; ")}. ` +
      "Arrange them in two tidy stepped rows inside and above the cooler so EVERY carton front is individually visible and countable. " +
      "No carton may be fully hidden behind another; do not add, remove, merge or crop cartons.",
    );
    const finalPrompt = prompt ? `${prompt}\n\n${mapLines.join("\n")}` : "";

    out.push({
      ...r,
      comps: composition.map((c: any) => ({
        flavor: c.flavor, qty: c.qty,
        box_size: c._art?.size ?? null,
        box_count: c._art ? c.qty / c._art.size : null,
        boxes: c._art ? `${c.qty / c._art.size} × ${c._art.size}ct` : "?",
        thumb: c._art?.evidence ?? null,
        donor_title: c._donor_title,
      })),
      price: model.suggested, floor: model.floor, landed: model.landed, cooler: model.cooler,
      cost_cents: variant.cost_cents,
      prompt: finalPrompt, promptError,
      referenceUrls: refs.slice(0, 6),
      main_image_url: null,
    });
  }

  for (const l of out) {
    if (l.promptError || !l.prompt) { console.log(`✗ ${l.slug}: prompt blocked — ${String(l.promptError).slice(0, 140)}`); continue; }
    try {
      const t0 = Date.now();
      const res = await generateMainImage({ prompt: l.prompt, r2_path_slug: `preview3-${l.slug}`, reference_urls: l.referenceUrls });
      l.main_image_url = res?.image_url ?? null;
      console.log(`✓ ${l.slug}: ${Math.round((Date.now() - t0) / 1000)}s → ${l.main_image_url}`);
    } catch (e: any) {
      l.main_error = String(e?.message ?? e).slice(0, 160);
      console.log(`✗ ${l.slug}: ${l.main_error}`);
    }
  }
  writeFileSync("/private/tmp/claude-501/-Users-vladimirkuznetsov-SS-Command-Center/1dbdc77d-9c20-49be-9e0d-c48b604008f6/scratchpad/preview-final-3.json", JSON.stringify(out, null, 1));
  console.log(`готово: ${out.filter((l: any) => l.main_image_url).length}/2`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
