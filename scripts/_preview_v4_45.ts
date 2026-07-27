// PREVIEW iteration 4 — rework ONLY listings 4 and 5.
// My full check of iteration 3 found: the global CARTON COUNT CONTRACT made
// every carton countable (v2 defect fixed) but the model pads rows to fill
// the cooler's width:
//   #4: drew 5 strawberry + 5 grape (needed 4 + 4) → 56 sandwiches, not 48.
//   #5: drew 5 Berry Burst + 3 Blackberry (needed 4 + 4) + a partial sliver.
// Fix: a ROW LAYOUT CONTRACT — one row per flavor with an exact spelled-out
// carton count, explicit "never add a carton to fill empty space", and a ban
// on partial/cropped cartons. Texts unchanged from iteration 3.
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
const WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

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
    const withArt = composition.filter((c: any) => c._donor_image && c._art);
    withArt.forEach((c: any) => {
      refs.push(c._donor_image);
      const boxes = c.qty / c._art.size;
      mapLines.push(
        `Reference ${refs.length} is the exact ${c._art.size}-count retail carton of ${c.flavor}. ` +
        `Draw exactly ${boxes} of THIS carton: same proportions, same artwork, and its genuine printed "${c._art.size}" count badge — never any other number on it.`,
      );
    });

    // Iteration-4: the model pads rows to fill the cooler width. Assign every
    // flavor its own row with a spelled-out count and forbid space-filling.
    const singles = withArt.filter((c: any) => c.qty / c._art.size === 1);
    const multis = withArt.filter((c: any) => c.qty / c._art.size > 1);
    const rows: any[][] = [];
    if (singles.length) rows.push(singles);
    multis.forEach((c: any) => rows.push([c]));
    const totalBoxes = withArt.reduce((s: number, c: any) => s + c.qty / c._art.size, 0);
    const rowLines = rows.map((row, i) => {
      const n = row.reduce((s: number, c: any) => s + c.qty / c._art.size, 0);
      const desc = row.map((c: any) => `${c.qty / c._art.size} carton${c.qty / c._art.size > 1 ? "s" : ""} of ${c._art.size}-count ${c.flavor}`).join(" and ");
      const pos = i === 0 ? "back row, tallest" : i === rows.length - 1 ? "front row" : `row ${i + 1}`;
      return `Row ${i + 1} (${pos}): EXACTLY ${n} carton${n > 1 ? "s" : ""} — ${desc}. Count them: ${WORDS.slice(0, n).join(", ")}. Not ${n + 1}, not ${n - 1 > 0 ? n - 1 : 0} — exactly ${n}. No other carton may appear in this row.`;
    });
    mapLines.push(
      "ROW LAYOUT CONTRACT (mandatory): the cartons stand in stepped rows from back to front, one flavor per row:",
      ...rowLines,
      `TOTAL cartons in the whole scene: EXACTLY ${totalBoxes}. Any other total is an error.`,
      "If a row does not fill the cooler's width, leave that space empty (white foam or a gel pack) — NEVER add an extra carton to fill space.",
      "Every carton is fully inside the frame and shows its complete front face; no carton is cropped by the image edge, sliced to a sliver, or hidden behind another.",
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
      const res = await generateMainImage({ prompt: l.prompt, r2_path_slug: `preview4-${l.slug}`, reference_urls: l.referenceUrls });
      l.main_image_url = res?.image_url ?? null;
      console.log(`✓ ${l.slug}: ${Math.round((Date.now() - t0) / 1000)}s → ${l.main_image_url}`);
    } catch (e: any) {
      l.main_error = String(e?.message ?? e).slice(0, 160);
      console.log(`✗ ${l.slug}: ${l.main_error}`);
    }
  }
  writeFileSync("/private/tmp/claude-501/-Users-vladimirkuznetsov-SS-Command-Center/1dbdc77d-9c20-49be-9e0d-c48b604008f6/scratchpad/preview-final-4.json", JSON.stringify(out, null, 1));
  console.log(`готово: ${out.filter((l: any) => l.main_image_url).length}/2`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
