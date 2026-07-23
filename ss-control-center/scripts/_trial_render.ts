// TRIAL RUN — 12 new Uncrustables ASINs (owner: "пробный забег на 10-15 новых асин").
// Recipes are validated by the new Bundle Factory box-planner module
// (src/lib/bundle-factory/uncrustables-box-planner.ts) and copy is GENERATED
// by it — this run is the module's first production consumer.
// Rendering uses the frozen proven prompt contract from _preview_v7b_xl.ts:
// REFERENCE MAPPING + ROW LAYOUT + UNIFORM CARTON SIZE + EXACT FRONT TEXT +
// SCENE/BRANDING anchor.
// Env: WAVE=1|2|3 (5 S / 5 M-L / 2 XL), SLUGS=a,b overrides, DRY=1 plan only.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { writeFileSync } from "node:fs";

import type { Recipe } from "../src/lib/bundle-factory/uncrustables-box-planner";

const TRIAL_RECIPES: Recipe[] = [
  // Wave 1 — S band
  { slug: "s-berry-trio-24", comps: [
    { flavor: "Peanut Butter & Mixed Berry Spread", qty: 8 },
    { flavor: "Peanut Butter & Blackberry Spread", qty: 8 },
    { flavor: "Peanut Butter & Raspberry Spread", qty: 8 },
  ] },
  { slug: "s-wheat-duo-24", comps: [
    { flavor: "Whole Wheat Peanut Butter & Strawberry Jam", qty: 12 },
    { flavor: "Whole Wheat Peanut Butter & Grape Jelly", qty: 12 },
  ] },
  { slug: "s-protein-quartet-28", comps: [
    { flavor: "Peanut Butter & Strawberry Jam Protein", qty: 8 },
    { flavor: "Peanut Butter & Blueberry", qty: 8 },
    { flavor: "Morning Protein Peanut Butter & Mixed Berry Spread", qty: 8 },
    { flavor: "Peanut Butter & Strawberry Jam", qty: 4 },
  ] },
  { slug: "s-bigbox-trio-28", comps: [
    { flavor: "Peanut Butter & Honey Spread", qty: 10 },
    { flavor: "Peanut Butter & Chocolate Flavored Spread", qty: 10 },
    { flavor: "Peanut Butter & Apple Cinnamon Jelly Protein", qty: 8 },
  ] },
  { slug: "s-chocolate-lovers-30", comps: [
    { flavor: "Peanut Butter & Chocolate Flavored Spread", qty: 10 },
    { flavor: "Chocolate Flavored Hazelnut Spread", qty: 8 },
    { flavor: "Peanut Butter", qty: 12 },
  ] },
  // Wave 2 — S tail + M/L band
  { slug: "s-classic-honey-30", comps: [
    { flavor: "Peanut Butter & Honey Spread", qty: 10 },
    { flavor: "Peanut Butter & Strawberry Jam", qty: 12 },
    { flavor: "Peanut Butter", qty: 8 },
  ] },
  { slug: "m-honey-choc-grape-48", comps: [
    { flavor: "Peanut Butter & Honey Spread", qty: 20 },
    { flavor: "Peanut Butter & Chocolate Flavored Spread", qty: 20 },
    { flavor: "Peanut Butter & Grape Jelly", qty: 8 },
  ] },
  { slug: "m-protein-family-48", comps: [
    { flavor: "Peanut Butter & Blueberry", qty: 16 },
    { flavor: "Morning Protein Peanut Butter & Mixed Berry Spread", qty: 16 },
    { flavor: "Peanut Butter & Strawberry Jam Protein", qty: 16 },
  ] },
  { slug: "m-variety-54", comps: [
    { flavor: "Peanut Butter & Honey Spread", qty: 20 },
    { flavor: "Peanut Butter & Chocolate Flavored Spread", qty: 10 },
    { flavor: "Peanut Butter & Strawberry Jam Protein", qty: 8 },
    { flavor: "Peanut Butter & Mixed Berry Spread", qty: 16 },
  ] },
  { slug: "l-choc-berry-60", comps: [
    { flavor: "Peanut Butter & Chocolate Flavored Spread", qty: 20 },
    { flavor: "Peanut Butter & Blueberry", qty: 24 },
    { flavor: "Morning Protein Peanut Butter & Mixed Berry Spread", qty: 16 },
  ] },
  // Wave 3 — XL (scene-complexity ceiling, rendered last)
  { slug: "xl-honey-choc-blueberry-96", comps: [
    { flavor: "Peanut Butter & Honey Spread", qty: 40 },
    { flavor: "Peanut Butter & Chocolate Flavored Spread", qty: 40 },
    { flavor: "Peanut Butter & Blueberry", qty: 16 },
  ] },
  { slug: "xl-protein-90", comps: [
    { flavor: "Peanut Butter & Honey Spread", qty: 10 },
    { flavor: "Peanut Butter & Blueberry", qty: 32 },
    { flavor: "Morning Protein Peanut Butter & Mixed Berry Spread", qty: 32 },
    { flavor: "Peanut Butter & Strawberry Jam Protein", qty: 16 },
  ] },
];

