/** Only account-bound Seller Central screen evidence can establish a current queue. */
export const QUEUE_SOURCE = 'seller_central_screen';
export const QUEUE_TTL_MS = 60 * 60_000;
export interface ScreenSnapshot {
  source: typeof QUEUE_SOURCE; storeIndex: number; observedAt: string;
  collector?: 'cs-screen-worker'; method: 'screen_read'; account: 'Salutem Solutions'; evidenceRef: string;
  metrics: { unread: number | null; responseNeeded: number; overSla: number | null; reportedUnresolved: number | null };
  threadErrors?: {row:number;field:'identity'|'sla';reason:string}[];
  lastFailure?: { observedAt: string; reason: string };
  threads: { order: string; buyer: string; deadline: string | null; overSla: boolean | null }[];
}
export function validateScreenSnapshot(s: ScreenSnapshot, now = new Date()) {
  if (!s || s.source !== QUEUE_SOURCE || s.method !== 'screen_read' || s.storeIndex !== 1 || s.account !== 'Salutem Solutions' || !s.evidenceRef?.trim()) throw Error('Account-bound Seller Central screen evidence required');
  const age=now.getTime()-Date.parse(s.observedAt);
  if (!Number.isFinite(age) || age<0 || age>QUEUE_TTL_MS) throw Error('Fresh screen timestamp required');
  if (!s.metrics || !Array.isArray(s.threads)) throw Error('Screen metrics and complete Response needed list required');
  for (const key of ['unread','responseNeeded','overSla','reportedUnresolved'] as const) {const n=s.metrics[key];if (n!==null && (!Number.isInteger(n)||n<0)) throw Error('Invalid screen metric');}
  const errors=s.threadErrors??[];
  if(!Array.isArray(errors)||errors.some(e=>!Number.isInteger(e.row)||e.row<0||e.row>=s.metrics.responseNeeded||!['identity','sla'].includes(e.field)||!e.reason?.trim())||new Set(errors.map(e=>e.row)).size!==errors.length)throw Error('Invalid thread read errors');
  const missing=errors.filter(e=>e.field==='identity').length;
  if (s.metrics.responseNeeded===null || s.threads.length+missing!==s.metrics.responseNeeded || new Set(s.threads.map(t=>t.order)).size!==s.threads.length) throw Error('Response needed count/list mismatch');
  for(const t of s.threads) if(!/^\d{3}-\d{7}-\d{7}$/.test(t.order)||!t.buyer?.trim()||![true,false,null].includes(t.overSla)) throw Error('Invalid screen thread');
  if((missing||s.threads.some(t=>t.overSla===null))&&s.metrics.overSla!==null)throw Error('Incomplete SLA evidence cannot establish an aggregate');
  return s;
}
export function queueView(snapshot: ScreenSnapshot | null, now = new Date()) {
  let valid=false;
  if(snapshot) try { validateScreenSnapshot(snapshot,new Date(snapshot.observedAt));valid=true; } catch {}
  const age=valid?now.getTime()-Date.parse(snapshot!.observedAt):Infinity;
  const failed=Boolean(snapshot?.lastFailure && (!valid || Date.parse(snapshot.lastFailure.observedAt)>=Date.parse(snapshot.observedAt)));
  const fresh=valid && !failed && age>=0 && age<QUEUE_TTL_MS;
  const errors=fresh?(snapshot!.threadErrors??[]).map(e=>({account:'Salutem Solutions',error:`Thread ${e.row+1} ${e.field}: ${e.reason}`})):[];
  const partial=fresh&&(errors.length>0||snapshot!.threads.some(t=>t.overSla===null));
  return {source:QUEUE_SOURCE, readStatus:fresh?(partial?'partial':'ok'):'unknown', coverage:fresh?{expected:snapshot!.metrics.responseNeeded,read:snapshot!.threads.length}:null, state:fresh?'fresh':failed?'unknown':valid?'stale':'unknown', stale:!fresh,
    lastSuccessfulCheckAt:valid?snapshot!.observedAt:null,lastScanAt:valid?snapshot!.observedAt:null,
    reason:failed?`Screen check failed: ${snapshot!.lastFailure!.reason}`:fresh?null:valid?'Снимок Seller Central устарел':'Не проверено: нет подтверждённого экранного снимка Seller Central',
    metrics:fresh?snapshot!.metrics:{unread:null,responseNeeded:null,overSla:null,reportedUnresolved:null},
    threads:fresh?snapshot!.threads.map(t=>({...t,storeIndex:1,status:'response_needed',stale:false,lastScanAt:snapshot!.observedAt})):[],
    collector:valid?snapshot!.collector??'manual':null, evidenceRef:valid?snapshot!.evidenceRef:null, errors};
}
