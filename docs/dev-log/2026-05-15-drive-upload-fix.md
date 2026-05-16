# 2026-05-15 — Google Drive Upload Production Outage + Resolution

## TL;DR

После sprint 2026-05-14 (Drive upload перенесён из n8n в SS Control Center) этикетки покупались через Veeqo, но **PDF не появлялись на Google Drive**. Vladimir несколько дней не замечал потому что UI показывал зелёный счётчик «PDF saved 5/5» — но за этим стоял proxy URL fallback, не реальный Drive upload.

**Корневая причина:** тройное несоответствие. Код был переписан на OAuth refresh token (потому что service account не работает на личном Gmail без Workspace Shared Drive), но `.env.example` и `wiki/google-drive-setup.md` остались с инструкциями про service account. Vladimir по инструкции из wiki установил в Vercel `GOOGLE_SERVICE_ACCOUNT_JSON` — код это полностью игнорирует, требует `GOOGLE_OAUTH_*`, не находит их, тихо падает на fallback на `/api/shipping/label-pdf?shipmentId=X` (наш прокси к Veeqo с авторизацией). С пользовательской точки зрения «PDF доступен по клику» — но это не Drive, и завтра при ротации API key Veeqo PDF может стать недоступен.

**Решение:** дважды слой надёжности — синхронный OAuth upload (Layer 1) + асинхронный Vercel cron back-fill каждые 15 минут (Layer 2) + manual admin retry button (Layer 3). Всё **внутри SS Control Center**, n8n и Джеки полностью выводятся из этой цепочки.

---

## Хронология

**~21:30 ET (14 мая)** — Vladimir заметил что Drive не сохраняет PDF, написал в чат.

**~21:35 ET** — провёл аудит кода через filesystem MCP. Обнаружил тройное несоответствие:
- `src/lib/google-drive.ts` требует `GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN` + `GOOGLE_DRIVE_ROOT_FOLDER`
- `.env.example` описывает `GOOGLE_SERVICE_ACCOUNT_JSON`
- `wiki/google-drive-setup.md` детально описывает service account flow

**~21:50 ET** — также обнаружил UI bug: счётчик «PDF saved X/Y» считал `pdfSaved = labelPath != null`, что истина даже для proxy fallback (proxy URL всегда есть). Vladimir видел зелёное «5/5 saved» и пропускал warning сообщение 10px шрифтом внизу карточки.

**~22:10 ET** — переписал `wiki/google-drive-setup.md` на OAuth flow с пошаговой инструкцией Google Cloud Console + OAuth Playground.

**~22:30 ET** — обсудили варианты с Vladimir-ом. Три пути: in-app, n8n back-fill (Джеки), in-app + n8n hybrid. Vladimir сказал что Джеки ненадёжен («периодически отваливается»). Выбрали **чистый in-app dual-layer**: синхронный + cron back-fill, всё внутри SS Control Center.

**~22:45 ET** — Vladimir предложил «доделай всё сам до конца». Объяснил что один шаг неавтоматизируем — OAuth consent screen Google. Это сознательный security gate, требует человеческого клика «Allow». Всё остальное автоматизируется.

**~23:00 ET** — Vladimir сел делать OAuth setup, я coachил через чат. Открыли Google Cloud Console, нашли существующий OAuth client `n8n-automation` (Web application) от Джеки в проекте `n8n-automation-469920`.

**~23:15 ET** — переиспользовали client. Добавили redirect URI `https://developers.google.com/oauthplayground` к существующему (старый URI Джеки не тронули). Создали второй secret через `+ Add secret` (Google не показывает полный secret существующего, только last 4 chars).

**~23:30 ET** — OAuth Playground с своими credentials, scope `https://www.googleapis.com/auth/drive`, прошли consent от kuzy.vladimir@gmail.com, exchanged authorization code, получили refresh token.

**~23:45 ET** — записали credentials в `.env.local` (gitignored), создали master deploy prompt для Claude Code. Vladimir отдаст файл Claude Code в VS Code, тот сам прокинет в Vercel + redeploy.

---

## Технические находки

### 1. Service account не работает на personal Gmail Drive

Документировано в комментарии к `google-drive.ts`:
> «Personal-Gmail Drive doesn't allow service accounts to actually write — they don't have any storage quota of their own and you'd need Workspace Shared Drives for that to work, which kuzy.vladimir@gmail.com (the folder owner) doesn't have.»

Если бы попытались отладить старую service account реализацию — наткнулись бы на `storageQuotaExceeded` или похожие ошибки. Это знание заслуживает быть в wiki как явное предупреждение.

