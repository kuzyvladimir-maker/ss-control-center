/**
 * Phase 2.2 Stage 4 — Content pipeline orchestrator.
 *
 * Combines content-generation + compliance-gate + retry-with-feedback +
 * persistence into one entry point: `runContentGeneration(draft_id, channels)`.
 *
 * Per-call flow (one Claude template invocation):
 *   1. Claude generates title/bullets/description.
 *   2. runComplianceGate({ autoFix: true }) checks the output. Rules 3 + 4
 *      inject the curator disclaimer automatically — final_bullets and
 *      final_description from the decision are what we persist.
 *   3. If decision = CAN_PUBLISH → save GeneratedContent row, done.
 *   4. If decision = BLOCKED → format failed rules into a regeneration
 *      prompt and call Claude again. Repeat up to MAX_RETRIES.
 *   5. After MAX_RETRIES still BLOCKED → save row with
 *      compliance_status=BLOCKED and manual_review_required=true.
 *
 * Multi-channel dedup:
 *   Each unique template (`amazon`, `walmart`) gets ONE Claude call —
 *   even if 5 Amazon accounts target the draft. The 5 Amazon channels
 *   then get GeneratedContent rows that all point at the same generated
 *   text (template field tracks which row paid Claude; siblings carry
 *   generation_cost_cents = 0).
 *
 * Compliance accounting:
 *   Each channel row gets its own ComplianceCheck (re-runs the gate per
 *   channel, since the channel-specific browse_node / image affect Rule
 *   5 + Rule 6). For Phase 2.2 we run with `skip_image_check: true` —
 *   the image gate fires in Phase 2.3 when main_image_url is set.
 */

import { prisma } from "@/lib/prisma";
import {
  generateContent,
  type ContentGenerationInput,
  type ContentGenerationOutput,
} from "./content-generation";
import type { KbChannelTemplate } from "./kb-loader";
import { runComplianceGate } from "./compliance/gate";
import type {
  BundleComponentInput,
  RuleResult,
} from "./compliance/types";
import { logLifecycle } from "./lifecycle-log";
import type { Variant } from "./variation-matrix";
import { NotFoundError, PreconditionError } from "./errors";
import {
  countDistinctBrands,
  resolveAmazonBrowseNode,
} from "./browse-node-resolver";

const MAX_RETRIES = 3;

/**
 * Channel → template mapping. The 5 Amazon channels share one Claude
 * call, Walmart gets its own.
 */
export function channelTemplate(channel: string): KbChannelTemplate {
  return channel === "WALMART" ? "walmart" : "amazon";
}

export interface RunContentGenerationInput {
  bundle_draft_id: string;
  /** Optional subset; defaults to all channels on the draft. */
  channels?: string[];
  actor?: string;
}

export interface ChannelOutcome {
  channel: string;
  template: KbChannelTemplate;
  compliance_status: "CAN_PUBLISH" | "BLOCKED";
  attempts: number;
  generation_cost_cents: number;
  manual_review_required: boolean;
  failed_rule_ids: string[];
  generated_content_id: string;
  is_template_owner: boolean;
}

export interface RunContentGenerationResult {
  ok: boolean;
  bundle_draft_id: string;
  outcomes: ChannelOutcome[];
  total_cost_cents: number;
  duration_ms: number;
  error?: string;
}

