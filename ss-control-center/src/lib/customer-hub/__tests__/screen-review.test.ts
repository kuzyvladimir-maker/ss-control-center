import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateReview} from '../screen-review';
const x={order:'113-2368331-6725010',buyer:'Mary',requestId:'review-1',evidenceRef:'/screen/example.png',observedAt:new Date().toISOString(),clientText:'No cold pack',facts:[],decisionRu:'Clarify condition',missing:['Temperature unknown']};
test('screen review requires fresh identity, evidence and paired translations',()=>{
 assert.equal(validateReview(x).order,x.order);
 for(const bad of [{...x,evidenceRef:''},{...x,observedAt:'2020-01-01'},{...x,draftEn:'Hello Mary'},{...x,order:'other'}])assert.throws(()=>validateReview(bad));
});
