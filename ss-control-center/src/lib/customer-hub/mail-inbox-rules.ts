/** Contract of cs_mail_unanswered.py. Mail evidence is not Seller Central state. */
export const MAIL_SOURCE = 'amazon_mail' as const;
export const MAIL_ACCOUNTS = ['amazon@salutem.solutions', 'amz.commerce@salutem.solutions', 'amazon.retailerdistributor@gmail.com', 'info.siriustrading@gmail.com'];
export const MAIL_FRESH_MS = 60 * 60_000;
export interface MailMessage { id: string; thread: string; date: string; sender: 'buyer' | 'seller'; buyer: string; subject: string; order: string | null; text: string; truncated: boolean; bodyAvailable: boolean }
export interface MailItem { account: string; buyer: string; date: string; subject: string; thread: string;
  order?: string | null; threadIds?: string[]; lastMessageAt?: string; lastSender?: 'buyer' | 'seller';
  status?: 'awaiting_reply' | 'sent' | 'resolved' | 'needs_review'; statusReason?: string; messages?: MailMessage[] }
export interface MailSnapshot { checkedAt: string; schemaVersion?: number; lookbackDays?: number; threads?: MailItem[]; unanswered: MailItem[]; errors: { account: string; error: string }[] }
export interface MailState { latest: MailSnapshot; lastSuccessfulCheckAt: string | null; accounts: Record<string, { checkedAt: string; items: MailItem[]; history?: MailItem[]; lookbackDays?: number }> }
export function validateMailSnapshot(input: unknown, now = new Date()): MailSnapshot {
  const s = input as MailSnapshot;
  if (!s || !Array.isArray(s.unanswered) || !Array.isArray(s.errors) || typeof s.checkedAt !== 'string') throw Error('Invalid mail snapshot');
  const at = Date.parse(s.checkedAt);
  if (!Number.isFinite(at) || at > now.getTime() + 60_000 || now.getTime() - at > MAIL_FRESH_MS) throw Error('Invalid or stale mail check time');
  if (s.schemaVersion === 2 && (!Array.isArray(s.threads) || !s.lookbackDays || s.lookbackDays < 1 || s.lookbackDays > 30)) throw Error('Invalid full mail history');
  for (const list of [s.unanswered, ...(s.threads ? [s.threads] : [])]) {
  const seen = new Set<string>();
  for (const x of list) {
    if (!x || !MAIL_ACCOUNTS.includes(x.account) || !['buyer','subject','date','thread'].every(k => typeof x[k as keyof MailItem] === 'string') || !/^[a-f0-9]{8,64}$/i.test(x.thread) || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(x.date)) throw Error('Invalid mail thread');
    const key = `${x.account}:${x.thread}`;
    if (seen.has(key)) throw Error('Duplicate account/thread');
    seen.add(key);
    if (s.schemaVersion === 2) {
      if (!['awaiting_reply','sent','resolved','needs_review'].includes(x.status || '') || !['buyer','seller'].includes(x.lastSender || '') || !x.lastMessageAt || !Number.isFinite(Date.parse(x.lastMessageAt)) || !Array.isArray(x.messages) || !x.messages.length || !Array.isArray(x.threadIds)) throw Error('Incomplete conversation');
      if (x.order && !/^\d{3}-\d{7}-\d{7}$/.test(x.order)) throw Error('Invalid order');
      for (const m of x.messages) if (!m || typeof m.id !== 'string' || typeof m.text !== 'string' || m.text.length > 20000 || !['buyer','seller'].includes(m.sender) || !Number.isFinite(Date.parse(m.date))) throw Error('Invalid conversation message');
    }
  }
  }
  if (s.schemaVersion === 2) {
    const keys = (rows: MailItem[]) => rows.map(x => `${x.account}:${x.thread}`).sort().join('|');
    if (keys(s.unanswered) !== keys(s.threads!.filter(t => t.status === 'awaiting_reply'))) throw Error('Unanswered/history mismatch');
  }
  for (const e of s.errors) if (!e || !MAIL_ACCOUNTS.includes(e.account) || typeof e.error !== 'string' || !e.error.trim()) throw Error('Invalid mail account error');
  return s;
}
export function mergeMailSnapshot(previous: MailState | null, next: MailSnapshot): MailState {
  if (previous && Date.parse(next.checkedAt) <= Date.parse(previous.latest.checkedAt)) return previous;
  const accounts = { ...previous?.accounts };
  for (const account of MAIL_ACCOUNTS) {
    if (!next.errors.some(e => e.account === account)) accounts[account] = { checkedAt: next.checkedAt, items: next.unanswered.filter(i => i.account === account), history: next.threads?.filter(i => i.account === account), lookbackDays: next.lookbackDays ?? 7 };
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
    coverage: [{ channel: 'Amazon', state: stale ? 'incomplete' : 'covered', scope: 'Configured Amazon mailboxes; mail evidence, not Seller Central' },
      ...['Walmart','eBay','TikTok'].map(channel => ({ channel, state: 'not_covered', scope: 'No Amazon mailbox source' }))],
    // Partial successes are visible, but never presented as a complete total.
    items: accounts.filter(a => !a.stale).flatMap(a => state!.accounts[a.account].items),
    historyItems: accounts.flatMap(a => state?.accounts[a.account]?.history ?? []),
    historyAvailable: accounts.every(a => Array.isArray(state?.accounts[a.account]?.history)),
    errors: state?.latest.errors ?? [], lookbackDays: state?.latest.lookbackDays ?? 7 };
}
