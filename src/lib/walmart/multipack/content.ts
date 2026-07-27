// Walmart Quantity-Confusion Fix — content layer. Rewrites title + the lead
// bullets so the pack count and the "1 order = N" formula are impossible to
// miss. Deterministic and brand-voice safe (no promo adjectives, no emoji —
// see CLAUDE.md). Respects Walmart limits: title <= 75 chars, bullet <= 500.

// Brand-voice enforcement now lives in the shared lib (Phase 0.3). Re-exported
// so existing importers (`./content`) keep working.
import { scrubBrandVoice } from "@/lib/brand-voice";
export { scrubBrandVoice };

const TITLE_MAX = 75;

/** Best-effort physical-unit noun from the product title, for natural copy. */
export function inferUnitNoun(title: string): string {
  const t = title.toLowerCase();
  if (/\bbread\b|\bloaf\b|\bbrioche\b/.test(t)) return "loaves";
  if (/\bdrink\b|\bbottle\b|\bwater\b|\bjuice\b/.test(t)) return "bottles";
  if (/\bsoup\b|\bbeans?\b|\btomato\b|\bcan\b|\bcanned\b/.test(t)) return "cans";
  if (/\bbuns?\b|\btortillas?\b|\bwraps?\b/.test(t)) return "bags";
  return "packages";
}

/** Strip an existing "(Pack of N)" / "N-Pack" / our "— N-Pack (N noun)" suffix
 *  so re-running on an already-updated title is idempotent. Handles em-dash. */
function stripPackPhrase(title: string): string {
  return title
    .replace(/\s*[—–-]\s*\d+[-\s]?pack\s*\(\s*\d+\s+\w+\s*\)\s*$/i, "") // our "— N-Pack (N noun)"
    .replace(/\s*\(\s*\d+\s+\w+\s*\)\s*$/i, "")                          // leftover "(N noun)"
    .replace(/[,—–-]?\s*\(?\bpack of \d+\b\)?/i, "")
    .replace(/[,—–-]?\s*\b\d+[-\s]?pack\b/i, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s,;—–-]+$/, "")
    .trim();
}

export interface MultipackContent {
  title: string;
  bullets: string[];
  description: string;
}

const QUANTITY_RE = /quantity 1|pack ships|order contains|multipack of|ships all|same item shown|not 1\b/i;

/** The single, canonical pack-quantity sentence — stated once, in the description. */
export function quantityLeadSentence(packCount: number, noun: string): string {
  const n = Math.max(2, Math.floor(packCount));
  return `This listing is a multipack of ${n} ${noun}: one order ships all ${n} ${noun} together — selecting quantity 1 sends ${n}, not 1.`;
}

export interface ListingContent {
  title: string;
  keyFeatures: string[];
  description: string;
}

/**
 * Professional listing rebuild for a multipack. The pack-quantity message is
 * stated EXACTLY ONCE — in the description's lead sentence (it is already in the
 * title, the main image, and the badge). Bullets stay product-focused, sourced
 * from the donor's parsed feature bullets (brand-voice scrubbed, lightly
 * normalized), so they carry the real selling info that drives content score.
 */
export function buildMultipackListing(
  currentTitle: string,
  packCount: number,
  opts: { noun?: string; donorBullets?: string[]; donorDescription?: string } = {},
): ListingContent {
  const n = Math.max(2, Math.floor(packCount));
  const noun = opts.noun ?? inferUnitNoun(currentTitle);
  const base = stripPackPhrase(currentTitle);

  const suffix = ` — ${n}-Pack (${n} ${noun})`;
  let title = base + suffix;
  if (title.length > TITLE_MAX) {
    const room = TITLE_MAX - suffix.length;
    title = base.slice(0, Math.max(0, room)).replace(/[\s,;–-]+$/, "") + suffix;
  }

  // Bullets: donor product bullets, scrubbed + de-duped, never the quantity line.
  const seen = new Set<string>();
  let keyFeatures = (opts.donorBullets ?? [])
    .map(scrubBrandVoice)
    .filter((b) => b.length >= 8 && b.length <= 500 && !QUANTITY_RE.test(b))
    .filter((b) => { const k = b.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });

  // If the donor was thin on bullets, derive a few factual ones from sentences
  // in its description so the content score isn't starved.
  if (keyFeatures.length < 3 && opts.donorDescription) {
    for (const s of opts.donorDescription.split(/(?<=[.!?])\s+|\n+/)) {
      const c = scrubBrandVoice(s.replace(/^•\s*/, ""));
      if (c.length >= 12 && c.length <= 300 && !QUANTITY_RE.test(c)) {
        const k = c.toLowerCase();
        if (!seen.has(k)) { seen.add(k); keyFeatures.push(c); }
      }
      if (keyFeatures.length >= 5) break;
    }
  }
  keyFeatures = keyFeatures.slice(0, 8);

  // Quantity message: stated ONCE, here, as the description lead.
  const quantityLead = quantityLeadSentence(n, noun);
  const donorDesc = (opts.donorDescription ?? "")
    .split(/\n+/).map(scrubBrandVoice).filter((l) => l && !QUANTITY_RE.test(l)).join(" ")
    .slice(0, 4000);
  const description = donorDesc ? `${quantityLead}\n\n${donorDesc}` : quantityLead;

  return { title, keyFeatures, description };
}

/**
 * Rewrite listing content with an explicit, front-loaded pack count.
 *   - title: "<product> — N-Pack (N <noun>)" trimmed to 75 chars
 *   - bullet[0]: the anti-confusion formula
 *   - bullet[1]: what one order physically is
 * Existing bullets (if any) are preserved after the two we prepend.
 */
export function rewriteMultipackContent(
  currentTitle: string,
  packCount: number,
  opts: { noun?: string; existingBullets?: string[] } = {},
): MultipackContent {
  const n = Math.max(2, Math.floor(packCount));
  const noun = opts.noun ?? inferUnitNoun(currentTitle);
  const base = stripPackPhrase(currentTitle);

  const suffix = ` — ${n}-Pack (${n} ${noun})`;
  let title = base + suffix;
  if (title.length > TITLE_MAX) {
    const room = TITLE_MAX - suffix.length;
    title = base.slice(0, Math.max(0, room)).replace(/[\s,;–-]+$/, "") + suffix;
  }

  // "a multipack of N" avoids the a/an-before-a-number grammar trap
  // ("a 8-pack" reads as "a eight-pack"). Walmart channel: original brand
  // only, NO own-brand / gift-set / curator claim (per project rules).
  const formula = `This listing is a multipack of ${n} ${noun}. One order ships all ${n} ${noun}. Selecting quantity 1 sends ${n} ${noun}, not 1.`;
  const oneOrder = `Each order contains ${n} ${noun} packaged together. To receive ${n} ${noun}, order quantity 1.`;

  // A third, purely factual bullet so we always meet Walmart's per-product-type
  // minimum of 3 keyFeatures, even when the donor listing carried none.
  const sameItem = `All ${n} ${noun} are the same item shown in the product photos.`;

  const kept = (opts.existingBullets ?? []).filter(
    (b) => b && !/quantity 1|pack ships|order contains|multipack of|same item shown/i.test(b),
  );
  const bullets = [formula, oneOrder, sameItem, ...kept].slice(0, 9);

  const description =
    `${formula} ${oneOrder}\n\n` +
    `The ${n} ${noun} are the same item shown in the photos.`;

  return { title, bullets, description };
}
