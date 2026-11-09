import { test } from "node:test";
import assert from "node:assert/strict";
import { closeManually, validateManualClose } from "../manual-close";

const input = { storeIndex: 1, orderId: "111-4672452-6889854", sentAt: "2026-11-08T15:35:59Z",
  screenshot: { name: "proof.png", base64: "iVBORw0KGgo=" } };

test("manual closure requires exact store/order, screenshot and past timezone timestamp", () => {
  assert.equal(validateManualClose(input).sha256.length, 64);
  for (const bad of [{...input, storeIndex:2}, {...input, orderId:"wrong"}, {...input, sentAt:"2026-11-08T15:35:59"},
    {...input, sentAt:"2099-01-01T00:00:00Z"}, {...input, screenshot:{name:"bad",base64:"eA=="}}])
    assert.throws(() => validateManualClose(bad));
});

test("manual closure cancels queued work, stores screenshot, is idempotent and cannot send", async () => {
  let stored: {value:string} | null = null;
  const writes: unknown[] = [];
  const tx = {
    setting: {findUnique:async()=>stored, create:async({data}:{data:{value:string}})=>{stored=data;}},
    buyerMessage: {findMany:async(args:unknown)=>{writes.push(args);return [{id:"old"}];}, updateMany:async(args:unknown)=>{writes.push(args);return {count:1};}},
    csTask: {findFirst:async()=>null, updateMany:async(args:unknown)=>{writes.push(args);return {count:1};}},
    csCard: {updateMany:async(args:unknown)=>{writes.push(args);return {count:2};}},
  };
  const db = {$transaction:async(fn:(t:typeof tx)=>Promise<unknown>)=>fn(tx)} as unknown as Parameters<typeof closeManually>[1];
  const result = await closeManually(input, db);
  assert.equal(result.cardsClosed, 2);
  const before = writes.length;
  assert.equal((await closeManually(input, db)).alreadyRecorded, true);
  assert.equal(writes.length, before);
  assert.match(JSON.stringify(writes), /CANCELLED/);
  assert.match(JSON.stringify(writes[0]), /receivedAt.*lt/); // New follow-ups are excluded.
  assert.ok(stored);
  assert.match(JSON.stringify(stored), /iVBORw0KGgo=/);
});

test("manual closure refuses a currently claimed SEND before updating anything", async () => {
  const tx = {setting:{findUnique:async()=>null},buyerMessage:{findMany:async()=>[{id:"old"}]},csTask:{findFirst:async()=>({id:"sending"})}};
  const db = {$transaction:async(fn:(t:typeof tx)=>Promise<unknown>)=>fn(tx)} as unknown as Parameters<typeof closeManually>[1];
  await assert.rejects(closeManually(input, db), /currently claimed/);
});
