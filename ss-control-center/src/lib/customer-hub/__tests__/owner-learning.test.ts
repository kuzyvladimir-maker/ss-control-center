import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ownerExampleId,ownerRuleId} from '../owner-learning';
import {rankKnowledgeBase} from '../kb-retrieval';
import {assertSendPolicy,removeApologies,salutemClosing} from '../reply-policy';
test('one situation keeps one example across retries and versions; comments deduplicate',()=>{
 assert.equal(ownerExampleId('message'),ownerExampleId('message'));
 assert.notEqual(ownerExampleId('message'),ownerExampleId('other'));
 assert.equal(ownerRuleId('card','rework',' note '),ownerRuleId('card','rework','note'));
});
test('relevant owner corrections outrank older imported examples',()=>{
 const common={problemType:'T5',scenario:'damaged parcel',customerSaid:'damaged parcel',channel:'Amazon',source:'owner_edit'};
 const ranked=rankKnowledgeBase([{...common,tags:'imported'},{...common,tags:'owner-approved'},{...common,tags:'owner-corrected'}],{customerMessage:'damaged parcel',predicted:[{problemType:'T5',hits:1}],channel:'Amazon'});
 assert.equal(ranked[0].row.tags,'owner-corrected');assert.equal(ranked[1].row.tags,'owner-approved');
});
test('no apologies or admissions; exact sign-off; refunds over $50 need explicit owner decision',()=>{
 const text=salutemClosing(removeApologies("Hello,\n\nWe're sorry for the inconvenience; we will review your request.\n\nBest regards,\nCustomer Support Team"));
 assert.doesNotThrow(()=>assertSendPolicy(text,100));
 assert.match(text,/review your request/);assert.match(text,/Salutem Solutions$/);
 assert.throws(()=>assertSendPolicy('Sorry.\nSalutem Solutions',20),/apology/);
 assert.throws(()=>assertSendPolicy('Our mistake.\nSalutem Solutions',20),/fault/);
 assert.throws(()=>assertSendPolicy('Hello\nCustomer Support Team',20),/Salutem/);
 const refund='We will issue a full refund.\nSalutem Solutions';
 assert.throws(()=>assertSendPolicy(refund,51),/owner/);
 assert.throws(()=>assertSendPolicy(refund,null),/owner/);
 assert.doesNotThrow(()=>assertSendPolicy(refund,51,true));
});

import {enqueueSendTask} from '../cs-tasks';
test('autopilot cannot enqueue even a policy-compliant response',async()=>{
 const m={storeIndex:1,editedResponse:'Hello,\nWe are reviewing your request.\nSalutem Solutions',suggestedResponse:null,orderTotal:20} as unknown as Parameters<typeof enqueueSendTask>[0];
 await assert.rejects(enqueueSendTask(m,{approvedBy:'autopilot'}),/Explicit owner/);
});
