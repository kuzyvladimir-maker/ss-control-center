# 🧠 Customer Hub Decision Engine

## Суть
AI-движок классификации и принятия решений по обращениям покупателей. 5 слоёв анализа, работает через Claude API.

## 5 слоёв

### Слой 1: Классификация (Problem Type T1-T20)
Определение типа проблемы: where is my order, damaged, spoiled, wrong item, missing item, etc.

### Слой 2: Оценка риска
A-to-Z risk (HIGH/MEDIUM/LOW), food safety risk (boolean), urgency.

### Слой 3: Решение
Action: REPLACEMENT, REFUND, A2Z_GUARANTEE, ESCALATE, INFO, PHOTO_REQUEST.

### Слой 4: Чеклист
Internal actions: что нужно проверить/сделать перед ответом.

### Слой 5: Кто платит
WHO_SHOULD_PAY: us / carrier / Amazon / buyer.

## Post-generation validator (флажки вместо авто-переписывания)

После генерации ответа модели запускается детектор нарушений
(`detectResponseViolations` в [message-analyzer.ts](../../ss-control-center/src/lib/customer-hub/message-analyzer.ts)),
который проверяет 6 правил:

1. предложен cancel для shipped заказа
2. fact-check нашёл неверные даты
3. ответ говорит "delivered", хотя заказ in_transit
4. ответ говорит "in transit", хотя заказ delivered
5. seller-funded refund, хотя должна платить Amazon
6. гарантия food safety после жалобы на spoilage

**Что делает детектор:** не переписывает ответ. Если найдены нарушения,
к `reasoning` добавляется тег `[NEEDS REVIEW: ...]`, а в UI
[MessageDetail.tsx](../../ss-control-center/src/components/customer-hub/MessageDetail.tsx)
показывается янтарный баннер **«Needs review — policy violation detected»**
с перечнем проблем. Оператор решает: отправить как есть, отредактировать
вручную, или нажать кнопку **Fix**.

**Manual Fix button** (`action: "fix"` в
[api/customer-hub/messages/[id]/route.ts](../../ss-control-center/src/app/api/customer-hub/messages/[id]/route.ts))
вызывает `validateAndFixResponse`, который пытается переписать ответ
через второй вызов модели по жёсткому промпту. Если не получилось —
последним шагом подставляет `buildSafeResponse` (детерминированный
шаблон). Это путь ТОЛЬКО ручной, по явному клику.

**Почему так:** раньше `analyzeMessage` автоматически переписывал ответ
или подставлял safe template при любом нарушении. Это прятало нормальные
ответы модели под примитивными шаблонами («старый усечённый формат»).
Теперь оператор видит оригинал модели + предупреждение и решает сам.

## Связанные файлы
- `src/lib/customer-hub/message-analyzer.ts` — реализация (analyzeMessage,
  detectResponseViolations, validateAndFixResponse, buildSafeResponse)
- `src/lib/customer-hub/message-enricher.ts` — сборка фактов для промпта
- `src/lib/claude.ts` — Claude API клиент
- `src/components/customer-hub/MessageDetail.tsx` — UI-баннеры и Fix button
- `docs/CUSTOMER_HUB_ALGORITHM_v2.2.md` — полное описание

## 🔗 Связи
- **Часть:** [Customer Hub](customer-hub.md)
- **Зависит от:** [Claude AI](claude-ai.md), [Amazon SP-API](amazon-sp-api.md) (данные заказа для контекста)
- **Влияет на:** [A-to-Z & Chargeback](atoz-chargeback.md) (risk assessment)
- **См. также:** [Frozen shipping rules](frozen-shipping-rules.md) (food safety)

## Bilingual UI (EN/RU) — 2026-04-11

Operator может читать и редактировать сообщение клиента и ответ в двух
языках одновременно. Английский — каноничный язык (именно он отправляется
клиенту), русский — рабочая колонка для Владимира, чтобы не копировать в
переводчик.

**Хранение.** В `BuyerMessage` добавлены три поля:
- `customerMessageRu` — перевод входящего сообщения
- `suggestedResponseRu` — перевод AI-ответа
- `editedResponseRu` — перевод ручного редакта (если был)

