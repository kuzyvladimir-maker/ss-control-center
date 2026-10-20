/* eslint-disable @typescript-eslint/no-explicit-any -- Gmail API payloads are untyped JSON here */
/**
 * Import the owner's real buyer replies into the Customer Hub knowledge base.
 *
 * Source: Amazon "Your e-mail to …" confirmations in the seller mailbox (a
 * copy of every reply sent from Seller Central). Each copy is paired with the
 * buyer's latest message on the same order before the reply, then stored as
 * a KnowledgeBaseEntry (source = owner_edit). Idempotent via a hash tag.
 * Read-only on Gmail; writes only KnowledgeBaseEntry rows.
 *
 *   npx tsx scripts/import-owner-replies-from-gmail.ts --dry-run [--days=365] [--mailbox=amazon@salutem.solutions]
 *   npx tsx scripts/import-owner-replies-from-gmail.ts --apply
 *
 * Dry run writes the extracted pairs to data/customer-hub-owner-replies.json.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });
import { readFileSync, writeFileSync } from "node:fs";

const arg = (name: string, def: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? def;
const APPLY = process.argv.includes("--apply");
const DAYS = Number(arg("days", "365"));
const MAILBOX = arg("mailbox", "amazon@salutem.solutions");
/** Reuse data/customer-hub-owner-replies.json; only label the unlabeled pairs. */
const REUSE = process.argv.includes("--reuse");
/** Distil the owner's voice guide from the replies into Setting customer_hub_voice_guide. */
const VOICE = process.argv.includes("--voice");

const TYPES =
  "T1 in transit/where is it; T2 says delivered but not received; T3 late; T4 thawed/spoiled food; T5 damaged; T6 wrong item; T7 missing item; T8 expired/no date; T9 shipping cost complaint; T10 cancel request; T11 refund/return request; T12 unauthorized order; T13 A-to-Z mention; T14 review threat; T15 health/safety; T16 postage due; T17 quality/taste/price complaint; T18 pre-sale or general question; T19 refund already issued; T20 repeat complaint; T21 paid expedited shipping, got standard";

