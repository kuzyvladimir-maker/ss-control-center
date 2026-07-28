// Phase 2.0 Compliance Gate — main orchestrator.
//
// One call = one gate evaluation. Runs all 8 rules sequentially, persists
// a ComplianceCheck row, updates the parent BundleDraft / ChannelSKU's
// `compliance_status`, writes one ComplianceAuditLog entry, and returns
// the aggregated ComplianceDecision.
//
// Rules run sequentially (not parallel) for three reasons:
//   1. Rule 3 / Rule 4 mutate `input.bullets` / `input.description` when
//      autoFix is on; later rules (Rule 8) must see the mutated values.
//   2. The vision call (Rule 6) is the only paid step; serial execution
//      lets us short-circuit on cheap failures if we ever decide to.
//   3. Determinism for tests.
//
// Persistence is gated on the caller providing `bundle_draft_id`. Smoke
// tests / ad-hoc calls without an id get the decision in memory, no
// ComplianceCheck row is written, no audit-log entry is created.

import { prisma } from "@/lib/prisma";

import type {
  ComplianceInput,
  ComplianceOptions,
  ComplianceDecision,
  RuleResult,
} from "./types";

import { ruleTitleForeignBrands } from "./rules/rule-1-title-foreign-brands";
import { ruleBrandField } from "./rules/rule-2-brand-field";
import { ruleDisclaimerBullets } from "./rules/rule-3-disclaimer-bullets";
import { ruleDisclaimerDescription } from "./rules/rule-4-disclaimer-description";
import { ruleBrowseNode } from "./rules/rule-5-browse-node";
import { ruleImageVisionCheck } from "./rules/rule-6-image-vision-check";
import { rulePermanentBlocklist } from "./rules/rule-7-permanent-blocklist";
import { rulePromotionalLanguage } from "./rules/rule-8-promotional-language";

import { writeAuditLog } from "./audit-log";
import { findForeignBrandsInText } from "./banned-words";
import { isOwnBrandPassthrough } from "../own-brand";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function collectDetectedLogos(rules: RuleResult[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rules) {
    if (!r.details) continue;
    const logos = (r.details as Record<string, unknown>).detected_logos;
    if (!Array.isArray(logos)) continue;
    for (const l of logos) {
      if (typeof l !== "string") continue;
      const lower = l.trim().toLowerCase();
      if (!lower || seen.has(lower)) continue;
      seen.add(lower);
      out.push(l.trim());
    }
  }
  return out;
}