const WAVES: Record<string, string[]> = {
  "1": TRIAL_RECIPES.slice(0, 5).map((r) => r.slug),
  "2": TRIAL_RECIPES.slice(5, 10).map((r) => r.slug),
  "3": TRIAL_RECIPES.slice(10).map((r) => r.slug),
};

const QUALIFIERS = [
  "whole wheat", "protein", "morning", "reduced sugar", "beamin",
  "strawberry", "grape", "honey", "chocolate", "hazelnut",
  "raspberry", "blueberry", "blackberry", "mixed berry", "apple cinnamon",
];
const WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

async function main() {
  const bp: any = await import("../src/lib/bundle-factory/uncrustables-box-planner");
  const cm: any = await import("../src/lib/pricing/cost-model");
  const ip: any = await import("../src/lib/bundle-factory/image-pipeline");
  const ig: any = await import("../src/lib/bundle-factory/image-generation");
  const dd: any = await import("../src/lib/bundle-factory/donor-dedup");
  const mg: any = await import("../src/lib/bundle-factory/audit/uncrustables-authenticity-merged");
  const p: any = await import("../src/lib/prisma");
  const validateRecipe = bp.validateRecipe ?? bp.default?.validateRecipe;
  const buildListingCopy = bp.buildListingCopy ?? bp.default?.buildListingCopy;
  const priceFor = cm.priceFor ?? cm.default?.priceFor;
  const buildImagePrompt = ip.buildImagePrompt ?? ip.default?.buildImagePrompt;
  const frozenAnchorUrls = ip.frozenAnchorUrls ?? ip.default?.frozenAnchorUrls;
  const generateMainImage = ig.generateMainImage ?? ig.default?.generateMainImage;
  const donorUnitPriceCents = dd.donorUnitPriceCents ?? dd.default?.donorUnitPriceCents;
  const resolveArt = mg.resolveMergedUncrustablesPackageArt ?? mg.default?.resolveMergedUncrustablesPackageArt;
  const prisma = p.prisma ?? p.default?.prisma;

  // Gate 0: every trial recipe must pass the box-planner before anything renders.
  let invalid = 0;
  for (const r of TRIAL_RECIPES) {
    const errs = validateRecipe(r.comps);
    const total = r.comps.reduce((s: number, c: any) => s + c.qty, 0);
    if (errs.length) { invalid++; console.log(`✗ PLAN ${r.slug} (${total}ct): ${errs.join("; ")}`); }
    else console.log(`✓ PLAN ${r.slug} (${total}ct)`);
  }
  if (invalid) { console.error(`box-planner rejected ${invalid} recipes — fix before rendering`); process.exit(1); }

  const slugFilter = process.env.SLUGS ? process.env.SLUGS.split(",") : process.env.WAVE ? WAVES[process.env.WAVE] : null;
  if (!slugFilter) { console.error("set WAVE=1|2|3 or SLUGS=a,b"); process.exit(1); }
  const selected = TRIAL_RECIPES.filter((r) => slugFilter.includes(r.slug));

  const donors = await prisma.donorProduct.findMany({
    where: { OR: [{ brand: { contains: "Uncrustable" } }, { title: { contains: "Uncrustable" } }], needsReview: false },
    select: {
      id: true, title: true, brand: true, productLine: true, flavor: true,
      mainImageUrl: true, bestPrice: true,
      offers: { where: { isFirstParty: true, via: "direct", price: { gt: 0 } }, select: { price: true, packSizeSeen: true, pricePerUnit: true } },
    },
  });
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
  for (const r of selected) {
    const total = r.comps.reduce((s: number, c: any) => s + c.qty, 0);
    const model = priceFor(total);
    const copy = buildListingCopy(r.comps);
    const composition = r.comps.map((c: any, i: number) => {
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
      idx: 0, name: copy.title, composition,
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
        `Ref ${refs.length} = the ${c._art.size}-count carton of ${c.flavor}; draw exactly ${boxes} of it, its printed "${c._art.size}" badge unchanged.`,
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
      return `Row ${i + 1} (${pos}): EXACTLY ${n} carton${n > 1 ? "s" : ""} — ${desc}. Count: ${WORDS.slice(0, n).join(", ")}. No other carton in this row.`;
    });
    const frontText = [
      'FRONT TEXT: each front prints its flavor line once, single ampersand, no word repeated, matching its reference photo exactly.',
    ];
    if (r.comps.some((c: any) => c.flavor === "Peanut Butter & Chocolate Flavored Spread"))
      frontText.push('The Chocolate carton reads exactly "Peanut Butter & Chocolate Flavored Spread Sandwich" (the word Spread appears once before Sandwich).');
    if (r.comps.some((c: any) => c.flavor === "Peanut Butter & Honey Spread"))
      frontText.push('The Honey carton reads exactly "Peanut Butter & Honey Spread Sandwich".');
    mapLines.push(
      "ROW LAYOUT CONTRACT (mandatory): the cartons stand in stepped rows from back to front, one flavor per row:",
      ...rowLines,
      `TOTAL cartons: EXACTLY ${totalBoxes}.`,
      "Unfilled row width stays empty (foam/gel pack) — never add cartons to fill space. Every carton front fully visible; none cropped, slivered, or hidden. Cartons stand side by side only — no depth pairs. Same-count cartons share identical dimensions — no wide or stretched boxes.",
      "SCENE: the open white Salutem Solutions foam cooler from Reference 1 with lid and gel packs IS the stage; rows sit inside/above it. Never a flat catalog lineup on plain white.",
      "BRANDING: the cooler front and every gel pack carry the EXACT branding from Reference 1 — the green lotus emblem with the words SALUTEM SOLUTIONS and OUR BEST SOLUTIONS FOR YOU. Copy that logo pixel-faithfully. NEVER invent a different logo, monogram, crest or typography.",
      frontText.join(" "),
    );
    const finalPrompt = prompt ? `${prompt}\n\n${mapLines.join("\n")}` : "";

    out.push({
      slug: r.slug, total,
      title: copy.title, bullets: copy.bullets, description: copy.description,
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
      const res = await generateMainImage({ prompt: l.prompt, r2_path_slug: `trial1-${l.slug}`, reference_urls: l.referenceUrls });
      l.main_image_url = res?.image_url ?? null;
      if (!l.main_image_url) l.main_error = res?.error ?? "no url, no error";
      console.log(`✓ ${l.slug}: ${Math.round((Date.now() - t0) / 1000)}s → ${l.main_image_url}${l.main_error ? ` | ERROR: ${l.main_error}` : ""}`);
    } catch (e: any) {
      l.main_error = String(e?.message ?? e).slice(0, 160);
      console.log(`✗ ${l.slug}: ${l.main_error}`);
    }
  }
  const wave = process.env.WAVE ?? "custom";
  writeFileSync(`/private/tmp/claude-501/-Users-vladimirkuznetsov-SS-Command-Center/1dbdc77d-9c20-49be-9e0d-c48b604008f6/scratchpad/trial-wave${wave}.json`, JSON.stringify(out, null, 1));
  console.log(`готово: ${out.filter((l: any) => l.main_image_url).length}/${out.length}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
