# n8n Workflows — SS Control Center

These workflow JSONs live next to the codebase so Vladimir can re-import them
into n8n if the instance is rebuilt. Each workflow hits a Next.js API route
on Vercel; the route requires `Authorization: Bearer ${CRON_SECRET}`.

## Files

| File | Cron (ET) | Endpoint hit |
|---|---|---|
| `frozen-nightly-analysis.json` | 03:00 daily | `POST /api/frozen/run-analysis` |
| `frozen-morning-summary.json` | 07:00 daily | `GET /api/frozen/morning-summary` |

## How to import into n8n

1. Open n8n in the browser (`http://<vps-ip>:5678`).
2. Go to **Workflows → Import from File**.
3. Pick one of the JSON files in this folder.
4. The workflow opens but is paused — review nodes, then click **Active** in
   the top-right to enable the cron.

## Required environment variables in n8n

Set these in n8n under **Settings → Environment Variables** (or in the
`.env` file on the VPS if you're using docker-compose):

- `NEXTJS_BASE_URL` — e.g. `https://salutemsolutions.info`
- `CRON_SECRET` — same value as in Vercel project env
- `TELEGRAM_CHAT_ID` — default chat for the morning summary (Vladimir's DM)
- `TELEGRAM_ALERT_CHAT_ID` — group/channel for error alerts

The Telegram node also needs **Telegram API credentials** wired up in n8n →
Credentials → New → Telegram. Use the bot token from `TELEGRAM_BOT_TOKEN`.

## Manual test

In n8n, open a workflow → click **Execute Workflow** in the top-right.
- For `frozen-nightly-analysis`: the Next.js endpoint runs the pipeline
  (can take 30-120s) and returns a JSON summary. If `errors > 0`, the
  Telegram branch fires.
- For `frozen-morning-summary`: returns aggregated counts + a HTML-formatted
  message. If `total > 0`, the Telegram branch sends the summary.

## Why n8n, not Vercel cron

Vercel's Hobby plan only allows daily cron schedules. The frozen pipeline
itself runs daily (03:00 ET fits), so that part *could* run as a Vercel
cron. We keep it in n8n because:
1. Symmetry with the morning summary, which is a second daily ping (and
   Vercel only allows so many before billing kicks in).
2. n8n gives us free retry + error alerting without code changes.
3. If we ever need sub-daily polling (priority alerts in summer heat
   waves), only the n8n schedule has to change.
