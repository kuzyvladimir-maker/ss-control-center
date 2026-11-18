'use client';
import {useEffect,useState} from 'react';
interface Entry {id?:string;order:string;buyer?:string;status:string;approvedAt?:string;blocker?:string;recordedAt?:string;body?:string;history?:Entry[]}
export default function ExecutionPanel(){
 const [data,setData]=useState<{tasks:Entry[];intents:Entry[]}|null>(null);
 const [error,setError]=useState(false);
 useEffect(()=>{
  const refresh=()=>fetch('/api/customer-hub/executions',{cache:'no-store'}).then(r=>{if(!r.ok)throw Error();return r.json()}).then(d=>{setData(d);setError(false)}).catch(()=>setError(true));
  void refresh();window.addEventListener('cs-mail-refresh',refresh);
  return()=>window.removeEventListener('cs-mail-refresh',refresh);
 },[]);
 const groups=new Map<string,Entry[]>();
 for(const t of data?.tasks||[])groups.set(t.order,[...(groups.get(t.order)||[]),t]);
 return <section className="border border-rule rounded p-4 space-y-2">
  <h2 className="font-semibold">Reply instructions</h2>
  <p className="text-sm">Execution history is separate from the current Response needed queue. Automatic sending remains disabled.</p>
  {error?<p role="alert">Execution journal unavailable. Refresh to retry.</p>:!data?<p>Loading…</p>:<>
   {data.intents.filter(t=>t.status!=='blocked').map(t=><div key={t.order}>
    <p>{t.buyer} · {t.order} · <strong>{t.status}</strong></p>
    <details><summary>Instruction and reply evidence</summary><p>{t.recordedAt}</p><pre className="whitespace-pre-wrap">{t.body}</pre><details><summary>Technical record</summary><pre className="whitespace-pre-wrap text-xs">{JSON.stringify(t,null,2)}</pre></details></details>
   </div>)}
   <details><summary>Technical details and preserved instruction history ({groups.size} historical orders)</summary>
    <p>Blocked records below are not unanswered customers. Repeated orders group distinct historical tasks; no records have been deleted.</p>
    {data.intents.filter(t=>t.status==='blocked').map(t=><details key={t.order}><summary>{t.buyer} · {t.order} · blocked</summary><p>{t.blocker}</p><details><summary>Technical record</summary><pre className="whitespace-pre-wrap text-xs">{JSON.stringify(t,null,2)}</pre></details></details>)}
    {[...groups].map(([order,tasks])=><details key={order}><summary>{order} · {tasks.length} historical task{tasks.length===1?'':'s'}</summary>{tasks.map(t=><p key={t.id}>{t.id} · {t.status} · {t.approvedAt} · {t.blocker}</p>)}</details>)}
   </details>
  </>}
 </section>;
}