function partsText(payload: any): { html: string; plain: string } {
  let html = "";
  let plain = "";
  const walk = (p: any) => {
    if (!p) return;
    if (p.body?.data) {
      const s = Buffer.from(p.body.data, "base64").toString("utf8");
      if (p.mimeType === "text/html") html += s;
      else if (p.mimeType === "text/plain") plain += s;
    }
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  return { html, plain };
}

async function main() {
  const g = await import("@/lib/gmail-api");
  const { parseAmazonBuyerEmail } = await import("@/lib/customer-hub/gmail-parser");
  const { predictProblemTypes } = await import("@/lib/customer-hub/kb-retrieval");
  const imp = await import("@/lib/customer-hub/owner-reply-import");
  const { prisma } = await import("@/lib/prisma");

  let unique: any[] = [];
  if (REUSE) {
    unique = JSON.parse(readFileSync("data/customer-hub-owner-replies.json", "utf8"));
    console.log(`reusing ${unique.length} pairs from data/customer-hub-owner-replies.json`);
  } else {
  const acc = await g.getGmailAccountByEmail(MAILBOX);
  if (!acc) throw new Error(`Gmail ${MAILBOX} is not connected`);
  const storeMap = await g.loadEmailToStoreMap();

  const confirmations = await g.searchMessages(
    acc.refreshToken,
    `from:donotreply@amazon.com subject:"Your e-mail to" newer_than:${DAYS}d`,
    500
  );
  console.log(`confirmations found: ${confirmations.length}`);

  const pairs: any[] = [];
  const skipped: Record<string, number> = {};
  const skip = (why: string) => (skipped[why] = (skipped[why] || 0) + 1);

  for (const c of confirmations) {
    if (!c.id) continue;
    const msg = await g.readMessage(acc.refreshToken, c.id);
    const headers: any[] = msg.payload?.headers || [];
    const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
    const sentAt = new Date(Number(msg.internalDate || 0));
    const { html, plain } = partsText(msg.payload);
    const conf = imp.parseConfirmationText(plain || imp.htmlToText(html), subject);
    if (!conf) { skip("no message markers"); continue; }
    if (!conf.orderId) { skip("no order id"); continue; }

    // Buyer's latest message on this order before our reply.
    const buyerList = await g.searchMessages(
      acc.refreshToken,
      `from:marketplace.amazon.com "${conf.orderId}"`,
      20
    );
    let best: { text: string; at: number; name: string | null; productType?: string } | null = null;
    for (const b of buyerList) {
      if (!b.id) continue;
      const full = await g.readMessage(acc.refreshToken, b.id);
      const at = Number(full.internalDate || 0);
      if (at > sentAt.getTime()) continue;
      const parsed = parseAmazonBuyerEmail(full, storeMap);
      if (!parsed?.customerMessage) continue;
      if (!best || at > best.at) best = { text: parsed.customerMessage, at, name: parsed.customerName };
    }
    if (!best) { skip("no buyer message found"); continue; }

    const buyerText = best.text.replace(/\s*View Message\s*$/i, "").trim();
    const predicted = predictProblemTypes(buyerText);
    pairs.push({
      orderId: conf.orderId,
      buyerName: conf.buyerName || best.name,
      product: conf.product,
      buyerAt: new Date(best.at).toISOString(),
      replyAt: sentAt.toISOString(),
      problemType: predicted[0]?.problemType || "T18",
      predicted: predicted.map((p) => p.problemType),
      action: imp.inferOwnerAction(conf.replyText),
      buyerText,
      replyText: conf.replyText,
      hash: imp.pairHash(buyerText, conf.replyText),
    });
  }

  unique = [...new Map(pairs.map((p) => [p.hash, p])).values()];
  console.log(`pairs: ${unique.length}, skipped:`, skipped);
  }

  // Label each pair with the AI on the subscription worker (no paid keys):
  // the keyword guess above misses most cases. 10 pairs per call.
  const { completeWithSubscription } = await import("@/lib/llm/subscription");
  const todo = unique.filter((p) => !p.aiLabeled);
  for (let i = 0; i < todo.length; i += 10) {
    const batch = todo.slice(i, i + 10);
    const prompt = `Classify Amazon buyer-support cases. Each case = buyer message + the seller's actual reply.
Problem types: ${TYPES}
Actions (what the SELLER's reply actually did): info (answered/reassured), clarify (asked for photos/details), redirect_amazon (sent buyer to Amazon / A-to-Z / cancellation request), replacement, partial_refund, full_refund, cancel (approved/cancelled order), decline (politely refused).
Return ONLY a JSON array: [{"i":<index>,"problemType":"T#","action":"<action>","scenario":"<one plain English sentence: situation + what the seller did>"}]

${batch
  .map(
    (p, k) =>
      `#${k}\nBUYER: ${p.buyerText.slice(0, 700)}\nSELLER: ${p.replyText.slice(0, 900)}`
  )
  .join("\n\n")}`;
    for (let attempt = 1; attempt <= 3; attempt++) try {
      const { text } = await completeWithSubscription({ prompt, lanes: attempt === 3 ? ["codex"] : ["claude"] });
      const arr = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] || "[]");
      for (const r of arr) {
        const p = batch[r.i];
        if (!p) continue;
        if (/^T\d{1,2}$/.test(r.problemType)) p.problemType = r.problemType;
        if (typeof r.action === "string") p.action = r.action;
        if (typeof r.scenario === "string") p.scenario = r.scenario;
        p.aiLabeled = true;
      }
      break;
    } catch (e) {
      console.warn(`label batch ${i} attempt ${attempt} failed:`, e instanceof Error ? e.message : e);
    }
    console.log(`labeled ${Math.min(i + 10, todo.length)}/${todo.length}`);
  }

  writeFileSync("data/customer-hub-owner-replies.json", JSON.stringify(unique, null, 1));
  if (!APPLY) {
    console.log("dry run — wrote data/customer-hub-owner-replies.json; pass --apply to write the KB");
    await prisma.$disconnect();
    return;
  }

  if (VOICE) {
    const sample = unique
      .filter((_, k) => k % Math.max(1, Math.floor(unique.length / 45)) === 0)
      .slice(0, 45);
    const prompt = `Below are real replies a seller sent to Amazon buyers. Write a concise STYLE GUIDE (max 25 bullet lines, plain English) that lets another writer reproduce this voice exactly: greeting, sign-off, tone, typical structure, recurring phrases, how bad news / refusals / photo requests / redirects to Amazon are phrased, what is never said. Describe patterns only — no customer names, order numbers or dates.

${sample.map((p, k) => `--- reply ${k + 1} (${p.problemType}/${p.action})\n${p.replyText.slice(0, 1200)}`).join("\n\n")}`;
    const raw = (await completeWithSubscription({ prompt, lanes: ["claude"] })).text;
    // Drop any learned review/feedback asks — Amazon restricts them in buyer
    // messages — and pin the hard limits at the end.
    const text =
      raw
        .split(/\n(?=\*\*|#)/)
        .filter((sec) => !/review|feedback/i.test(sec.split("\n")[0]))
        .join("\n")
        .split("\n")
        .filter((l) => !/\b(review|feedback|rating)\b/i.test(l.replace(/A-to-z Guarantee review/gi, "")))
        .join("\n")
        .trim() +
      `

**Hard limits (always win over the patterns above)**
- Never ask for a review, rating or feedback.
- No links, email addresses or phone numbers.
- Never cancel or offer to cancel a shipped order; never ask to return frozen food.
- Never argue about food safety; never make health claims.`;
    const { VOICE_GUIDE_KEY } = await import("@/lib/customer-hub/knowledge-base");
    await prisma.setting.upsert({
      where: { key: VOICE_GUIDE_KEY },
      create: { key: VOICE_GUIDE_KEY, value: text.trim() },
      update: { value: text.trim() },
    });
    console.log(`voice guide saved (${text.length} chars):\n${text.trim()}`);
  }

  const existing = await prisma.knowledgeBaseEntry.findMany({
    where: { source: "owner_edit" },
    select: { tags: true },
  });
  const have = new Set(
    existing.flatMap((e) => (e.tags || "").split(",").filter((t) => t.startsWith("hash:")))
  );
  let created = 0;
  for (const p of unique) {
    if (have.has(`hash:${p.hash}`)) continue;
    await prisma.knowledgeBaseEntry.create({
      data: {
        problemType: p.problemType,
        scenario: `${p.scenario || "Owner reply in Seller Central"} (${p.replyAt.slice(0, 10)}; product: ${p.product || "unknown"})`.slice(0, 600),
        customerSaid: p.buyerText.slice(0, 2000),
        correctAction: p.action,
        correctResponse: p.replyText,
        reasoning: "Real reply the owner sent from Seller Central (imported from the Amazon confirmation email). Action label is inferred from the reply text.",
        source: "owner_edit",
        channel: "Amazon",
        tags: `orderId:${p.orderId},date:${p.replyAt.slice(0, 10)},hash:${p.hash}`,
      },
    });
    created++;
  }
  console.log(`KB rows created: ${created} (already present: ${unique.length - created})`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
