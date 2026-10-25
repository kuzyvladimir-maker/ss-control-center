/**
 * Customer Service approval cards + VPS agent tasks (topic 42).
 * Design: docs/wiki/customer-hub-vps-send.md
 *
 * Cards: the hub writes them; Jackie publishes each one to Telegram topic 42
 * with three inline buttons and relays the owner's press (+ comment) back.
 * Tasks: SEND (owner-approved reply) and LOOKUP (read-only data) for the
 * agent on the Amazon account's own VPS — Seller Central is never opened
 * anywhere else.
 */
import { after } from "next/server";
import { cardAction, markPublished, pendingCards } from "@/lib/customer-hub/cs-cards";
import { claimTask, completeTask, listTasks } from "@/lib/customer-hub/cs-tasks";
import { processCase, setApprovedReply } from "@/lib/customer-hub/cs-pipeline";
import { prisma } from "@/lib/prisma";
import { optionalString, requireString } from "../channels";
import type { JackieTool } from "../registry";

function reprocessLater(messageId: string, ownerInstruction?: string) {
  after(async () => {
    try {
      // The owner is already working on this case: always rebuild the card,
      // never park it behind a VPS lookup.
      await processCase(messageId, { ownerInstruction, forceCard: true });
    } catch (e) {
      console.error("[cs-agent] reprocess failed:", e);
    }
  });
}

const cardsPending: JackieTool = {
  name: "cs_cards_pending",
  description:
    "Customer Service approval cards waiting to be posted to Telegram topic 42. Each has textRu (ready Russian message) and buttons[] with callbackData 'cs:<cardId>:<approve|wrong|rework>'. After posting call cs_card_published.",
  write: false,
  input_schema: { type: "object", properties: { limit: { type: "number" } }, additionalProperties: false },
  handler: async (args) => pendingCards(typeof args.limit === "number" ? args.limit : 10),
};

const cardPublished: JackieTool = {
  name: "cs_card_published",
  description: "Mark a card as posted to Telegram (stores the Telegram message id).",
  write: true,
  input_schema: {
    type: "object",
    properties: { card_id: { type: "string" }, telegram_message_id: { type: "string" } },
    required: ["card_id", "telegram_message_id"],
    additionalProperties: false,
  },
  handler: async (args) => markPublished(requireString(args, "card_id"), requireString(args, "telegram_message_id")),
};