function collectDetectedBrands(rules: RuleResult[], title: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Rule 1: foreign brands in title.
  for (const r of rules) {
    const details = isRecord(r.details) ? r.details : null;
    if (!details) continue;
    const brands = details.foreign_brands_in_title;
    if (Array.isArray(brands)) {
      for (const b of brands) {
        if (typeof b !== "string") continue;
        const key = b.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(b);
      }
    }
  }
  // Rule 7 matches add their foreign_brand too.
  for (const r of rules) {
    if (r.rule_id !== "rule-7-permanent-blocklist") continue;
    const details = isRecord(r.details) ? r.details : null;
    if (!details) continue;
    const matches = details.matches;
    if (!Array.isArray(matches)) continue;
    for (const m of matches) {
      if (!isRecord(m)) continue;
      const b = m.foreign_brand;
      if (typeof b !== "string") continue;
      const key = b.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(b);
    }
  }
  // Safety net: anything findForeignBrandsInText catches that the rules
  // missed (e.g. when rule 1 ran with old `input.title` and the caller
  // overrode the title later).
  for (const b of findForeignBrandsInText(title)) {
    const key = b.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return out;
}

/**
 * Run the 8 hard rules on `input` and return a ComplianceDecision.
 *
 * If `input.bundle_draft_id` is set, the decision is persisted to a new
 * ComplianceCheck row and the parent draft/sku's compliance_status is
 * updated to CAN_PUBLISH or BLOCKED accordingly.
 */
export async function runComplianceGate(
  input: ComplianceInput,
  options: ComplianceOptions = {},
): Promise<ComplianceDecision> {
  // Defensive copy of bullets so rule auto-fix doesn't mutate the caller's
  // array literal across runs. Description is a primitive string — mutation
  // happens through reassignment, not aliasing.
  const workingInput: ComplianceInput = {
    ...input,
    bullets: Array.isArray(input.bullets) ? [...input.bullets] : [],
    // Own-brand passthrough (Uncrustables) — derive from the brand field when
    // the caller didn't set it. Drives Rules 1/2/3/4 below.
    own_brand: input.own_brand ?? isOwnBrandPassthrough(input.brand),
  };

  const rules: RuleResult[] = [];

  rules.push(ruleTitleForeignBrands(workingInput));
  rules.push(ruleBrandField(workingInput));
  rules.push(ruleDisclaimerBullets(workingInput, options));
  rules.push(ruleDisclaimerDescription(workingInput, options));
  rules.push(ruleBrowseNode(workingInput));
  rules.push(await ruleImageVisionCheck(workingInput));
  rules.push(await rulePermanentBlocklist(workingInput));
  rules.push(rulePromotionalLanguage(workingInput));

  const passed = rules.filter((r) => r.passed);
  const failed = rules.filter((r) => !r.passed);

  const decision: "CAN_PUBLISH" | "BLOCKED" =
    failed.length === 0 ? "CAN_PUBLISH" : "BLOCKED";

  const cost_cents = rules.reduce((acc, r) => acc + (r.cost_cents ?? 0), 0);
  const detected_logos = collectDetectedLogos(rules);
  const detected_brands = collectDetectedBrands(rules, workingInput.title);

  let compliance_check_id: string | undefined;

  if (workingInput.bundle_draft_id) {
    const check = await prisma.complianceCheck.create({
      data: {
        bundle_draft_id: workingInput.bundle_draft_id,
        channel_sku_id: workingInput.channel_sku_id ?? null,
        decision,
        hard_rules_passed: JSON.stringify(passed.map((r) => r.rule_id)),
        hard_rules_failed: JSON.stringify(
          failed.map((r) => ({
            rule_id: r.rule_id,
            reason: r.reason ?? null,
            details: r.details ?? null,
          })),
        ),
        detected_brands: detected_brands.length
          ? JSON.stringify(detected_brands)
          : null,
        detected_logos: detected_logos.length
          ? JSON.stringify(detected_logos)
          : null,
        ai_vision_response: null,
        cost_cents,
      },
      select: { id: true },
    });
    compliance_check_id = check.id;

    const blockedReasons = failed.map((r) => r.rule_id);

    // Update BundleDraft.
    await prisma.bundleDraft.update({
      where: { id: workingInput.bundle_draft_id },
      data: {
        compliance_status: decision,
        compliance_check_id: check.id,
        compliance_blocked_at: decision === "BLOCKED" ? new Date() : null,
        compliance_blocked_reasons:
          decision === "BLOCKED" ? JSON.stringify(blockedReasons) : null,
      },
    });

    // Update ChannelSKU if check was scoped to one.
    if (workingInput.channel_sku_id) {
      await prisma.channelSKU.update({
        where: { id: workingInput.channel_sku_id },
        data: {
          compliance_status: decision,
          compliance_check_id: check.id,
          compliance_blocked_at: decision === "BLOCKED" ? new Date() : null,
          compliance_blocked_reasons:
            decision === "BLOCKED" ? JSON.stringify(blockedReasons) : null,
        },
      });
    }

    await writeAuditLog({
      bundle_draft_id: workingInput.bundle_draft_id,
      channel_sku_id: workingInput.channel_sku_id ?? null,
      event_type: "gate_check",
      actor: options.actor ?? "system",
      decision,
      event_details: {
        compliance_check_id: check.id,
        rule_summary: rules.map((r) => ({
          rule_id: r.rule_id,
          passed: r.passed,
          reason: r.reason ?? null,
          auto_fix_applied: r.auto_fix_applied ?? false,
        })),
        cost_cents,
      },
    });
  }

  return {
    decision,
    rules,
    compliance_check_id,
    cost_cents,
    final_bullets: workingInput.bullets,
    final_description: workingInput.description,
    detected_brands,
    detected_logos,
  };
}
