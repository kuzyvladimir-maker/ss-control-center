/**
 * Phase 2.6.1 — Sample 5 SALUTEM planned listings for content analysis.
 *
 * Companion to inspect-failed-content.ts. AMZCOM failed-listings analysis
 * exposed a template fingerprint (5 specific emojis, manual bullet
 * markers, promotional adjectives, HTML in description). We need to know
 * whether SALUTEM (998 listings, the Brand Registry owner) shares that
 * fingerprint before deciding scrub scope:
 *
 *   Verdict A: SALUTEM ≈ AMZCOM template → universal scrub on all 1038
 *   Verdict B: SALUTEM clean             → scrub only on 40 AMZCOM
 *   Verdict C: SALUTEM has different non-compliant pattern → bespoke
 *
 * This script picks 5 evenly-spaced SALUTEM rows from the existing plan
 * cohort, dumps the raw bullets + description, runs the same heuristic
 * detector as the AMZCOM script, appends Section B to
 * docs/PHASE_2_6_1_FAILED_CONTENT_ANALYSIS.md, and writes the verdict.
 *
 * Read-only — no SP-API, no DB writes.
 */

import "dotenv/config";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { prisma } from "@/lib/prisma";

const SCAN_ID = "cmpaisoq80000wlfz4llxuo5k";
const DOC_PATH = join(
  process.cwd(),
  "..",
  "docs",
  "PHASE_2_6_1_FAILED_CONTENT_ANALYSIS.md",
);

const PROMOTIONAL_WORDS = [
  "ultimate",
  "amazing",
  "best",
  "must-have",
  "must have",
  "perfect",
  "delicious",
  "incredible",
  "premium quality",
  "exclusive",
  "guaranteed",
  "delightful",
  "ideal",
  "unmatched",
  "superior",
  "world-class",
  "world class",
  "finest",
  "top-quality",
  "top quality",
];

const HEALTH_CLAIM_WORDS = [
  "cure",
  "treat",
  "prevent",
  "boost",
  "energy",
  "weight loss",
  "natural",
  "detox",
  "antioxidant",
  "immune",
  "metabolism",
];

const EMOJI_RE =
  /[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{2300}-\u{23FF}\u{2700}-\u{27BF}]/gu;

