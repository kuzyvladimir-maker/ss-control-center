import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {advanceExecution,type ExecutionRecord} from './execution-journal';
const now=new Date('2026-11-18T19:30:00Z');
const pending:ExecutionRecord={storeIndex:1,order:'112-8162702-1044245',buyer:'MJ',approvalSource:'owner message 1625',status:'pending',body:'Verified exact reply',attemptId:'manual-1',startedAt:'2026-11-18T19:17:00Z'};
const sent:ExecutionRecord={...pending,status:'sent_verified',verification:{source:'seller_central_screen',method:'screen_read',storeIndex:1,orderId:pending.order,bodySha256:createHash('sha256').update(pending.body!).digest('hex'),observedAt:'2026-11-18T19:29:00Z',sellerMessageVisible:true,evidenceRef:'screen-receipt',afterReload:true,processingResponse:false}};
test('processing or wrong-order evidence never completes an instruction',()=>{
 assert.throws(()=>advanceExecution(pending,{...sent,verification:{...sent.verification,processingResponse:true}},now));
 assert.throws(()=>advanceExecution(pending,{...sent,verification:{...sent.verification,orderId:'113-2972988-7474644'}},now));
 assert.throws(()=>advanceExecution(pending,{...sent,body:'different'},now));
});
test('verified attempt is idempotent, preserves history, cannot replay or downgrade',()=>{
 const blocked={...pending,status:'blocked' as const,blocker:'Previous access failed'};
 const record=advanceExecution(blocked,sent,now);
 assert.equal(record.history?.[0].blocker,blocked.blocker);
 assert.deepEqual(advanceExecution(record,sent,now),record);
 assert.throws(()=>advanceExecution(record,pending,now));
 assert.throws(()=>advanceExecution(record,{...sent,attemptId:'again'},now));
});
test('pending attempts survive retry and cannot be silently replaced',()=>{
 assert.throws(()=>advanceExecution(pending,{...pending,attemptId:'again'},now));
 assert.throws(()=>advanceExecution(null,{...pending,approvalSource:''},now));
 assert.throws(()=>advanceExecution(null,{...pending,status:'blocked'},now));
});