**Когда переводится.** Переводы кешируются в БД, не на каждый рендер:
- При первом синке из Gmail — `customerMessage` → RU
- При `analyzeMessage` / `runAnalysis` — новый `suggestedResponse` → RU,
  плюс back-fill `customerMessageRu` если его не было
- При `runRewrite` и `runFix` — новый ответ → RU
- При ручном редактировании через UI — по blur любой колонки,
  вторая обновляется через `/api/customer-hub/messages/[id]/translate`

**Движок перевода.** [translator.ts](../../ss-control-center/src/lib/customer-hub/translator.ts)
использует тот же provider chain, что и analyzer (Claude primary,
OpenAI fallback). Промпт требует сохранять line breaks, order IDs,
tracking numbers, даты, carrier имена verbatim.

**UI-контракт.** В [MessageDetail.tsx](../../ss-control-center/src/components/customer-hub/MessageDetail.tsx):
- Customer Message блок — 2 колонки read-only (EN | RU)
- Suggested Response в view mode — 2 колонки read-only
- Suggested Response в edit mode — 2 `Textarea` (EN canonical | RU working).
  `onBlur` EN → перевод в RU. `onBlur` RU → перевод в EN (перезаписывает
  canonical). Save отправляет PATCH с `editedResponse` + `editedResponseRu`
- Fallback-надпись «Перевод недоступен (появится после Re-analyze)» для
  старых записей синкнутых до появления translator

## Auto-resolution для уже отвеченных кейсов

Three layers of auto-resolution close out cases we already replied to,
so the Messages tab doesn't accumulate stale OVERDUE noise:

1. **First-sync thread heuristic.** Когда новое сообщение засинкивается из
   Gmail, если его `gmailThreadId` уже содержит > 1 сообщения — сразу
   `RESOLVED` (`resolution = auto_resolved_gmail_thread`). Срабатывает
   для сообщений, на которые мы уже ответили до того как они попали в
   нашу БД.

2. **Confirmation sweep.** При каждом синке ищем письма от Amazon с
   subject "Your response sent" / "message sent" / "confirmation"
   (`newer_than:2d`), извлекаем Order ID регексом `\d{3}-\d{7}-\d{7}`,
   и помечаем соответствующее сообщение как `SENT` с
   `responseSentVia = SELLER_CENTRAL`. **Требует включённой настройки
   "Confirmation Notifications" в Amazon Seller Central** — без этого
   Amazon не шлёт письма-подтверждения.

3. **Stale ANALYZED re-check.** Каждый синк проходит по всем
   `NEW`/`ANALYZED` сообщениям этого аккаунта старше 6 часов и
   пере-дёргает `gmailThreadId` через `readThread`. Если thread теперь
   содержит > 1 сообщения — `RESOLVED` (`resolution =
   auto_resolved_thread_grew`). Это страховка для случаев когда (1)
   Confirmation Notifications выключены и (2) мы ответили после первого
   синка. Лимит 100 сообщений на проход чтобы не блокировать sync.

## Аудит и переписка SYSTEM_PROMPT — 2026-04-11

После жалобы Владимира на «шаблонные противоречивые ответы» провели
аудит всего analyzer pipeline и нашли 3 root cause:

**1. Старый SYSTEM_PROMPT был template-first, не reasoning-first.**
Конкретно жёсткое правило `RESPONSE FORMAT step 4: ONE FACTUAL SENTENCE
using ACTUAL tracking data` принуждало модель в КАЖДЫЙ ответ вставлять
строку про tracking, даже если customer уже получил товар и пишет про
повреждение. Результат: ответы вида «понимаю, вы получили испорченный
товар + ваша посылка ещё в пути и придёт 30 апреля + мы пришлём замену».
Internal contradiction.

**2. Модель — Sonnet 4.6, не Opus 4.6.**
В Setting table стояло `ai_claude_model = claude-sonnet-4-6`. Sonnet 4
неплох для классификации, но плохо разрешает конфликты между фактами и
естественным языком (например customer message vs tracking status).
GPT-5, с которым Vladimir сравнивал, по уровню сопоставим с Opus 4.6.

