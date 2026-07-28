/**
 * Phase 2.6.1 — Inspect content of failed disclaimer-injection listings.
 *
 * After the 2026-05-19 AMZCOM safety test produced 10/10 failures with
 * Amazon error code 99300 ("false/promotional claims or external
 * links"), we need to look at the EXISTING bullets + description that
 * Amazon's PDP classifier is rejecting — Amazon validates the FULL
 * PATCH body, not the delta, so our additive disclaimer text isn't
 * the cause; the existing content is.
 *
 * This script is read-only. No SP-API calls. Just queries Turso for the
 * first 3 failed remediations of the target scan and dumps everything
 * we know about them, plus a heuristic content analysis (emojis, URLs,
 * promotional/health claim words, HTML tags) that points at what the
 * classifier is likely catching.
 *
 * Usage:
 *   set -a; source .env.local; set +a
 *   npx tsx scripts/inspect-failed-content.ts
 */

import "dotenv/config";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { prisma } from "@/lib/prisma";

const SCAN_ID = "cmpaisoq80000wlfz4llxuo5k";
const OUTPUT_PATH = join(
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
  "fat-burning",
  "fat burning",
  "lean",
  "fortified",
  "wellness",
  "vitality",
];

// Emoji ranges per the Unicode TR51 emoji presentation properties.
const EMOJI_RE =
  /[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{2300}-\u{23FF}\u{2700}-\u{27BF}]/gu;

const URL_RE = /\b(?:https?:\/\/|www\.)[\w./?%&=#:-]+/gi;

const HTML_TAG_RE = /<\/?([a-zA-Z][\w-]*)(?:\s[^>]*)?>/g;

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
  urls: string[];
  promotional: string[];
  healthClaims: string[];
  htmlTags: Record<string, number>;
}

