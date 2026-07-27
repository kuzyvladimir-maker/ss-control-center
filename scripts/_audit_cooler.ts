// READ-ONLY audit of the restored AI cooler-hero images against the AGREED
// ideal picture (docs/BUNDLE_FACTORY_FROZEN_MAIN_IMAGE_v1.0.md + owner's rules):
//
//   • our branded Salutem Solutions EPS cooler
//   • our branded "FROZEN GEL PACK / KEEP FROZEN" pouches
//   • REAL Smucker's Uncrustables packaging (correct wordmark, not invented)
//   • NO printed count digits on boxes or wrappers (owner 2026-07-08)
//   • a MIX must show every flavor of that listing
//
// Writes data/cooler-audit.json. Mutates nothing, publishes nothing.
// Vision runs on the Claude Max subscription via askVisionJson ($0), which
// downscales the payload (see docs/wiki/vision-payload-downscale.md).
import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
import { readFileSync, writeFileSync } from "node:fs";

type MapEntry = { draft_id: string; name: string; composite: string | null; cooler: string | null };

const PROMPT = (flavors: string[], units: number) =>
  `You are auditing an Amazon MAIN image for a frozen Uncrustables multipack.\n\n` +
  `The ideal image: a white styrofoam cooler carrying the SALUTEM SOLUTIONS logo, ` +
  `white branded pouches reading "FROZEN GEL PACK" / "KEEP FROZEN", and inside the cooler ` +
  `the REAL retail product: Smucker's Uncrustables boxes.\n\n` +
  `This listing contains ${units} sandwiches of: ${flavors.map((f) => `"${f}"`).join(", ")}.\n\n` +
  `Answer ONLY with JSON:\n{\n` +
  `  "salutem_cooler": true/false,          // white styrofoam cooler with the SALUTEM SOLUTIONS logo\n` +
  `  "salutem_gel_packs": true/false,       // branded FROZEN GEL PACK pouches present\n` +
  `  "real_uncrustables_packaging": true/false, // the boxes show the REAL Smucker's Uncrustables brand\n` +
  `  "fabricated_packaging": true/false,    // invented packaging with no real brand on it\n` +
  `  "brand_text_correct": true/false,      // "Uncrustables"/"Smucker's" spelled correctly, not garbled\n` +
  `  "printed_count_numbers": true/false,   // ANY printed quantity digit on a box or wrapper (e.g. "15", "4")\n` +
  `  "flavors_seen": ["..."],\n` +
  `  "all_expected_flavors_present": true/false,\n` +
  `  "notes": "one short sentence"\n}`;

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { askVisionJson } = await import("@/lib/sourcing/vision");
  const ci = await import("@/lib/bundle-factory/composite-image");

  const map: MapEntry[] = JSON.parse(readFileSync("data/uncrustables-image-map.json", "utf8"));
  const withCooler = map.filter((m) => m.cooler);
  console.log(`auditing ${withCooler.length} cooler images\n`);

  const results: Array<Record<string, unknown>> = [];
  let clean = 0, defect = 0, unknown = 0;

  for (const [i, m] of withCooler.entries()) {
    const d = await prisma.bundleDraft.findUnique({
      where: { id: m.draft_id },
      select: { variation_matrix: { select: { selected_variant_idx: true, variants_json: true } } },
    });
    const vm = d?.variation_matrix;
    let flavors: string[] = [], units = 0;
    if (vm?.selected_variant_idx != null) {
      try {
        const v = JSON.parse(vm.variants_json)[vm.selected_variant_idx];
        flavors = (v?.composition ?? []).map((c: { product_name: string }) => ci.shortFlavorLabel(c.product_name));
        units = (v?.composition ?? []).reduce((s: number, c: { qty: number }) => s + c.qty, 0);
      } catch { /* leave empty */ }
    }
    const isMix = flavors.length > 1;

    const r = await askVisionJson([m.cooler!], PROMPT(flavors, units), 320);
    if (!r || typeof r !== "object") {
      unknown++;
      results.push({ ...m, verdict: "UNKNOWN", reasons: ["vision unavailable"] });
      console.log(`[${i + 1}/${withCooler.length}] ?  ${m.name.slice(0, 42)}  (vision failed)`);
      continue;
    }

    const reasons: string[] = [];
    if (r.salutem_cooler === false) reasons.push("no Salutem cooler");
    if (r.salutem_gel_packs === false) reasons.push("no branded gel packs");
    if (r.fabricated_packaging === true) reasons.push("FABRICATED packaging");
    if (r.real_uncrustables_packaging === false) reasons.push("packaging not real Uncrustables");
    if (r.brand_text_correct === false) reasons.push("garbled brand text");
    if (r.printed_count_numbers === true) reasons.push("printed count digits");
    if (isMix && r.all_expected_flavors_present === false) reasons.push(`missing a flavor (${flavors.join(" + ")})`);

    const verdict = reasons.length ? "DEFECT" : "CLEAN";
    if (verdict === "CLEAN") clean++; else defect++;
    results.push({ ...m, flavors, units, verdict, reasons, observed: r });
    console.log(`[${i + 1}/${withCooler.length}] ${verdict === "CLEAN" ? "OK" : "✗ "} ${m.name.slice(0, 42)}  ${reasons.join("; ")}`);
  }

  writeFileSync("data/cooler-audit.json", JSON.stringify(results, null, 2));

  // Which defect drives the most listings?
  const tally = new Map<string, number>();
  for (const r of results) for (const x of (r.reasons as string[]) ?? []) {
    const k = x.startsWith("missing a flavor") ? "missing a flavor (mix)" : x;
    tally.set(k, (tally.get(k) ?? 0) + 1);
  }
  console.log(`\n===== CLEAN ${clean} | DEFECT ${defect} | UNKNOWN ${unknown} =====`);
  console.log("defects by cause:");
  for (const [k, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${k}`);
  console.log("\nfull report: data/cooler-audit.json");

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