const URL_RE = /\b(?:https?:\/\/|www\.)[\w./?%&=#:-]+/gi;
const HTML_TAG_RE = /<\/?([a-zA-Z][\w-]*)(?:\s[^>]*)?>/g;
const MANUAL_BULLET_RE = /(?:^|\n)\s*[•●►▪○▶➤→]+\s*/g;

function parseJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

interface FindingHits {
  emojis: string[];
  uniqueEmojis: string[];
  manualBullets: number;
  urls: string[];
  promotional: string[];
  healthClaims: string[];
  htmlTags: Record<string, number>;
}

function analyze(text: string): FindingHits {
  const lower = text.toLowerCase();
  const emojis = text.match(EMOJI_RE) ?? [];
  const urls = text.match(URL_RE) ?? [];
  const manualBullets = (text.match(MANUAL_BULLET_RE) ?? []).length;
  const promotional = PROMOTIONAL_WORDS.filter((w) => lower.includes(w));
  const healthClaims = HEALTH_CLAIM_WORDS.filter((w) =>
    new RegExp(`\\b${w.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i").test(text),
  );
  const htmlTags: Record<string, number> = {};
  for (const m of text.matchAll(HTML_TAG_RE)) {
    const tag = m[1].toLowerCase();
    htmlTags[tag] = (htmlTags[tag] ?? 0) + 1;
  }
  return {
    emojis,
    uniqueEmojis: [...new Set(emojis)],
    manualBullets,
    urls,
    promotional,
    healthClaims,
    htmlTags,
  };
}

function fmtListLine(label: string, h: FindingHits): string[] {
  const lines: string[] = [];
  lines.push(
    `- **${label} emoji count:** ${h.emojis.length}` +
      (h.uniqueEmojis.length ? ` — \`${h.uniqueEmojis.join(" ")}\`` : ""),
  );
  lines.push(`- **${label} manual bullet markers:** ${h.manualBullets}`);
  lines.push(
    `- **${label} URLs:** ${h.urls.length}` +
      (h.urls.length ? ` — ${h.urls.slice(0, 3).map((u) => `\`${u}\``).join(", ")}` : ""),
  );
  lines.push(
    `- **${label} promotional words:** ${h.promotional.length}` +
      (h.promotional.length ? ` — ${h.promotional.map((w) => `\`${w}\``).join(", ")}` : ""),
  );
  lines.push(
    `- **${label} health-claim words:** ${h.healthClaims.length}` +
      (h.healthClaims.length ? ` — ${h.healthClaims.map((w) => `\`${w}\``).join(", ")}` : ""),
  );
  const htmlPairs = Object.entries(h.htmlTags).sort((a, b) => b[1] - a[1]);
  lines.push(
    `- **${label} HTML tags:** ${htmlPairs.length === 0 ? "0" : htmlPairs.map(([t, n]) => `${t}×${n}`).join(", ")}`,
  );
  return lines;
}

async function main() {
  // Find the candidate pool: SALUTEM rows with status='plan' for this scan.
  // Then pick 5 evenly-spaced indices for representative coverage.
  const all = await prisma.listingRemediation.findMany({
    where: {
      status: "plan",
      audit_result: {
        scan_id: SCAN_ID,
        account: "SALUTEM",
      },
    },
    include: {
      audit_result: {
        select: {
          asin: true,
          sku: true,
          account: true,
          title: true,
          original_bullets: true,
          original_description: true,
          detected_brands: true,
          detected_logos: true,
          risk_reasons: true,
        },
      },
    },
    orderBy: { audit_result_id: "asc" },
  });
  console.log(`SALUTEM 'plan' rows total: ${all.length}`);
  if (all.length === 0) {
    console.error("No SALUTEM rows in 'plan' status — has the plan script run for this scan?");
    process.exit(1);
  }

  // Sample 5 spaced indices: 0, n/5, 2n/5, 3n/5, 4n/5
  const n = all.length;
  const sampleIndices = [0, 1, 2, 3, 4].map((i) =>
    Math.min(n - 1, Math.floor((i * n) / 5)),
  );
  const samples = [...new Set(sampleIndices)].map((i) => all[i]);
  console.log(`Sampling indices: ${sampleIndices.join(", ")}`);

  // Render markdown for Section B (append).
  const lines: string[] = [];
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("# SECTION B — SALUTEM samples (for comparison)");
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(
    `**Source:** ${samples.length} evenly-spaced rows from the ${n} SALUTEM ` +
      `\`plan\` rows for scan \`${SCAN_ID}\`. Purpose: confirm or refute the ` +
      `AMZCOM template fingerprint (5 emojis, manual \`•\` bullets, ` +
      `promotional adjectives, HTML in description) on the Brand-Registry ` +
      `cohort before deciding scrub scope.`,
  );
  lines.push("");

  const perListingTotals: Array<FindingHits & { perListingTitle: string }> = [];

  samples.forEach((r, i) => {
    const audit = r.audit_result;
    const bullets = parseJson<string[]>(audit.original_bullets, []).filter(
      (b) => typeof b === "string",
    );
    const description = audit.original_description ?? "";
    const detectedBrands = parseJson<string[]>(audit.detected_brands, []);
    const detectedLogos = parseJson<string[]>(audit.detected_logos, []);
    const reasons = parseJson<string[]>(audit.risk_reasons, []);

    lines.push(`## B${i + 1}. \`${audit.asin}\` · ${audit.account}`);
    lines.push("");
    lines.push(`**Title:** ${audit.title}`);
    lines.push(`**SKU:** \`${audit.sku ?? "—"}\``);
    lines.push("");
    lines.push("### Risk context");
    lines.push(`- **Reasons (${reasons.length}):**`);
    for (const reason of reasons) lines.push(`  - ${reason}`);
    lines.push(
      `- **detected_brands:** ${detectedBrands.length ? detectedBrands.map((b) => `\`${b}\``).join(", ") : "—"}`,
    );
    lines.push(
      `- **detected_logos:** ${detectedLogos.length ? detectedLogos.map((l) => `\`${l}\``).join(", ") : "—"}`,
    );
    lines.push("");

    lines.push(`### Original bullets (${bullets.length})`);
    lines.push("");
    bullets.forEach((b, idx) => {
      lines.push(`**${idx + 1}.**`);
      lines.push("```");
      lines.push(b);
      lines.push("```");
    });
    if (bullets.length === 0) {
      lines.push("_No bullets stored._");
      lines.push("");
    }

    lines.push(`### Original description (raw, length=${description.length})`);
    lines.push("");
    lines.push("```");
    lines.push(description || "(empty)");
    lines.push("```");
    lines.push("");

    const combined = bullets.join("\n") + "\n" + description;
    const hits = analyze(combined);
    perListingTotals.push({ ...hits, perListingTitle: audit.asin });
    lines.push("### Heuristic analysis");
    lines.push("");
    lines.push(...fmtListLine("Combined (bullets + description)", hits));
    lines.push("");
    lines.push("---");
    lines.push("");
  });

  // Aggregate across all 5 samples
  const allText =
    samples
      .map((r) => {
        const bullets = parseJson<string[]>(r.audit_result.original_bullets, []);
        return bullets.join("\n") + "\n" + (r.audit_result.original_description ?? "");
      })
      .join("\n") ?? "";
  const agg = analyze(allText);

  lines.push("## Cross-listing aggregate (5 SALUTEM samples)");
  lines.push("");
  lines.push(...fmtListLine("All SALUTEM samples", agg));
  lines.push("");

  // ── VERDICT ──
  // Decision rule: compare aggregate against the AMZCOM fingerprint.
  // AMZCOM had: many emojis, manual bullets, multiple promo words, HTML.
  // - If SALUTEM aggregate has emoji>0 OR manualBullets>0 OR promo>=3 OR HTML>=5 → same template → Verdict A
  // - If SALUTEM aggregate is fully clean (all zero) → Verdict B
  // - Mixed (e.g. only HTML but no emojis) → Verdict C
  const dirtinessHints = [
    agg.emojis.length > 0 ? `emojis=${agg.emojis.length}` : null,
    agg.manualBullets > 0 ? `manualBullets=${agg.manualBullets}` : null,
    agg.promotional.length > 0 ? `promo=${agg.promotional.length}` : null,
    Object.keys(agg.htmlTags).length > 0
      ? `html=${Object.entries(agg.htmlTags)
          .map(([t, n]) => `${t}×${n}`)
          .join(",")}`
      : null,
  ].filter(Boolean) as string[];

  const isFullyClean =
    agg.emojis.length === 0 &&
    agg.manualBullets === 0 &&
    agg.promotional.length === 0 &&
    Object.keys(agg.htmlTags).length === 0;

  const matchesAmzcomTemplate =
    agg.emojis.length > 0 &&
    (agg.manualBullets > 0 || agg.promotional.length >= 3);

  let verdict: "A" | "B" | "C";
  let verdictText: string;
  if (matchesAmzcomTemplate) {
    verdict = "A";
    verdictText =
      "SALUTEM has SAME template as AMZCOM (emojis + manual bullets + promo + HTML) — " +
      "apply UNIVERSAL scrub to all 1038 listings.";
  } else if (isFullyClean) {
    verdict = "B";
    verdictText =
      "SALUTEM is clean (no emojis, no manual bullets, no promo, no HTML) — " +
      "apply scrub ONLY to the 40 AMZCOM listings; SALUTEM proceeds with disclaimer-only.";
  } else {
    verdict = "C";
    verdictText =
      "SALUTEM has a DIFFERENT non-compliant pattern from AMZCOM " +
      `(observed: ${dirtinessHints.join(", ")}) — universal scrub still strips ` +
      `these categories, so safe default is Verdict A but a follow-up review ` +
      `may want a bespoke rule set.`;
  }

  lines.push(`## VERDICT — ${verdict}`);
  lines.push("");
  lines.push(verdictText);
  lines.push("");
  lines.push(
    `**Evidence:** SALUTEM samples (5 listings) show ` +
      (dirtinessHints.length ? dirtinessHints.join("; ") : "no policy-trigger patterns") +
      `. AMZCOM samples (3 failed listings, Section A) showed emojis=30 (5 unique), ` +
      `promo=5, HTML=46 tag instances. ` +
      (verdict === "A"
        ? "Patterns align → universal scrub."
        : verdict === "B"
          ? "Patterns diverge — SALUTEM clean → scope-limited scrub."
          : "Patterns partially overlap — keep universal scrub but watch for differences."),
  );
  lines.push("");
  lines.push(
    `Persisted as the \`SCRUB_VERDICT\` constant used by ` +
      `\`scripts/disclaimer-injection-plan.ts\` (and replan).`,
  );
  lines.push("");

  const existing = await readFile(DOC_PATH, "utf8").catch(() => "");
  // Strip any prior Section B + VERDICT block so re-running gives a fresh
  // bottom; everything above the first occurrence of "# SECTION B" stays.
  const cutoff = existing.indexOf("# SECTION B");
  const base = cutoff >= 0 ? existing.slice(0, cutoff).replace(/\n+$/, "\n") : existing;
  await mkdir(dirname(DOC_PATH), { recursive: true });
  await writeFile(DOC_PATH, base + lines.join("\n"), "utf8");
  console.log(`Appended Section B + Verdict ${verdict} → ${DOC_PATH}`);
  console.log(`VERDICT: ${verdict}`);
  console.log(verdictText);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