### 2. OAuth Playground 24h revoke — обходится своими credentials

OAuth Playground по умолчанию отзывает refresh tokens через 24 часа. Это безопасность для test токенов. Но если использовать **свои own application OAuth credentials** через Configuration panel — этот revoke не применяется. Нужно явно делать (chek «Use your own OAuth credentials» в Settings).

### 3. Client Secret больше нельзя посмотреть после создания

Google в 2024 убрал возможность просматривать полный Client Secret существующего OAuth client. Видны только последние 4 символа. **Если потерял — `Add secret` создаёт второй параллельный secret (rotation pattern), оба активны одновременно.**

### 4. Reuse существующего OAuth client сэкономило шаг

Изначально планировали выпускать новый OAuth client в новом GCP проекте. Но обнаружили проект `n8n-automation-469920` с готовым Web application client от Джеки. Переиспользовали — пропустили этапы создания проекта, OAuth consent screen setup, новой выдачи client. Сэкономили ~10 минут.

**Caveat:** существующий client помечен Google на удаление «not used for over 6 months» (last_used: Sept 19 2025). После того как SS Control Center начнёт refreshing tokens через него — last_used обновится, warning исчезнет.

### 5. UI зеленило proxy fallback

```typescript
// до фикса в page.tsx BuyReportDialog
const pdfMissing = report.bought.filter((b) => !b.pdfSaved).length;
// pdfSaved = labelPath != null, true даже для proxy URL
// результат: зелёное "5/5 saved" при всех failed Drive uploads
```

Это худший вид UI lie — molochaт о неуспехе. Урок: для трёх-уровневой fallback системы (drive/disk/proxy) счётчик «success» должен быть привязан к **highest tier**, не к любому tier.

После фикса:
```typescript
const driveCount = report.bought.filter((b) => b.pdfSource === "drive").length;
// + prominent warning банер если proxy/disk fallback fires
```

### 6. Dual-layer reliability pattern

Pattern для сценариев где синхронный upload может падать тихо:
- **Layer 1:** sync upload в hot path (`/api/shipping/buy`). Best effort.
- **Layer 2:** cron scan для leftovers. Bounded batch size. Idempotent.
- **Layer 3:** admin manual trigger. Same code as Layer 2 but with bigger limits.

Все три используют **одну и ту же** функцию `uploadLabelPdf()` — нет дублирования логики. Каждый слой добавляет другой контекст вызова (synchronous request / scheduled job / admin UI).

---

## Что осталось сделать

1. **Vladimir → Claude Code в VS Code:** прогнать `docs/CLAUDE_CODE_PROMPT_FINAL_DEPLOY.md`. После — Drive должен заработать.

2. **Verify через тест-покупку:** одна этикетка → проверить что появилась на Drive по правильному пути.

3. **Back-fill старые этикетки:** через admin UI `/admin/integrations` нажать «Run now» с lookback 1 year. Это догрузит на Drive все покупки которые лежали с proxy URL.

4. **Ротация secret (через ~неделю):** удалить `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` из Google Cloud Console (Add secret → выпустить третий новый → обновить Vercel env → удалить второй). Из чата второй secret уже утёк, надо ротировать. Refresh token также можно регенерить через OAuth Playground заново.

5. **Future hardening:**
   - Telegram alert когда `[drive-backfill]` за сутки нашёл >5 errors — сигнал что что-то стабильно не получается
   - Возможно — переключиться на `drive.file` scope (least privilege) если найдём способ pre-authorize существующую папку Shipping Labels для нашего OAuth client. Сейчас полный `drive` scope.

---

## Связанные документы

- `docs/MASTER_PROMPT_v3.3.md` §8 — структура папок на Drive (не менялась, всё ещё актуальна)
- `docs/wiki/google-drive-setup.md` — переписанная инструкция OAuth (создано 2026-05-15)
- `docs/wiki/drive-backfill.md` — будет создано в рамках DRIVE_BACKFILL промпта
- `docs/CLAUDE_CODE_PROMPT_DRIVE_OAUTH_FIX.md` — cleanup .env.example + UI fix
- `docs/CLAUDE_CODE_PROMPT_DRIVE_BACKFILL.md` — Layer 2 cron + admin UI
- `docs/CLAUDE_CODE_PROMPT_FINAL_DEPLOY.md` — master: env vars + run obove two + deploy
- `src/lib/google-drive.ts` — реализация OAuth client + uploadLabelPdf
- `src/lib/shipping-label-files.ts` — buildFolderPath / buildPdfFilename
