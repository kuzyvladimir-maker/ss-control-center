# 🎯 CUSTOMER HUB — Финальный алгоритм
## Version 3.0 — 2026-04-11
## Salutem Solutions Control Center

> Этот документ заменяет ВСЕ предыдущие: CS_ALGORITHM v1/v1.2/v1.4, CUSTOMER_HUB v1.0/v2.1/v2.2
> Единственный актуальный алгоритм для Customer Hub модуля.

---

## 1. ОБЗОР

Customer Hub — единая страница `/customer-hub` с 4 табами. Все данные через API (Gmail + SP-API + Veeqo). Скриншоты только для Walmart (временно).

| Таб | Источник | Обогащение | Действие |
|-----|----------|------------|----------|
| Messages | Gmail API | SP-API Orders + Veeqo tracking | AI анализ → SP-API Messaging |
| A-to-Z Claims | SP-API Reports | SP-API Orders + tracking | Генерация ответа |
| Chargebacks | Gmail API | SP-API Orders + tracking | Генерация ответа |
| Feedback | SP-API Reports | — | Request Removal / ответ |

---

## 2. АККАУНТЫ

| # | Аккаунт | Email | Store Index | SP-API | Gmail |
|---|---------|-------|-------------|--------|-------|
| 1 | Salutem Solutions | amazon@salutem.solutions | store1 | ✅ | ✅ |
| 2 | Vladimir Personal | kuzy.vladimir@gmail.com | store2 | ✅ | ✅ |
| 3 | AMZ Commerce | amz.commerce@salutem.solutions | store3 | ✅ | ✅ |
| 4 | Sirius International | ancienmadina2@gmail.com | store4 | ✅ | ✅ |
| 5 | Retailer Distributor | amazon.retaildistributor@gmail.com | store5 | ✅ | ✅ |

EMAIL_TO_STORE маппинг читается из БД динамически (не hardcoded).

Walmart — 1 аккаунт (API ключ отсутствует, работает через скриншоты).

---

## 3. ИСТОЧНИКИ ДАННЫХ

### 3.1 Входящие сообщения — Gmail API

```
Query: from:marketplace.amazon.com to:{account_email} newer_than:2d
```

Парсинг email:
- Order ID: из Subject или Body — regex /(\d{3}-\d{7}-\d{7})/
- Customer Name: из From header "Name - Amazon Marketplace" или Subject "from Amazon customer Name"
- Message Text: из Body HTML после "Message:"
- ASIN / Product: из HTML таблицы в Body
- receivedAt: из email header "Date" (для 24h deadline)

### 3.2 Обогащение — SP-API + Veeqo

Для каждого Order ID:

```
SP-API Orders API:
  → purchaseDate, orderTotal, latestShipDate, latestDeliveryDate
  → ShipmentServiceLevelCategory (requested shipping: "NextDay", "SecondDay", "Standard")

SP-API Order Items:
  → ASIN, title, quantity, itemPrice

Veeqo API:
  → trackingNumber, carrier, service (actual shipping service)
  → shipDate, allocation status (delivered/shipped/cancelled)
  → delivery_date, tracking_events
  → boughtThroughVeeqo (Buy Shipping), employee_notes
  → product tags (Frozen/Dry)
```

### 3.3 Ключевые сравнения при обогащении

| Что сравниваем | Зачем |
|----------------|-------|
| requestedShippingService vs actualShippingService | Обнаружить shipping mismatch (T21) |
| promisedEDD vs carrierEstimatedDelivery | Реальная задержка (не today - EDD) |
| promisedEDD vs actualDelivery | Фактическое опоздание |
| shipDate vs latestShipDate | Shipped on time? |
| daysInTransit (shipDate → delivery/today) | Критично для frozen |
| Claims Protected badge | Buy Shipping Protection доступна? |

### 3.4 Определение типа товара (Frozen / Dry)

| Признак | Тип |
|---------|-----|
| Ice Cream, Frozen, Beef (сырой), Fish, Shrimp, Meat, Sausage, Wings, Waffles, Freshpet | **Frozen** |
| Broth, Soup, Sauce, Canned, Crackers, Nuts, Dried, Powder, Supplement, Treats | **Dry** |
| Jimmy Dean → всё Frozen |
| Walmart канал → **всегда Dry** (frozen запрещён) |
| Не определено → Unknown, пометить для ручной проверки |
| Veeqo product tags → приоритетный источник |