const cardActionTool: JackieTool = {
  name: "cs_card_action",
  description:
    "Relay the owner's button press on a card. approve → queues a SEND task for the account VPS. wrong/rework without comment → returns askOwnerRu (ask the owner, then call again with his voice/text answer as comment). With comment → saved as an owner rule and a new card version is built in the background (poll cs_cards_pending).",
  write: true,
  input_schema: {
    type: "object",
    properties: {
      card_id: { type: "string" },
      action: { type: "string", enum: ["approve", "wrong", "rework"] },
      comment: { type: "string", description: "Owner's explanation / how he would answer (Russian is fine)." },
      override_text: {
        type: "string",
        description:
          "approve only: send THIS exact reply verbatim (becomes the message's editedResponse, SEND task carries it unchanged — no regeneration/scrub).",
      },
    },
    required: ["card_id", "action"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const action = requireString(args, "action");
    if (!["approve", "wrong", "rework"].includes(action)) throw new Error("action must be approve|wrong|rework");
    const res = await cardAction(
      requireString(args, "card_id"),
      action as "approve" | "wrong" | "rework",
      optionalString(args, "comment") ?? null,
      ctx.actor,
      optionalString(args, "override_text") ?? null
    );
    if (res.reprocessMessageId) reprocessLater(res.reprocessMessageId, res.ownerInstruction);
    return res;
  },
};

const tasksList: JackieTool = {
  name: "cs_tasks_list",
  description:
    "QUEUED Customer Service tasks for ONE Amazon account (store_index). Run only on that account's VPS. kind SEND = post the approved reply in Seller Central Buyer-Seller Messaging; LOOKUP = read-only data search. Payload has instructionsRu.",
  write: false,
  input_schema: {
    type: "object",
    properties: { store_index: { type: "number" }, kind: { type: "string", enum: ["SEND", "LOOKUP"] } },
    required: ["store_index"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const store = Number(args.store_index);
    if (!Number.isInteger(store)) throw new Error("store_index must be an integer");
    const rows = await listTasks(store, optionalString(args, "kind"));
    return rows.map((t) => ({ ...t, payload: JSON.parse(t.payloadJson) }));
  },
};

const taskClaim: JackieTool = {
  name: "cs_task_claim",
  description: "Claim a QUEUED task before acting (lock). Fails if someone already claimed it.",
  write: true,
  input_schema: {
    type: "object",
    properties: { task_id: { type: "string" }, vps: { type: "string", description: "VPS label, e.g. salutem-vps" } },
    required: ["task_id", "vps"],
    additionalProperties: false,
  },
  handler: async (args) => claimTask(requireString(args, "task_id"), requireString(args, "vps")),
};

const taskComplete: JackieTool = {
  name: "cs_task_complete",
  description:
    "Report a claimed task. outcome DONE / FAILED / UNKNOWN (UNKNOWN = not sure the message went out; it is never re-sent — read the thread and report). SEND: pass screenshot_url of the sent message. LOOKUP: pass result {\"M6\": \"found text\", …} keyed by the requested items.",
  write: true,
  input_schema: {
    type: "object",
    properties: {
      task_id: { type: "string" },
      outcome: { type: "string", enum: ["DONE", "FAILED", "UNKNOWN"] },
      result: { type: "object" },
      screenshot_url: { type: "string" },
      error: { type: "string" },
    },
    required: ["task_id", "outcome"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const outcome = requireString(args, "outcome");
    if (!["DONE", "FAILED", "UNKNOWN"].includes(outcome)) throw new Error("outcome must be DONE|FAILED|UNKNOWN");
    const res = await completeTask(requireString(args, "task_id"), outcome as "DONE" | "FAILED" | "UNKNOWN", {
      result: (args.result as Record<string, unknown>) || undefined,
      screenshotUrl: optionalString(args, "screenshot_url"),
      error: optionalString(args, "error"),
    });
    if ("reprocessMessageId" in res && res.reprocessMessageId) reprocessLater(res.reprocessMessageId);
    return res;
  },
};

const caseProcess: JackieTool = {
  name: "cs_case_process",
  description:
    "Run the Customer Service pipeline now for one buyer message (by message_id or amazon_order_id): collect data → analysis → approval card. force_card=true builds the card even if some data is missing (gaps listed on the card). Runs in the background; poll cs_cards_pending ~1-2 min later.",
  write: true,
  input_schema: {
    type: "object",
    properties: {
      message_id: { type: "string" },
      amazon_order_id: { type: "string" },
      force_card: { type: "boolean" },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    let id = optionalString(args, "message_id");
    const orderId = optionalString(args, "amazon_order_id");
    if (!id && orderId) {
      const m = await prisma.buyerMessage.findFirst({
        where: { amazonOrderId: orderId, direction: "incoming" },
        orderBy: { receivedAt: "desc" },
      });
      id = m?.id;
    }
    if (!id) throw new Error("message_id or amazon_order_id with an incoming message is required");
    const messageId = id;
    const forceCard = args.force_card === true;
    after(async () => {
      try {
        const r = await processCase(messageId, { forceCard });
        console.log("[cs_case_process]", messageId, JSON.stringify(r));
      } catch (e) {
        console.error("[cs_case_process] failed:", e);
      }
    });
    return { ok: true, messageId, queued: true, hint: "poll cs_cards_pending in ~1-2 min" };
  },
};

const cardSetReply: JackieTool = {
  name: "cs_card_set_reply",
  description:
    "Put an EXACT owner-approved reply on a case as a new PENDING card (supersedes prior versions, incl. PUBLISHED). text_en is used VERBATIM — never regenerated or scrubbed — and approve will send exactly this. Facts come from the case's existing data. Args: amazon_order_id OR message_id, text_en (required), text_ru (optional owner translation; auto-translated for the owner's view if omitted). Returns card_id.",
  write: true,
  input_schema: {
    type: "object",
    properties: {
      message_id: { type: "string" },
      amazon_order_id: { type: "string" },
      text_en: { type: "string" },
      text_ru: { type: "string" },
    },
    required: ["text_en"],
    additionalProperties: false,
  },
  handler: async (args) => {
    let id = optionalString(args, "message_id");
    const orderId = optionalString(args, "amazon_order_id");
    if (!id && orderId) {
      const m = await prisma.buyerMessage.findFirst({
        where: { amazonOrderId: orderId, direction: "incoming" },
        orderBy: { receivedAt: "desc" },
      });
      id = m?.id;
    }
    if (!id) throw new Error("message_id or amazon_order_id with an incoming message is required");
    const r = await setApprovedReply(id, requireString(args, "text_en"), optionalString(args, "text_ru") ?? null);
    return { ok: true, ...r, hint: "card is PENDING; approve (or cs_card_action approve) sends text_en verbatim" };
  },
};

export const tools: JackieTool[] = [caseProcess, cardsPending, cardPublished, cardActionTool, cardSetReply, tasksList, taskClaim, taskComplete];
