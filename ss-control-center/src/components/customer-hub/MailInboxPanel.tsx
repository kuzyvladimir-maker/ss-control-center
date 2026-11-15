"use client";
import { useEffect, useRef, useState } from 'react';
interface Message { id: string; date: string; sender: string; text: string; truncated?: boolean }
interface Thread { account: string; buyer: string; date: string; subject: string; thread: string; mailLink: string; messageId: string | null; order: string | null; cardStatus: string | null; lastMessageAt?: string; lastSender?: string; status: string; statusReason?: string; messages?: Message[]; stale: boolean }
interface Inbox {
  stale: boolean; historyAvailable: boolean; lookbackDays: number; lastSuccessfulCheckAt: string | null;
  accounts: { account: string; state: string; lastSuccessfulCheckAt: string | null; error: string | null }[];
  threads: Thread[];
}
const when = (date: string | null) => date ? new Date(date).toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' }) : 'Never';
const labels: Record<string,string> = { awaiting_reply:'Awaiting reply', sent:'Sent', resolved:'Resolved (ignore list)', needs_review:'No reply found in older mail' };
const keyOf = (t: Thread) => `${t.account}:${t.thread}`;
export default function MailInboxPanel({ showQueue = true, period = 30, processRequest = 0 }: { showQueue?: boolean; period?: number; processRequest?: number }) {
  const [data, setData] = useState<Inbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const handled = useRef(0);
  useEffect(() => {
    let active = true;
    const refresh = () => fetch('/api/customer-hub/mail-inbox?view=all', { cache: 'no-store' }).then(async r => { const d=await r.json(); if (!r.ok) throw Error(d.error || `HTTP ${r.status}`); return d; })
      .then(d => { if (active) { setData(d); setError(null); } }).catch(e => { if (active) setError(`Mail history unavailable: ${e.message}`); });
    window.addEventListener('cs-mail-refresh', refresh);
    void refresh(); const timer = setInterval(refresh, 60_000);
    return () => { active=false; clearInterval(timer); window.removeEventListener('cs-mail-refresh', refresh); };
  }, []);
  useEffect(() => {
    if (!showQueue || !data || !processRequest || handled.current === processRequest) return;
    handled.current = processRequest;
    if (data.stale || !data.historyAvailable) { setNotice('Cannot select the next case until a complete mail check is available.'); return; }
    const next = data.threads.filter(t => t.status === 'awaiting_reply').sort((a,b) => (a.lastMessageAt || '').localeCompare(b.lastMessageAt || ''))[0];
    if (!next) { setNotice('No messages awaiting reply in the last 7 days. All conversations remain available below.'); setFilter('all'); return; }
    setFilter('all'); setSelected(keyOf(next)); setNotice(`Opened ${next.buyer}. Review only — no reply has been sent.`);
  }, [data, processRequest, showQueue]);
  async function checkMail() {
    setChecking(true); setError(null); setNotice('Mail check requested. Waiting for the server worker…');
    try {
      const response=await fetch('/api/customer-hub/mail-refresh',{method:'POST'}); const job=await response.json();
      if (!response.ok) throw Error(job.error || `HTTP ${response.status}`);
      const until=Date.now()+180_000;
      while (Date.now()<until) {
        await new Promise(resolve=>setTimeout(resolve,3000));
        const r=await fetch('/api/customer-hub/mail-refresh',{cache:'no-store'}); const state=await r.json();
        if (!r.ok) throw Error(state.error || `HTTP ${r.status}`);
        if (state.id !== job.id) throw Error('Mail check was replaced; refresh the view for its status.');
        if (state.status === 'failed') throw Error(state.error || 'Mail check failed');
        if (state.status === 'completed') { window.dispatchEvent(new Event('cs-mail-refresh')); setNotice('Mail checked successfully; history and counts refreshed.'); return; }
      }
      throw Error('Mail check is still pending. The previous successful check remains visible; try refreshing the view shortly.');
    } catch(e) { setError(e instanceof Error ? e.message : 'Mail check failed'); setNotice(null); }
    finally { setChecking(false); }
  }
  const days=Math.min(30,period);
  const threads=(data?.threads || []).filter(t => !t.lastMessageAt || Date.parse(t.lastMessageAt)>=Date.now()-days*86400_000);
  const shown=threads.filter(t=>filter==='all'||t.status===filter);
  const active=threads.find(t=>keyOf(t)===selected);
  return <section className="space-y-3 rounded-lg border border-rule bg-surface p-4" aria-label="Amazon mail history">
    <h2 className="text-xl font-semibold">Ждут ответа: {data && data.historyAvailable && !data.stale ? data.threads.filter(t=>t.status==='awaiting_reply').length : 'неизвестно'}</h2>
    <p className="text-sm text-ink-2">{!data?'Загрузка истории…':!data.historyAvailable?'История пока недоступна':`История за ${days} дней: ${threads.length}${data.stale ? ' (последние сохранённые данные)' : threads.some(t=>t.status==='awaiting_reply') ? ' (все статусы, включая ожидающие ответа)' : ' (не требуют ответа)'}`}</p>
    <p className="text-sm">Needs review: {data?.historyAvailable ? threads.filter(t=>t.status==='needs_review').length : '—'} — старые письма без найденного подтверждения ответа; нужна ручная проверка, это не подтверждённая очередь ожидания.</p>
    <p className="text-sm">Last successful mail check: <strong>{when(data?.lastSuccessfulCheckAt ?? null)}</strong></p>
    <p className="text-xs text-ink-3">History: last {days} days. Awaiting reply: last 7 days; older mail without a reply needs review. Only mail delivered to the four configured Amazon mailboxes is covered. Messages without an email notification, other mailboxes, attachments and older history are not covered. This is not a complete Seller Central inbox. Walmart, eBay and TikTok: Not covered.</p>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {notice && <p role="status" className="text-sm text-ink-2">{notice}</p>}
    {data?.stale && <ul className="text-xs space-y-1">{data.accounts.map(a=><li key={a.account}>{a.account}: {a.state} · Last success: {when(a.lastSuccessfulCheckAt)}{a.error?` · ${a.error}`:''}</li>)}</ul>}
    {showQueue && <>
      <div className="flex flex-wrap gap-2 items-center">{['all','awaiting_reply','sent','resolved','needs_review'].map(f=><button key={f} onClick={()=>setFilter(f)} aria-pressed={filter===f} className={`rounded border px-3 py-1 text-sm ${filter===f?'bg-green-soft2 font-semibold':'border-rule'}`}>{f==='all'?'История':f==='resolved'?'Resolved':f==='needs_review'?'Needs review':labels[f]} ({f==='all'?threads.length:threads.filter(t=>t.status===f).length})</button>)}<button className="rounded border border-rule px-3 py-1 text-sm" onClick={checkMail} disabled={checking}>{checking?'Checking mail…':'Refresh mail status'}</button></div>
      {!data ? <p>Loading mail history…</p> : !data.historyAvailable ? <p>Full mail history has not been published. Request a mail check; an empty queue does not mean there are no conversations.</p> : !shown.length ? <p>No conversations in this filter. Select All to see the full history.</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-rule"><th className="p-2">Last message</th><th className="p-2">Buyer / order</th><th className="p-2">Last sender</th><th className="p-2">Status</th><th className="p-2">Conversation</th></tr></thead><tbody>{shown.map(t=><tr key={keyOf(t)} className="border-b border-rule"><td className="p-2">{when(t.lastMessageAt || null)}</td><td className="p-2"><strong>{t.buyer}</strong><p className="font-mono text-xs">{t.order || 'Order not found in email'}</p><p className="text-xs text-ink-3">{t.account}</p></td><td className="p-2">{t.lastSender==='seller'?'Salutem / seller':t.lastSender==='buyer'?'Buyer':'Unknown'}</td><td className="p-2">{labels[t.status] || t.status}</td><td className="p-2"><button className="underline" aria-expanded={selected===keyOf(t)} onClick={()=>setSelected(selected===keyOf(t)?null:keyOf(t))}>View messages ({t.messages?.length ?? 0})</button></td></tr>)}</tbody></table></div>}
      {active && <article aria-label={`Conversation with ${active.buyer}`} className="rounded border border-rule p-4 space-y-3"><div className="flex justify-between gap-2"><h3 className="font-semibold">{active.buyer} · {active.order || active.subject}</h3><button onClick={()=>setSelected(null)}>Close conversation</button></div><p className="text-xs">{labels[active.status]}{active.statusReason==='ignore_list'?' — manually excluded by the source ignore list; this is not proof of a sent reply.':''}</p>{active.messages?.map(m=><div key={m.id} className="border-t border-rule pt-3"><p className="text-xs font-semibold">{m.sender==='seller'?'Seller reply':'Buyer message'} · {when(m.date)}</p><p className="whitespace-pre-wrap break-words text-sm mt-2">{m.text || 'Message body unavailable in the mail source.'}</p>{m.truncated&&<p className="text-xs text-danger">Long message truncated; open the original email for the remainder.</p>}</div>)}<a className="underline text-sm" href={active.mailLink} target="_blank" rel="noreferrer">Open original mail thread</a></article>}
    </>}
  </section>;
}