---

## 4. АЛГОРИТМ ПРИНЯТИЯ РЕШЕНИЯ — 5 ШАГОВ

### Шаг 1: ПРОЧИТАТЬ СООБЩЕНИЕ КЛИЕНТА (приоритет №1)

Это САМЫЙ ВАЖНЫЙ шаг. Всё начинается с текста клиента.

- Что случилось с точки зрения клиента?
- Что клиент просит? (cancel, refund, replacement, информацию?)
- Какая эмоция? (спокойный, раздражённый, угрожает?)
- Какие конкретные детали упомянул? (заплатил за expedited, нужно к конкретной дате, и т.д.)
- Цитировать ключевые фразы в reasoning.

### Шаг 2: ПРОВЕРИТЬ ФАКТЫ ДОСТАВКИ (поддержка для решения)

- Сравнить requested service vs actual service → shipping mismatch?
- Где посылка СЕЙЧАС? Когда carrier обещает доставить (не EDD, а реальная оценка carrier)?
- Реальная задержка: carrier_estimated_delivery - original_deliver_by
- Shipped on time? Buy Shipping? Claims Protected?
- Для frozen: daysInTransit > 3 = HIGH RISK

### Шаг 3: ПРОВЕРИТЬ БАЗУ ЗНАНИЙ

- Были ли похожие кейсы? Что решили? Какой результат?
- Использовать как guidance, адаптировать к текущей ситуации.

### Шаг 4: ПРИНЯТЬ РЕШЕНИЕ

Следовать иерархии приоритетов:
```
1. Health risk → немедленный refund, никаких споров
2. Frozen spoilage → replacement/refund, не просить возврат
3. Carrier fault (+ Buy Shipping) → redirect Amazon / A-to-Z
4. Our fault → replacement/refund за наш счёт
5. Customer fault / нет проблемы → clarify / no action
```

Экономическая лестница (от дешёвого к дорогому):
```
1. Clarify / запрос деталей ← самый дешёвый
2. Redirect to Amazon CS ← пусть Amazon платит
3. Replacement ← дешевле refund (теряем COGS, не revenue)
4. Partial refund ← компромисс
5. Full refund ← последний вариант
```

### Шаг 5: СГЕНЕРИРОВАТЬ ОТВЕТ

- Обратиться к тому что КЛИЕНТ НАПИСАЛ (не игнорировать его слова)
- Использовать реальные tracking данные (carrier ETA, не только EDD)
- Следовать всем guardrails
- Начать с "Dear {name},"

---

## 5. ТИПЫ ПРОБЛЕМ (T1-T21)

| ID | Тип | Триггеры |
|----|-----|----------|
| T1 | Not received (in transit) | "where is", "haven't received", "when" |
| T2 | Not received (delivered) | "never got it", "didn't receive" + tracking=delivered |
| T3 | Late delivery | "took too long", "delayed", "late" |
| T4 | Spoiled/thawed/melted food | "thawed", "melted", "warm", "spoiled", "rancid" |
| T5 | Damaged item | "damaged", "broken", "crushed", "leaked" |
| T6 | Wrong item | "wrong", "different", "incorrect" |
| T7 | Missing item | "missing", "incomplete", "only got 1 of 2" |
| T8 | Expired product | "expired", "best by", "expiration date" |
| T9 | Shipping cost complaint | "shipping cost", "too expensive" |
| T10 | Cancellation request | "cancel", "don't want", "changed my mind" |
| T11 | Return/refund request | "refund", "return", "money back" |
| T12 | Unauthorized purchase | "didn't order", "not my order", "fraud" |
| T13 | A-to-Z threat/mention | "A-to-Z", "claim", "guarantee" |
| T14 | Negative review threat | "1 star", "bad review", "report" |
| T15 | Health/safety concern | "sick", "food poisoning", "FDA", "lawyer" |
| T16 | Carrier postage due | "pay extra", "postage due" |
| T17 | Quality complaint | "taste", "quality", "doesn't work" |
| T18 | Pre-sale question | "ingredients", "allergens", "shelf life" |
| T19 | Refund already issued | "already refunded", "got refund but" |
| T20 | Repeat complaint | 2+ сообщения по одному заказу |
| T21 | Shipping service mismatch | Клиент платил expedited, отправлено standard |

