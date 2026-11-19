import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { assertQueueMembership } from './screen-inbox';
import { renderCardText } from './card-format';
import { assertSendPolicy } from './reply-policy';
export interface ScreenReview {
 order:string; buyer:string; evidenceRef:string; observedAt:string; requestId:string;
 clientText:string; clientRu?:string; facts:{what:string;value:string}[];
 decisionRu:string; missing:string[]; draftEn?:string; draftRu?:string;
}
export function validateReview(x:ScreenReview, now=Date.now()) {
 const age=now-Date.parse(x.observedAt);
 if(!/^\d{3}-\d{7}-\d{7}$/.test(x.order)||!x.buyer?.trim()||!x.evidenceRef?.trim()||!x.requestId?.trim()||!Number.isFinite(age)||age<0||age>3600000)throw Error('Fresh account-bound screen review required');
 if(!x.clientText?.trim()||!x.decisionRu?.trim()||!Array.isArray(x.facts)||!Array.isArray(x.missing))throw Error('Screen facts, decision and unknowns required');
 if(Boolean(x.draftEn?.trim())!==Boolean(x.draftRu?.trim()))throw Error('Both RU and EN drafts required');
 if(x.draftEn)assertSendPolicy(x.draftEn,null,false);
 return x;
}
/** Stores a draft for owner review only. Never calls a buyer transport or learns approval. */
export async function screenReview(input:ScreenReview) {
 const x=validateReview(input); const queue=await assertQueueMembership(1,x.order);
 const id='screen-review-'+createHash('sha256').update(x.requestId).digest('hex').slice(0,32);
 const existing=await prisma.csCard.findUnique({where:{id}});
 if(existing)return JSON.parse(existing.cardJson);
 const infoOnly=!x.draftEn;
 const payload=await prisma.$transaction(async tx=>{
  const messageId='screen-message-'+createHash('sha256').update(x.requestId).digest('hex').slice(0,32);
  await tx.buyerMessage.create({data:{id:messageId,source:'screenshot',channel:'Amazon',storeIndex:1,storeName:'Salutem Solutions',customerName:x.buyer,amazonOrderId:x.order,customerMessage:x.clientText,customerMessageRu:x.clientRu||null,suggestedResponse:x.draftEn||null,suggestedResponseRu:x.draftRu||null,status:'ANALYZED',ownerBrief:x.decisionRu,action:'clarify'}});
  const textRu=renderCardText({orderId:x.order,store:'Salutem Solutions',version:1,infoOnly,deadlineRu:queue.threads.find(t=>t.order===x.order)?.deadline||'Срок — см. свежую очередь Seller Central',clientRu:x.clientRu||x.clientText,historyRu:null,facts:[...x.facts,{what:'Экранный источник',value:x.evidenceRef+'; '+x.observedAt}],verdictRu:x.decisionRu,pointsRu:[],missing:x.missing,draftRu:x.draftRu||null,draftEn:x.draftEn||'',attachments:[]});
  const card={cardId:id,buyerMessageId:messageId,version:1,...(infoOnly?{kind:'info'}:{}),store:'Salutem Solutions',storeIndex:1,orderId:x.order,textRu,draftEn:x.draftEn||'',draftRu:x.draftRu||null,draftSource:'screen_review',queueSource:queue.source,queueObservedAt:queue.lastScanAt,buttons:infoOnly?[]:[{label:'Одобрить',action:'approve',callbackData:`cs:${id}:approve`},{label:'Неверно',action:'wrong',callbackData:`cs:${id}:wrong`},{label:'Доработать',action:'rework',callbackData:`cs:${id}:rework`}]};
  await tx.csCard.create({data:{id,buyerMessageId:messageId,cardJson:JSON.stringify(card)}});return card;
 });return payload;
}
