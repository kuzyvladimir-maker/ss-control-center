import { advanceExecution, type ExecutionRecord } from '@/lib/customer-hub/execution-journal';
import { prisma } from '@/lib/prisma';
import { executionState,SEND_TRANSPORT_ENABLED } from '@/lib/customer-hub/send-verification';
import { verifyJackieAuth } from '@/lib/jackie-mcp/registry';
export async function GET(){
 const [tasks,intents]=await Promise.all([prisma.csTask.findMany({where:{kind:'SEND',storeIndex:1},orderBy:{createdAt:'desc'}}),prisma.setting.findMany({where:{key:{startsWith:'cs_execution_intent:'}}})]);
 return Response.json({transportEnabled:SEND_TRANSPORT_ENABLED,blocker:'Screen-only sender has not been verified; no automatic execution or resumption',tasks:tasks.map(t=>({id:t.id,order:t.amazonOrderId,status:executionState(t),executionBlocked:!SEND_TRANSPORT_ENABLED&&t.status!=='SENT_VERIFIED',approvedAt:t.approvedAt,approvedBy:t.approvedBy,createdAt:t.createdAt,legacyStatus:t.status,blocker:t.status==='DONE'?'Legacy completion without in-thread screen evidence':t.error||'Automatic sender is disabled; historical task is not the current queue',error:t.error})),intents:intents.map(r=>JSON.parse(r.value))},{headers:{'Cache-Control':'no-store'}});
}
// Record an owner-reported unresolved instruction, never a runnable send task.
export async function POST(request:Request){const error=verifyJackieAuth(request.headers.get('authorization'));if(error)return Response.json({error},{status:401});const x=await request.json();if(x.storeIndex!==1||!/^\d{3}-\d{7}-\d{7}$/.test(x.order)||!x.approvalSource||!x.buyer)return Response.json({error:'Order, buyer and explicit instruction provenance required'},{status:400});const key=`cs_execution_intent:1:${x.order}`;const value={...x,status:'blocked',sentVerified:false,blocker:'Prior send instruction remains unresolved. No in-thread confirmation recorded; this journal does not execute sends.',recordedAt:new Date().toISOString()};const row=await prisma.setting.upsert({where:{key},update:{},create:{key,value:JSON.stringify(value)}});return Response.json(JSON.parse(row.value));}

// Record a manually authorized screen execution with immutable evidence/history. No transport call.
export async function PUT(request:Request){
 const error=verifyJackieAuth(request.headers.get('authorization'));if(error)return Response.json({error},{status:401});
 try {
  const next=await request.json() as ExecutionRecord;
  const value=await prisma.$transaction(async tx=>{
   const key=`cs_execution_intent:1:${next.order}`;
   const row=await tx.setting.findUnique({where:{key}});
   const value=advanceExecution(row?JSON.parse(row.value):null,next);
   await tx.setting.upsert({where:{key},create:{key,value:JSON.stringify(value)},update:{value:JSON.stringify(value)}});
   return value;
  });
  return Response.json(value);
 }catch(e){return Response.json({error:e instanceof Error?e.message:'Invalid execution evidence'},{status:400});}
}