function analyze(text: string): FindingHits {
  const lower = text.toLowerCase();
  const emojis = text.match(EMOJI_RE) ?? [];
  const urls = text.match(URL_RE) ?? [];
  const promotional = PROMOTIONAL_WORDS.filter((w) => lower.includes(w));
  const healthClaims = HEALTH_CLAIM_WORDS.filter((w) =>
    new RegExp(`\\b${w.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i").test(text),
  );
  const htmlTags: Record<string, number> = {};
  for (const m of text.matchAll(HTML_TAG_RE)) {
    const tag = m[1].toLowerCase();
    htmlTags[tag] = (htmlTags[tag] ?? 0) + 1;
  }
  return { emojis, urls, promotional, healthClaims, htmlTags };
}

function summarise(label: string, h: FindingHits): string[] {
  const lines: string[] = [];
  lines.push(`- **${label} emoji count:** ${h.emojis.length}` + (h.emojis.length ? ` — \`${[...new Set(h.emojis)].join(" ")}\`` : ""));
  lines.push(`- **${label} URLs:** ${h.urls.length}` + (h.urls.length ? ` — ${h.urls.map((u) => `\`${u}\``).join(", ")}` : ""));
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
  const rows = await prisma.listingRemediation.findMany({
    where: {
      status: "failed",
      audit_result: { scan_id: SCAN_ID },
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
    orderBy: { completed_at: "desc" },
    take: 3,
  });

  console.log(`Loaded ${rows.length} failed rows for scan ${SCAN_ID}`);
  if (rows.length === 0) {
    console.warn("No failed rows found — nothing to inspect.");
    return;
  }

  const lines: string[] = [];
  lines.push(`# Phase 2.6.1 — Failed AMZCOM Listings Content Analysis`);
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Scan:** \`${SCAN_ID}\``);
  lines.push(`**Failure mode:** Amazon PDP code 99300 — "false/promotional claims or external links"`);
  lines.push("");
  lines.push(
    "All 10 AMZCOM listings in the 2026-05-19 safety test were rejected by " +
      "Amazon's PDP classifier during VALIDATION_PREVIEW (before any real " +
      "PATCH). Since SP-API PATCH replaces the FULL `bullet_point[]` and " +
      "`product_description` arrays, Amazon validates everything we send — " +
      "not just our added disclaimer. The disclaimer text itself is " +
      "defensive (no claims, no URLs), so the trigger must be in the " +
      "existing content this dump exposes.",
  );
  lines.push("");

  let i = 0;
  for (const r of rows) {
    i++;
    const audit = r.audit_result;
    const bullets = parseJson<string[]>(audit.original_bullets, []).filter(
      (b) => typeof b === "string",
    );
    const description = audit.original_description ?? "";
    const detectedBrands = parseJson<string[]>(audit.detected_brands, []);
    const detectedLogos = parseJson<string[]>(audit.detected_logos, []);
    const reasons = parseJson<string[]>(audit.risk_reasons, []);

    lines.push(`## ${i}. \`${audit.asin}\` · ${audit.account}`);
    lines.push("");
    lines.push(`**Title:** ${audit.title}`);
    lines.push(`**SKU:** \`${audit.sku ?? "—"}\``);
    lines.push("");

    lines.push("### Risk context");
    lines.push(`- **Reasons (${reasons.length}):**`);
    for (const reason of reasons) lines.push(`  - ${reason}`);
    lines.push(`- **detected_brands:** ${detectedBrands.length ? detectedBrands.map((b) => `\`${b}\``).join(", ") : "—"}`);
    lines.push(`- **detected_logos:** ${detectedLogos.length ? detectedLogos.map((l) => `\`${l}\``).join(", ") : "—"}`);
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
    lines.push(description);
    lines.push("```");
    lines.push("");

    // Heuristic analysis
    const joinedBullets = bullets.join("\n");
    const bulletsHits = analyze(joinedBullets);
    const descHits = analyze(description);

    lines.push("### Heuristic analysis — what might trigger PDP code 99300");
    lines.push("");
    lines.push(...summarise("Bullets", bulletsHits));
    lines.push(...summarise("Description", descHits));
    lines.push("");

    const verdict: string[] = [];
    if (bulletsHits.emojis.length > 0 || descHits.emojis.length > 0) {
      verdict.push(
        "Emojis present — Amazon's automated PDP classifier sometimes treats them as decoration violating bullet-point guidelines (which require plain factual text).",
      );
    }
    if (bulletsHits.promotional.length > 0 || descHits.promotional.length > 0) {
      verdict.push(
        "Promotional language present — Amazon's policy explicitly bans 'subjective claims' (perfect/ultimate/incredible/etc.) in bullets and descriptions.",
      );
    }
    if (bulletsHits.healthClaims.length > 0 || descHits.healthClaims.length > 0) {
      verdict.push(
        "Health/wellness words present — for grocery + supplements categories these can trigger FDA-related compliance flags inside Amazon's classifier.",
      );
    }
    if (bulletsHits.urls.length > 0 || descHits.urls.length > 0) {
      verdict.push(
        "URLs present — explicit external-link policy violation; Amazon strips/blocks these.",
      );
    }
    if (Object.keys(descHits.htmlTags).length > 0) {
      verdict.push(
        `HTML tags present in description (${Object.keys(descHits.htmlTags).join(", ")}). Limited HTML is allowed in product_description for some product types; for others it's stripped; in either case the validation classifier may treat unbalanced/disallowed tags as a 99300.`,
      );
    }
    if (verdict.length > 0) {
      lines.push("**Likely 99300 triggers:**");
      verdict.forEach((v) => lines.push(`- ${v}`));
    } else {
      lines.push(
        "**No obvious 99300 triggers** found by these heuristics. The classifier may be matching on a phrase that isn't on our wordlist.",
      );
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  // Final overview across all 3 rows.
  lines.push("## Cross-listing patterns");
  lines.push("");
  const allBulletsText = rows
    .flatMap((r) => parseJson<string[]>(r.audit_result.original_bullets, []))
    .join("\n");
  const allDescText = rows.map((r) => r.audit_result.original_description ?? "").join("\n");
  const allTextHits = analyze(allBulletsText + "\n" + allDescText);
  lines.push("Aggregating across the 3 sample listings:");
  lines.push(...summarise("All bullets+description", allTextHits));
  lines.push("");
  lines.push(
    "If the same heuristic categories (emojis, promotional words, HTML tags) " +
      "fire on all three, that's a strong signal the AMZCOM seed content " +
      "was generated by the same template/tool — and a single content " +
      "sanitiser (Phase 2.6.2 Title/Content rewrite) would fix the whole " +
      "cohort. If the categories diverge per listing, sanitisation needs to " +
      "be per-listing rather than templated.",
  );
  lines.push("");

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, lines.join("\n"), "utf8");
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
