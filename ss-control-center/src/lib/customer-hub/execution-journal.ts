import { createHash } from 'node:crypto';
import { verifySentEvidence } from './send-verification';
export interface ExecutionRecord {
  storeIndex: number; order: string; buyer: string; approvalSource: string;
  status: 'approved' | 'pending' | 'blocked' | 'sent_verified';
  body?: string; attemptId?: string; startedAt?: string; blocker?: string | null;
  verification?: Record<string, unknown>; recordedAt?: string;
  history?: Omit<ExecutionRecord, 'history'>[];
  [key: string]: unknown;
}
/** A journal update never queues or sends a message. Verified attempts cannot be replayed. */
export function advanceExecution(previous: ExecutionRecord | null, next: ExecutionRecord, now = new Date()): ExecutionRecord {
  if (next.storeIndex !== 1 || !/^\d{3}-\d{7}-\d{7}$/.test(next.order) || !next.buyer?.trim() || !next.approvalSource?.trim()) throw Error('Explicit account, order, buyer and authorization required');
  if (!['approved','pending','blocked','sent_verified'].includes(next.status)) throw Error('Invalid execution status');
  if (previous?.status === 'sent_verified') {
    if (next.status === 'sent_verified' && next.attemptId === previous.attemptId && next.body === previous.body) return previous;
    throw Error('Verified instruction cannot be replayed or downgraded');
  }
  if (next.status === 'pending' || next.status === 'sent_verified') {
    if (!next.body?.trim() || !next.attemptId?.trim() || !Number.isFinite(Date.parse(next.startedAt || '')) || Date.parse(next.startedAt!) > now.getTime()) throw Error('Durable attempt ID, exact body and start time required');
    if (previous?.status === 'pending' && (previous.attemptId !== next.attemptId || previous.body !== next.body)) throw Error('Unconfirmed attempt cannot be replaced; verify the existing attempt');
  }
  if (next.status === 'blocked' && !next.blocker?.trim()) throw Error('Concrete blocker required');
  if (next.status === 'sent_verified') {
    if (next.verification?.processingResponse !== false || next.verification?.afterReload !== true) throw Error('Wait for processing and re-read the branch');
    verifySentEvidence({storeIndex:1,amazonOrderId:next.order,payloadJson:JSON.stringify({body:next.body}),claimedAt:new Date(next.startedAt!)},{sentVerification:next.verification},now);
    if (next.verification.bodySha256 !== createHash('sha256').update(next.body!).digest('hex')) throw Error('Body mismatch');
  }
  const history = previous ? [...(previous.history || []), Object.fromEntries(Object.entries(previous).filter(([key])=>key !== 'history')) as ExecutionRecord] : [];
  return {...next, blocker:next.status==='blocked'?next.blocker:null, sentVerified:next.status==='sent_verified',recordedAt:now.toISOString(),history};
}