---

## 6. УРОВНИ РИСКА

| Уровень | Условия | Действие |
|---------|---------|----------|
| 🟢 LOW | В пути в рамках EDD, pre-sale вопрос, простой запрос | Информировать. Не делать refund. |
| 🟡 MEDIUM | Wrong item без фото, повреждение без доказательств, неясная жалоба | Запросить детали. Решать после получения информации. |
| 🔴 HIGH | Thawed food, carrier delay видимый, shipping mismatch, повторная жалоба | Решать немедленно. Replacement или refund. |
| ⚫ CRITICAL | Illness/FDA, A-to-Z уже подан, 3+ сообщения без решения | Короткий ответ. Refund. Эскалация Владимиру. |

---

## 7. РЕШАЮЩЕЕ ДЕРЕВО ПО ТИПАМ

### T1: Not received, в пути

```
В рамках EDD? → REASSURE (дать EDD, успокоить)
Past EDD, < 3 дней → APOLOGIZE + предложить подождать 1-2 дня
Past EDD, > 3 дней → APOLOGIZE + refund или replacement
Past EDD + Frozen + >3 дней transit → replacement/refund (товар испорчен)
```

### T2: Not received, delivered

```
Delivered + Buy Shipping → redirect Amazon CS (они покроют)
Delivered + wrong city → redirect Amazon CS (misdelivery)
Delivered + correct address → попросить проверить (neighbors, porch, locker)
  → Если не нашёл → redirect Amazon CS
```

### T3: Late delivery

```
Buy Shipping + shipped on time + carrier delay → redirect Amazon CS
  (Amazon покроет через A-to-Z / Claims Protection)
Shipped late (наша вина) → replacement или refund (мы платим)
Frozen + late → replacement (товар скорее всего испорчен)
```

### T4: Spoiled/thawed/melted food (3 уровня)

```
C1. Slight thaw, доставлено за ≤3 дня:
  → Запросить фото
  → НЕ давать food safety advice
  → Предложить replacement

C2. Melted/thawed, доставлено за >3 дня:
  → НЕ требовать фото (не блокировать решение)
  → Replacement
  → Если carrier delay + Buy Shipping → Amazon платит
  → Если наша упаковка → мы платим

C3. Rancid/illness/FDA:
  → CRITICAL
  → Immediate full refund
  → Короткий ответ
  → НЕ спорить о безопасности
  → НЕ упоминать vet expenses
  → Эскалация Владимиру
```

### T5: Damaged item

```
Запросить фото → replacement или refund (выбор клиента)
Food item → не просить вернуть (food safety)
Non-food → можно предложить return
Если carrier damage → carrier claim / Amazon
```

### T6: Wrong item

```
Запросить фото (товар + label)
Food → replacement, не просить вернуть
Non-food → replacement
Повторный wrong item → REFUND (safer)
Мы платим. Проверить SKU/fulfillment.
```

### T7: Missing item

```
Запросить фото содержимого
Подтвердить что не хватает → дослать недостающее
Мы платим.
```

### T8: Expired product

```
Запросить фото (best by date)
Refund + replacement (если клиент хочет)
Мы платим. Проверить SKU/партию.
НЕ просить вернуть. Food safety.
```

### T9: Shipping cost complaint

```
Объяснить что цена включает доставку (weight/size/distance)
Если уже отправлено → cancel невозможен
После доставки → может обратиться в Amazon CS
НЕ предлагать partial refund автоматически
```

### T10: Cancellation request

```
НЕ отправлено → cancel + refund
Отправлено + Dry → объяснить что в пути, redirect Amazon return после доставки
Отправлено + Frozen → refund (вернуть frozen нельзя)
SHIPPED → НИКОГДА не предлагать cancel
```

### T11: Return/refund request

```
Food (любой) на Amazon → NON-RETURNABLE → refund без возврата
  НО: "не понравился вкус" → NO REFUND (нет проблемы с товаром)
Food на Walmart → Walmart позволяет возврат → через official Walmart flow
Dry non-food → стандартный Amazon return
```

### T12: Unauthorized purchase

```
→ НЕ разбирать самому
→ Redirect Amazon CS (fraud case)
→ НЕ делать refund автоматически
```

### T13: A-to-Z threat

