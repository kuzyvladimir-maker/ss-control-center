// Release claims stranded by a lost write race. Only CLAIMED with
// request_count = 0 — durable proof the POST never happened. Anything else is
// resolved by reading, never by releasing.
import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';
const env=Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]}));
const db=createClient({url:env.TURSO_DATABASE_URL,authToken:env.TURSO_AUTH_TOKEN});
const apply = process.argv.includes('--apply');

const rows=(await db.execute(`SELECT a.id, a.state, a.request_count, s.sku, s.id AS sku_id, s.listing_status
  FROM MarketplaceSubmissionAttempt a JOIN ChannelSKU s ON s.id=a.channel_sku_id
  WHERE a.state='CLAIMED' AND a.request_count=0`)).rows;
console.log(`кандидатов: ${rows.length}`);
for(const r of rows) console.log(` · ${r.sku} attempt=${r.id} listing=${r.listing_status}`);
if(!apply){ console.log('\n(сухой прогон; добавь --apply чтобы применить)'); process.exit(0); }
for(const r of rows){
  await db.execute({sql:`UPDATE MarketplaceSubmissionAttempt
    SET state='RETRYABLE', active_key=NULL, marketplace_disposition='LOCAL_PREFLIGHT_RETRYABLE',
        error_json=?, terminal_at=CURRENT_TIMESTAMP, retry_after=NULL, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND state='CLAIMED' AND request_count=0`,
    args:[JSON.stringify({error:'Claim stranded by a lost write race; no POST was made (request_count=0)'}), r.id]});
  await db.execute({sql:`UPDATE ChannelSKU SET listing_status='RETRYABLE', lifecycle_status='VALIDATED', updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND listing_status='SUBMITTING'`, args:[r.sku_id]});
  console.log(`освобождено: ${r.sku}`);
}
const check=(await db.execute(`SELECT COUNT(*) n FROM MarketplaceSubmissionAttempt WHERE state='CLAIMED' AND request_count=0`)).rows[0];
console.log(`осталось зависших: ${check.n}`);
process.exit(0);
