import { prisma } from '@/lib/prisma';
import { mailView, mergeMailSnapshot, validateMailSnapshot, type MailState } from './mail-inbox-rules';
const KEY = 'cs_mail_inbox_v1';
export async function acceptMailSnapshot(input: unknown) {
  const next = validateMailSnapshot(input);
  await prisma.$transaction(async tx => {
    const row = await tx.setting.findUnique({ where: { key: KEY } });
    const state = mergeMailSnapshot(row ? JSON.parse(row.value) : null, next);
    await tx.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(state) }, update: { value: JSON.stringify(state) } });
    await tx.csTask.updateMany({ where: { kind: 'INBOX_SCAN', status: { in: ['QUEUED','CLAIMED'] } }, data: { status: 'CANCELLED', error: 'Permanently disabled: Amazon mail source replaces Chrome inbox bridge (2026-11-15)' } });
  });
  return mailInbox();
}
export async function mailInbox(now = new Date(), db = prisma) {
  const row = await db.setting.findUnique({ where: { key: KEY } });
  return mailView(row ? JSON.parse(row.value) as MailState : null, now);
}
/** Keep source membership even when a local card says SENT. Only exact account/thread joins. */
async function mailThreads(history: boolean, now = new Date(), db = prisma) {
  const view = await mailInbox(now, db);
  const threads = await Promise.all((history ? view.historyItems : view.items).map(async item => {
    const message = await db.buyerMessage.findFirst({ where: { channel: 'Amazon', direction: 'incoming', storeEmail: item.account, gmailThreadId: { in: item.threadIds ?? [item.thread] } }, orderBy: { receivedAt: 'desc' } });
    const card = message ? await db.csCard.findFirst({ where: { buyerMessageId: message.id }, orderBy: { createdAt: 'desc' } }) : null;
    return { ...item, order: item.order ?? message?.amazonOrderId ?? null, storeIndex: message?.storeIndex ?? null, messageId: message?.id ?? null,
      status: item.status ?? 'awaiting_reply', cardStatus: card?.status ?? null,
      telegramLink: card?.telegramMessageId ? `https://t.me/c/3924739153/${card.telegramMessageId}` : null,
      mailLink: `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(item.account)}#all/${item.thread}`,
      // Source dates lack a timezone; do not invent an Amazon response deadline.
      deadline: null, lastScanAt: view.accounts.find(a => a.account === item.account)!.lastSuccessfulCheckAt, stale: view.accounts.find(a => a.account === item.account)!.stale };
  }));
  const { items: _items, historyItems: _history, ...meta } = view;
  void _items; void _history;
  return { ...meta, threads };
}

export const mailOpenThreads = (now = new Date(), db = prisma) => mailThreads(false, now, db);
export const mailHistory = (now = new Date(), db = prisma) => mailThreads(true, now, db);