```
→ НЕ поддаваться шантажу
→ "Давайте разберёмся в вашей проблеме детальнее"
→ Запросить конкретные детали проблемы
→ Решать ПРОБЛЕМУ, а не угрозу
→ Если за угрозой реальная проблема → решить
→ Если нет реальной проблемы → clarify
```

### T14: Negative review threat

```
→ НЕ поддаваться
→ Решить реальную проблему (если есть)
→ НЕ просить не оставлять отзыв (Amazon policy violation)
→ НЕ предлагать компенсацию за неоставление отзыва
```

### T15: Health/safety concern

```
→ CRITICAL
→ Immediate full refund
→ "Please dispose of the product. We are issuing a full refund immediately."
→ НЕ спорить, НЕ обсуждать food safety
→ НЕ упоминать vet expenses (liability)
→ Эскалация Владимиру
```

### T16: Carrier postage due

```
→ "You should NOT pay any additional charges"
→ Replacement или refund
→ Carrier claim
```

### T17: Quality complaint

```
Субъективное ("не понравился вкус") → NO REFUND на Amazon (food non-returnable, нет проблемы с товаром)
Субъективное на Walmart → через official Walmart return flow
Реальный дефект → запросить фото → replacement
Повторная жалоба на один SKU → уведомить Владимира
```

### T18: Pre-sale question

```
→ Ответить по данным листинга
→ НЕ ГАДАТЬ по ингредиентам/аллергенам
→ Направить на label/manufacturer если не уверен
```

### T19: Refund already issued

```
→ Подтвердить что refund обработан
→ "3-5 business days"
→ НЕ давать повторный refund
```

### T20: Repeat complaint

```
2-е сообщение → повысить приоритет, предложить конкретное решение
3+ сообщений → CRITICAL → refund/replacement немедленно → эскалация Владимиру
НЕ повторять "подождите" если уже говорили
```

### T21: Shipping service mismatch

```
Клиент платил за expedited → отправлено standard
→ НИКОГДА не признавать mismatch напрямую
→ "shipped using the fastest available shipping option at the time"
→ НЕ предлагать cancel (уже отправлено)
→ Предложить: дождаться доставки → return/refund через Amazon
→ Risk: HIGH
→ Who pays: мы (seller responsibility)

ПРАВИЛО НА БУДУЩЕЕ (Shipping Labels модуль):
IF customer selected expedited AND expedited not available
THEN: НЕ ОТПРАВЛЯТЬ. Связаться с клиентом или отменить.
```

---

## 8. МАТРИЦА "КТО ПЛАТИТ"

| Ситуация | Кто | Механизм |
|----------|-----|----------|
| Carrier delay + Buy Shipping + shipped on time | **Amazon** | A-to-Z / Claims Protection |
| Delivered + not received + Buy Shipping | **Amazon** | A-to-Z |
| Unauthorized purchase | **Amazon** | Fraud case |
| Carrier damage | **Amazon/Carrier** | Claims Protection / carrier claim |
| Shipping mismatch (наш сервис не тот) | **Мы** | Refund/replacement |
| Wrong item / missing item | **Мы** | Fulfillment error |
| Expired product | **Мы** | Inventory management error |
| Quality complaint (реальный дефект) | **Мы** | Product issue |
| Thawed food + наша упаковка | **Мы** | Packaging issue |
| Thawed food + carrier delay | **Amazon** | Buy Shipping Claims Protection |
| Subjective quality ("не понравился") | **Клиент** | No refund (food non-returnable) |

---

## 9. BUY SHIPPING CLAIMS PROTECTION

### Условия (все 4 обязательны):

1. ✅ Этикетка через Veeqo/Amazon Buy Shipping с badge **"Claims Protected"** (НЕ "Late Delivery Risk")
2. ✅ Первый carrier scan в день Ship By или следующий день
3. ✅ Ответ покупателю в течение **48 часов** (24h лучше)
4. ✅ Покупатель подаёт **A-to-Z claim** (через A-to-Z, не напрямую)

### Что даёт:
- Amazon финансирует refund — НЕ из кармана продавца
- A-to-Z claim НЕ считается против ODR
- OTDR защищён

