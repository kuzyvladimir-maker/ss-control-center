"use client";
import { useEffect, useState } from 'react';
interface Inbox {
  stale: boolean; lastSuccessfulCheckAt: string | null; checkedAt: string | null;
  accounts: { account: string; state: string; lastSuccessfulCheckAt: string | null; error: string | null }[];
  threads: { account: string; buyer: string; date: string; subject: string; thread: string; mailLink: string; messageId: string | null; order: string | null; cardStatus: string | null }[];
}
const when = (date: string | null) => date ? new Date(date).toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' }) : 'Never';
export default function MailInboxPanel({ showQueue = true }: { showQueue?: boolean }) {
  const [data, setData] = useState<Inbox | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () => fetch('/api/customer-hub/mail-inbox', { cache: 'no-store' }).then(r => { if (!r.ok) throw Error(); return r.json(); })
      .then(d => { if (active) { setData(d); setFailed(false); } }).catch(() => { if (active) setFailed(true); });
    window.addEventListener('cs-mail-refresh', refresh);
    void refresh(); const timer = setInterval(refresh, 60_000);
    return () => { active = false; clearInterval(timer); window.removeEventListener('cs-mail-refresh', refresh); };
  }, []);
  return <section className="space-y-3 rounded-lg border border-rule bg-surface p-4" aria-label="Amazon mail inbox">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <strong>Amazon mail · Awaiting reply</strong>
      <span className={failed || data?.stale ? 'text-danger' : 'text-ink-2'}>{failed ? 'Check unavailable' : !data ? 'Loading check status…' : data.stale ? 'Incomplete or stale — total unknown' : `${data.threads.length} awaiting reply`}</span>
    </div>
    <p className="text-sm">Last successful check: <strong>{when(data?.lastSuccessfulCheckAt ?? null)}</strong></p>
    <p className="text-xs text-ink-3">Scheduled every 30 minutes. Amazon mail only, last 7 days. Mail reply matching; not Seller Central status. Walmart, eBay and TikTok: Not covered.</p>
    {data && (data.stale || failed) && <ul className="text-xs space-y-1">{data.accounts.map(a => <li key={a.account}>{a.account}: {a.state} · Last success: {when(a.lastSuccessfulCheckAt)}{a.error ? ` · ${a.error}` : ''}</li>)}</ul>}
    {showQueue && data && !failed && <>
      {data.threads.length === 0 ? <p className="text-sm text-ink-2">{data.stale ? 'No complete current result. An empty list does not mean the inbox is clear.' : 'No unanswered threads in the covered mailboxes and time window.'}</p> :
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-rule"><th className="p-2">Date (mail source)</th><th className="p-2">Mailbox</th><th className="p-2">Buyer / subject</th><th className="p-2">Status</th><th className="p-2">Open</th></tr></thead>
          <tbody>{data.threads.map(t => <tr key={`${t.account}:${t.thread}`} className="border-b border-rule"><td className="p-2 whitespace-nowrap">{t.date}</td><td className="p-2">{t.account}</td><td className="p-2"><strong>{t.buyer}</strong><p>{t.subject}</p>{t.order && <p className="text-xs">{t.order}</p>}</td><td className="p-2">Awaiting reply<p className="text-xs text-ink-3">Card: {t.cardStatus || 'Not linked'}</p></td><td className="p-2"><a className="underline" href={t.mailLink} target="_blank" rel="noreferrer">Mail thread</a>{t.messageId && <p><a className="underline" href={`/customer-hub?message=${encodeURIComponent(t.messageId)}`}>Hub case</a></p>}</td></tr>)}</tbody></table></div>}
    </>}
  </section>;
}
