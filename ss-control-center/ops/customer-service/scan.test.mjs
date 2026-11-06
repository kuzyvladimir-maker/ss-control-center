import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const script=readFileSync(new URL('./scan-inbox.js',import.meta.url),'utf8');
const row={caseId:'a',merchantId:'A3A7A0RDFUSGBS',orders:['112-4952260-7430602'],buyerName:'Dee',lastUpdatedDate:1000,actionNeeded:86401000,marketplaceId:'US'};
function run(reply){return vm.runInNewContext(script,{location:{origin:'https://sellercentral.amazon.com'},document:{body:{innerText:'Salutem Solutions'}},AbortSignal,fetch:async p=>({ok:true,json:async()=>reply(p)})});}
test('scan traverses pages, reads buyer text, and checks membership a second time',async()=>{
 const seen=[]; const result=JSON.parse(await run(p=>{seen.push(p); if(p.includes('/a?'))return {partyCase:{merchantId:row.merchantId,caseArtifacts:[{creator:{partyRole:'BUYER'},createdDate:1000,message:{messageBody:'Missing one'}}]}};if(p.includes('ACTION_NEEDED'))return {cases:[row],nextToken:''};if(p.includes('nextToken=10'))return {cases:[{...row,caseId:'c'}],nextToken:''};return {cases:[{...row,caseId:'b'}],nextToken:'10'};}));
 assert.equal(result.items[0].text,'Missing one');assert.equal(result.resolved.length,2);assert.equal(seen.filter(p=>p.includes('ACTION_NEEDED')).length,2);
});
test('wrong-account or malformed folder is never a complete empty scan',async()=>{
 await assert.rejects(run(()=>({cases:[{...row,merchantId:'other'}],nextToken:''})),/Account mismatch/);
 await assert.rejects(run(()=>({})),/Incomplete/);
});
test('repeated pages fail closed',async()=>{
 await assert.rejects(run(()=>({cases:[row],nextToken:'10'})),/Duplicate page/);
});