### Что НЕ работает:
- ❌ Продавец выдал refund сам → Amazon не компенсирует
- ❌ Клиент не открыл A-to-Z → нет компенсации
- ❌ "Late Delivery Risk" badge → защиты нет
- ❌ SAFE-T claim → это только для FBA, не для FBM (наш случай)

### Главное правило:
> При вине перевозчика: НЕ делать refund немедленно. Ответить, посочувствовать, направить клиента в Amazon CS. Amazon возместит клиенту — и нас не тронет.

### Carrier Self-Declared Delay:
Если tracking содержит статус "Delayed" — это документальное доказательство вины carrier. Зафиксировать для carrier compensation claim.

---

## 10. ФОРМАТ ОТВЕТА

### Amazon:

```
Dear {Customer Name},

{Обращение к тому что клиент написал — acknowledge.}
{Одно фактическое предложение с реальными tracking данными.}
{Одно предложение с решением / next step.}

Best regards,
{Store Name}
```

Правила:
- ВСЕГДА начинать с "Dear {name},"
- 4-8 предложений
- Язык = язык клиента (English / Spanish)
- НЕ использовать эмодзи, внешние ссылки, промо
- Использовать РЕАЛЬНЫЕ данные (carrier, даты, transit time)
- НЕ обещать завершённое действие если оно ещё не сделано: "I can arrange..." не "I am processing..."

### Walmart:

```
Hello {Name или без имени},

{Извинение за неудобство.}
{Факт.}
{Решение / redirect to Walmart flow.}

Thank you for your understanding.
```

Правила:
- Короче чем Amazon
- Нейтральный тон
- НЕ обещать refund/replacement от продавца → redirect to Walmart official flow
- НЕ предлагать скидки/partial refund
- НЕ просить клиента отменить заказ

---

## 11. ЖЁСТКИЕ ПРАВИЛА (НИКОГДА НЕ НАРУШАТЬ)

### Запрещено в ответах:

- ❌ Эмодзи, GIF
- ❌ Внешние ссылки
- ❌ Промо-контент
- ❌ Просить изменить/удалить отзыв
- ❌ Предлагать компенсацию за неоставление отзыва
- ❌ Личные контакты (email, телефон)
- ❌ Давать food safety advice ("may still be safe")
- ❌ Упоминать vet expenses / medical costs
- ❌ Признавать shipping mismatch ("we couldn't buy Next Day")
- ❌ Предлагать cancel для shipped orders
- ❌ Гарантировать безопасность еды при spoilage
- ❌ Использовать неправильные даты (только из enriched data)
- ❌ Говорить "delivered" когда статус "in transit" (и наоборот)
- ❌ Поддаваться шантажу (refund за угрозу отзыва/A-to-Z)
- ❌ Обещать "within the hour" и подобные конкретные сроки

### Запрещено агенту:

- ❌ Использовать SAFE-T для carrier delay (SAFE-T = FBA only)
- ❌ Давать refund без причины
- ❌ Давать двойной refund
- ❌ Давать refund за "не понравился вкус" на Amazon (food non-returnable)
- ❌ Отправлять заказ другим сервисом без согласия клиента (shipping mismatch)
- ❌ Игнорировать текст сообщения и строить ответ только на tracking

### Обязательно:

- ✅ Ответить в течение 24 часов (идеально 12)
- ✅ Для Buy Shipping Protection — ответ в течение 48 часов
- ✅ Frozen товары — НЕ просить вернуть (food safety)
- ✅ Food items на Amazon — NON-RETURNABLE
- ✅ При replacement — помнить: товара нет на складе, НУЖЕН ЗАКАЗ У ПОСТАВЩИКА
- ✅ Читать ВСЮ историю переписки перед ответом
- ✅ Использовать replacement раньше refund (дешевле)
- ✅ Фото просить ТОЛЬКО если товар доставлен за ≤3 дня

---

## 12. SUPPLIER REORDER

> Владимир — перекупщик. Товара НЕТ на складе постоянно. При replacement нужно ЗАКАЗАТЬ у поставщика.

| Действие | Нужен заказ? |
|----------|-------------|
| REPLACEMENT | ✅ ОБЯЗАТЕЛЬНО — заказать у поставщика |
| REFUND | ❌ Не нужно |
| REDIRECT AMAZON | ❌ Не нужно |

При replacement → internal note: "🛒 SUPPLIER REORDER: заказать {товар} × {qty} у поставщика для замены по заказу {Order ID}"

