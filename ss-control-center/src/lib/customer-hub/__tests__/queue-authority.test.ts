import test from 'node:test';import assert from 'node:assert/strict';
import {queueView,validateScreenSnapshot,type ScreenSnapshot} from '../queue-authority';
import {verifySentEvidence,executionState,SEND_TRANSPORT_ENABLED} from '../send-verification';
import {createHash} from 'node:crypto';
const now=new Date('2026-11-18T18:00:00Z');
const snapshot:ScreenSnapshot={source:'seller_central_screen',method:'screen_read',storeIndex:1,account:'Salutem Solutions',evidenceRef:'test-screen.png',observedAt:now.toISOString(),metrics:{unread:0,responseNeeded:2,overSla:2,reportedUnresolved:1},threads:[{order:'112-8162702-1044245',buyer:'MJ',deadline:null,overSla:true},{order:'111-1111111-1111111',buyer:'Other',deadline:null,overSla:true}]};
test('missing source is unknown, never zero',()=>{const q=queueView(null,now);assert.equal(q.state,'unknown');assert.equal(q.metrics.responseNeeded,null);assert.deepEqual(q.threads,[])});
test('expired source retains last success but exposes no current figures',()=>{const q=queueView(snapshot,new Date(now.getTime()+3600000));assert.equal(q.state,'stale');assert.equal(q.metrics.responseNeeded,null);assert.equal(q.lastSuccessfulCheckAt,now.toISOString());assert.equal(q.threads.length,0)});
test('2 Response needed plus 1 unresolved is still 2, unread independent',()=>{const q=queueView(snapshot,now);assert.equal(q.metrics.responseNeeded,2);assert.equal(q.metrics.reportedUnresolved,1);assert.equal(q.metrics.unread,0);assert.equal(q.threads.length,2)});
test('mail history 27 and needs_review cannot establish queue',()=>{const mail={source:'amazon_mail',threads:Array(27).fill({status:'needs_review'}),observedAt:now.toISOString()} as unknown as ScreenSnapshot;assert.equal(queueView(mail,now).state,'unknown');assert.throws(()=>validateScreenSnapshot(mail,now))});
test('incomplete list and wrong account fail closed',()=>{assert.throws(()=>validateScreenSnapshot({...snapshot,threads:[]},now));assert.throws(()=>validateScreenSnapshot({...snapshot,storeIndex:2},now))});
const task={storeIndex:1,amazonOrderId:'112-8162702-1044245',payloadJson:JSON.stringify({body:'Approved reply'}),claimedAt:new Date(now.getTime()-1000)};
const proof={source:'seller_central_screen',method:'screen_read',storeIndex:1,orderId:task.amazonOrderId,bodySha256:createHash('sha256').update('Approved reply').digest('hex'),observedAt:now.toISOString(),sellerMessageVisible:true,evidenceRef:'test-sent-screen.png'};
test('sent needs exact in-thread proof, never just success or screenshot URL',()=>{assert.throws(()=>verifySentEvidence(task,{},now));assert.throws(()=>verifySentEvidence(task,{sentVerification:{...proof,bodySha256:'wrong'}},now));assert.throws(()=>verifySentEvidence(task,{sentVerification:{...proof,orderId:'other'}},now));assert.doesNotThrow(()=>verifySentEvidence(task,{sentVerification:proof},now))});
test('legacy DONE is not verified and disabled transport cannot resume',()=>{assert.equal(SEND_TRANSPORT_ENABLED,false);assert.equal(executionState({status:'DONE',approvedAt:now,resultJson:null}),'blocked');assert.equal(executionState({status:'CLAIMED',approvedAt:now,resultJson:null}),'pending');assert.equal(executionState({status:'QUEUED',approvedAt:now,resultJson:null}),'approved')});

import {prisma} from '@/lib/prisma';
import {completeTask,claimTask} from '../cs-tasks';
test('repeated completion writes one verified reply; repeat claim cannot send',async()=>{
 const at=new Date();const row={...task,id:'test-task',kind:'SEND',status:'CLAIMED',buyerMessageId:'m',cardId:null,claimedAt:new Date(at.getTime()-1000)};
 let writes=0;
 const tx={csTask:{updateMany:async({data}:{data:{status:string}})=>{if(row.status!=='CLAIMED')return {count:0};row.status=data.status;return {count:1}}},buyerMessage:{findUnique:async()=>({id:'m',channel:'Amazon',storeIndex:1}),update:async()=>({}),upsert:async()=>{writes++;return {}}}};
 const db={csTask:{findUnique:async()=>row,findUniqueOrThrow:async()=>row},$transaction:async(fn:(db:typeof tx)=>Promise<unknown>)=>fn(tx)} as unknown as typeof prisma;
 const result={sentVerification:{...proof,observedAt:at.toISOString()}};
 await completeTask('test-task','DONE',{result},db);await completeTask('test-task','DONE',{result},db);assert.equal(writes,1);
 await assert.rejects(()=>claimTask('test-task','screen',db),/blocked/);await assert.rejects(()=>claimTask('test-task','screen',db),/blocked/);assert.equal(writes,1);
});
