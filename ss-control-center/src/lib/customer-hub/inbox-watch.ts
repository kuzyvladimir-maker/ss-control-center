/** Amazon-mail inbox authority. No browser tasks or Seller Central inference. */
import { prisma } from '@/lib/prisma';
import { urgencyOf, type Urgency } from './inbox-rules';
import { mailOpenThreads } from './mail-inbox';
export { closeAnsweredByReply } from './answered';
export * from './inbox-rules';
export { ACTIVE_CS_STORES as WATCHED_STORES } from './config';
export const ALERT_CARD_MESSAGE_ID = 'cs-alert';
export const LIVE_CARD = ['PENDING','PUBLISHED','WRONG','REWORK','APPROVED'];
const OPEN_STATUS = ['NEW','ANALYZED'];
export const telegramLink = (id: string | null | undefined) => id ? `https://t.me/c/3924739153/${id}` : null;
export const openThreads = mailOpenThreads;
export async function inboxStatus(now = new Date()) {
  const view = await openThreads(now);
  return { ...view, generatedAt: now.toISOString(),
    totals: { unanswered: view.stale ? null : view.threads.length, overdue: null, dueUnder6h: null,
      noCard: view.threads.filter(t => !t.cardStatus).length, cardsAwaitingOwner: view.threads.filter(t => t.cardStatus === 'PUBLISHED').length },
    stores: view.accounts, cases: view.threads };
}
/** Mail metadata cannot authorize replies or reconstruct missing buyer text. Gmail ingest still builds drafts. */
export async function reconcileInbox(opts: { now?: Date; budgetMs?: number; dryRun?: boolean } = {}) {
  const retired = opts.dryRun ? { count: 0 } : await prisma.csTask.updateMany({
    where: { kind: 'INBOX_SCAN', status: { in: ['QUEUED','CLAIMED'] } },
    data: { status: 'CANCELLED', error: 'Chrome inbox scanning permanently disabled; use Amazon mail source' },
  });
  const view = await openThreads(opts.now);
  return { open: view.stale ? null : view.threads.length, built: [], deferred: 0, reopened: [], createdFromInbox: [], mismatches: [],
    scansQueued: 0, blockedTasksSkipped: retired.count, alertCardId: null, errors: view.errors.map(e => `${e.account}: ${e.error}`) };
}
/** urgency for a card in cs_cards_pending (reply cards only). */
export async function cardUrgency(
  card: { buyerMessageId: string; status: string; createdAt: Date },
  now: Date = new Date()
): Promise<Urgency | null> {
  if (card.buyerMessageId === ALERT_CARD_MESSAGE_ID) return null;
  const m = await prisma.buyerMessage.findUnique({
    where: { id: card.buyerMessageId },
    select: { receivedAt: true, createdAt: true, amazonOrderId: true, storeIndex: true },
  });
  if (!m) return null;
  // Amazon's clock starts at the oldest unanswered message of the order.
  const oldest = m.amazonOrderId
    ? await prisma.buyerMessage.findFirst({
        where: {
          storeIndex: m.storeIndex,
          amazonOrderId: m.amazonOrderId,
          direction: "incoming",
          status: { in: OPEN_STATUS },
          responseSentAt: null,
        },
        orderBy: { receivedAt: "asc" },
        select: { receivedAt: true, createdAt: true },
      })
    : null;
  const receivedAt = oldest?.receivedAt || oldest?.createdAt || m.receivedAt || m.createdAt;
  return urgencyOf({ receivedAt, now, card, covered: true });
}


export async function inboxStillNeedsReply(storeIndex: number, orderId: string, replySentAt: Date) {
  const view = await openThreads();
  return view.threads.some(t => t.storeIndex === storeIndex && t.order === orderId && t.lastScanAt && Date.parse(t.lastScanAt) > replySentAt.getTime());
}
