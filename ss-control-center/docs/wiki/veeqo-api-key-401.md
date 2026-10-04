# Veeqo API key rejected (401) — Procurement "Could not load"

**Symptom:** /procurement shows an error, Dashboard "To buy" is 0 or marked "Veeqo key rejected".
**Cause:** Veeqo returns `401 You're not authorized` for `VEEQO_API_KEY` (key revoked or recreated).
**Behavior now:** `/api/procurement/items` answers 502 with "Veeqo API key rejected — обновите VEEQO_API_KEY в Vercel"; `/api/dashboard/summary` returns `procurement.error`. Helper: `isVeeqoAuthError` in `src/lib/veeqo/client.ts`.

**Fix:**
1. Veeqo → Settings → API Keys: create a new key (do not delete the old one yet).
2. Check: `curl -H "x-api-key: $KEY" "https://api.veeqo.com/orders?page_size=1"` must return 200.
3. Vercel project `ss-control-center`: replace `VEEQO_API_KEY` (Production, plus Preview/Development if set), then redeploy production.
4. Update local `.env.local` (never commit).
5. Check `vercel logs --environment production --no-branch --since 15m --level error` for no "Veeqo API error 401".

Never print or commit the key.
