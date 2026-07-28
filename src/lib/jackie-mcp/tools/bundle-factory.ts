/**
 * Jackie MCP tools — Bundle Factory.
 *
 * Wraps the Phase 2.1-2.5 orchestrators. Publish defaults to dry-run
 * for safety; explicit dry_run=false (or apply=true on republish_sku)
 * is required to hit marketplaces.
 */

import { prisma } from "@/lib/prisma";
import { runValidationForDraft } from "@/lib/bundle-factory/validation/validation-pipeline";
import { promoteDraftToChannelSkus } from "@/lib/bundle-factory/validation/promote-draft";
import { runDistribution } from "@/lib/bundle-factory/distribution/distribution-pipeline";
import {
  persistPollResult,
  pollSubmissionStatus,
} from "@/lib/bundle-factory/distribution/status-poller";
import { optionalNumber, optionalString, requireString } from "../channels";
import type { JackieTool } from "../registry";

const draftsList: JackieTool = {
  name: "drafts_list",
  description:
    "List BundleDraft rows. status filter optional (DRAFT|RESEARCHED|VARIATION_SELECTED|GENERATED|IMAGE_GENERATING|IMAGE_GENERATED|VALIDATING|VALIDATED|PUBLISHING|PUBLISHED|APPROVED|ERROR|…).",
  write: false,
  input_schema: {
    type: "object",
    properties: {
      status: { type: "string" },
      limit: { type: "number", default: 50 },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    const where: Record<string, unknown> = {};
    const status = optionalString(args, "status");
    if (status) where.status = status;
    const limit = optionalNumber(args, "limit") ?? 50;
    const rows = await prisma.bundleDraft.findMany({
      where,
      orderBy: { updated_at: "desc" },
      take: Math.min(limit, 200),
      select: {
        id: true,
        draft_name: true,
        brand: true,
        category: true,
        status: true,
        compliance_status: true,
        target_channels: true,
        master_bundle_id: true,
        created_at: true,
        updated_at: true,
      },
    });
    return { count: rows.length, drafts: rows };
  },
};

const draftGet: JackieTool = {
  name: "draft_get",
  description:
    "Full BundleDraft detail with variation_matrix + generated_content + (if promoted) ChannelSKU rows of its MasterBundle.",
  write: false,
  input_schema: {
    type: "object",
    properties: { draft_id: { type: "string" } },
    required: ["draft_id"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const id = requireString(args, "draft_id");
    const draft = await prisma.bundleDraft.findUnique({
      where: { id },
      include: {
        variation_matrix: true,
        generated_content: { orderBy: { channel: "asc" } },
      },
    });
    if (!draft) return { error: "not_found" };
    const channelSkus = draft.master_bundle_id
      ? await prisma.channelSKU.findMany({
          where: { master_bundle_id: draft.master_bundle_id },
          orderBy: { channel: "asc" },
        })
      : [];
    return { draft, channel_skus: channelSkus };
  },
};

const draftValidate: JackieTool = {
  name: "draft_validate",
  description:
    "Run the Phase 2.4 validation pipeline on every CAN_PUBLISH GeneratedContent. Lazy-promotes the draft to ChannelSKU first (allocates UPCs from UPCPool).",
  write: true,
  input_schema: {
    type: "object",
    properties: { draft_id: { type: "string" } },
    required: ["draft_id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = requireString(args, "draft_id");
    const promote = await promoteDraftToChannelSkus(id);
    const validation = await runValidationForDraft({ bundle_draft_id: id, actor: ctx.actor });
    return { promote, validation };
  },
};

const draftPublish: JackieTool = {
  name: "draft_publish",
  description:
    "Phase 2.5 Distribution. Defaults to dry_run=true (DRY RUN — payloads only, no marketplace submission). Pass apply=true to actually PUT to Amazon / POST to Walmart.",
  write: true,
  input_schema: {
    type: "object",
    properties: {
      draft_id: { type: "string" },
      apply: { type: "boolean", default: false, description: "MUST be true for real submission. Defaults to false (dry run)." },
      channels: { type: "array", items: { type: "string" } },
    },
    required: ["draft_id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = requireString(args, "draft_id");
    const apply = args.apply === true;
    const channels = Array.isArray(args.channels)
      ? (args.channels as unknown[]).filter((c): c is string => typeof c === "string")
      : undefined;
    return runDistribution({
      bundle_draft_id: id,
      apply,
      channels,
      actor: ctx.actor,
    });
  },
};

const skuPollStatus: JackieTool = {
  name: "sku_poll_status",
  description:
    "Refresh distribution status of one ChannelSKU (calls marketplace GET, updates listing_status). Use to lift a SUBMITTED SKU to LIVE / FAILED after Amazon / Walmart finished processing the feed.",
  write: false,
  input_schema: {
    type: "object",
    properties: { sku_id: { type: "string" } },
    required: ["sku_id"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const id = requireString(args, "sku_id");
    const sku = await prisma.channelSKU.findUnique({ where: { id } });
    if (!sku) return { error: "not_found" };
    const result = await pollSubmissionStatus(sku);
    await persistPollResult(result);
    return result;
  },
};

export const tools: JackieTool[] = [
  draftsList,
  draftGet,
  draftValidate,
  draftPublish,
  skuPollStatus,
];
