// Walmart Quantity-Confusion Fix — content layer. Rewrites title + the lead
// bullets so the pack count and the "1 order = N" formula are impossible to
// miss. Deterministic and brand-voice safe (no promo adjectives, no emoji —
// see CLAUDE.md). Respects Walmart limits: title <= 75 chars, bullet <= 500.

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

/** Strip an existing trailing "(Pack of N)" / "N-Pack" so we can re-state it cleanly. */
function stripPackPhrase(title: string): string {
  return title
    .replace(/[,\-–]?\s*\(?\bpack of \d+\b\)?/i, "")
    .replace(/[,\-–]?\s*\b\d+[-\s]?pack\b/i, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s,;–-]+$/, "")
    .trim();
}

export interface MultipackContent {
  title: string;
  bullets: string[];
  description: string;
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

  const kept = (opts.existingBullets ?? []).filter(
    (b) => b && !/quantity 1|pack ships|order contains|multipack of/i.test(b),
  );
  const bullets = [formula, oneOrder, ...kept].slice(0, 9);

  const description =
    `${formula} ${oneOrder}\n\n` +
    `The ${n} ${noun} are the same item shown in the photos.`;

  return { title, bullets, description };
}
