/** Seller Central screen evidence only. No mail fallback. */
import { prisma } from '@/lib/prisma';
import { screenInbox } from './screen-inbox';
export { closeAnsweredByReply } from './answered';
export * from './inbox-rules';
export { ACTIVE_CS_STORES as WATCHED_STORES } from './config';
export const ALERT_CARD_MESSAGE_ID = 'cs-alert';
export const LIVE_CARD = ['PENDING','PUBLISHED','WRONG','REWORK','APPROVED'];
export const telegramLink = (id: string | null | undefined) => id ? `https://t.me/c/3924739153/${id}` : null;
export const openThreads = screenInbox;
export async function inboxStatus(now = new Date()) {
  const view = await openThreads(now);
  return { ...view, generatedAt: now.toISOString(),
    totals: { unanswered: view.metrics.responseNeeded, overdue: view.metrics.overSla, dueUnder6h: null,
      noCard: view.stale ? null : view.threads.filter(t => !t.cardStatus).length, cardsAwaitingOwner: view.stale ? null : view.threads.filter(t => t.cardStatus === 'PUBLISHED').length },
    stores: [{storeIndex:1,state:view.state}], cases: view.threads };
}
/** Mail metadata cannot authorize replies or reconstruct missing buyer text. Gmail ingest still builds drafts. */
export async function reconcileInbox(opts: { now?: Date; budgetMs?: number; dryRun?: boolean } = {}) {
  const retired = opts.dryRun ? { count: 0 } : await prisma.csTask.updateMany({
    where: { kind: 'INBOX_SCAN', status: { in: ['QUEUED','CLAIMED'] } },
    data: { status: 'CANCELLED', error: 'Chrome inbox scanning permanently disabled; await verified Seller Central screen evidence' },
  });
  const view = await openThreads(opts.now);
  return { open: view.stale ? null : view.threads.length, built: [], deferred: 0, reopened: [], createdFromInbox: [], mismatches: [],
    scansQueued: 0, blockedTasksSkipped: retired.count, alertCardId: null, errors: view.errors.map(e => `${e.account}: ${e.error}`) };
}
export async function inboxStillNeedsReply(storeIndex: number, orderId: string, replySentAt: Date) {
  const view = await openThreads();
  return view.threads.some(t => t.storeIndex === storeIndex && t.order === orderId && t.lastScanAt && Date.parse(t.lastScanAt) > replySentAt.getTime());
}
