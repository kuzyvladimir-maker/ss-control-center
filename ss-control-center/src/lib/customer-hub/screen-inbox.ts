import { prisma } from '@/lib/prisma';
import { queueView, validateScreenSnapshot, type ScreenSnapshot } from './queue-authority';
export const SCREEN_KEY='cs_seller_screen_v1';
export async function screenInbox(now=new Date(),db=prisma) {
 const row=await db.setting.findUnique({where:{key:SCREEN_KEY}});
 let snapshot=null;try{snapshot=row?JSON.parse(row.value):null;}catch{}
 const view=queueView(snapshot,now);
 const threads=await Promise.all(view.threads.map(async t=>{
  const m=await db.buyerMessage.findFirst({where:{storeIndex:1,amazonOrderId:t.order,direction:'incoming'},orderBy:{createdAt:'desc'}});
  const card=m?await db.csCard.findFirst({where:{buyerMessageId:m.id},orderBy:{createdAt:'desc'}}):null;
  return {...t,messageId:m?.id??null,cardStatus:card?.status??null,telegramLink:card?.telegramMessageId?`https://t.me/c/3924739153/${card.telegramMessageId}`:null};
 }));
 return {...view,threads};
}
export async function recordScreenSnapshot(input:ScreenSnapshot) {
 const next=validateScreenSnapshot(input);
 await prisma.$transaction(async tx=>{const row=await tx.setting.findUnique({where:{key:SCREEN_KEY}});if(row&&Math.max(Date.parse(JSON.parse(row.value).observedAt)||0,Date.parse(JSON.parse(row.value).lastFailure?.observedAt||JSON.parse(row.value).observedAt)||0)>=Date.parse(next.observedAt))throw Error('Screen evidence must advance');await tx.setting.upsert({where:{key:SCREEN_KEY},create:{key:SCREEN_KEY,value:JSON.stringify(next)},update:{value:JSON.stringify(next)}});});
 return screenInbox();
}
export async function assertQueueMembership(storeIndex:number,order:string|null) {
 const view=await screenInbox();
 if(view.stale||storeIndex!==1||!view.threads.some(t=>t.order===order))throw Error('Publication blocked: no fresh Seller Central Response needed evidence for this order');
 return view;
}

/** A failed read invalidates current metrics immediately, retaining the last successful check. */
export async function recordScreenFailure(input:{storeIndex:number;source:string;observedAt:string;reason:string}) {
 const age=Date.now()-Date.parse(input.observedAt);
 if(input.storeIndex!==1||input.source!=='seller_central_screen'||!input.reason?.trim()||!Number.isFinite(age)||age<0||age>3600000)throw Error('Fresh account-bound failure required');
 await prisma.$transaction(async tx=>{
  const row=await tx.setting.findUnique({where:{key:SCREEN_KEY}});
  if(!row){await tx.setting.create({data:{key:SCREEN_KEY,value:JSON.stringify({lastFailure:{observedAt:input.observedAt,reason:input.reason}})}});return;}
  const prior=JSON.parse(row.value);
  if(Date.parse(input.observedAt)<Math.max(Date.parse(prior.observedAt)||0,Date.parse(prior.lastFailure?.observedAt||prior.observedAt)||0))throw Error('Failure cannot precede latest observation');
  await tx.setting.update({where:{key:SCREEN_KEY},data:{value:JSON.stringify({...prior,lastFailure:{observedAt:input.observedAt,reason:input.reason}})}});
 });
 return screenInbox();
}
