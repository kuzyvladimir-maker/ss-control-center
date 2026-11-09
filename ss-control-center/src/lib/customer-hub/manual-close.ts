import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { assertActiveCsStore } from "./config";

export interface ManualCloseInput {
  storeIndex: number;
  orderId: string;
  sentAt: string;
  screenshot: { name: string; base64: string };
}

export function validateManualClose(input: ManualCloseInput, now = new Date()) {
  assertActiveCsStore(input.storeIndex);
  if (!/^\d{3}-\d{7}-\d{7}$/.test(input.orderId)) throw new Error("Invalid order ID");
  const sentAt = new Date(input.sentAt);
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(input.sentAt) || !Number.isFinite(sentAt.getTime()) || sentAt > now)
    throw new Error("sentAt must be a past timestamp with timezone");
  const screenshot = input.screenshot;
  if (!screenshot?.name || typeof screenshot.base64 !== "string" || screenshot.base64.length > 4_000_000 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(screenshot.base64)) throw new Error("Screenshot required (PNG/JPEG, max 3 MB)");
  const bytes = Buffer.from(screenshot.base64, "base64");
  if (!(bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) || bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))))
    throw new Error("Screenshot must be PNG or JPEG");
  return { sentAt, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Records an ALREADY sent reply; never sends anything to Amazon. */
export async function closeManually(input: ManualCloseInput, db = prisma) {
  const { sentAt, sha256 } = validateManualClose(input);
  const auditKey = `cs_manual_close:${input.storeIndex}:${input.orderId}:${sentAt.toISOString()}:${sha256}`;
  return db.$transaction(async (tx) => {
    const prior = await tx.setting.findUnique({ where: { key: auditKey } });
    if (prior) return { ...JSON.parse(prior.value).receipt, alreadyRecorded: true };
    const messages = await tx.buyerMessage.findMany({ where: {
      channel: "Amazon", storeIndex: input.storeIndex, amazonOrderId: input.orderId, direction: "incoming",
      OR: [{ receivedAt: { lt: sentAt } }, { receivedAt: null, createdAt: { lt: sentAt } }],
    } });
    if (!messages.length) throw new Error("No buyer messages before sentAt for this order");
    const ids = messages.map((m) => m.id);
    const inFlight = await tx.csTask.findFirst({ where: { buyerMessageId: { in: ids }, kind: "SEND", status: "CLAIMED" } });
    if (inFlight) throw new Error("SEND is currently claimed; reconcile its result before manual closure");
    const source = `Отправлено вне хаба; source=VPS_MANUAL; sentAt=${sentAt.toISOString()}; screenshot=${auditKey}`;
    await tx.buyerMessage.updateMany({ where: { id: { in: ids } }, data: {
      status: "SENT", caseStage: "SENT", responseSentAt: sentAt, responseSentVia: "VPS_AGENT", resolution: source,
    } });
    // Retire every version too: neither an older nor a latest card can reappear.
    const cards = await tx.csCard.updateMany({ where: { buyerMessageId: { in: ids }, status: { not: "SENT" } }, data: { status: "SENT", ownerComment: source } });
    const tasks = await tx.csTask.updateMany({ where: { buyerMessageId: { in: ids }, status: "QUEUED" }, data: {
      status: "CANCELLED", completedAt: new Date(), error: source,
    } });
    const receipt = { orderId: input.orderId, sentAt: sentAt.toISOString(), messageIds: ids, cardsClosed: cards.count, tasksCancelled: tasks.count, auditKey, screenshotSha256: sha256 };
    await tx.setting.create({ data: { key: auditKey, value: JSON.stringify({ receipt, screenshot: input.screenshot, recordedAt: new Date().toISOString() }) } });
    return receipt;
  });
}
