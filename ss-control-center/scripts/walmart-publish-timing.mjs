// How long Walmart actually takes to process what we send.
//
// Every real submission stamps its own clock in the ledger: requested_at is the
// POST, accepted_at is Walmart acknowledging the feed, terminal_at is the feed
// reaching a terminal state. The poll cron (every 5 minutes) advances the last
// one, so the answer accumulates on its own — no separate measurement needed.
//
// Run: node scripts/walmart-publish-timing.mjs
import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';
const env=Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]}));
const db=createClient({url:env.TURSO_DATABASE_URL,authToken:env.TURSO_AUTH_TOKEN});
const r=await db.execute(`SELECT s.sku, a.state, a.marketplace_disposition AS disp,
  a.claimed_at, a.requested_at, a.accepted_at, a.terminal_at
  FROM MarketplaceSubmissionAttempt a JOIN ChannelSKU s ON s.id=a.channel_sku_id
  WHERE a.request_count > 0 ORDER BY a.created_at DESC`);
console.log(`отправок с реальным POST: ${r.rows.length}`);
for(const x of r.rows){
  const t=(v)=>v?new Date(v).toISOString().replace('T',' ').slice(0,19):'—';
  const mins=(a,b)=>a&&b?Math.round((new Date(b)-new Date(a))/60000)+'м':'—';
  console.log(`\n${x.sku} · ${x.state} · ${x.disp}`);
  console.log(`  claimed   ${t(x.claimed_at)}`);
  console.log(`  requested ${t(x.requested_at)}   (POST)`);
  console.log(`  accepted  ${t(x.accepted_at)}   +${mins(x.requested_at,x.accepted_at)} от POST`);
  console.log(`  terminal  ${t(x.terminal_at)}   +${mins(x.requested_at,x.terminal_at)} от POST`);
}
process.exit(0);
