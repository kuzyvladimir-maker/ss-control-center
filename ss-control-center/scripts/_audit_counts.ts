// Second audit pass, READ-ONLY.
//
// The first pass flagged "printed count digits" as a defect. That was too strict:
// a REAL Uncrustables box always prints its count ("4", "10", "15"), and our
// prompt asks for an exact decomposition (24 -> 10+10+4). Digits are only a
// defect when they DON'T sum to the listing's sandwich count.
//
// So: for every image that has NO hard defect (fabricated packaging / garbled
// brand / missing flavor), read the printed numbers and add them up ourselves.
// Vision reads, we do the arithmetic — models can't be trusted to sum.
import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
import { readFileSync, writeFileSync } from "node:fs";

const HARD = ["FABRICATED packaging", "packaging not real Uncrustables", "garbled brand text", "no Salutem cooler", "no branded gel packs"];
const isHard = (reasons: string[]) => reasons.some((r) => HARD.includes(r) || r.startsWith("missing a flavor"));

const PROMPT =
  `This is an Amazon main image: a cooler holding real Smucker's Uncrustables retail boxes.\n` +
  `Each box prints how many sandwiches it holds — a small number near a top corner (typically 4, 8, 10 or 15).\n\n` +
  `Read them. Answer ONLY with JSON:\n` +
  `{ "box_counts": [10, 10, 4],   // one entry per visible box, null if the number is not legible\n` +
  `  "loose_sandwiches": 0,        // individually wrapped sandwiches visible outside any box\n` +
  `  "notes": "one short sentence" }`;

async function main() {
  const { askVisionJson } = await import("@/lib/sourcing/vision");
  const audit = JSON.parse(readFileSync("data/cooler-audit.json", "utf8")) as Array<{
    draft_id: string; name: string; cooler: string; units: number; reasons: string[];
  }>;

  const candidates = audit.filter((a) => a.cooler && !isHard(a.reasons ?? []));
  console.log(`hard-defect images: ${audit.length - candidates.length}`);
  console.log(`checking counts on the remaining ${candidates.length}\n`);

  const out: Array<Record<string, unknown>> = [];
  let ok = 0, wrong = 0, unreadable = 0;

  for (const [i, a] of candidates.entries()) {
    const r = await askVisionJson([a.cooler], PROMPT, 200);
    const raw = Array.isArray(r?.box_counts) ? (r.box_counts as Array<number | null>) : null;
    if (!raw || raw.length === 0) {
      unreadable++; out.push({ ...a, count_verdict: "UNREADABLE" });
      console.log(`[${i + 1}/${candidates.length}] ?  ${a.name.slice(0, 40)}  (couldn't read)`);
      continue;
    }
    const nums = raw.filter((x): x is number => typeof x === "number");
    const anyNull = raw.some((x) => typeof x !== "number");
    const loose = typeof r.loose_sandwiches === "number" ? r.loose_sandwiches : 0;
    const sum = nums.reduce((s, n) => s + n, 0) + loose;

    let verdict: string;
    if (anyNull) { verdict = "UNREADABLE"; unreadable++; }
    else if (sum === a.units) { verdict = "COUNT_OK"; ok++; }
    else { verdict = "COUNT_WRONG"; wrong++; }

    out.push({ ...a, box_counts: raw, loose, sum, expected: a.units, count_verdict: verdict });
    const tag = verdict === "COUNT_OK" ? "OK" : verdict === "COUNT_WRONG" ? "✗ " : "? ";
    console.log(`[${i + 1}/${candidates.length}] ${tag} ${a.name.slice(0, 40)}  boxes=[${raw.join(",")}]${loose ? `+${loose} loose` : ""} sum=${sum} expected=${a.units}`);
  }

  writeFileSync("data/cooler-count-audit.json", JSON.stringify(out, null, 2));
  console.log(`\n===== COUNT_OK ${ok} | COUNT_WRONG ${wrong} | UNREADABLE ${unreadable} =====`);
  console.log(`hard defects (separate): ${audit.length - candidates.length}`);
  console.log(`\ntotal needing a fix: ${(audit.length - candidates.length) + wrong + unreadable}`);
  console.log("report: data/cooler-count-audit.json");
}
main().catch((e) => { console.error(e); process.exit(1); });
