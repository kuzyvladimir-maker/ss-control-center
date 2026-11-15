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
export async function mailInbox(now = new Date()) {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  return mailView(row ? JSON.parse(row.value) as MailState : null, now);
}
/** Keep source membership even when a local card says SENT. Only exact account/thread joins. */
export async function mailOpenThreads(now = new Date()) {
  const view = await mailInbox(now);
  const threads = await Promise.all(view.items.map(async item => {
    const message = await prisma.buyerMessage.findFirst({ where: { channel: 'Amazon', direction: 'incoming', storeEmail: item.account, gmailThreadId: item.thread }, orderBy: { receivedAt: 'desc' } });
    const card = message ? await prisma.csCard.findFirst({ where: { buyerMessageId: message.id }, orderBy: { createdAt: 'desc' } }) : null;
    return { ...item, order: message?.amazonOrderId ?? null, storeIndex: message?.storeIndex ?? null, messageId: message?.id ?? null,
      status: 'awaiting_reply', cardStatus: card?.status ?? null,
      telegramLink: card?.telegramMessageId ? `https://t.me/c/3924739153/${card.telegramMessageId}` : null,
      mailLink: `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(item.account)}#all/${item.thread}`,
      // Source dates lack a timezone; do not invent an Amazon response deadline.
      deadline: null, lastScanAt: view.accounts.find(a => a.account === item.account)!.lastSuccessfulCheckAt, stale: false };
  }));
  const { items: _items, ...meta } = view;
  void _items;
  return { ...meta, threads };
}
