// SPURIOUS-PACK FILTER over the 247 ready_to_publish list.
// The Comm-01 defect: title "…12 Pre Sliced Bagels, Value Pack - 1 Box (…12 Ct.), Total 12 Bagels"
// yielded packCount=12, so we tiled ONE box ×12 → a false 12-multipack. The "12" is the
// INNER piece count (bagels inside one box), not a pack of 12 boxes.
//
// Discriminator:
//   GENUINE  → title has an explicit multipack marker ("(Pack of N)", "N Pack",
//              "N-Pack", "N Count Pack", "Case of N", "N Boxes/Bags/Pouches/Packs")
//              matching packCount, OR packCount does NOT coincide with any inner-piece
//              count number in the title.
//   SPURIOUS → packCount equals a number that appears in the title as an INNER piece
//              count (e.g. "12 Bagels", "12 Ct", "12 Count", "Total 12"), AND there is
//              NO explicit multipack marker for that count, AND/OR the title names a
//              SINGULAR container ("1 Box", "1 Bag", "Value Pack", "Family Size",
//              "Party Size" with a single net weight).
// We print three buckets: GENUINE (safe to publish), SPURIOUS (exclude), REVIEW (eyeball).
import { readFileSync, writeFileSync } from "node:fs";

const ready: any[] = JSON.parse(readFileSync("_ready_to_publish.json", "utf8"));

// explicit multipack markers that legitimize a pack count of N
function hasExplicitPackMarker(title: string, n: number): boolean {
  const t = title.toLowerCase();
  const N = String(n);
  const pats = [
    `\\(\\s*pack\\s+of\\s+${N}\\s*\\)`,      // (Pack of 8)
    `pack\\s+of\\s+${N}\\b`,                  // Pack of 8
    `\\b${N}\\s*[- ]?\\s*pack\\b`,            // 8 Pack / 8-Pack
    `\\bpack\\s+${N}\\b`,                     // Pack 8
    `\\bcase\\s+of\\s+${N}\\b`,               // Case of 8
    `\\b${N}\\s*[- ]?\\s*count\\s+pack\\b`,   // 8 Count Pack
    `\\b${N}\\s*(boxes|bags|pouches|packs|packets|bottles|cans|jars|bars|cartons|containers|units)\\b`, // 8 Boxes / 8 Bags
    `\\bset\\s+of\\s+${N}\\b`,                // Set of 8
    `\\bbundle\\s+of\\s+${N}\\b`,             // Bundle of 8
    `\\b${N}\\s*x\\b`,                        // 8x
  ];
  return pats.some((p) => new RegExp(p, "i").test(t));
}

// inner piece-count phrases: N followed by a "unit-inside-package" noun, or N Ct/Count
function innerCountMatches(title: string, n: number): string[] {
  const N = String(n);
  const hits: string[] = [];
  const innerNouns = "bagels|slices|sliced|pieces|cookies|crackers|bars|sticks|cups|pouches|packets|servings|wraps|rolls|buns|muffins|tortillas|franks|links|patties|nuggets|bites|ct|count|pack\\.?|total";
  const re = new RegExp(`\\b(?:total\\s+)?${N}\\s*(?:pre[\\s-]?sliced\\s+)?(?:${innerNouns})\\b`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(title)) !== null) hits.push(m[0].trim());
  return hits;
}

// singular-container signals: one physical package sold, count is decorative
function singularContainer(title: string): string[] {
  const t = title.toLowerCase();
  const sigs = ["1 box", "1 bag", "1 pouch", "1 bottle", "1 jar", "1 can", "value pack", "family size", "party size", "1 pack", "single"];
  return sigs.filter((s) => t.includes(s));
}

const genuine: any[] = [], spurious: any[] = [], review: any[] = [];
for (const r of ready) {
  const n = r.pack;
  const marker = hasExplicitPackMarker(r.title, n);
  const inner = innerCountMatches(r.title, n);
  const singular = singularContainer(r.title);
  const reasons: string[] = [];
  if (marker) reasons.push("explicit-marker");
  if (inner.length) reasons.push(`inner-count[${inner.join("|")}]`);
  if (singular.length) reasons.push(`singular[${singular.join("|")}]`);

  if (marker) {
    genuine.push({ ...r, why: reasons.join(" ") });
  } else if (inner.length && singular.length) {
    // packCount coincides with inner count AND a singular container is named → Comm-01 class
    spurious.push({ ...r, why: reasons.join(" ") });
  } else if (inner.length) {
    // count coincides with an inner-piece number but no singular-container word → needs eyeball
    review.push({ ...r, why: reasons.join(" ") });
  } else {
    // no inner-count coincidence, no explicit marker → count came from remediation record / genuine
    genuine.push({ ...r, why: reasons.join(" ") || "no-inner-coincidence" });
  }
}

genuine.sort((a, b) => a.sku.localeCompare(b.sku));
spurious.sort((a, b) => a.sku.localeCompare(b.sku));
review.sort((a, b) => a.sku.localeCompare(b.sku));

console.log(`=== SPURIOUS-PACK FILTER over ${ready.length} ready SKUs ===`);
console.log(`GENUINE (safe): ${genuine.length} · SPURIOUS (exclude): ${spurious.length} · REVIEW (eyeball): ${review.length}\n`);
console.log(`--- SPURIOUS (${spurious.length}) — excluded from publish ---`);
for (const s of spurious) console.log(`  [pk${s.pack}] ${s.sku} :: ${s.title}\n      ${s.why}`);
console.log(`\n--- REVIEW (${review.length}) — need eyeball ---`);
for (const s of review) console.log(`  [pk${s.pack}] ${s.sku} :: ${s.title}\n      ${s.why}`);

writeFileSync("_spurious_buckets.json", JSON.stringify({ genuine, spurious, review }, null, 1));
console.log(`\nwrote _spurious_buckets.json`);
