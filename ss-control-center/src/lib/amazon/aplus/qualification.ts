/**
 * A+ Content Factory — qualification gate (deterministic).
 *
 * Checks a generated A+ document against everything in the knowledge base before
 * it can go to approval/publish: brand voice, A+ content policy, and the IP/gift-set
 * rules. Errors BLOCK; warnings are surfaced for the operator. The LLM generator is
 * prompted to satisfy these, and Amazon's validate endpoint is the final check —
 * this gate catches violations cheaply and locally first.
 *
 * Rules: docs/wiki/aplus-content-knowledge-base.md + aplus-ip-giftset-rules.md.
 */

import { MAX_MODULES, type AplusDocument } from "./modules";

export interface Violation { severity: "error" | "warn"; rule: string; found: string }
export interface QualificationResult { pass: boolean; violations: Violation[] }

// HARD (block) — regexes are word-boundary where sensible.
const HARD: { rule: string; re: RegExp }[] = [
  { rule: "pricing/promo/discount", re: /\b(cheap|affordable|discount|\bsale\b|bonus|coupon|lowest price|% ?off|save \$|deal of)\b/i },
  { rule: "shipping claim", re: /\b(free shipping|fast shipping|free delivery)\b/i },
  { rule: "guarantee/warranty", re: /\b(guarantee|guaranteed|warranty|money[- ]back|satisfaction guaranteed)\b/i },
  { rule: "purchase CTA", re: /\b(buy now|add to cart|shop now|order now|get yours|click here)\b/i },
  { rule: "contact/link", re: /(https?:\/\/|www\.|\b[\w.+-]+@[\w-]+\.[\w.]+\b|\b\d{3}[-.]\d{3}[-.]\d{4}\b)/i },
  { rule: "eco claim (banned Oct-2024)", re: /\b(eco[- ]friendly|biodegradable|compostable)\b/i },
  { rule: "ranking superlative", re: /(#1\b|\bnumber one\b|best[- ]selling|top[- ]rated)\b/i },
  { rule: "health/medical claim", re: /\b(cure|cures|treat|treats|prevent|prevents|detox|weight loss|heal\b|boosts? (immunity|health))\b/i },
  { rule: "affiliation/endorsement (IP)", re: /\b(authorized|official|endorsed|licensed|in partnership|in collaboration|affiliated with)\b/i },
  // PDP 99300 triggers — defensive trademark language reads as a claim.
  { rule: "PDP-99300 trigger", re: /\b(not affiliated|trademarks? (belong|are the property)|respective owners?|sourced from authorized)\b/i },
];
// SOFT (warn) — brand-voice promo adjectives (we also scrub these) + time-sensitive.
const SOFT: { rule: string; re: RegExp }[] = [
  { rule: "promo adjective", re: /\b(ultimate|perfect|premium|best|amazing|incredible|exclusive|must[- ]have|finest|exceptional|outstanding|magnificent|wonderful|fantastic|superior|world[- ]class|awesome|delightful|delicious|ideal)\b/i },
  { rule: "emoji", re: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}✅⭐]/u },
  { rule: "time-sensitive word", re: /\b(on sale now|latest|brand new)\b/i },
];

const DISCLAIMER_RE = /curated and assembled by salutem solutions/i;

/** Pull every text string out of an A+ document for scanning. */
function collectText(doc: AplusDocument): string {
  const parts: string[] = [doc.name];
  const walk = (o: unknown) => {
    if (o == null) return;
    if (typeof o === "string") { parts.push(o); return; }
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (typeof o === "object") { for (const v of Object.values(o as Record<string, unknown>)) walk(v); }
  };
  walk(doc.contentModuleList);
  return parts.join("  ");
}

export function qualify(doc: AplusDocument): QualificationResult {
  const violations: Violation[] = [];
  const all = collectText(doc);

  for (const { rule, re } of HARD) {
    const m = all.match(re);
    if (m) violations.push({ severity: "error", rule, found: m[0] });
  }
  for (const { rule, re } of SOFT) {
    const m = all.match(re);
    if (m) violations.push({ severity: "warn", rule, found: m[0] });
  }

  // Structural: module count, disclaimer presence.
  if ((doc.contentModuleList?.length ?? 0) > MAX_MODULES) {
    violations.push({ severity: "error", rule: "too many modules (>7)", found: String(doc.contentModuleList.length) });
  }
  if ((doc.contentModuleList?.length ?? 0) === 0) {
    violations.push({ severity: "error", rule: "no modules", found: "0" });
  }
  if (!DISCLAIMER_RE.test(all)) {
    violations.push({ severity: "error", rule: "missing curator disclaimer", found: "—" });
  }

  return { pass: !violations.some((v) => v.severity === "error"), violations };
}