export async function runContentGeneration(
  input: RunContentGenerationInput,
): Promise<RunContentGenerationResult> {
  const startMs = Date.now();

  const draft = await prisma.bundleDraft.findUnique({
    where: { id: input.bundle_draft_id },
    include: { variation_matrix: true },
  });
  if (!draft) {
    throw new NotFoundError(`BundleDraft ${input.bundle_draft_id} not found`);
  }
  if (!draft.variation_matrix) {
    throw new PreconditionError(
      `BundleDraft ${draft.id} has no VariationMatrix — generate variations first`,
    );
  }
  if (draft.variation_matrix.selected_variant_idx == null) {
    throw new PreconditionError(
      `BundleDraft ${draft.id} has no selected variant — call select-variation first`,
    );
  }

  let variants: Variant[];
  try {
    variants = JSON.parse(draft.variation_matrix.variants_json) as Variant[];
  } catch (e) {
    throw new Error(
      `VariationMatrix.variants_json is malformed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const selected = variants[draft.variation_matrix.selected_variant_idx];
  if (!selected) {
    throw new Error(
      `Selected variant idx ${draft.variation_matrix.selected_variant_idx} is out of range`,
    );
  }

  const allChannels: string[] = (() => {
    try {
      const parsed = JSON.parse(draft.target_channels) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((c): c is string => typeof c === "string");
      }
    } catch {
      /* fall through */
    }
    return [];
  })();
  const channels =
    input.channels && input.channels.length > 0 ? input.channels : allChannels;
  if (channels.length === 0) {
    throw new Error(`No channels supplied and draft.target_channels is empty`);
  }

  // Build the per-template input once (it's the same content for both
  // 'amazon' and 'walmart' — only the system prompt differs via template).
  const bundleComponents: BundleComponentInput[] = selected.composition.map(
    (c) => ({ brand: c.brand, product_name: c.product_name }),
  );

  // Phase 1 — pull the primary donor's harvested content so Claude ADAPTS real
  // catalog data (titles/bullets/description/ingredients/nutrition harvested
  // from Walmart/Sam's/BJ's/etc.) instead of inventing. A studio-built
  // component's research_pool_id IS the DonorProduct id; brief-built drafts may
  // not match — graceful (donor_reference stays undefined → prior behaviour).
  let donorReference: ContentGenerationInput["donor_reference"];
  const primaryDonorId = selected.composition[0]?.research_pool_id;
  if (primaryDonorId) {
    const donor = await prisma.donorProduct.findUnique({
      where: { id: primaryDonorId },
      select: {
        title: true,
        bullets: true,
        description: true,
        ingredients: true,
        nutritionFacts: true,
      },
    });
    if (donor) {
      let bullets: string[] | undefined;
      try {
        const b = donor.bullets ? JSON.parse(donor.bullets) : null;
        if (Array.isArray(b)) {
          bullets = b.filter((x): x is string => typeof x === "string");
        }
      } catch {
        /* malformed donor.bullets JSON — skip */
      }
      donorReference = {
        title: donor.title ?? undefined,
        bullets: bullets && bullets.length > 0 ? bullets : undefined,
        description: donor.description ?? undefined,
        ingredients: donor.ingredients ?? undefined,
        nutrition: donor.nutritionFacts ?? undefined,
      };
    }
  }

  const generationInputBase = {
    draft_name: draft.draft_name,
    brand: draft.brand,
    category: draft.category,
    composition_type: draft.composition_type,
    pack_count: draft.pack_count,
    selected_variant: selected,
    donor_reference: donorReference,
  };

  // Generate per template (dedup the 5 Amazon channels into one Claude
  // call). For each channel, run the compliance gate separately so the
  // ComplianceCheck row + auto-fix mutation lives per-channel.
  const templates = new Set<KbChannelTemplate>();
  for (const ch of channels) templates.add(channelTemplate(ch));

  const templateResults = new Map<
    KbChannelTemplate,
    {
      content: ContentGenerationOutput;
      attempts: number;
      failed_rule_ids: string[];
      final_bullets: string[];
      final_description: string;
      final_compliance_check_id?: string;
      compliance_passed: boolean;
    }
  >();

  let totalCost = 0;
  let topLevelError: string | undefined;

  // The browse_node we feed into the compliance gate is the same for
  // every Amazon channel that shares the "amazon" template — it's
  // derived from the bundle composition, not the channel. Multi-brand
  // bundles get the Gift Basket Exception primary node (required by
  // compliance Rule 5); single-brand still defaults there for now (see
  // browse-node-resolver for the future per-category swap).
  const distinctBrands = countDistinctBrands(bundleComponents);
  // Pick any AMAZON_ channel that the template covers — the resolver
  // only cares about the prefix, so any one works. For "walmart" we
  // pass a synthetic WALMART channel so the resolver returns null.
  const templateChannelHint = (template: KbChannelTemplate): string =>
    template === "amazon"
      ? (channels.find((c) => c.startsWith("AMAZON_")) ?? "AMAZON_AMZCOM")
      : "WALMART";

  for (const template of templates) {
    const browseNode = resolveAmazonBrowseNode({
      channel: templateChannelHint(template),
      distinct_brands: distinctBrands,
    });
    const r = await generateAndComply({
      input: { ...generationInputBase, template } as ContentGenerationInput,
      draft_id: draft.id,
      bundle_components: bundleComponents,
      browse_node: browseNode,
    });
    templateResults.set(template, r);
    totalCost += r.content.cost_cents;
    if (r.content.error && !r.compliance_passed) {
      // Surface but keep going for the other template.
      topLevelError = r.content.error;
    }
  }

  const outcomes: ChannelOutcome[] = [];
  for (const channel of channels) {
    const template = channelTemplate(channel);
    const tr = templateResults.get(template);
    if (!tr) {
      // Shouldn't happen — we built the templates set from channels.
      continue;
    }

    // Determine if this row is the "template owner" (pays Claude cost).
    const isOwner = !outcomes.some((o) => o.template === template);

    const row = await prisma.generatedContent.upsert({
      where: {
        bundle_draft_id_channel: {
          bundle_draft_id: draft.id,
          channel,
        },
      },
      create: {
        bundle_draft_id: draft.id,
        channel,
        template,
        title: tr.content.title,
        bullets_json: JSON.stringify(tr.final_bullets),
        description: tr.final_description,
        compliance_status: tr.compliance_passed ? "CAN_PUBLISH" : "BLOCKED",
        compliance_check_id: tr.final_compliance_check_id ?? null,
        compliance_attempts: tr.attempts,
        manual_review_required: !tr.compliance_passed,
        failed_rule_ids: tr.failed_rule_ids.length
          ? JSON.stringify(tr.failed_rule_ids)
          : null,
        generation_cost_cents: isOwner ? tr.content.cost_cents : 0,
        claude_response_id: isOwner ? tr.content.claude_response_id : null,
        claude_input_tokens: isOwner ? tr.content.input_tokens : 0,
        claude_output_tokens: isOwner ? tr.content.output_tokens : 0,
        cache_read_tokens: isOwner ? tr.content.cache_read_tokens : 0,
        cache_write_tokens: isOwner ? tr.content.cache_write_tokens : 0,
      },
      update: {
        template,
        title: tr.content.title,
        bullets_json: JSON.stringify(tr.final_bullets),
        description: tr.final_description,
        compliance_status: tr.compliance_passed ? "CAN_PUBLISH" : "BLOCKED",
        compliance_check_id: tr.final_compliance_check_id ?? null,
        compliance_attempts: tr.attempts,
        manual_review_required: !tr.compliance_passed,
        failed_rule_ids: tr.failed_rule_ids.length
          ? JSON.stringify(tr.failed_rule_ids)
          : null,
        // Cost columns only update for the template owner row to avoid
        // double-counting on regeneration.
        ...(isOwner
          ? {
              generation_cost_cents: tr.content.cost_cents,
              claude_response_id: tr.content.claude_response_id,
              claude_input_tokens: tr.content.input_tokens,
              claude_output_tokens: tr.content.output_tokens,
              cache_read_tokens: tr.content.cache_read_tokens,
              cache_write_tokens: tr.content.cache_write_tokens,
            }
          : {}),
      },
      select: { id: true },
    });

    outcomes.push({
      channel,
      template,
      compliance_status: tr.compliance_passed ? "CAN_PUBLISH" : "BLOCKED",
      attempts: tr.attempts,
      generation_cost_cents: isOwner ? tr.content.cost_cents : 0,
      manual_review_required: !tr.compliance_passed,
      failed_rule_ids: tr.failed_rule_ids,
      generated_content_id: row.id,
      is_template_owner: isOwner,
    });
  }

  // Flip the draft status when every channel is CAN_PUBLISH. Mixed
  // result → leave at VARIATION_SELECTED so the operator can re-run
  // regenerate-content after manual review.
  const allPassed = outcomes.every((o) => o.compliance_status === "CAN_PUBLISH");
  if (allPassed) {
    await prisma.bundleDraft.update({
      where: { id: draft.id },
      data: { status: "GENERATED" },
    });
    await logLifecycle({
      entity_type: "BundleDraft",
      entity_id: draft.id,
      from_status: draft.status,
      to_status: "GENERATED",
      reason: `Content generated and compliance-passed for ${outcomes.length} channels`,
      actor: input.actor ?? "system",
      details: {
        total_cost_cents: totalCost,
        templates: Array.from(templates),
        outcomes: outcomes.map((o) => ({
          channel: o.channel,
          attempts: o.attempts,
        })),
      },
    });
  } else {
    // Still flag in the lifecycle log so the audit trail is complete.
    await logLifecycle({
      entity_type: "BundleDraft",
      entity_id: draft.id,
      from_status: draft.status,
      to_status: draft.status, // no transition
      reason: `Content generated; some channels need manual review`,
      actor: input.actor ?? "system",
      details: {
        total_cost_cents: totalCost,
        outcomes: outcomes.map((o) => ({
          channel: o.channel,
          status: o.compliance_status,
          failed: o.failed_rule_ids,
        })),
      },
    });
  }

  return {
    ok: outcomes.some((o) => o.compliance_status === "CAN_PUBLISH"),
    bundle_draft_id: draft.id,
    outcomes,
    total_cost_cents: totalCost,
    duration_ms: Date.now() - startMs,
    error: topLevelError,
  };
}

// ── Per-template generation with retry loop ─────────────────────────────

interface GenerateAndComplyInput {
  input: ContentGenerationInput;
  draft_id: string;
  bundle_components: BundleComponentInput[];
  browse_node: string | null;
}

async function generateAndComply(args: GenerateAndComplyInput): Promise<{
  content: ContentGenerationOutput;
  attempts: number;
  failed_rule_ids: string[];
  final_bullets: string[];
  final_description: string;
  final_compliance_check_id?: string;
  compliance_passed: boolean;
}> {
  let attempt = 0;
  let lastContent: ContentGenerationOutput | null = null;
  let lastFailedRules: RuleResult[] = [];
  let priorFailure: ContentGenerationInput["prior_failure"] | undefined;

  while (attempt < MAX_RETRIES) {
    attempt += 1;
    const content = await generateContent({
      ...args.input,
      prior_failure: priorFailure,
    });
    lastContent = content;

    if (content.error || !content.title || content.bullets.length === 0) {
      // Could be JSON parse / API failure. Feed THAT back to Claude as
      // an additional attempt — same retry budget.
      lastFailedRules = [
        {
          rule_id: "content-generation-error",
          passed: false,
          reason: content.error ?? "empty_output",
        },
      ];
      priorFailure = {
        attempt,
        failed_rules: lastFailedRules.map((r) => ({
          rule_id: r.rule_id,
          reason: r.reason,
          details: r.details,
        })),
        last_title: content.title,
        last_bullets: content.bullets,
        last_description: content.description,
      };
      continue;
    }

    // Compliance gate with autoFix → disclaimer gets injected by rules 3+4.
    const decision = await runComplianceGate(
      {
        bundle_draft_id: args.draft_id,
        title: content.title,
        brand: args.input.brand,
        bullets: content.bullets,
        description: content.description,
        browse_node: args.browse_node,
        main_image_url: null,
        bundle_components: args.bundle_components,
        skip_image_check: true,
      },
      { autoFix: true, actor: "content-pipeline" },
    );

    if (decision.decision === "CAN_PUBLISH") {
      return {
        content,
        attempts: attempt,
        failed_rule_ids: [],
        final_bullets: decision.final_bullets,
        final_description: decision.final_description,
        final_compliance_check_id: decision.compliance_check_id,
        compliance_passed: true,
      };
    }

    lastFailedRules = decision.rules.filter((r) => !r.passed);
    priorFailure = {
      attempt,
      failed_rules: lastFailedRules.map((r) => ({
        rule_id: r.rule_id,
        reason: r.reason,
        details: r.details,
      })),
      last_title: content.title,
      last_bullets: content.bullets,
      last_description: content.description,
    };
  }

  // Exhausted retries — record the last attempt as BLOCKED and let the
  // caller mark it for manual review.
  const failedIds = lastFailedRules.map((r) => r.rule_id);
  return {
    content: lastContent ?? {
      title: "",
      bullets: [],
      description: "",
      cost_cents: 0,
      cache_hit: false,
      claude_response_id: "",
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      raw_response: "",
      error: "no Claude attempts recorded",
    },
    attempts: attempt,
    failed_rule_ids: failedIds,
    final_bullets: lastContent?.bullets ?? [],
    final_description: lastContent?.description ?? "",
    compliance_passed: false,
  };
}
