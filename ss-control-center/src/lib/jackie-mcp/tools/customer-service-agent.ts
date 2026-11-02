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
import { infoCard, processCase, setApprovedReply } from "@/lib/customer-hub/cs-pipeline";
import { listCancelRequests, syncCancelNotices } from "@/lib/customer-hub/cancel-requests";
import { getConnectedGmailAccounts } from "@/lib/gmail-api";
import { inboxStatus, reconcileInbox } from "@/lib/customer-hub/inbox-watch";
import { prisma } from "@/lib/prisma";
import { optionalString, requireString } from "../channels";
import type { JackieTool } from "../registry";

function reconcileLater() {
  after(async () => {
    try {
      const r = await reconcileInbox({ budgetMs: 200_000 });
      console.log("[cs-agent] reconcile after inbox scan:", JSON.stringify(r));
    } catch (e) {
      console.error("[cs-agent] reconcile failed:", e);
    }
  });
}

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
    "Customer Service cards waiting to be posted to Telegram topic 42. Each has textRu (ready Russian message) and buttons[] with callbackData 'cs:<cardId>:<approve|wrong|rework>'. Reply cards carry urgency (overdue | due_soon | no_card | send_stuck | card_stale | ok), deadline and hoursLeft. Cards with kind:'alert' are inbox alarms (unanswered / overdue buyer messages): post textRu as is, no buttons. After posting ANY card call cs_card_published.",
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
    "QUEUED Customer Service tasks for ONE Amazon account (store_index). Run only on that account's VPS. kind SEND = post the approved reply in Seller Central Buyer-Seller Messaging; LOOKUP = read-only data search; INBOX_SCAN = read-only list of the Seller Central Buyer Messages inbox filtered by Response needed (incl. Over SLA), report result {items:[{orderId, buyerName, subject, receivedAt, overSla, text}]} — queued every 30 min per account. Payload has instructionsRu.",
  write: false,
  input_schema: {
    type: "object",
    properties: { store_index: { type: "number" }, kind: { type: "string", enum: ["SEND", "LOOKUP", "INBOX_SCAN"] } },
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
    "Report a claimed task. outcome DONE / FAILED / UNKNOWN (UNKNOWN = not sure the message went out; it is never re-sent — read the thread and report). SEND: pass screenshot_url of the sent message. LOOKUP: pass result {\"M6\": \"found text\", …} keyed by the requested items. INBOX_SCAN: pass result {\"items\": [{orderId, buyerName, subject, receivedAt, overSla, text}]} (empty inbox = items: []); the hub then reopens/creates cards for every Response Needed message.",
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
    if ("reconcile" in res && res.reconcile) reconcileLater();
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

const inboxStatusTool: JackieTool = {
  name: "cs_inbox_status",
  description:
    "One-call Customer Service check (owner, 2026-11-01): how many buyer messages are still unanswered and how many are overdue, per store (all 5 Amazon accounts), with the latest Seller Central inbox scan per store (Response Needed / Over SLA counts) and every open case: order, buyer, deadline, hours left, urgency (overdue | due_soon | no_card | send_stuck | card_stale | ok), card state + Telegram link. Read-only. reconcile=true also runs the reconciliation now (builds missing cards, posts alerts).",
  // reconcile=true writes (cards, alerts); the plain call only reads.
  write: true,
  input_schema: { type: "object", properties: { reconcile: { type: "boolean" } }, additionalProperties: false },
  handler: async (args) => {
    if (args.reconcile === true) {
      const r = await reconcileInbox({ budgetMs: 150_000 });
      return { reconcile: r, ...(await inboxStatus()) };
    }
    return inboxStatus();
  },
};

const cancelRequestsTool: JackieTool = {
  name: "cs_cancel_requests",
  description:
    "Buyer cancellation requests (Amazon 'Order cancelation request' notification emails, all store mailboxes) per order, with the order status, total, when we bought the label (Veeqo) and before_shipment: true = the buyer asked to cancel BEFORE the label → shipping it was our fault, a refund refusal is forbidden (owner, 2026-11-02); false = asked after the label; null = not proven / not shipped. days = lookback (default 30). sync_days = first pull notices from Gmail for that many days (backfill, 1–60). before_shipment_only=true filters.",
  // sync_days stores notices and label times; otherwise read + cache only.
  write: true,
  input_schema: {
    type: "object",
    properties: {
      days: { type: "number" },
      sync_days: { type: "number" },
      before_shipment_only: { type: "boolean" },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    const days = typeof args.days === "number" && args.days > 0 ? Math.min(args.days, 90) : 30;
    let sync: { created: number; errors: string[] } | null = null;
    if (typeof args.sync_days === "number" && args.sync_days > 0) {
      const n = Math.min(Math.round(args.sync_days), 60);
      sync = await syncCancelNotices(await getConnectedGmailAccounts(), `${n}d`);
    }
    const items = await listCancelRequests({ days, onlyBeforeShipment: args.before_shipment_only === true });
    return {
      sync,
      days,
      total: items.length,
      beforeShipment: items.filter((i) => i.beforeShipment === true).length,
      items,
    };
  },
};

const caseInfoCard: JackieTool = {
  name: "cs_case_info_card",
  description:
    "Build an INFORMATION card (kind 'info', no buttons, nothing to send) for a buyer message that is already answered — e.g. a cancellation requested before shipment discovered after the refusal went out. Fresh case data incl. the cancellation fact; decision_ru overrides the decision line. It appears in cs_cards_pending; post it without buttons (cs_card_published as usual).",
  write: true,
  input_schema: {
    type: "object",
    properties: {
      message_id: { type: "string" },
      amazon_order_id: { type: "string" },
      decision_ru: { type: "string" },
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
    return infoCard(id, optionalString(args, "decision_ru"));
  },
};

export const tools: JackieTool[] = [inboxStatusTool, cancelRequestsTool, caseInfoCard, caseProcess, cardsPending, cardPublished, cardActionTool, cardSetReply, tasksList, taskClaim, taskComplete];
