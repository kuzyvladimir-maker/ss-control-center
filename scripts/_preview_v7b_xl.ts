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
    slug: "xl-family-variety-90",
    total: 90,
    comps: [
      { flavor: "Peanut Butter & Honey Spread", qty: 30 },
      { flavor: "Peanut Butter & Chocolate Flavored Spread", qty: 20 },
      { flavor: "Peanut Butter & Blueberry", qty: 24 },
      { flavor: "Morning Protein Peanut Butter & Mixed Berry Spread", qty: 16 },
    ],
    title: "Smucker's Uncrustables Frozen Sandwich Variety Pack, Honey, Chocolate, Burstin' Blueberry and Beamin' Berry Blend, 90 Count",
    bullets: [
      "Includes 90 individually wrapped frozen sandwiches: 30 Peanut Butter & Honey Spread, 20 Peanut Butter & Chocolate Flavored Spread, 24 Burstin' Blueberry Peanut Butter & Blueberry Spread (12g protein per sandwich), and 16 Beamin' Berry Blend Morning Protein Peanut Butter & Mixed Berry Spread (12g protein per sandwich).",
      "Packed in original retail boxes: three 10-count boxes of Honey Spread, two 10-count boxes of Chocolate Flavored Spread, three 8-count boxes of Burstin' Blueberry, and two 8-count boxes of Beamin' Berry Blend.",
      "Each sandwich is sealed in its original individual wrapper on soft crustless bread.",
      "Keep frozen. Thaw at room temperature for 30 to 60 minutes before eating; once thawed, consume within 8 hours. Do not refreeze.",
      "An insulated foam cooler and frozen gel packs accompany the sandwiches as cold-pack components.",
    ],
    description: "This variety pack contains 90 individually wrapped Smucker's Uncrustables frozen sandwiches in four varieties: 30 Peanut Butter & Honey Spread, 20 Peanut Butter & Chocolate Flavored Spread, 24 Burstin' Blueberry Peanut Butter & Blueberry Spread (12g protein per sandwich), and 16 Beamin' Berry Blend Morning Protein Peanut Butter & Mixed Berry Spread (12g protein per sandwich).\n\nThe sandwiches arrive in their original retail boxes: three 10-count boxes of Honey Spread, two 10-count boxes of Chocolate Flavored Spread, three 8-count boxes of Burstin' Blueberry, and two 8-count boxes of Beamin' Berry Blend. Each sandwich is made on soft crustless bread and sealed in its own wrapper by the original manufacturer.\n\nKeep frozen. Thaw at room temperature for 30 to 60 minutes before eating and consume within 8 hours of thawing. An insulated foam cooler with frozen gel packs is included as packaging.",
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
    mapLines.push(
      "ROW LAYOUT CONTRACT (mandatory): the cartons stand in stepped rows from back to front, one flavor per row:",
      ...rowLines,
      `TOTAL cartons: EXACTLY ${totalBoxes}.`,
      "Unfilled row width stays empty (foam/gel pack) — never add cartons to fill space. Every carton front fully visible; none cropped, slivered, or hidden. Cartons stand side by side only — no depth pairs. Same-count cartons share identical dimensions — no wide or stretched boxes.",
      "SCENE: the open white Salutem Solutions foam cooler from Reference 1 with lid and gel packs IS the stage; rows sit inside/above it. Never a flat catalog lineup on plain white.",
      "BRANDING: the cooler front and every gel pack carry the EXACT branding from Reference 1 — the green lotus emblem with the words SALUTEM SOLUTIONS and OUR BEST SOLUTIONS FOR YOU. Copy that logo pixel-faithfully. NEVER invent a different logo, monogram, crest or typography.",
      'FRONT TEXT: each front prints its flavor line once, single ampersand, no word repeated. The Chocolate carton reads exactly "Peanut Butter & Chocolate Flavored Spread Sandwich" (the word Spread appears once before Sandwich). The Honey carton reads exactly "Peanut Butter & Honey Spread Sandwich".',
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
      const res = await generateMainImage({ prompt: l.prompt, r2_path_slug: `preview7-${l.slug}`, reference_urls: l.referenceUrls });
      l.main_image_url = res?.image_url ?? null;
      if (!l.main_image_url) l.main_error = res?.error ?? "no url, no error";
      console.log(`✓ ${l.slug}: ${Math.round((Date.now() - t0) / 1000)}s → ${l.main_image_url}${l.main_error ? ` | ERROR: ${l.main_error}` : ""}`);
    } catch (e: any) {
      l.main_error = String(e?.message ?? e).slice(0, 160);
      console.log(`✗ ${l.slug}: ${l.main_error}`);
    }
  }
  writeFileSync("/private/tmp/claude-501/-Users-vladimirkuznetsov-SS-Command-Center/1dbdc77d-9c20-49be-9e0d-c48b604008f6/scratchpad/preview-final-7b.json", JSON.stringify(out, null, 1));
  console.log(`готово: ${out.filter((l: any) => l.main_image_url).length}/${out.length}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
