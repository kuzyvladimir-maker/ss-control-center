// PREVIEW batch 2 — five NEW listings (owner: "Давай еще 5 листингов делать").
// Uses the PROVEN iteration-5 prompt contract: REFERENCE MAPPING + ROW LAYOUT
// (one flavor per row, spelled-out counts, never fill empty space) + UNIFORM
// CARTON SIZE + EXACT FRONT TEXT.
// New coverage vs batch 1: classic Peanut Butter 4ct, Strawberry Jam Protein
// 8ct, Apple Cinnamon Jelly Protein 8ct, Whole Wheat Grape 4ct; cooler tiers
// M-max (60) and XL (90).
// QUALIFIERS extended with ingredient tokens so the classic Peanut Butter
// flavor can't match jam/jelly donors (subset titles).
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { writeFileSync } from "node:fs";

type Comp = { flavor: string; qty: number };

const RECIPES: Array<{ slug: string; total: number; comps: Comp[]; title: string; bullets: string[]; description: string }> = [
  {
    slug: "classic-trio-24",
    total: 24,
    comps: [
      { flavor: "Peanut Butter", qty: 8 },
      { flavor: "Peanut Butter & Strawberry Jam", qty: 8 },
      { flavor: "Peanut Butter & Grape Jelly", qty: 8 },
    ],
    title: "Smucker's Uncrustables Frozen Sandwich Variety Pack, Peanut Butter, Strawberry Jam and Grape Jelly, 24 Count",
    bullets: [
      "Includes 24 individually wrapped frozen sandwiches: 8 Peanut Butter, 8 Peanut Butter & Strawberry Jam, and 8 Peanut Butter & Grape Jelly.",
      "Packed in original retail boxes: two 4-count boxes of each flavor.",
      "Each sandwich is sealed in its original individual wrapper on soft crustless bread.",
      "Keep frozen. Thaw at room temperature for 30 to 60 minutes before eating; once thawed, consume within 8 hours. Do not refreeze.",
      "An insulated foam cooler and frozen gel packs accompany the sandwiches as cold-pack components.",
    ],
    description: "This variety pack contains 24 individually wrapped Smucker's Uncrustables frozen sandwiches in three varieties: 8 Peanut Butter, 8 Peanut Butter & Strawberry Jam, and 8 Peanut Butter & Grape Jelly.\n\nThe sandwiches arrive in their original retail boxes: two 4-count boxes of each flavor. Each sandwich is made on soft crustless bread and sealed in its own wrapper by the original manufacturer.\n\nKeep frozen. Thaw at room temperature for 30 to 60 minutes before eating and consume within 8 hours of thawing. An insulated foam cooler with frozen gel packs is included as packaging.",
  },
  {
    slug: "protein-duo-wwgrape-28",
    total: 28,
    comps: [
      { flavor: "Peanut Butter & Strawberry Jam Protein", qty: 8 },
      { flavor: "Peanut Butter & Apple Cinnamon Jelly Protein", qty: 8 },
      { flavor: "Whole Wheat Peanut Butter & Grape Jelly", qty: 12 },
    ],
    title: "Smucker's Uncrustables Frozen Sandwich Variety Pack, Strawberry Jam 12g Protein, Apple Cinnamon Jelly 12g Protein and Whole Wheat Grape Jelly, 28 Count",
    bullets: [
      "Includes 28 individually wrapped frozen sandwiches: 8 Peanut Butter & Strawberry Jam with 12g protein per sandwich, 8 Peanut Butter & Apple Cinnamon Jelly with 12g protein per sandwich, and 12 Whole Wheat Peanut Butter & Grape Jelly.",
      "Packed in original retail boxes: one 8-count box of Strawberry Jam Protein, one 8-count box of Apple Cinnamon Jelly Protein, and three 4-count boxes of Whole Wheat Grape Jelly.",
      "Each sandwich is sealed in its original individual wrapper on soft crustless bread.",
      "Keep frozen. Thaw at room temperature for 30 to 60 minutes before eating; once thawed, consume within 8 hours. Do not refreeze.",
      "An insulated foam cooler and frozen gel packs accompany the sandwiches as cold-pack components.",
    ],
    description: "This variety pack contains 28 individually wrapped Smucker's Uncrustables frozen sandwiches in three varieties: 8 Peanut Butter & Strawberry Jam (12g protein per sandwich), 8 Peanut Butter & Apple Cinnamon Jelly (12g protein per sandwich), and 12 Whole Wheat Peanut Butter & Grape Jelly.\n\nThe sandwiches arrive in their original retail boxes: one 8-count box of each protein variety and three 4-count boxes of Whole Wheat Grape Jelly. Each sandwich is made on soft crustless bread and sealed in its own wrapper by the original manufacturer.\n\nKeep frozen. Thaw at room temperature for 30 to 60 minutes before eating and consume within 8 hours of thawing. An insulated foam cooler with frozen gel packs is included as packaging.",
  },
  {
    slug: "chocolate-hazelnut-raspberry-30",
    total: 30,
    comps: [
      { flavor: "Peanut Butter & Chocolate Flavored Spread", qty: 10 },
      { flavor: "Chocolate Flavored Hazelnut Spread", qty: 8 },
      { flavor: "Peanut Butter & Raspberry Spread", qty: 12 },
    ],
    title: "Smucker's Uncrustables Frozen Sandwich Variety Pack, Chocolate Flavored Spread, Chocolate Hazelnut and Raspberry, 30 Count",
    bullets: [
      "Includes 30 individually wrapped frozen sandwiches: 10 Peanut Butter & Chocolate Flavored Spread, 8 Chocolate Flavored Hazelnut Spread, and 12 Peanut Butter & Raspberry Spread.",
      "Packed in original retail boxes: one 10-count box of Chocolate Flavored Spread, two 4-count boxes of Chocolate Hazelnut, and three 4-count boxes of Raspberry.",
      "Each sandwich is sealed in its original individual wrapper on soft crustless bread.",
      "Keep frozen. Thaw at room temperature for 30 to 60 minutes before eating; once thawed, consume within 8 hours. Do not refreeze.",
      "An insulated foam cooler and frozen gel packs accompany the sandwiches as cold-pack components.",
    ],
    description: "This variety pack contains 30 individually wrapped Smucker's Uncrustables frozen sandwiches in three varieties: 10 Peanut Butter & Chocolate Flavored Spread, 8 Chocolate Flavored Hazelnut Spread, and 12 Peanut Butter & Raspberry Spread.\n\nThe sandwiches arrive in their original retail boxes: one 10-count box of Chocolate Flavored Spread, two 4-count boxes of Chocolate Hazelnut, and three 4-count boxes of Raspberry. Each sandwich is made on soft crustless bread and sealed in its own wrapper by the original manufacturer.\n\nKeep frozen. Thaw at room temperature for 30 to 60 minutes before eating and consume within 8 hours of thawing. An insulated foam cooler with frozen gel packs is included as packaging.",
  },
  {
    slug: "honey-chocolate-60",
    total: 60,
    comps: [
      { flavor: "Peanut Butter & Honey Spread", qty: 30 },
      { flavor: "Peanut Butter & Chocolate Flavored Spread", qty: 30 },
    ],
    title: "Smucker's Uncrustables Frozen Sandwich Variety Pack, Honey Spread and Chocolate Flavored Spread, 60 Count",
    bullets: [
      "Includes 60 individually wrapped frozen sandwiches: 30 Peanut Butter & Honey Spread and 30 Peanut Butter & Chocolate Flavored Spread.",
      "Packed in original retail boxes: three 10-count boxes of Honey Spread and three 10-count boxes of Chocolate Flavored Spread.",
      "Each sandwich is sealed in its original individual wrapper on soft crustless bread.",
      "Keep frozen. Thaw at room temperature for 30 to 60 minutes before eating; once thawed, consume within 8 hours. Do not refreeze.",
      "An insulated foam cooler and frozen gel packs accompany the sandwiches as cold-pack components.",
    ],
    description: "This variety pack contains 60 individually wrapped Smucker's Uncrustables frozen sandwiches in two varieties: 30 Peanut Butter & Honey Spread and 30 Peanut Butter & Chocolate Flavored Spread.\n\nThe sandwiches arrive in their original retail boxes: three 10-count boxes of each flavor. Each sandwich is made on soft crustless bread and sealed in its own wrapper by the original manufacturer.\n\nKeep frozen. Thaw at room temperature for 30 to 60 minutes before eating and consume within 8 hours of thawing. An insulated foam cooler with frozen gel packs is included as packaging.",
  },
  {
    slug: "xl-family-variety-90",
    total: 90,
    comps: [
      { flavor: "Peanut Butter & Honey Spread", qty: 30 },
      { flavor: "Peanut Butter & Chocolate Flavored Spread", qty: 20 },
      { flavor: "Peanut Butter & Blueberry", qty: 16 },
      { flavor: "Peanut Butter & Strawberry Jam", qty: 12 },
      { flavor: "Peanut Butter & Grape Jelly", qty: 12 },
    ],
    title: "Smucker's Uncrustables Frozen Sandwich Variety Pack, Honey, Chocolate, Blueberry, Strawberry Jam and Grape Jelly, 90 Count",
    bullets: [
      "Includes 90 individually wrapped frozen sandwiches: 30 Peanut Butter & Honey Spread, 20 Peanut Butter & Chocolate Flavored Spread, 16 Burstin' Blueberry Peanut Butter & Blueberry Spread (12g protein per sandwich), 12 Peanut Butter & Strawberry Jam, and 12 Peanut Butter & Grape Jelly.",
      "Packed in original retail boxes: three 10-count boxes of Honey Spread, two 10-count boxes of Chocolate Flavored Spread, two 8-count boxes of Burstin' Blueberry, three 4-count boxes of Strawberry Jam, and three 4-count boxes of Grape Jelly.",
      "Each sandwich is sealed in its original individual wrapper on soft crustless bread.",
      "Keep frozen. Thaw at room temperature for 30 to 60 minutes before eating; once thawed, consume within 8 hours. Do not refreeze.",
      "An insulated foam cooler and frozen gel packs accompany the sandwiches as cold-pack components.",
    ],
    description: "This variety pack contains 90 individually wrapped Smucker's Uncrustables frozen sandwiches in five varieties: 30 Peanut Butter & Honey Spread, 20 Peanut Butter & Chocolate Flavored Spread, 16 Burstin' Blueberry Peanut Butter & Blueberry Spread (12g protein per sandwich), 12 Peanut Butter & Strawberry Jam, and 12 Peanut Butter & Grape Jelly.\n\nThe sandwiches arrive in their original retail boxes: three 10-count boxes of Honey Spread, two 10-count boxes of Chocolate Flavored Spread, two 8-count boxes of Burstin' Blueberry, three 4-count boxes of Strawberry Jam, and three 4-count boxes of Grape Jelly. Each sandwich is made on soft crustless bread and sealed in its own wrapper by the original manufacturer.\n\nKeep frozen. Thaw at room temperature for 30 to 60 minutes before eating and consume within 8 hours of thawing. An insulated foam cooler with frozen gel packs is included as packaging.",
  },
];

