import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAIL_ACCOUNTS, mailView, mergeMailSnapshot, validateMailSnapshot, type MailSnapshot } from '../mail-inbox-rules';
import { listTasks } from '../cs-tasks';
const now = new Date('2026-11-15T15:00:00Z');
const item = { account: MAIL_ACCOUNTS[0], buyer: 'Buyer', date: '2026-11-15 09:00', subject: 'Question', thread: '19aabbcc00112233' };
const snapshot = (extra: Partial<MailSnapshot> = {}): MailSnapshot => ({ checkedAt: now.toISOString(), unanswered: [item], errors: [], ...extra });
test('successful empty source means zero only inside declared mail coverage', () => {
 const view = mailView(mergeMailSnapshot(null, validateMailSnapshot(snapshot({ unanswered: [] }), now)), now);
 assert.equal(view.stale, false); assert.equal(view.items.length, 0); assert.equal(view.lastSuccessfulCheckAt, now.toISOString());
 assert.deepEqual(view.coverage.filter(c => c.state === 'not_covered').map(c => c.channel), ['Walmart','eBay','TikTok']);
});
test('failed check retains previous last success, never turns errors into empty success', () => {
 const previous = mergeMailSnapshot(null, snapshot());
 const failed = mergeMailSnapshot(previous, snapshot({ checkedAt: '2026-11-15T15:30:00Z', unanswered: [], errors: MAIL_ACCOUNTS.map(account => ({ account, error: 'Mail access failed' })) }));
 const view = mailView(failed, new Date('2026-11-15T15:31:00Z'));
 assert.equal(view.stale,true); assert.equal(view.items.length,0); assert.equal(view.lastSuccessfulCheckAt,previous.lastSuccessfulCheckAt);
 assert.ok(view.accounts.every(a => a.unanswered === null)); assert.equal(failed.accounts[item.account].items.length,1);
});
test('partial errors preserve only healthy account results; matching is account+thread, not buyer name', () => {
 const other = {...item, account: MAIL_ACCOUNTS[1]};
 const previous = mergeMailSnapshot(null, validateMailSnapshot(snapshot({unanswered:[item,other]}), now));
 const view = mailView(mergeMailSnapshot(previous, snapshot({ checkedAt:'2026-11-15T15:10:00Z', unanswered:[other], errors:[{account:item.account,error:'expired'}] })), new Date('2026-11-15T15:11:00Z'));
 assert.equal(view.stale,true); assert.deepEqual(view.items,[other]); assert.equal(view.lastSuccessfulCheckAt,now.toISOString());
});
test('after 60 minutes and before any check, count is unknown and no old threads are actionable', () => {
 assert.equal(mailView(null,now).stale,true);
 const view=mailView(mergeMailSnapshot(null,snapshot()),new Date('2026-11-15T16:00:00Z'));
 assert.equal(view.stale,true);assert.equal(view.items.length,0);assert.equal(view.lastSuccessfulCheckAt,now.toISOString());
});
test('late arrivals and duplicate retries cannot roll back successful source evidence', () => {
 const state=mergeMailSnapshot(null,snapshot());
 assert.equal(mergeMailSnapshot(state,snapshot({checkedAt:'2026-11-15T14:59:00Z',unanswered:[]})),state);
 assert.equal(mergeMailSnapshot(state,snapshot()),state);
});
test('reject malformed, stale, unknown accounts and duplicate account/thread snapshots', () => {
 for(const bad of [{}, snapshot({errors:undefined}), snapshot({checkedAt:'2026-11-14T15:00:00Z'}),snapshot({unanswered:[{...item,account:'unknown'}]}),snapshot({unanswered:[item,item]}), snapshot({unanswered:[{...item,thread:'../../other'}]})]) assert.throws(()=>validateMailSnapshot(bad,now));
});
test('disabled INBOX_SCAN cannot be handed to any browser worker', async () => {
 assert.deepEqual(await listTasks(1,'INBOX_SCAN'),[]);
});
