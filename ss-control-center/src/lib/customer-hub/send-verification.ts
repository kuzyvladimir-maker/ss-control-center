import { createHash } from 'node:crypto';
export const SEND_TRANSPORT_ENABLED=false; // No approved screen-only executor has been verified.
export function verifySentEvidence(task:{storeIndex:number;amazonOrderId:string|null;payloadJson:string;claimedAt:Date|null},result:Record<string,unknown>|undefined,now=new Date()) {
 const p=result?.sentVerification as {source?:string;method?:string;storeIndex?:number;orderId?:string;bodySha256?:string;observedAt?:string;sellerMessageVisible?:boolean;evidenceRef?:string}|undefined;
 const body=JSON.parse(task.payloadJson).body;
 const at=Date.parse(p?.observedAt||'');
 if(!p || p.source!=='seller_central_screen'||p.method!=='screen_read'||p.storeIndex!==task.storeIndex||!task.amazonOrderId||p.orderId!==task.amazonOrderId||p.sellerMessageVisible!==true||!p.evidenceRef?.trim()||p.bodySha256!==createHash('sha256').update(body).digest('hex')||!Number.isFinite(at)||!task.claimedAt||at<task.claimedAt.getTime()||at>now.getTime()||now.getTime()-at>3600000)throw Error('Sent requires fresh in-thread screen confirmation bound to account, order and exact approved body');
 return p;
}
export function executionState(task:{status:string;approvedAt:Date|null;resultJson:string|null}) {
 if(task.status==='SENT_VERIFIED')return 'sent_verified';
 if(task.status==='CLAIMED')return 'pending';
 if(['FAILED','UNKNOWN','CANCELLED','BLOCKED','DONE'].includes(task.status))return 'blocked';
 return task.approvedAt?'approved':'blocked';
}