**3. `runAnalysis` не пере-запускал enricher.**
Re-analyze вызывал только модель, передавая ей `carrierEstimatedDelivery`
из БД. Если изначальный sync прошёл до подключения UPS/FedEx/USPS API,
там лежала старая заглушка (или fallback на promisedEdd, который
Amazon's frozen original). Модель получала устаревший факт.

### Что переделано

- **Полная переписка SYSTEM_PROMPT** ([message-analyzer.ts](../../ss-control-center/src/lib/customer-hub/message-analyzer.ts)).
  Новая структура:
    1. **Source-of-truth hierarchy** — большой блок в начале, явно
       говорит модели: customer message > internal tracking. С
       примерами конфликтов («got crushed» vs `in_transit`,
       «didn't arrive» vs `delivered`, и т.д.)
    2. **No rigid response template** — убрали обязательное «one
       factual sentence about tracking». Body — что ситуация требует.
       Длина 3-7 предложений по обстоятельствам, не «4-8 для отчёта».
    3. **Reasoning examples** — три примера: damaged + tracking conflict,
       T21 mismatch, scan error wrong address. Каждый показывает как
       рассуждать, не просто шаблон.
    4. Reasoning field модели должен фиксировать (a) ключевую фразу
       клиента, (b) конфликт фактов если есть, (c) выбор действия

- **Bump model на claude-opus-4-6** одним SQL update в Setting table

- **`reEnrichStoredMessage` в `runAnalysis`** — перед каждым
  re-analyze пере-дёргает Amazon SP-API + Veeqo + UPS/FedEx/USPS
  напрямую. Свежие даты долетают до модели

### Результат

| Кейс | Старый ответ | Новый ответ |
|---|---|---|
| Crushed Uncrustables (T5) | «package in transit, ETA April 30» (бред) | «Sorry it arrived crushed, share photo, replacement» |
| Deborah T21 | «scheduled for delivery on April 11» (Amazon frozen) | «UPS estimates April 15» (real carrier ETA) |
| Wrong address T2 | generic «contact Amazon CS» | reasoning над scan events: «Round Rock был sorting facility, реальная доставка в Meadowlakes рядом с Marble Falls» |
| Cathy T9 (shipping cost) | плоский извин | объяснение: «$70 это Next Day Air для refrigerated dog food» |

Третий кейс особенно показателен — модель прочитала JSON tracking
events и применила географическое рассуждение. Это и есть качество
ответов уровня GPT-5, к которому стремились.

## Decision Matrix v1 — 25 reference scenarios

После аудита 2026-04-11 промпт был полностью переделан с template-first
на **policy-matrix-first**: вместо размытых «правил» в прозе, в промпт
вшита таблица из 25 reference scenarios, проработанных Q&A-сессией с
Vladimir. Модель Opus 4.6 обязана классифицировать кейс против таблицы
и в reasoning указать какой row матчится.

### 9 таблиц, ~25 строк

| Table | Тема | Кол-во строк | Пример строки |
|---|---|---|---|
| **A** | Delivery & tracking | 7 | T21 mismatch → clarify+partial, us |
| **B** | Condition (spoilage/damage/safety) | 5 | Frozen thawed (no photo) → replacement, amazon |
| **C** | Wrong / missing items | 3 | Honest extra item → none, us (loss, goodwill) |
| **D** | Cancellation | 4 | Cancel in transit (any reason) → none, buyer |
| **E** | Refund requests | 4 | Refund + threat → clarify, never capitulate |
| **F** | Pre-sale questions | 1 | Allergen → redirect к label/manufacturer |
| **G** | Repeat complaints | 1 | 3rd+ msg → replacement, no more clarify |
| **H** | Disputes (A-to-Z, chargeback) | 2 | Chargeback → no customer contact, evidence prep |
| **I** | Adversarial | 1 | Review extortion → clarify, hold position |

### Ключевые экономические принципы (выше таблиц)

1. **claimsProtected = главный рычаг** — Amazon платит за carrier issues, не мы
2. **Frozen + delay → IMMEDIATE replacement** (не «wait and see»)
3. **Replacement обычно дешевле refund** — приоритет
4. **Customer fault → НЕТ carrier protection** (changed mind, mistake, taste — buyer pays)
5. **Honest customer → goodwill** (extra item оставляем, благодарим)
6. **Wrong/missing → clarify first** (anti-abuse, вежливо)
7. **Repeat 3+ → пропускаем clarify**, сразу resolution

### Hard rules (non-negotiable)

- NEVER давать food safety advice ("safe to eat" / "still good")
- NEVER угадывать состав / allergens
- NEVER дублировать refund
- NEVER уступать угрозам review/A-to-Z
- NEVER возвращать frozen food
- T21: never admit mismatch, использовать "fastest available option", partial refund (не full)

### Reasoning examples в промпте

5 высококачественных примеров рассуждения встроены в промпт, каждый
показывает: ключевую фразу клиента → match строки таблицы → проверка
экономических принципов → response. Это даёт модели «working memory»
для нюансов которые не помещаются в табличный формат.

### Output structure

Reasoning field модели должен содержать:
  (a) ключевую фразу клиента
  (b) какая строка матрицы матчится (например "Table B / Frozen thawed photo")
  (c) конфликт facts↔customer если есть
  (d) выбор action и почему (со ссылкой на economic principle)

Это делает решения **traceable**: оператор может в любой момент проверить
почему модель решила именно так, и привязать решение к документированной
бизнес-политике.

### Результат на тестовых кейсах

| Кейс | Action | Citation в reasoning |
|---|---|---|
| Deborah T21 | partial_refund | "Match: Table A row 'T21 mismatch'" |
| Crushed Uncrustables | replacement | "Table B row 'Dry product crushed/damaged' ... critical nuance: this is FROZEN product, also likely thawed" |
| Wrong address scan | clarify | "Matches TABLE A row 'Carrier scan shows wrong city'... final DELIVERED scan in MEADOWLAKES" |
| Cathy $70 shipping | clarify | объяснение Next Day Air для refrigerated dog food |

В Crushed-кейсе модель сама поймала что Uncrustables — frozen product
(не dry как было в данных) и применила food safety rule.

## Decision Matrix v2 — по документу CUSTOMER_HUB_ALGORITHM_v3.0 + Q&A

После Q&A сессии (25 сценариев) был составлен Decision Matrix v1. Затем
Vladimir передал полный документ `docs/CUSTOMER_HUB_ALGORITHM_v3.0.md`
(792 строки, ~40 сценариев), который был сопоставлен с v1. По 9
расхождениям принято решение, и промпт переписан → **Decision Matrix v2**.

### Ключевые изменения v1 → v2

**1. Carrier delay + claimsProtected → redirect_amazon (не replacement)**
Ранее: «Real carrier delay → replacement, pays=amazon» (мы берём на себя
замену, надеясь на Amazon возмещение).
Сейчас: `claimsProtected` требует, чтобы клиент **сам** открыл A-to-Z.
Если мы выдаём replacement — Amazon **не компенсирует** нам ничего.
Поэтому v2: `claimsProtected=true + carrier fault → redirect_amazon`,
pays=amazon, мы тратим $0.

**2. Frozen 3-day hard rule встроено в prompt**
Новое правило в Hard-Coded Operating Rules:
> Мы покупаем shipping services только где promised delivery ≤ 3
> календарных дня для Frozen. Следовательно: frozen + daysInTransit > 3
> = **по определению** carrier delay, без дополнительных проверок.

Это позволяет модели рассуждать: «Uncrustables, frozen, 8 дней транзита →
Frozen 3-day rule broken → carrier fault → claimsProtected → redirect».

**3. Table B split на C1/C2/C3 по daysInTransit**
- **C1** — frozen «slight thaw», daysInTransit ≤3 → clarify+replace (наша
  упаковка), we pay
- **C2** — frozen thawed, daysInTransit >3, claimsProtected → redirect_amazon
- **C2** (no claims) — frozen thawed, daysInTransit >3, без Buy Shipping →
  replacement, we pay
- **C3** — illness/FDA → immediate full refund, we pay, escalate

**4. Table D frozen cancel-after-delivery logic**
Новое: если frozen + delivered + **мы всё сделали правильно** (shipped on
time, без T21, без damage на нашей стороне) → **none, pays=none**. Food
non-returnable И refund не положен.
Если мы failed (late ship, T21, wrong item) → full_refund, we pay, no
return required.

**5. Walmart channel — отдельные правила**
Новая секция в промпте. Когда `channel=Walmart`:
- Все resolutions через official Walmart flow, не от продавца напрямую
- «Didn't like taste» → refund **разрешён** (противоположно Amazon)
- Frozen не существует на Walmart
- Никаких partial refunds / discounts (Walmart forbids)
- Короче, нейтральнее, transactional тон

**6. «Don't lecture» economic principle**
Добавлен в список экономических принципов:
> Если факты уже подразумевают проблему (frozen + 8 days = очевидно
> spoiled), НЕ добавлять «please don't consume» warnings — клиент уже
> знает. Лектурение это padding и outsourcing решения на клиента.

Это решило кейс Uncrustables, где раньше модель добавляла ненужные
food safety инструкции.

**7. `claimsProtected` detection fixed**
Ранее: зависел от строки `employee_notes ~ "Label Purchased"`, которая
не надёжно попадала из Veeqo → все кейсы давали claimsProtected=false.
Сейчас: `boughtThroughVeeqo = !!(veeqoShipment && tracking_number)` —
по правилу Vladimir'а «все этикетки покупаются через Buy Shipping», так
что любой Veeqo shipment автоматически = Buy Shipping.

**8. `carrierSelfDeclaredDelay` — новое enriched поле**
Детектит в tracking events ключевые слова: delay, delayed, exception,
weather, missed, late, rescheduled, unable to deliver. Это документальное
доказательство carrier fault — используется моделью вместе с
claimsProtected для принятия решения о redirect_amazon.

**9. Hybrid auto-fix (вместо flag-only)**
Ранее v1: все violations flag-only, оператор сам решает.
Сейчас v2: разделение:
- **Hard violations** (incorrect dates, cancellation suggested for shipped,
  delivered↔in_transit confusion, seller refund when Amazon pays) →
  **auto-fix** через validateAndFixResponse
- **Subtle violations** (food safety wording, tone issues) → **flag-only**
  в reasoning с `[NEEDS REVIEW: ...]`

**10. `supplierReorderNote` field**
Vladimir — перекупщик, inventory нет. Каждый replacement требует
supplier reorder. В JSON output модель теперь ОБЯЗАНА генерировать
структурированный note при action=replacement:
```
"Freshpet Chicken Recipe × 1 | reason: wrong item shipped | original: 113-...-..."
```
UI показывает синий banner «🛒 Supplier reorder required» с этим note.
Phase 2: автоматическое создание clone order через Veeqo API.

### Как выглядит v2 в действии

**Crushed Uncrustables (T5, frozen, 8 days transit):**
- `claimsProtected=1, boughtThroughVeeqo=1`
- action=**redirect_amazon**, pays=**amazon**
- Reasoning цитирует: *"matches Table B / Frozen C2: 'Frozen thawed/melted, daysInTransit >3, claimsProtected=YES' → redirect_amazon"*
- Ответ явно упоминает 3-day rule: *"8 days in transit (well beyond the 3-day window required for frozen shipments), the carrier is clearly responsible"*
- Никакого лектуринга про food safety
- Redirect на A-to-Z Guarantee refund

Это именно то, что Vladimir описывал как правильное поведение:
carrier-fault + Buy Shipping → Amazon платит, мы тратим $0.

## Confirmation Sweep — фикс 2026-04-11

Amazon Seller Central шлёт подтверждения после того как продавец ответил
клиенту, если включена настройка **Notification Preferences → Messaging
→ Buyer-Seller Messages / Confirmation Notifications**.

### Реальный формат письма (verified)

- **From:** `donotreply@amazon.com`
- **To:** seller email (например `amazon@salutem.solutions`)
- **Subject:** `Your e-mail to {Customer First Name}` (например
  `Your e-mail to Thomas`)
- **Body:**
  ```
  Dear Salutem Solutions,

  Here is a copy of the e-mail you sent to Thomas.

  Order ID: 113-9882870-2864209

  1 | B0DQ1NQCSF | Uncrustables Frozen Peanut Butter & Grape Jelly ...

  --- Begin message ---
  {полный текст ответа продавца}
  --- End message ---

  Warmest Regards,
  Amazon.com
  ```

### Gmail query

Финальный запрос (в [messages/route.ts](../../ss-control-center/src/app/api/customer-hub/messages/route.ts)):
```
from:donotreply@amazon.com to:{account.email} subject:"Your e-mail to" newer_than:7d
```

**Старая неработавшая версия:** `subject:"Your response" OR
subject:"message sent" OR subject:"confirmation"` — никогда не матчила
реальный Amazon subject format.

### Workflow

1. Продавец отвечает клиенту через Seller Central UI
2. Amazon отправляет подтверждение на `donotreply@amazon.com` →
   `{seller email}` с subject `Your e-mail to {Name}`
3. При следующем `POST /api/customer-hub/messages` (sync) запускается
   confirmation sweep
4. Sweep находит письма, извлекает `Order ID: (\d{3}-\d{7}-\d{7})` из
   subject или snippet
5. Находит matching `BuyerMessage` с status NEW/ANALYZED и тем же
   amazonOrderId, помечает `status=SENT`, `responseSentVia=SELLER_CENTRAL`,
   `responseSentAt={date from Amazon email header}`
6. Кейс уходит из active view

### Тест на реальных данных 2026-04-11
После фикса query:
- Gmail search вернул 2 подходящих письма за последние 7 дней
- Reset BuyerMessage cmnutu0vj... → ANALYZED → sync → `confirmations:1`
  → BuyerMessage автоматически переведён в SENT/SELLER_CENTRAL с
  timestamp 2026-04-12T03:21:43

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
- 2026-04-11: **Decision Matrix v1** — после Q&A-сессии с Vladimir по 25 reference scenarios, промпт переделан на policy-matrix-first. 9 таблиц (A-I) с явными action/whoShouldPay/notes. Модель цитирует строку таблицы в reasoning. См. раздел «Decision Matrix v1» выше.
- 2026-04-11: **Полная переписка SYSTEM_PROMPT** (template-first → reasoning-first), bump модели на Opus 4.6, добавлен `reEnrichStoredMessage` в `runAnalysis`. См. раздел «Аудит и переписка SYSTEM_PROMPT» выше. Все 4 stale кейса батчем пере-проанализированы — Deborah теперь корректно показывает April 15, crushed Uncrustables не противоречит сам себе, wrong-address кейс рассуждает над scan events.
- 2026-04-11: Добавлен третий слой авто-резолюции в sync route — stale
  ANALYZED re-check. Каждый синк проходит по сообщениям старше 6 часов
  и пере-проверяет их Gmail thread; если thread вырос — `RESOLVED`. Также
  одноразовый бэкфилл переводов для 4 сообщений созданных до появления
  translator.ts (через временный endpoint, удалён после использования).
- 2026-04-11: Добавлен bilingual UI (EN/RU) для customer message и
  suggested response. Новые поля в `BuyerMessage`: `customerMessageRu`,
  `suggestedResponseRu`, `editedResponseRu`. Новый lib
  `src/lib/customer-hub/translator.ts`. Новый endpoint
  `POST /api/customer-hub/messages/[id]/translate` для on-blur-sync.
  См. раздел «Bilingual UI» выше.
- 2026-04-11: Validator переделан с авто-переписывания на flag-only режим.
  `analyzeMessage` больше не вызывает `validateAndFixResponse` автоматически
  и не подставляет `buildSafeResponse` как fallback. Вместо этого пишет
  `[NEEDS REVIEW: ...]` в reasoning; UI показывает янтарный баннер.
  `validateAndFixResponse` остался для ручной кнопки **Fix**. Также
  в `message-enricher.ts` убран fallback на `promisedEdd` для
  `carrierEstimatedDelivery` — теперь только реальные carrier-ETA из
  Veeqo shipment detail endpoint и tracking events, иначе `null`.
  Причина: стабильная проблема с кейсами типа Deborah (T21), где модель
  получала нормальный ответ, а валидатор выбрасывал его и подставлял
  примитивный шаблон с неверной датой.
