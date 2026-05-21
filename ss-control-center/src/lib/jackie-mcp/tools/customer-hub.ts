/**
 * Jackie MCP tools — Customer Hub.
 *
 * Most data comes from our own DB (Gmail parser + classifier populated
 * BuyerMessage / AtozzClaim / SellerFeedback). Reply / represent /
 * removal-request actions invoke the existing sender + analyzer.
 */

import { prisma } from "@/lib/prisma";
import { sendResponse } from "@/lib/customer-hub/response-sender";
import { generateAtozResponse } from "@/lib/customer-hub/atoz-analyzer";
import {
  optionalNumber,
  optionalString,
  requireString,
  requireChannel,
} from "../channels";
import type { JackieTool } from "../registry";

// ── Buyer messages ────────────────────────────────────────────────────

const messagesList: JackieTool = {
  name: "messages_list",
  description:
    "List buyer messages for one channel (Amazon or Walmart). Default status='unread'; pass 'all' to include responded/closed. Channel must be 'AMAZON_SALUTEM'|…|'WALMART'.",
  write: false,
  input_schema: {
    type: "object",
    properties: {
      channel: { type: "string" },
      status: { type: "string", description: "'unread' | 'all' | a specific BuyerMessage status" },
      limit: { type: "number", default: 50 },
    },
    required: ["channel"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const channel = requireChannel(args);
    const status = optionalString(args, "status") ?? "unread";
    const limit = optionalNumber(args, "limit") ?? 50;

    const channelTag = channel === "WALMART" ? "Walmart" : "Amazon";
    const storeIndex = (() => {
      switch (channel) {
        case "AMAZON_SALUTEM": return 1;
        case "AMAZON_PERSONAL": return 2;
        case "AMAZON_AMZCOM": return 3;
        case "AMAZON_SIRIUS": return 4;
        case "AMAZON_RETAILER": return 5;
        default: return undefined;
      }
    })();
    const where: Record<string, unknown> = { channel: channelTag };
    if (storeIndex) where.storeIndex = storeIndex;
    if (status !== "all") {
      // BuyerMessage.status — Customer Hub statuses: PENDING / RESPONDED / CLOSED / ESCALATED
      // 'unread' is convenience: anything that isn't RESPONDED / CLOSED.
      if (status === "unread") {
        where.status = { notIn: ["RESPONDED", "CLOSED"] };
      } else {
        where.status = status;
      }
    }
    const rows = await prisma.buyerMessage.findMany({
      where,
      orderBy: { receivedAt: "desc" },
      take: Math.min(limit, 200),
    });
    return { count: rows.length, messages: rows };
  },
};

const messageGet: JackieTool = {
  name: "message_get",
  description: "Fetch one buyer message by BuyerMessage.id, including the AI-generated response if one was drafted.",
  write: false,
  input_schema: {
    type: "object",
    properties: { message_id: { type: "string" } },
    required: ["message_id"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const id = requireString(args, "message_id");
    const row = await prisma.buyerMessage.findUnique({ where: { id } });
    if (!row) return { error: "not_found" };
    return { message: row };
  },
};

const messageRespond: JackieTool = {
  name: "message_respond",
  description:
    "Send a reply to a buyer message via the existing Customer Hub response-sender (SP-API Messaging for Amazon, MANUAL marker for Walmart). Set dry_run=true to draft + preview without sending.",
  write: true,
  input_schema: {
    type: "object",
    properties: {
      message_id: { type: "string" },
      body: { type: "string", description: "Optional override of the AI-drafted response — when omitted, sender uses the stored draftedResponse." },
      dry_run: { type: "boolean", default: false },
    },
    required: ["message_id"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const id = requireString(args, "message_id");
    const body = optionalString(args, "body");
    const dry_run = args.dry_run === true;
    const row = await prisma.buyerMessage.findUnique({ where: { id } });
    if (!row) throw new Error(`BuyerMessage ${id} not found`);
    const stored = row.editedResponse ?? row.suggestedResponse ?? null;
    const preview = body ?? stored ?? "(no stored response yet — pass body to send)";
    if (dry_run) return { dry_run: true, would_send: preview };
    if (body) {
      // Persist override into editedResponse so the sender uses Jackie's text.
      await prisma.buyerMessage.update({
        where: { id },
        data: { editedResponse: body },
      });
    }
    const result = await sendResponse(id);
    return result;
  },
};

// ── A-to-Z + Chargebacks (same AtozzClaim table) ──────────────────────

const atozClaimsList: JackieTool = {
  name: "atoz_claims_list",
  description:
    "List A-to-Z + chargeback claims. claim_type='A_TO_Z'|'CHARGEBACK' filter optional; status filter optional (NEW|EVIDENCE_GATHERED|RESPONSE_READY|SUBMITTED|DECIDED|APPEALED|CLOSED).",
  write: false,
  input_schema: {
    type: "object",
    properties: {
      claim_type: { type: "string" },
      status: { type: "string" },
      limit: { type: "number", default: 50 },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    const where: Record<string, unknown> = {};
    const claimType = optionalString(args, "claim_type");
    if (claimType) where.claimType = claimType;
    const status = optionalString(args, "status");
    if (status) where.status = status;
    const limit = optionalNumber(args, "limit") ?? 50;
    const rows = await prisma.atozzClaim.findMany({
      where,
      orderBy: { detectedAt: "desc" },
      take: Math.min(limit, 200),
    });
    return { count: rows.length, claims: rows };
  },
};

const atozClaimAnalyze: JackieTool = {
  name: "atoz_claim_analyze",
  description:
    "Run the A-to-Z analyzer on one claim — generates an Amazon-facing defense response, a customer-facing message, and a strategyType label. Read-only (does not submit anywhere).",
  write: false,
  input_schema: {
    type: "object",
    properties: { claim_id: { type: "string" } },
    required: ["claim_id"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const id = requireString(args, "claim_id");
    const row = await prisma.atozzClaim.findUnique({ where: { id } });
    if (!row) throw new Error(`AtozzClaim ${id} not found`);
    const result = await generateAtozResponse(row);
    return { claim_id: id, analysis: result };
  },
};

// ── Seller Feedback ───────────────────────────────────────────────────

const feedbackList: JackieTool = {
  name: "feedback_list",
  description:
    "List SellerFeedback rows. rating filter optional (1..5). status filter optional (NEW|ANALYZED|REMOVAL_SUBMITTED|REMOVED|DENIED|CONTACT_SENT|CLOSED).",
  write: false,
  input_schema: {
    type: "object",
    properties: {
      rating: { type: "number" },
      status: { type: "string" },
      limit: { type: "number", default: 50 },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    const where: Record<string, unknown> = {};
    const rating = optionalNumber(args, "rating");
    if (rating !== undefined) where.rating = rating;
    const status = optionalString(args, "status");
    if (status) where.status = status;
    const limit = optionalNumber(args, "limit") ?? 50;
    const rows = await prisma.sellerFeedback.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(limit, 200),
    });
    return { count: rows.length, feedback: rows };
  },
};

const feedbackMarkRemovalRequested: JackieTool = {
  name: "feedback_mark_removal_requested",
  description:
    "Mark a SellerFeedback row as REMOVAL_SUBMITTED — used after Vladimir manually submits the removal request via Seller Central and wants Jackie to update tracking. Optional cs_case_id to link the Amazon case.",
  write: true,
  input_schema: {
    type: "object",
    properties: {
      feedback_id: { type: "string" },
      cs_case_id: { type: "string" },
      dry_run: { type: "boolean", default: false },
    },
    required: ["feedback_id"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const id = requireString(args, "feedback_id");
    const caseId = optionalString(args, "cs_case_id");
    const dry_run = args.dry_run === true;
    if (dry_run) {
      return { dry_run: true, would_update: { id, status: "REMOVAL_SUBMITTED", csCaseId: caseId ?? null } };
    }
    const row = await prisma.sellerFeedback.update({
      where: { id },
      data: {
        status: "REMOVAL_SUBMITTED",
        removalSubmittedAt: new Date(),
        csCaseId: caseId,
      },
    });
    return { ok: true, feedback: row };
  },
};

export const tools: JackieTool[] = [
  messagesList,
  messageGet,
  messageRespond,
  atozClaimsList,
  atozClaimAnalyze,
  feedbackList,
  feedbackMarkRemovalRequested,
];