---

## 13. WALMART — ОТДЕЛЬНЫЕ ПРАВИЛА

### Ключевые отличия от Amazon:

| Правило | Amazon | Walmart |
|---------|--------|---------|
| Refund за "не понравилось" | ❌ No (non-returnable) | ✅ Yes (Walmart policy) |
| Frozen товары | ✅ Есть | ❌ Нет |
| Переговоры/скидки | Иногда partial | ❌ НИКОГДА |
| Просить cancel | — | ❌ ЗАПРЕЩЕНО |
| Return food | ❌ (food safety) | ✅ (Walmart позволяет) |
| Resolution flow | Продавец решает | **Через official Walmart flow** |

### Walmart кейсы — ВСЕГДА через official flow:

```
Damaged / Missing / Wrong / Delivered-not-received / Lost
→ "Please go to your Walmart order and use the 'Start a return' or 'Report an issue' flow.
   Walmart Customer Care will guide you through the next steps."
```

НЕ обещать refund/replacement от продавца. Walmart сам управляет процессом.

---

## 14. POST-GENERATION GUARDRAILS

3 слоя защиты ПОСЛЕ генерации ответа AI:

```
AI генерирует ответ
      ↓
[Слой 1] Fact Check — даты, carrier, status совпадают с данными?
      ↓
[Слой 2] Policy Validator — нет запрещённых действий?
      ↓
[Слой 3] Auto-Fix — автоматическое исправление если нарушения
      ↓
Финальный ответ (или safe fallback template)
```

### Fact Check проверяет:

| Что | Как | Severity |
|-----|-----|----------|
| Даты в ответе | Сравнить с shipDate, EDD, actualDelivery | ERROR |
| Carrier | Совпадает с enriched.carrier? | ERROR |
| Tracking status | "delivered" в ответе vs реальный status | ERROR |

### Policy Validator ловит:

| Нарушение | Действие |
|-----------|----------|
| "cancel" для shipped order | AUTO-FIX |
| Неправильные даты | AUTO-FIX |
| "safe to eat" при spoilage | AUTO-FIX |
| Seller refund когда Amazon должен платить | AUTO-FIX |
| "delivered" когда in_transit | AUTO-FIX |

### Auto-Fix:
Повторный вызов AI с жёсткими constraints + список нарушений.
Если AI не исправил → безопасный шаблон (safe fallback).

### Confidence Level:

| Уровень | Значение |
|---------|----------|
| ✅ HIGH | Факты верны, правила соблюдены → можно отправлять |
| 🟡 MEDIUM | Мелкие несоответствия → проверить |
| 🔴 LOW | Критические ошибки → ручная правка обязательна |

---

## 15. ОБНАРУЖЕНИЕ ОТВЕТОВ (Confirmation Notifications)

Amazon Seller Central → Messaging → включить ВСЕ 4 notification:

| Notification | Действие в Control Center |
|---|---|
| Buyer Messages | Создать BuyerMessage, status = NEW |
| Confirmation Notifications | Найти BuyerMessage → status = SENT |
| Delivery Failures | Пометить ⚠️ FAILED |
| Buyer Opt-out | Пометить 🚫 OPT_OUT — не отвечать |

При sync Gmail: искать confirmation emails → автоматически помечать кейсы как SENT.
Fallback: кнопка "Responded in Seller Central" в UI.

---

## 16. ИСТОРИЯ ДИАЛОГА

Amazon отправляет КАЖДОЕ сообщение как отдельный email. Предыдущая переписка НЕ видна.

Наша БД = единственный источник истории.

```
При обработке нового сообщения:
1. Найти ВСЕ BuyerMessage с тем же amazonOrderId
2. Определить messageNumber (1 = первое, 2 = повторное, 3+ = эскалация)
3. Проверить: есть ли A-to-Z claim? Negative feedback?
4. Передать историю в AI контекст
```

| Сообщение # | Поведение |
|-------------|-----------|
| 1 | Стандартная обработка |
| 2 | Повысить приоритет. Предложить конкретное решение. НЕ повторять "подождите" |
| 3+ | CRITICAL → refund/replacement → эскалация Владимиру |

---

## 17. KNOWLEDGE BASE

### Структура записи:

