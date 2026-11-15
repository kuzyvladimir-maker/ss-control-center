/** Contract of cs_mail_unanswered.py. Mail evidence is not Seller Central state. */
export const MAIL_SOURCE = 'amazon_mail' as const;
export const MAIL_ACCOUNTS = ['amazon@salutem.solutions', 'amz.commerce@salutem.solutions', 'amazon.retailerdistributor@gmail.com', 'info.siriustrading@gmail.com'];
export const MAIL_FRESH_MS = 60 * 60_000;
export interface MailItem { account: string; buyer: string; date: string; subject: string; thread: string }
export interface MailSnapshot { checkedAt: string; unanswered: MailItem[]; errors: { account: string; error: string }[] }
export interface MailState { latest: MailSnapshot; lastSuccessfulCheckAt: string | null; accounts: Record<string, { checkedAt: string; items: MailItem[] }> }
export function validateMailSnapshot(input: unknown, now = new Date()): MailSnapshot {
  const s = input as MailSnapshot;
  if (!s || !Array.isArray(s.unanswered) || !Array.isArray(s.errors) || typeof s.checkedAt !== 'string') throw Error('Invalid mail snapshot');
  const at = Date.parse(s.checkedAt);
  if (!Number.isFinite(at) || at > now.getTime() + 60_000 || now.getTime() - at > MAIL_FRESH_MS) throw Error('Invalid or stale mail check time');
  const seen = new Set<string>();
  for (const x of s.unanswered) {
    if (!x || !MAIL_ACCOUNTS.includes(x.account) || !['buyer','subject','date','thread'].every(k => typeof x[k as keyof MailItem] === 'string') || !/^[a-f0-9]{8,64}$/i.test(x.thread) || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(x.date)) throw Error('Invalid mail thread');
    const key = `${x.account}:${x.thread}`;
    if (seen.has(key)) throw Error('Duplicate account/thread');
    seen.add(key);
  }
  for (const e of s.errors) if (!e || !MAIL_ACCOUNTS.includes(e.account) || typeof e.error !== 'string' || !e.error.trim()) throw Error('Invalid mail account error');
  return s;
}
export function mergeMailSnapshot(previous: MailState | null, next: MailSnapshot): MailState {
  if (previous && Date.parse(next.checkedAt) <= Date.parse(previous.latest.checkedAt)) return previous;
  const accounts = { ...previous?.accounts };
  for (const account of MAIL_ACCOUNTS) {
    if (!next.errors.some(e => e.account === account)) accounts[account] = { checkedAt: next.checkedAt, items: next.unanswered.filter(i => i.account === account) };
  }
  return { latest: next, accounts, lastSuccessfulCheckAt: next.errors.length ? previous?.lastSuccessfulCheckAt ?? null : next.checkedAt };
}
export function mailView(state: MailState | null, now = new Date()) {
  const accounts = MAIL_ACCOUNTS.map(account => {
    const last = state?.accounts[account];
    const error = state?.latest.errors.find(e => e.account === account)?.error ?? null;
    const fresh = Boolean(last && now.getTime() - Date.parse(last.checkedAt) < MAIL_FRESH_MS && !error);
    return { account, state: error ? 'failed' : !last ? 'never' : fresh ? 'fresh' : 'stale', stale: !fresh,
      lastSuccessfulCheckAt: last?.checkedAt ?? null, error, unanswered: fresh ? last!.items.length : null };
  });
  const stale = accounts.some(a => a.stale);
  return { source: MAIL_SOURCE, checkedAt: state?.latest.checkedAt ?? null, lastSuccessfulCheckAt: state?.lastSuccessfulCheckAt ?? null,
    lastScanAt: state?.lastSuccessfulCheckAt ?? null, stale, scanState: !state ? 'never' : stale ? 'incomplete' : 'fresh', accounts,
    coverage: [{ channel: 'Amazon', state: stale ? 'incomplete' : 'covered', scope: 'Configured Amazon mailboxes; last 7 days; mail reply matching, not Seller Central' },
      ...['Walmart','eBay','TikTok'].map(channel => ({ channel, state: 'not_covered', scope: 'No Amazon mailbox source' }))],
    // Partial successes are visible, but never presented as a complete total.
    items: accounts.filter(a => !a.stale).flatMap(a => state!.accounts[a.account].items),
    errors: state?.latest.errors ?? [], lookbackDays: 7 };
}
