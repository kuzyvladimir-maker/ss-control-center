# 📨 Walmart: уточнение количества у клиента

## Суть
Покупатели на Walmart регулярно ошибаются с количеством на мультипак-листингах. Листинг «Mueller's Elbows … (Pack of 8)» — это **одна единица = 8 пачек**. Человек видит селектор количества, ставит 3 (думая «3 пачки») и получает 3 × 8 = **24 пачки**. Дальше — возврат, недовольство, удар по метрикам.

Эта фича даёт Владимиру кнопку на карточке Procurement: отправить покупателю вежливое письмо-уточнение «вы точно хотели столько?» **до отгрузки**, и потом увидеть ответ прямо в карточке.

## ⚠️ Ключевой механизм (была путаница)
У Walmart Marketplace API **нет эндпоинта «отправить сообщение покупателю»**. Связь с клиентом идёт **обычным письмом на per-order relay-адрес** (`4C11…@relay.walmart.com`). Этот адрес отдаёт Orders API в поле `customerEmailId`, и мы его уже сохраняем в `WalmartOrder`.

**Жёсткое ограничение:** relay принимает письмо **только с зарегистрированного Customer-service email** аккаунта. Для Sirius Trading International это **info.siriustrading@gmail.com** (Seller Center → Manage Contacts). Поэтому вся фича — это **отправка + опрос одного Gmail-ящика**, а не вызов Walmart API.

**Политика Walmart:** уточнение по заказу — разрешено (это «communication necessary for the order»). Запрещено: маркетинг, просьбы об отзыве, чужие трек-номера, письма-подтверждения. Проактивные звонки Walmart флагует как запрещённые — давим на email. Шаблон письма строго про заказ, в brand voice (factual, без emoji/промо).

## Поток
1. **Детектор аномалии** (`isQuantityAnomaly`): мультипак (packSize ≥ 2) заказан 2+ раз → жёлтый бейдж «Возможно ошибочное количество — спросить» на карточке. Только review-флаг, авто-рассылки нет.
2. **Кнопка → модалка** (`QuantityInquiryModal`): подставляет англоязычный шаблон (`buildInquiryEmail`), Владимир правит и жмёт «Отправить». **Кнопка + ручное подтверждение** — Владимир в контроле.
3. **Отправка** (`POST /api/procurement/inquire-quantity`): сервер резолвит relay-адрес из Walmart сам (клиенту не доверяет), шлёт письмо через Gmail с info.siriustrading@gmail.com, апсертит `WalmartCustomerInquiry` (status SENT).
4. **Опрос ответов** (крон `walmart-quantity-inquiry-poll`, 2×/сутки): ищет в ящике письма `from:<relay>`; пришёл ответ позже отправки → SENT→ANSWERED + текст ответа + Telegram-пинг; прошло 48ч без ответа → SENT→TIMEOUT.
5. **Чип в карточке**: «Спросили · ждём ответ» → «Ответ клиента: …» → «Нет ответа (48ч)». Статусы грузятся параллельно со списком (`POST /api/procurement/inquiry-status`).

## Архитектура
| Компонент | Файл | Роль |
|-----------|------|------|
| Модель БД | `prisma/schema.prisma` → `WalmartCustomerInquiry` | один ряд на PO: relayEmail, sentByEmail, snapshot строки, status, replyText |
| Миграция | `scripts/turso-migrate-walmart-customer-inquiry.mjs` | CREATE TABLE + индексы (Turso, идемпотентно) |
| Чистые хелперы | `src/lib/procurement/quantity-inquiry.ts` | `WALMART_SIRIUS_CS_EMAIL`, `isQuantityAnomaly`, `buildInquiryEmail` (client- и server-safe) |
| Gmail send | `src/lib/gmail-api.ts` → `sendGmailMessage`, `getGmailAccountByEmail` | + scope `gmail.send` в `getAuthUrl` |
| Отправка | `src/app/api/procurement/inquire-quantity/route.ts` | резолв relay (PO → DB → live-scan) + send + upsert |
| Статусы | `src/app/api/procurement/inquiry-status/route.ts` | флаги для карточек по customerOrderId |
| Крон опроса | `src/app/api/cron/walmart-quantity-inquiry-poll/route.ts` | 14:00 + 22:00 UTC, `maxDuration = 300` |
| UI: модалка | `src/app/procurement/components/QuantityInquiryModal.tsx` | compose + send |
| UI: карточка | `src/app/procurement/components/ProcurementCard.tsx` | бейдж аномалии + пункт меню + чип статуса |

## Резолв relay-адреса (надёжность)
Endpoint не доверяет клиенту адрес покупателя — резолвит сам, по приоритету:
1. `purchaseOrderId` из живого cancellation-sweep (клиент передаёт, если есть) → `getOrderById` (свежий relay).
2. DB-кэш `WalmartOrder` по `customerOrderId` → `getOrderById`; если живой запрос упал — берём `customerEmailId` из кэша.
3. Live-scan очередей Acknowledged + Created по `customerOrderId` (для свежих заказов, ещё не в кэше).

Нет relay-адреса в ответе Walmart → 422, письмо не уходит. Ящик не подключён → 409 с подсказкой подключить в Settings.

## Зависимость: подключить ящик
Фича не отправляет, пока **info.siriustrading@gmail.com** не подключён в Settings (Gmail OAuth) со scope **send + read**. Scope `gmail.send` добавлен в общий набор — на уже подключённые read-only ящики не влияет, но новый коннект Sirius должен пройти заново. `gmail.send` — «sensitive» (не «restricted») scope, доп. ревью Google не требует.

## Связанное
- [Walmart Marketplace API](walmart-api.md)
- Память: `project_walmart_customer_contact` (механизм relay + политика)
- Триггер фичи: возвраты по мультипак-ошибкам (заказы 200014756467686, 200014834141815)

_Добавлено 2026-06-07._