```
problemType: T1-T21
scenario: краткое описание
customerSaid: ключевые фразы клиента
trackingContext: in_transit/delivered + days + mismatch
correctAction: replacement / refund / redirect / clarify
correctResponse: текст ответа
reasoning: почему такое решение
whoShouldPay: us / amazon / carrier
outcome: positive / negative / neutral
tags: для поиска
```

### Использование:
Перед генерацией ответа → найти похожие кейсы → передать как guidance в AI контекст.
После решения кейса → кнопка "Save to KB" для накопления опыта.

---

## 18. EDGE CASE PRIORITY ORDER

Когда несколько факторов одновременно — приоритет:

```
1. Health risk (illness, FDA) → немедленный refund
2. Frozen spoilage → replacement/refund
3. Carrier fault (+ Buy Shipping) → redirect Amazon
4. Our fault (wrong item, late ship, mismatch) → мы платим
5. Customer fault / нет проблемы → clarify / no action
```

---

## 19. SPANISH TEMPLATES

### Reassure (в пути, в рамках EDD):
```
Estimado/a {name},

Gracias por comunicarse con nosotros. Su pedido está en tránsito y se espera que llegue antes del {EDD}. El paquete fue enviado el {shipDate} a través de {carrier}.

Si no lo ha recibido para esa fecha, no dude en contactarnos.

Saludos cordiales,
{store}
```

### Apologize (задержка):
```
Estimado/a {name},

Le pedimos disculpas por la demora con su pedido. Su paquete fue enviado el {shipDate} y lamentablemente ha experimentado un retraso en el tránsito.

Podemos ofrecerle un reemplazo sin costo adicional o un reembolso completo. Por favor indíquenos qué opción prefiere.

Saludos cordiales,
{store}
```

### Spoiled frozen:
```
Estimado/a {name},

Lamento mucho que su producto congelado haya llegado en mal estado. Entiendo su frustración.

Por favor no use el producto. Podemos enviarle un reemplazo sin costo adicional. No es necesario devolver el artículo.

Saludos cordiales,
{store}
```

---

## 20. РАСЧЁТ УБЫТКОВ (LOSSES)

| Тип | Формула |
|-----|---------|
| Full refund | Сумма refund |
| Partial refund | Сумма partial |
| Replacement | orderTotal × COGS% + label cost |
| A-to-Z lost | amountCharged |
| Chargeback lost | amountCharged |
| A-to-Z won (Amazon funded) | $0 |

COGS% = 40% (настраивается в Settings).
Label cost = ~$12 (estimate).

---

## 21. TELEGRAM УВЕДОМЛЕНИЯ

| Приоритет | Когда | Формат |
|-----------|-------|--------|
| 🔴 CRITICAL | A-to-Z, Chargeback, illness, 3+ сообщения | Немедленно |
| 🟡 HIGH | Negative feedback, frozen spoilage, mismatch | В течение часа |
| 🟢 NORMAL | Tracking вопрос, pre-sale | Сводка 2 раза в день |

---

## 22. CRON / POLLING

```
Каждые 8-12ч → Messages sync (Gmail → parse → enrich → AI)
Каждые 24ч   → A-to-Z sync (SP-API Reports)
Каждые 24ч   → Chargebacks sync (Gmail)
Каждые 24ч   → Feedback sync (SP-API Reports)
```

Phase 1: кнопка "Sync" в UI.
Phase 2: автоматический cron.

---

*Version 3.0 — 2026-04-11*
*Заменяет: CS_ALGORITHM v1/v1.2/v1.4, CUSTOMER_HUB_ALGORITHM v1.0/v2.1/v2.2*
*Источники: 6 предыдущих документов + GPT аудит + 40 проверенных кейсов*
*Ключевые отличия от v2.2:*
*— Приоритет текста клиента (Шаг 1 = читать сообщение)*
*— "Не понравился вкус" → NO REFUND на Amazon*
*— Угрозы → НЕ поддаваться, разобраться в проблеме*
*— Фото → только если доставлено за ≤3 дня*
*— Walmart → через official flow, не обещать от продавца*
*— Supplier Reorder при replacement*
*— Claims Protected vs Late Delivery Risk*
*— Carrier Self-Declared Delay*
*— Edge Case Priority: Health > Frozen > Carrier > Our > Customer*
*— Убраны vet expense mentions*
*— Убраны избыточные обещания ("I am processing...")*
