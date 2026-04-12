# 📧 Gmail API — Интеграция

## Суть
Получение buyer messages и chargeback notifications из Gmail. OAuth Web client зарегистрирован в Google Cloud проекте `neon-reporter-490119-r4` (Salutem OpenClaw); одни и те же credentials обслуживают все store-аккаунты. Refresh tokens хранятся в `Setting` таблице (ключи `gmail_refresh_token_store{N}`, `gmail_email_store{N}`), больше не в `.env`.

## Подключённые аккаунты
| Store | Название | Email | Статус |
|---|---|---|---|
| 1 | Salutem Solutions | amazon@salutem.solutions | ✅ Connected |
| 2 | Vladimir Personal | kuzy.vladimir@gmail.com | ✅ Connected |
| 3 | AMZ Commerce | amz.commerce@salutem.solutions | ⏳ готов к подключению |
| 4 | Sirius International | ancienmadina2@gmail.com | ⏳ готов к подключению |
| 5 | Retailer Distributor | amazon.retailerdistributor@gmail.com | ⏳ готов к подключению |

Email → store маппинг живёт в `src/lib/gmail-api.ts` в `EMAIL_TO_STORE`. При добавлении нового магазина обновить маппинг и поле `expectedEmail` будет автоматически подхвачено в `listGmailAccountStatus()`.

## OAuth flow
1. Пользователь жмёт **Connect** рядом с нужным Store в `/settings` → `GET /api/auth/gmail?store={N}`
2. Route строит authorization URL через `google.auth.OAuth2` с `state=store={N}`, редиректит на Google
3. Google → callback → `/api/auth/gmail/callback?code=...&state=store={N}`
4. Callback обменивает код на refresh token, получает email через `gmail.users.getProfile`, сохраняет через `saveGmailAccount(storeIndex, token, email)` в `Setting` таблицу
5. Редирект на `/settings?gmail=success&email=...&store={N}` — UI авто-обновляется через refetch

Без рестарта сервера. Без правки `.env`. Кнопка **Disconnect** удаляет записи из `Setting` через `DELETE /api/integrations/gmail?store={N}`.

## Gmail Queries
- **Buyer messages:** `from:marketplace.amazon.com to:{account_email} newer_than:2d`
- **Chargebacks:** `from:cb-seller-notification@amazon.com newer_than:7d`

## Парсинг писем
| Поле | Откуда | Паттерн |
|------|--------|-------|
| Order ID | Subject/Body | `(\d{3}-\d{7}-\d{7})` |
| Customer Name | Subject | `from Amazon customer (.+?)[\s(]` |
| ASIN | Body HTML | `/dp/([A-Z0-9]{10})` + `/gp/product/...` + `?asin=...` с валидацией `^B[A-Z0-9]{9}$` |
| Product Name | Body HTML | `<a href=".../dp/ASIN">…</a>` (anchor-based) |
| Message Text | Body | После `Message:` label |

## Связанные файлы
- `src/lib/gmail-api.ts` — Gmail OAuth клиент, `saveGmailAccount`, `getConnectedGmailAccounts`, `listGmailAccountStatus`
- `src/lib/customer-hub/gmail-parser.ts` — парсинг писем buyer messages
- `src/app/api/auth/gmail/route.ts` — OAuth init (`?store=N`)
- `src/app/api/auth/gmail/callback/route.ts` — OAuth callback + сохранение в БД
- `src/app/api/integrations/gmail/route.ts` — статус и disconnect
- `src/app/settings/page.tsx` → `GmailAccountsPanel` — per-store Connect/Disconnect UI

## Переменные окружения
- `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` — OAuth credentials (Web application client, создан в `neon-reporter-490119-r4`)
- `GMAIL_REDIRECT_URI` — опционально; при отсутствии `resolveRedirectUri()` использует `http://localhost:3000/api/auth/gmail/callback` в dev или `https://$VERCEL_URL/...` на проде
- `GMAIL_REFRESH_TOKEN_STORE{N}` — **legacy**, только для обратной совместимости. Новые подключения пишутся в `Setting` таблицу. UI помечает env-токены как "(from .env — legacy)"

## 🔗 Связи
- **Используется в:** [Customer Hub](customer-hub.md) (Messages + Chargebacks табы), [Amazon Notifications Map](amazon-notifications-map.md) (главный канал доставки уведомлений)
- **Связан с:** [Amazon SP-API](amazon-sp-api.md) (обогащение данных заказа)
- **См. также:** [A-to-Z & Chargeback](atoz-chargeback.md), [Deploy plan](deploy-to-vercel-plan.md)

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
- 2026-04-11: Полный рефакторинг OAuth: Web client создан, credentials в `.env`, токены мигрированы в `Setting` таблицу, UI с per-store Connect. Store 1 и 2 подключены. Добавлены email для Store 3/4/5 в `EMAIL_TO_STORE` маппинг, готовы к подключению кнопкой.