// Ingredient tokens added so subset flavor names (classic "Peanut Butter")
// can't match jam/jelly donors: any token present in the donor title but
// absent from the requested flavor disqualifies the donor.
const QUALIFIERS = [
  "whole wheat", "protein", "morning", "reduced sugar", "beamin",
  "strawberry", "grape", "honey", "chocolate", "hazelnut",
  "raspberry", "blueberry", "blackberry", "mixed berry", "apple cinnamon",
];
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
  // size: the registry art's carton size — the reference photo we hand the
  // renderer must show THAT carton, so a donor whose title carries the same
  // pack size wins over a cheaper different-size donor (a 10ct raspberry photo
  // with a "draw the 4ct badge" instruction is a fabrication invitation).
  const donorFor = (flavor: string, size?: number | null) => {
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
    const sizeRe = size ? new RegExp(`(?:^|[^0-9])${size}\\s*(?:ct\\b|count\\b)`, "i") : null;
    candidates.sort((a: any, b: any) => {
      const am = sizeRe && sizeRe.test(a.title ?? "") ? 0 : 1;
      const bm = sizeRe && sizeRe.test(b.title ?? "") ? 0 : 1;
      if (am !== bm) return am - bm;
      return (donorUnitPriceCents(a) ?? 9e9) - (donorUnitPriceCents(b) ?? 9e9);
    });
    return candidates[0] ?? null;
  };

  const out: any[] = [];
  for (const r of RECIPES) {
    const model = priceFor(r.total);
    const composition = r.comps.map((c, i) => {
      const art = resolveArt(c.flavor, "retail-carton");
      const d = donorFor(c.flavor, art?.retail_pack_size);
      const unit = d ? donorUnitPriceCents(d) : null;
      console.log(`  [${r.slug}] ${c.flavor} → donor: ${d?.title?.slice(0, 70) ?? "НЕТ"} | unit ${unit ?? "?"}¢ | art ${art?.retail_pack_size ?? "НЕТ"}ct`);
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
        composition_type: r.comps.length > 1 ? "MIXED_FLAVOR" : "SINGLE_FLAVOR", category: "FROZEN",
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
      "UNIFORM CARTON SIZE: cartons of the same count have IDENTICAL dimensions everywhere in the scene (every 4-count matches every other 4-count, every 8-count matches every other 8-count, every 10-count matches every other 10-count). Never draw a wider, double-width or stretched carton; if a row of equal cartons does not span the cooler, leave the leftover space empty.",
      'EXACT FRONT TEXT: each carton front prints its flavor line exactly once with a single ampersand (for example "Peanut Butter & Honey Spread Sandwich"). Never duplicate a word, letter or "&" across a line break.',
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

  const DRY = process.env.DRY === "1";
  for (const l of out) {
    if (l.promptError || !l.prompt) { console.log(`✗ ${l.slug}: prompt blocked — ${String(l.promptError).slice(0, 140)}`); continue; }
    if (DRY) { console.log(`DRY ${l.slug}: price $${l.price} cooler ${l.cooler} boxes ${l.comps.map((c: any) => c.boxes).join(" + ")}`); continue; }
    try {
      const t0 = Date.now();
      const res = await generateMainImage({ prompt: l.prompt, r2_path_slug: `preview6-${l.slug}`, reference_urls: l.referenceUrls });
      l.main_image_url = res?.image_url ?? null;
      console.log(`✓ ${l.slug}: ${Math.round((Date.now() - t0) / 1000)}s → ${l.main_image_url}`);
    } catch (e: any) {
      l.main_error = String(e?.message ?? e).slice(0, 160);
      console.log(`✗ ${l.slug}: ${l.main_error}`);
    }
  }
  writeFileSync("/private/tmp/claude-501/-Users-vladimirkuznetsov-SS-Command-Center/1dbdc77d-9c20-49be-9e0d-c48b604008f6/scratchpad/preview-final-6.json", JSON.stringify(out, null, 1));
  console.log(`готово: ${out.filter((l: any) => l.main_image_url).length}/${out.length}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
