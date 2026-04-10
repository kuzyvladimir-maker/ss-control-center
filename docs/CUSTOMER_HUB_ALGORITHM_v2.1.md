# 🎯 CUSTOMER HUB — Полный алгоритм
## Version 2.1 — 2026-04-09
## Salutem Solutions Control Center

---

## ОБЗОР

Customer Hub — **единая страница** (`/customer-hub`) с 4 табами, заменяющая отдельные страницы `/customer-service`, `/claims/atoz`, `/feedback`.

| # | Таб | Источник данных | Обогащение | Действие |
|---|-----|----------------|------------|----------|
| 1 | **Messages** | Gmail API (письма от `@marketplace.amazon.com`) | SP-API Orders (заказ + трекинг) | Claude анализ → SP-API Messaging |
| 2 | **A-to-Z Claims** | SP-API Reports (`GET_CLAIM_DATA`) | SP-API Orders (трекинг) | Генерация ответа → SP-API |
| 3 | **Chargebacks** | Gmail API (`cb-seller-notification@amazon.com`) | SP-API Orders (трекинг) | Генерация ответа → email |
| 4 | **Feedback** | SP-API Reports (`GET_SELLER_FEEDBACK_DATA`) | — | Request Removal / публичный ответ |

**Ключевой принцип v2:** агент работает через API напрямую. Скриншоты УБРАНЫ. Все данные — из Gmail API + Amazon SP-API.

---

## АККАУНТЫ

### Подключённые (Phase 1)

| # | Аккаунт | Канал | Email | Store Index | Gmail API | SP-API |
|---|---------|-------|-------|-------------|-----------|--------|
| 1 | Salutem Solutions | Amazon | amazon@salutem.solutions | store1 | ❌ (нужен OAuth) | ✅ |
| 2 | Vladimir Personal | Amazon | kuzy.vladimir@gmail.com | store2 | ✅ | ✅ |

### Будущие (Phase 2+)

| # | Аккаунт | Email | Store Index |
|---|---------|-------|-------------|
| 3 | AMZ Commerce | TBD | store3 |
| 4 | Sirius International | TBD | store4 |
| 5 | Retailer Distributor | TBD | store5 |
| 6 | Walmart | TBD | — |

> ⚠️ **Phase 1 ограничение:** Messages и Chargebacks через Gmail работают только для аккаунтов с подключённым Gmail API. A-to-Z и Feedback работают через SP-API для всех Amazon аккаунтов.

---

## АРХИТЕКТУРА ПОЛУЧЕНИЯ ДАННЫХ

### Gmail API — как получаем сообщения покупателей

**Формат входящего письма от покупателя Amazon:**

```
From: CustomerName - Amazon Marketplace <xxxxx@marketplace.amazon.com>
To: amazon@salutem.solutions (или kuzy.vladimir@gmail.com)
Subject: Shipping inquiry from Amazon customer Cathy (Order: 114-7863528-5212210)

Body (HTML):
- Order ID: 114-7863528-5212210
- Таблица: # | ASIN | Product Name
- Message: текст сообщения покупателя
```

**Парсинг письма:**

| Поле | Откуда извлекаем | Regex / метод |
|------|-----------------|---------------|
| Аккаунт | Header `To:` | Маппинг email → store index |
| Order ID | Header `Subject:` или Body | `(Order:\s*\|Order ID:\s*)(\d{3}-\d{7}-\d{7})` |
| Customer Name | Header `Subject:` | `from Amazon customer (.+?)[\s(]` |
| ASIN | Body (таблица) | HTML parsing |
| Product Name | Body (таблица) | HTML parsing |
| Message Text | Body (блок Message) | HTML parsing — текст после "Message:" |
| Language | Message Text | Определяет Claude (English / Spanish) |

**Gmail Query для поиска buyer messages:**
```
from:marketplace.amazon.com to:{account_email} newer_than:2d
```

**Gmail Query для chargebacks:**
```
from:cb-seller-notification@amazon.com newer_than:7d
```

**Маппинг email → аккаунт:**
```typescript
const EMAIL_TO_STORE: Record<string, { storeIndex: number; storeName: string }> = {
  'amazon@salutem.solutions': { storeIndex: 1, storeName: 'Salutem Solutions' },
  'kuzy.vladimir@gmail.com': { storeIndex: 2, storeName: 'Vladimir Personal' },
  // Добавлять по мере подключения новых аккаунтов
};
```

### SP-API — обогащение данных заказа

После извлечения Order ID из письма:

```
1. SP-API Orders API → GET /orders/{orderId}
   → purchaseDate, orderTotal, shippingAddress, numberOfItems

2. SP-API Orders API → GET /orders/{orderId}/orderItems  
   → ASIN, title, quantity, itemPrice

3. Veeqo API → поиск по amazonOrderId
   → trackingNumber, carrier, service, shipDate, EDD
   → employee_notes (есть ли "Label Purchased"?)

4. Carrier Tracking (UPS/FedEx/USPS API)
   → actualDeliveryDate, currentStatus, transitEvents
```

**Результат обогащения — контекст для Claude:**
```typescript
interface MessageContext {
  // Из Gmail
  customerName: string;
  customerMessage: string;
  language: 'English' | 'Spanish';
  
  // Из SP-API
  orderId: string;
  orderDate: string;
  orderTotal: number;
  product: string;
  asin: string;
  quantity: number;
  shippingAddress: { city: string; state: string; zip: string };
  
  // Из Veeqo / Tracking
  carrier: string;
  service: string;
  shipDate: string;
  promisedEdd: string;
  trackingNumber: string;
  trackingStatus: 'in_transit' | 'delivered' | 'exception' | 'unknown';
  actualDeliveryDate?: string;
  daysInTransit?: number;
  daysLate?: number;
  
  // Buy Shipping Protection
  boughtThroughVeeqo: boolean;
  claimsProtectedBadge: boolean;
  shippedOnTime: boolean;
}
```

---

## ТАБ 1: MESSAGES

### Polling

**Расписание:** каждые 8-12 часов (cron job в Control Center)
**Логика:** для каждого подключённого Gmail → поиск новых писем от `@marketplace.amazon.com`

### Алгоритм обработки одного сообщения

```
1. Gmail API: найти новые письма (newer_than:12h)
2. Для каждого письма:
   a. Парсить: To → определить аккаунт
   b. Парсить: Subject/Body → Order ID, Customer Name, Message
   c. Проверить: уже обработано? (по messageId в БД)
   d. Если новое → обогатить через SP-API + Veeqo + Tracking
   e. Отправить контекст в Claude для анализа
   f. Сохранить в БД (модель BuyerMessage)
   g. Уведомить Владимира в Telegram
```

### ★ История диалога — ключевой контекст

**Проблема:** клиент может писать повторно по тому же заказу. Amazon отправляет каждое сообщение как **отдельное email-уведомление** — предыдущая переписка в письме НЕ видна.

**Решение: наша БД = единственный источник истории**

```typescript
// При обработке нового сообщения:
const orderId = parseOrderId(email);

// Найти ВСЕ предыдущие сообщения по этому заказу
const history = await prisma.buyerMessage.findMany({
  where: { amazonOrderId: orderId },
  orderBy: { createdAt: 'asc' }
});
const messageNumber = history.length + 1;

// Проверить связанные кейсы
const hasAtoz = await prisma.atozzClaim.findFirst({ where: { amazonOrderId: orderId } });
const hasFeedback = await prisma.sellerFeedback.findFirst({ where: { orderId } });
```

Claude получает полную историю: все предыдущие сообщения клиента + наши ответы + что мы предлагали + какой был результат.

> ⚠️ **Важно:** наши ответы тоже сохраняем в BuyerMessage (direction = "outgoing"). Так Claude видит что мы уже предлагали и выбирает следующий шаг по экономической лестнице.

**Правила эскалации по количеству сообщений:**

| Сообщение # | Поведение |
|-------------|-----------|
| 1 (первое) | Стандартная обработка по Decision Engine |
| 2 (повторное) | Повысить приоритет. Если в 1й раз предлагали "подождать" → теперь replacement |
| 3+ | **CRITICAL** → Владимир. Клиент недоволен. Обычно → refund |
| Любое + A-to-Z filed | **CRITICAL** → немедленное решение |

### Слой 1: Классификация типа проблемы

Claude получает полный контекст (сообщение + данные заказа + трекинг) и определяет:

**A) Кто пишет:**
- `BUYER` — покупатель
- `AMAZON_CS` — Amazon Customer Service
- `SYSTEM` — автоматическое уведомление (chargeback, claim)

**B) Тип проблемы:**

| ID | Тип | Триггеры | Пример |
|----|-----|----------|--------|
| T1 | **Not received (in transit)** | "where is", "haven't received", "when" | Заказ ещё в пути |
| T2 | **Not received (delivered)** | "never got it", "didn't receive" + tracking=delivered | Tracking говорит delivered, клиент не получил |
| T3 | **Late delivery** | "took too long", "delayed", "late" | Доставлено позже EDD |
| T4 | **Spoiled/thawed/melted food** | "thawed", "melted", "warm", "spoiled", "rancid" | Frozen товар растаял |
| T5 | **Damaged item** | "damaged", "broken", "crushed", "leaked" | Повреждённая упаковка/товар |
| T6 | **Wrong item** | "wrong", "different", "incorrect", "not what I ordered" | Прислали не тот товар |
| T7 | **Missing item** | "missing", "incomplete", "only got 1 of 2" | Не хватает товара в заказе |
| T8 | **Expired product** | "expired", "best by", "expiration date" | Просроченный товар |
| T9 | **Shipping cost complaint** | "shipping cost", "too expensive", "$70 shipping" | Жалоба на стоимость доставки |
| T10 | **Cancellation request** | "cancel", "don't want", "changed my mind" | Хочет отменить |
| T11 | **Return/refund request** | "refund", "return", "money back" | Хочет вернуть/refund |
| T12 | **Unauthorized purchase** | "didn't order", "not my order", "fraud" | Не делал заказ |
| T13 | **A-to-Z threat/mention** | "A-to-Z", "claim", "guarantee", "file complaint" | Угрожает или упоминает A-to-Z |
| T14 | **Negative review threat** | "1 star", "bad review", "report" | Угрожает отзывом |
| T15 | **Health/safety concern** | "sick", "food poisoning", "FDA", "unsafe", "lawyer" | Здоровье/безопасность |
| T16 | **Carrier postage due** | "pay extra", "postage due", "COD" | Перевозчик требует доплату |
| T17 | **Quality complaint** | "taste", "quality", "doesn't work", "not as described" | Субъективная жалоба |
| T18 | **Pre-sale question** | "ingredients", "allergens", "shelf life", "how to" | Вопрос о товаре |
| T19 | **Refund already issued** | "already refunded", "got refund but" | Клиент пишет после refund |
| T20 | **Repeat complaint** | 2+ сообщения по одному заказу | Повторная жалоба |

### Слой 2: Оценка уровня риска

| Уровень | Условия | Действие |
|---------|---------|----------|
| 🟢 **LOW** | Tracking в норме, нет доказательств проблемы, вопросы о статусе до EDD, pre-sale | Не делать refund. Объяснить факты. Направить проверить mailbox/neighbors/locker |
| 🟡 **MEDIUM** | Wrong item без фото, повреждение без доказательств, неясная жалоба на качество, missing item без подтверждения | Не делать refund сразу. Запросить фото товара + упаковки + shipping label. Решать после получения доказательств |
| 🔴 **HIGH** | Thawed/melted food с фото, carrier delay видимый в tracking, повторный wrong item, misdelivery likely, клиент расстроен и пишет про safety | Не спорить. Обычно REPLACEMENT. Если клиент отказывается от replacement или риск эскалации → REFUND. Параллельно оценить Buy Shipping / reimbursement |
| ⚫ **CRITICAL** | Rancid smell, food poisoning, illness, lawyer/FDA threat, Amazon CS уже вовлечён, chargeback, Over SLA + angry customer | Короткий вежливый ответ. Без споров. Без медицинских суждений. REFUND. Никаких дискуссий о правоте клиента |

### Слой 3: Decision Engine — решающее дерево

**ЭКОНОМИЧЕСКАЯ ЛЕСТНИЦА (от дешёвого к дорогому):**
```
1. Clarification / запрос фото   ← самый дешёвый
2. Redirect to Amazon / A-to-Z   ← пусть Amazon платит
3. Replacement                    ← дешевле чем refund (мы теряем товар, не деньги)
4. Partial refund                 ← компромисс
5. Full refund                    ← последний вариант
```

> **Но:** если риск аккаунту высокий — full refund может быть дешевле чем спор.

#### Дерево решений по типу проблемы:

**T1: Not received, ещё в пути**
```
Tracking = in_transit AND дата < EDD?
├── ДА → REASSURE: "Your package is on its way, expected by {EDD}"
│        Действие: не refund, не replacement
│        Риск: LOW
└── НЕТ (past EDD, still in transit) → 
    ├── Задержка < 3 дней → APOLOGIZE + предложить подождать 1-2 дня
    └── Задержка > 3 дней → APOLOGIZE + REPLACEMENT или REFUND
```

**T2: Not received, tracking = Delivered**
```
Delivery proof? (photo, locker, front desk, recipient name)
├── ДА (strong proof) →
│   Действие: попросить проверить:
│   - mailbox / porch / garage
│   - parcel locker / front desk
│   - neighbors / household members
│   НЕ делать refund сразу
│   Если клиент настаивает → REFUND
│   Кто платит: Amazon (через A-to-Z если Buy Shipping)
│
├── Misdelivery likely (адрес/место не совпадает) →
│   Действие: FULL REFUND
│   Кто платит: Amazon reimbursement / support path
│
└── Неясно →
    Действие: запросить детали, предложить проверить
    Если настаивает → REFUND
```

**T3: Late delivery**
```
Buy Shipping + shipped on time + carrier delay visible?
├── ДА → 
│   Клиенту: APOLOGIZE + REPLACEMENT
│   Внутренне: Support case / Buy Shipping reimbursement
│   ⚠️ НЕ использовать SAFE-T (carrier delay ≠ SAFE-T)
│   Кто платит: Amazon
│
└── НЕТ (мы отправили поздно) →
    Клиенту: APOLOGIZE + REPLACEMENT или REFUND
    Кто платит: мы
```

**T4: Spoiled / thawed / melted food (3 подуровня)**
```
C1. Slight thaw / нет доказательств / неясно
    → Запросить фото
    → Не давать refund сразу
    → Можно предложить replacement
    → Риск: MEDIUM

C2. Melted / thawed / warm / фото предоставлены
    → Спорить минимально
    → REPLACEMENT preferred
    → Если клиент настаивает или риск высок → REFUND
    → Параллельно: carrier delay? → Buy Shipping reimbursement
    → Риск: HIGH
    
C3. Rancid / smelled bad / unsafe / illness / "thrown away"
    → Сразу не спорить
    → REFUND
    → Максимально коротко
    → НИКОГДА не утверждать что товар безопасен
    → Риск: CRITICAL
```

> ⚠️ **Ключевое для frozen:** смотреть не только на письмо, но и на shipping method, transit length, погоду, был ли weekend между отправкой и доставкой.

**T5: Damaged item**
```
Фото есть?
├── НЕТ → запросить фото товара + упаковки
├── ДА → 
│   Food item? → REPLACEMENT (не просить вернуть — food safety)
│   Non-food? → REPLACEMENT или REFUND (на выбор клиента)
│   Кто платит: мы (если наша упаковка) / carrier claim (если carrier повредил)
```

**T6: Wrong item**
```
Фото есть?
├── НЕТ → запросить фото товара + упаковки + shipping label
├── ДА, ошибка подтверждена →
│   Food item? → REPLACEMENT (не возвращать)
│   Non-food? → REPLACEMENT
│   Повторная ошибка? → REFUND (safer)
│   Кто платит: мы
```

**T7: Missing item**
```
Проверить order items vs что получил клиент
├── Реально не хватает → дослать недостающее или PARTIAL REFUND
├── Неясно → запросить фото содержимого посылки
```

**T8: Expired product**
```
→ Запросить фото (best by date)
→ Если подтверждено → REPLACEMENT + проверить SKU (проблема с партией?)
→ Уведомить Владимира если повторяется на одном SKU
→ Кто платит: мы
```

**T9: Shipping cost complaint**
```
→ Объяснить что цена на Amazon уже включает доставку
→ Если клиент настаивает → предложить возврат через стандартный Amazon return
→ НЕ предлагать partial refund на shipping автоматически
→ Если риск отзыва/A-to-Z → рассмотреть partial refund
→ Риск: MEDIUM
```

**T10: Cancellation request**
```
Уже отправлено?
├── НЕТ → отменить заказ
├── ДА → объяснить что в пути, предложить вернуть после получения
│        → Frozen: REFUND (вернуть frozen нельзя)
```

**T11: Return/refund request**
```
Frozen? → НЕ возвращать (food safety) → REFUND
Dry food? → стандартный Amazon return process
Причина? → перенаправить в соответствующую ветку (damaged → T5, wrong → T6)
```

**T12: Unauthorized purchase**
```
→ НЕ разбирать самому
→ НЕ делать refund автоматически
→ Направить в Amazon Customer Support
→ "We cannot verify account authorization details. Please contact Amazon directly."
→ Кто платит: Amazon (fraud case)
```

**T13: A-to-Z threat**
```
→ CRITICAL — немедленно предложить решение чтобы ПРЕДОТВРАТИТЬ claim
→ "I want to resolve this for you right now. I can offer replacement or full refund."
→ Если claim уже подан → переходит в таб A-to-Z
```

**T14: Negative review threat**
```
→ Решить проблему
→ НЕ просить не оставлять отзыв (нарушение Amazon policy)
→ НЕ предлагать компенсацию за отказ от отзыва
```

**T15: Health/safety concern**
```
→ CRITICAL
→ Короткий вежливый ответ
→ REFUND немедленно
→ НИКОГДА не спорить о безопасности еды
→ НИКОГДА не утверждать что товар безопасен
→ Уведомить Владимира немедленно
```

**T16: Carrier postage due**
```
→ Клиенту: "You should NOT pay any extra postage"
→ REFUND или REPLACEMENT
→ Внутренне: reimbursement case against carrier/Buy Shipping
→ Кто платит: carrier / Amazon support
```

**T17: Quality complaint (субъективное)**
```
Фото?
├── НЕТ → запросить фото + детали
├── ДА, реальный дефект → REPLACEMENT
├── Субъективное ("не понравился вкус") → REFUND + вежливый ответ
```

**T18: Pre-sale question**
```
→ Ответить по данным листинга
→ Если не знаешь → "Let me check and get back to you"
→ Риск: LOW
→ Можно автоматически (без одобрения Владимира)
```

**T19: Refund already issued**
```
→ Подтвердить что refund обработан
→ Указать срок (3-5 business days)
→ Не давать повторный refund
```

**T20: Repeat complaint**
```
→ Автоматически повысить приоритет
→ Если 3+ сообщений без решения → CRITICAL → Владимир
→ Проверить историю: тот же SKU? Системная проблема?
```

### Слой 4: Внутренний чеклист (перед каждым ответом)

Claude заполняет перед генерацией ответа:

```
TYPE:                 T1-T20
WHO_IS_WRITING:       BUYER | AMAZON_CS | SYSTEM
TRACKING_STATUS:      in_transit | delivered | exception | unknown
DELIVERED:            yes | no
DELIVERED_ON_TIME:    yes | no | unknown
PHOTO_PROOF:          yes | no | not_needed
BUY_SHIPPING:         yes | no
CLAIMS_PROTECTED:     yes | no
FOOD_SAFETY_RISK:     yes | no
A_TO_Z_RISK:          low | medium | high
RISK_LEVEL:           LOW | MEDIUM | HIGH | CRITICAL
BEST_ACTION:          clarify | redirect_amazon | replacement | partial_refund | full_refund
SECONDARY_ACTION:     (fallback если клиент откажется)
WHO_SHOULD_PAY:       us | amazon | carrier
INTERNAL_ACTION:      support_case | safe_t | buy_shipping_reimbursement | sku_check | none
```

### Слой 5: Кто должен платить

| Ситуация | Кто платит | Механизм |
|----------|-----------|----------|
| Delivered + клиент не получил + strong delivery proof | **Amazon** | A-to-Z (Buy Shipping Protection) |
| Carrier delay + shipped on time + Buy Shipping | **Amazon** | Support case / Buy Shipping reimbursement |
| Unauthorized purchase / account fraud | **Amazon** | Fraud case |
| Chargeback + delivered confirmed | **Amazon** (если выиграем) | Representment с доказательствами |
| Spoiled food + carrier delay | **Amazon** | Buy Shipping reimbursement (НЕ SAFE-T!) |
| Spoiled food + наша упаковка/сервис | **Мы** | Replacement за наш счёт |
| Wrong item | **Мы** | Replacement за наш счёт |
| Quality complaint / не понравилось | **Мы** | Refund |
| Повторный wrong item на одном SKU | **Мы** | Проверить fulfillment process |

> ⚠️ **SAFE-T vs Support/Buy Shipping:** Carrier delay → Buy Shipping Support case. SAFE-T используется ТОЛЬКО если есть отдельное основание (return, A-to-Z). Carrier delay сам по себе ≠ SAFE-T.

### Стратегия ответа на основе трекинга (краткая сводка)

```
trackingStatus = "delivered" AND daysLate <= 0
  → Доставлено вовремя
  → Жалоба на качество/damage → наша ответственность → REPLACEMENT/REFUND
  → Жалоба "не получил" → INVESTIGATE (locker? neighbors? front desk?)

trackingStatus = "delivered" AND daysLate > 0  
  → Carrier задержал
  → Frozen thawed → Buy Shipping Protection → REPLACEMENT + support case
  → Dry damaged → наша ответственность → REPLACEMENT/REFUND

trackingStatus = "in_transit" AND within EDD
  → Ещё в пути, в рамках обещанного
  → REASSURE клиента (LOW risk)

trackingStatus = "in_transit" AND past EDD
  → Задерживается
  → APOLOGIZE + предложить подождать или REPLACEMENT

trackingStatus = "exception" OR "unknown"
  → Проблема с доставкой
  → INVESTIGATE + предложить REPLACEMENT/REFUND
```

### Автоматические ответы (без участия Владимира)

**Простые кейсы (C1 при trackingStatus = in_transit, C10):**
- Генерируется ответ → отправляется автоматически через SP-API Messaging
- Логируется в БД
- Краткое уведомление в Telegram (информационно)

### Ответы с одобрением (все остальные)

**Telegram уведомление:**
```
🔔 Новое сообщение — Salutem Solutions
📦 Order: 114-7863528-5212210
👤 Customer: Cathy
📦 Product: Freshpet Select Deli Fresh (Dry)
📋 Category: C7 — Shipping cost complaint
🚚 Tracking: Delivered Apr 7 (on time)

💬 Customer: "I bought dog food it cost $50.00. Shipping was $70.00 
why is that. Way too high. I tried to cancel when I noticed but 
it wouldn't let me"

📝 Suggested Response:
"Dear Cathy, Thank you for reaching out..."

🎯 Action: PARTIAL_REFUND (shipping)
⏰ Respond within: 48 hours

[✅ Send] [✏️ Edit] [❌ Skip]
```

### Отправка ответа

**Через SP-API Messaging:**
```typescript
// createUnexpectedProblem — для решения проблем с заказом
POST /messaging/v1/orders/{amazonOrderId}/messages/createUnexpectedProblem
{
  "text": "Dear Cathy, ..."
}
```

> ⚠️ SP-API Messaging поддерживает ограниченный набор типов сообщений. Если нужный тип недоступен → fallback: ответ через email (Reply-To из исходного письма).

### Правила ответов (из CS_ALGORITHM v1)

**ЗАПРЕЩЕНО в ответах Amazon:**
- Эмодзи и GIF
- Внешние ссылки (кроме https для заказа)
- Промо-контент, маркетинг, купоны
- Просьба оставить/изменить/удалить отзыв
- Личные контакты (email, телефон)
- Подтверждения заказа/доставки (Amazon делает сам)

**ЗАПРЕЩЕНО агенту (из опыта реальных кейсов):**
- Обвинять клиента
- Писать "это не наша вина" в лоб
- Спорить о здоровье или безопасности пищи
- Обещать то, чего ещё нет
- Утверждать что товар "точно безопасен" при жалобе на spoilage
- Отправлять в SAFE-T если причина — carrier delay
- Использовать агрессивный или защитный тон
- Говорить "already shipped" если carrier ещё не picked up

**ОБЯЗАТЕЛЬНО:**
- Ответить в течение 48 часов (Buy Shipping Protection!)
- Все proactive messages — Order ID обязателен
- Языки: English + Spanish (определяется по языку клиента)
- Frozen товары НЕ просить вернуть (food safety)
- Писать коротко (4-8 предложений)
- Опираться на tracking и факты
- Использовать replacement раньше refund (если разумно)

**Формат каждого ответа:**
```
1. Thank you / apology (если уместно)
2. Одно фактическое предложение (на основе tracking/заказа)
3. Одно предложение с решением
4. Короткое профессиональное закрытие
```

**Специфика frozen (из опыта):**
- При replacement → лучше отправлять в понедельник (если риск зависания в выходные)
- При replacement → попросить подтверждение адреса (Amazon скрывает полный адрес после завершения заказа)
- Если label already created → можно дать tracking, но НЕ писать "already shipped" если carrier ещё не picked up

---

## ТАБ 2: A-TO-Z CLAIMS

### Источник данных

**SP-API Reports:** `GET_CLAIM_DATA` report
**Polling:** каждые 24 часа для каждого аккаунта (store1-store5)

### Алгоритм

```
1. SP-API: запросить отчёт GET_CLAIM_DATA
2. Парсить: новые claims (не в БД)
3. Для каждого нового claim:
   a. Извлечь: Order ID, причину, сумму, дедлайн
   b. SP-API Orders: получить данные заказа
   c. Veeqo/Tracking: получить трекинг
   d. Определить стратегию защиты
   e. Claude: сгенерировать ответ для Amazon
   f. Сохранить в БД (модель AtozzClaim)
   g. Уведомить Владимира (CRITICAL)
```

### Стратегии защиты

| Стратегия | Условие | Confidence |
|-----------|---------|------------|
| **BUY_SHIPPING_PROTECTION** | Этикетка через Veeqo + отправлено вовремя + carrier delay | HIGH |
| **PROOF_OF_DELIVERY** | Tracking = Delivered + адрес совпадает | HIGH |
| **CARRIER_DELAY_DEFENSE** | Carrier задержал, наша отгрузка вовремя | MEDIUM |
| **INR_DEFENSE** | Tracking = Delivered но клиент говорит не получил | MEDIUM |
| **MANUAL_REVIEW** | Нет чёткой защиты / недостаточно данных | LOW |

### Ответ для Amazon (шаблон)

```
We are responding to claim for order {orderId}.

1. SHIPMENT: Shipped {shipDate} via {carrier} {service}
2. TRACKING: {trackingNumber} — status: {status}
3. DELIVERY: {deliveredDate} to {city}, {state}
4. BUY SHIPPING: Label purchased through Amazon Buy Shipping ✅
5. ON-TIME SHIP: First carrier scan within promised window ✅

Based on the above, we request this claim be resolved in our favor.
```

### Параллельно — ответ клиенту

Всегда отправлять клиенту через SP-API Messaging:
```
Dear {name}, I see you've filed a claim regarding your order.
I want to resolve this immediately. I am processing a full 
refund/replacement for your order right now.
```

### Апелляция (если проиграли)

Один шанс. Claude автоматически готовит текст апелляции. Владимир одобряет → отправляем.

### Статусы

`NEW` → `EVIDENCE_GATHERED` → `RESPONSE_READY` → `SUBMITTED` → `DECIDED` → `APPEALED` → `CLOSED`

### Dashboard метрики

- Активные claims + дедлайны (сортировка по срочности)
- ODR текущий (по каждому аккаунту) + порог 1%
- История: Amazon funded / Seller funded / Appealed & Won
- Общие потери за период

---

## ТАБ 3: CHARGEBACKS

### Источник данных

**Gmail API:** письма от `cb-seller-notification@amazon.com`
**Polling:** каждые 24 часа

### Парсинг email

```
From: cb-seller-notification@amazon.com
Subject: Action Required: Chargeback claim on order {orderId}

Body:
- Order ID
- Chargeback amount
- Reason code
- Reply-By date (КРИТИЧНО — обычно 7 дней)
```

### Алгоритм

```
1. Gmail API: поиск новых писем от cb-seller-notification@amazon.com
2. Парсить: Order ID, amount, reason, deadline
3. SP-API Orders: данные заказа
4. Veeqo/Tracking: трекинг
5. Claude: сгенерировать ответ (7 обязательных пунктов)
6. Сохранить в БД (модель AtozzClaim, claimType = "CHARGEBACK")
7. Уведомить Владимира (CRITICAL + countdown до дедлайна)
```

### Ответ (7 обязательных пунктов)

```
Subject: Chargeback Response – Order {orderId}

1. Confirmation of Shipment: shipped {shipDate}
2. Carrier Information: {carrier} / {service}
3. Tracking Information: {trackingNumber} + link
4. Delivery Confirmation: delivered {deliveryDate} to {city, state}
5. Proof of Fulfillment: Amazon Buy Shipping, shipped on time
6. Return & Refund Policy: perishable food, not eligible for return
7. Return Address: {from Settings}
```

### Telegram уведомление

```
⚡ CHARGEBACK — Salutem Solutions
💰 Amount: $108.84
📦 Order: 113-0196033-6384224
📋 Reason: Fraudulent transaction
⏰ Reply-By: Apr 9, 2026 (1 day left!) 🔴

📊 Tracking: Delivered Dec 10, 2025 via UPS
✅ Amazon Buy Shipping: Yes (Protected)

[✅ Send Response] [✏️ Edit]
```

---

## ТАБ 4: FEEDBACK MANAGER

### Источник данных

**SP-API Reports:** `GET_SELLER_FEEDBACK_DATA`
**Polling:** каждые 24 часа для каждого аккаунта

### Классификация отзывов

**Удаляемые (нарушают политику Amazon):**
- Жалоба на скорость доставки/перевозчика → `CARRIER_DELAY`
- Отзыв о товаре, не о продавце → `PRODUCT_REVIEW`
- Нецензурная лексика → `OBSCENE`
- Контактная информация → `PERSONAL_INFO`

**НЕ удаляемые:**
- Реальный опыт работы с магазином
- Качество упаковки
- Общение с продавцом

### Алгоритм

```
1. SP-API: запросить отчёт GET_SELLER_FEEDBACK_DATA
2. Парсить: новые отзывы (не в БД)
3. Claude анализирует каждый отзыв:
   a. Удаляемый? → Request Removal (автоматически)
   b. Не удаляемый + негативный → генерировать ответ
   c. Позитивный → публичный ответ (ротация шаблонов)
4. Сохранить в БД (модель SellerFeedback)
5. Уведомить Владимира (для негативных)
```

### Публичные ответы на позитивные (ротация)

```
Template A: "Thank you so much for the wonderful feedback! 
Your satisfaction is our priority. [Store Name]"

Template B: "We truly appreciate your kind words! 
It means a lot to our team. [Store Name]"

Template C: "Thank you for taking the time to share your experience!
We're thrilled you're happy with your order. [Store Name]"
```

### Статусы

`NEW` → `ANALYZED` → `REMOVAL_SUBMITTED` → `REMOVED` | `DENIED` | `CONTACT_SENT` | `CLOSED`

> ⚠️ ЗАПРЕЩЕНО: просить клиента изменить/удалить отзыв, предлагать компенсацию за изменение

---

## 🟦 WALMART — ОТДЕЛЬНЫЙ РЕЖИМ (скриншоты)

> **Phase 1:** Walmart работает через скриншоты. Когда появится Walmart API — переедет на автоматический режим как Amazon.

### Интерфейс

В Customer Hub добавляется кнопка **"+ Walmart Case"** которая открывает модальное окно:

```
┌──────────────────────────────────────────────────────┐
│  🟦 New Walmart Case                          [✕]   │
│                                                      │
│  📸 Screenshots (drag & drop, paste, or click)      │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐       │
│  │  Screen 1  │ │  Screen 2  │ │     +      │       │
│  │  (order)   │ │  (message) │ │   Add more │       │
│  └────────────┘ └────────────┘ └────────────┘       │
│                                                      │
│  [🔍 Analyze]                                       │
│                                                      │
│  ─────────────────────────────────────────────────── │
│                                                      │
│  📊 Analysis:                                        │
│  Store: Walmart                                      │
│  Order: 2006789456                                   │
│  Customer: Mike Johnson                              │
│  Type: T5 — Damaged item                            │
│  Risk: 🟡 MEDIUM                                    │
│  Action: REQUEST_PHOTO → then REFUND                │
│                                                      │
│  💬 Response:                                        │
│  ┌────────────────────────────────────────────────┐  │
│  │ Hello Mike,                                    │  │
│  │ We're sorry for the inconvenience...           │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  [📋 Copy Response]  [✏️ Edit]  [🔄 Regenerate]    │
└──────────────────────────────────────────────────────┘
```

Поддерживает **несколько скриншотов** — order details, customer message, tracking, фото повреждения.

### Walmart Decision Engine

**Ключевые отличия от Amazon:**

| Правило | Amazon | Walmart |
|---------|--------|---------|
| Переговоры/скидки | Иногда partial refund | ❌ НИКОГДА |
| Просить клиента отменить | — | ❌ ЗАПРЕЩЕНО |
| Тон | Мягкий, empathetic | Нейтральный, по делу |
| Скорость решения | 48 часов | Как можно быстрее |
| Frozen товары | Есть | ❌ НЕТ (frozen запрещён) |
| Partial refund | Допустимо | ❌ НЕ предлагать |
| Возврат еды | Не просить | Не просить |

**Walmart типы кейсов:**

| Тип | Действие |
|-----|----------|
| Cancel (до отправки) | Cancel + подтвердить |
| Cancel (после отправки) | Объяснить, предложить return после получения |
| Where is my order | Дать tracking, коротко |
| Delivered, не получил | Проверить surroundings. НЕ refund сразу |
| Returned to sender | Refund + предложить перезаказать |
| Missing items | Resend (подтвердить адрес) |
| Damaged / expired | Refund или Replacement. НЕ спорить |
| Wrong item | Извиниться + return flow + refund |
| Unclear | Запросить Order ID, tracking, детали |

**Walmart жёсткие правила:**
- ❌ Никаких скидок и partial refund
- ❌ Не просить клиента отменить заказ
- ❌ Не обсуждать компенсации
- ❌ Не игнорировать сообщения (Seller Response Rate!)
- ✅ Быстро закрывать кейс
- ✅ Минимум текста, clear решение
- ✅ Нейтральный тон

**Формат ответа Walmart (4 части):**
```
1. Hello [Name], we're sorry for the inconvenience.
2. [Факт — что произошло]
3. [Решение — что мы делаем]
4. Thank you for your understanding.
```

### Walmart в БД

Walmart кейсы сохраняются в ту же модель `BuyerMessage` но с `channel = "Walmart"` и `source = "screenshot"`.

---

### Путь: `/customer-hub`

### Layout

```
┌─────────────────────────────────────────────────────────┐
│  🎯 Customer Hub                                         │
│                                                          │
│  [Messages (3)] [A-to-Z (1)] [Chargebacks (0)] [Feedback (2)] │
│                                                          │
│  Фильтр аккаунта: [All ▼] [Salutem] [Vladimir] [...]   │
│                                                          │
│  ┌──────────────────────────────────────────────────────┐│
│  │  Содержимое активного таба                           ││
│  │  ...                                                 ││
│  └──────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

### Таб Messages — список сообщений

```
┌──────────────────────────────────────────────────────────┐
│ 🔴 Apr 9  | Salutem  | Cathy      | C7 Shipping cost    │
│ 🟡 Apr 9  | Vladimir | John Smith | C1 Where is my order│
│ ✅ Apr 8  | Salutem  | Maria      | C2 Damaged (resolved)│
└──────────────────────────────────────────────────────────┘

Клик на строку → раскрывается детальная панель:

┌──────────────────────────────────────────────────────────┐
│ 📦 Order: 114-7863528-5212210  | 🏪 Salutem Solutions   │
│ 👤 Cathy  | 📦 Freshpet Deli Fresh 9lbs | Dry           │
│ 🚚 UPS Ground | Delivered Apr 7 ✅ | On time            │
│                                                          │
│ 💬 Customer Message:                                     │
│ "I bought dog food it cost $50.00. Shipping was $70.00   │
│  why is that..."                                         │
│                                                          │
│ 📋 Category: C7 — Shipping cost complaint                │
│ 🎯 Action: PARTIAL_REFUND                               │
│                                                          │
│ 📝 Suggested Response:                                   │
│ ┌────────────────────────────────────────────────────┐   │
│ │ Dear Cathy,                                        │   │
│ │ Thank you for reaching out...                      │   │
│ └────────────────────────────────────────────────────┘   │
│                                                          │
│ [📋 Copy] [✏️ Edit] [🔄 Regenerate] [✅ Send via API]   │
└──────────────────────────────────────────────────────────┘
```

### Таб A-to-Z — список claims

```
┌──────────────────────────────────────────────────────────┐
│ Status    | Store    | Order ID  | Reason | Amount | DL  │
│ 🔴 NEW   | Salutem  | 113-xxx   | INR    | $45.99 | 2d  │
│ ⏳ SUBM  | Vladimir | 114-xxx   | SNAD   | $89.00 | —   │
│ ✅ WON   | Salutem  | 112-xxx   | INR    | $32.50 | —   │
└──────────────────────────────────────────────────────────┘
```

### Общий Dashboard (над табами)

```
┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
│ Unread │ │ A-to-Z │ │ CB     │ │ ODR    │
│ Msgs   │ │ Active │ │ Active │ │ Worst  │
│  3     │ │  1     │ │  0     │ │ 0.4%   │
└────────┘ └────────┘ └────────┘ └────────┘
```

---

## SIDEBAR — ИЗМЕНЕНИЯ

**Убрать из sidebar:**
- ~~Customer Service~~ (заменён Customer Hub)
- ~~A-to-Z & Chargebacks~~ (внутри Customer Hub)
- ~~Feedback Manager~~ (внутри Customer Hub)

**Оставить:**
```
📊 Dashboard
💓 Account Health
🚚 Shipping Labels
🎯 Customer Hub          ← ЕДИНЫЙ МОДУЛЬ (4 таба)
🌡️ Frozen Analytics
📊 Adjustments
🏷️ Product Listings      (Phase 2)
💰 Sales Analytics       (Phase 2)
🛒 Suppliers             (Phase 3)
📢 Promotions            (Phase 3)
🔄 Integrations
⚙️ Settings
```

---

## БАЗА ДАННЫХ — НОВАЯ МОДЕЛЬ

### BuyerMessage (новая модель — заменяет CsCase для Messages)

```prisma
model BuyerMessage {
  id              String   @id @default(cuid())
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  // Источник
  gmailMessageId  String   @unique  // dedup
  gmailThreadId   String?
  
  // Аккаунт
  channel         String   @default("Amazon") // Amazon | Walmart
  source          String   @default("gmail")  // gmail | screenshot
  storeIndex      Int
  storeName       String
  storeEmail      String   // amazon@salutem.solutions
  
  // Клиент
  customerName    String?
  customerEmail   String?  // анонимизированный Amazon email
  language        String   @default("English") // English | Spanish
  
  // Заказ
  amazonOrderId   String
  orderDate       String?
  orderTotal      Float?
  
  // Товар
  product         String?
  asin            String?
  productType     String?  // Frozen | Dry
  quantity        Int?
  
  // Доставка (из Veeqo/Tracking)
  carrier         String?
  service         String?
  trackingNumber  String?
  shipDate        String?
  promisedEdd     String?
  actualDelivery  String?
  trackingStatus  String?  // in_transit | delivered | exception
  daysLate        Int?
  boughtThroughVeeqo Boolean @default(false)
  claimsProtected Boolean @default(false)
  shippedOnTime   Boolean?
  
  // Сообщение
  direction       String   @default("incoming") // incoming = от клиента, outgoing = наш ответ
  customerMessage String   // текст сообщения (или нашего ответа)
  
  // AI анализ (Decision Engine)
  problemType     String?  // T1-T20
  problemTypeName String?
  riskLevel       String?  // LOW | MEDIUM | HIGH | CRITICAL
  category        String?  // backwards compat
  categoryName    String?
  priority        String?  // LOW | MEDIUM | HIGH | CRITICAL
  action          String?  // clarify | redirect_amazon | replacement | partial_refund | full_refund
  secondaryAction String?  // fallback если клиент откажется
  whoShouldPay    String?  // us | amazon | carrier
  internalAction  String?  // support_case | safe_t | buy_shipping_reimbursement | sku_check | none
  foodSafetyRisk  Boolean  @default(false)
  atozRisk        String?  // low | medium | high
  
  // Ответ
  suggestedResponse String?
  editedResponse    String?
  responseSentAt    DateTime?
  responseSentVia   String?  // SP_API | EMAIL | MANUAL
  
  // Статус
  status          String   @default("NEW") // NEW | ANALYZED | RESPONSE_READY | SENT | RESOLVED
  resolution      String?
  
  // Связи
  frozenIncidentId String?  // если C3 → создан FrozenIncident
  
  vladimirNotes   String?
  imageData       String?  // base64 screenshots (Walmart only, multiple separated by delimiter)
}
```

> **Модель CsCase остаётся** для обратной совместимости и fallback (скриншоты), но новые сообщения идут в BuyerMessage.

---

## API ROUTES

### Customer Hub API

```
GET  /api/customer-hub/messages
     → Список сообщений (из BuyerMessage)
     → Фильтры: store, status, category, dateRange

POST /api/customer-hub/messages/sync
     → Запустить синхронизацию Gmail → парсинг → обогащение → Claude

POST /api/customer-hub/messages/{id}/send
     → Отправить ответ через SP-API Messaging

GET  /api/customer-hub/atoz
     → Список A-to-Z claims (из AtozzClaim)

POST /api/customer-hub/atoz/sync
     → Запустить синхронизацию SP-API Reports

POST /api/customer-hub/atoz/{id}/submit
     → Отправить ответ в Amazon

POST /api/customer-hub/atoz/{id}/appeal
     → Отправить апелляцию

GET  /api/customer-hub/chargebacks
     → Список chargebacks (из AtozzClaim where claimType = CHARGEBACK)

POST /api/customer-hub/chargebacks/sync
     → Синхронизация Gmail (cb-seller-notification)

GET  /api/customer-hub/feedback
     → Список отзывов (из SellerFeedback)

POST /api/customer-hub/feedback/sync
     → Синхронизация SP-API Reports

POST /api/customer-hub/feedback/{id}/request-removal
     → Запрос удаления отзыва

POST /api/customer-hub/feedback/{id}/respond
     → Публичный ответ на отзыв

GET  /api/customer-hub/stats
     → Общая статистика (для карточек над табами)
```

---

## CRON JOBS / POLLING

```
Каждые 8-12ч → Messages sync (Gmail → parse → enrich → Claude)
Каждые 24ч   → A-to-Z sync (SP-API Reports)
Каждые 24ч   → Chargebacks sync (Gmail)
Каждые 24ч   → Feedback sync (SP-API Reports)
```

В Phase 1 — кнопка "Sync" в UI для ручного запуска.
В Phase 2 — автоматический cron через API route + external scheduler.

---

## 🟦 WALMART CUSTOMER SERVICE (временная схема — скриншоты)

> Пока нет Walmart API — работаем по старой схеме: скриншот → AI анализ → copy-paste ответа в Seller Central. Когда получим API ключ — переведём на автоматику как Amazon.

### Интерфейс

В Customer Hub — отдельная кнопка или 5-й мини-таб:

```
┌──────────────────────────────────────────────────────┐
│ 🟦 Walmart Case (manual)              [📸 Upload]   │
│                                                      │
│ Drop screenshots here or click to upload             │
│ (можно несколько скриншотов одного кейса)            │
│                                                      │
│ ─────────────────────────────────────────────────── │
│                                                      │
│ 📊 Analysis:                                        │
│ Type: Delivered / Not received                       │
│ Risk: LOW                                           │
│ Action: Ask to check surroundings                    │
│                                                      │
│ 📝 Response:                                        │
│ ┌────────────────────────────────────────────────┐  │
│ │ Hello [Name],                                  │  │
│ │ We're sorry for the inconvenience...           │  │
│ └────────────────────────────────────────────────┘  │
│                                                      │
│ [📋 Copy Response] [✏️ Edit] [🔄 Regenerate]       │
└──────────────────────────────────────────────────────┘
```

### Walmart Decision Engine

**Принципы (жёстче Amazon):**
- Никаких переговоров / скидок / partial refund
- Не спорим с клиентом
- Быстро закрываем кейс
- Walmart может сам сделать refund → нужно опережать
- Коротко и по делу

**Классификация:**

| Тип | Действие | Refund? |
|-----|----------|---------|
| Cancel (не отправлен) | Cancel + подтвердить | — |
| Cancel (отправлен) | Объяснить, предложить вернуть после получения | Нет |
| Where is my order | Дать tracking, коротко | Нет |
| Delivered / not received | Проверить porch/neighbors/mailbox | Нет (сначала) |
| Returned to sender | Refund + предложить перезаказать | Да |
| Missing items | Resend + подтвердить адрес | Нет |
| Damaged / expired food | Refund ИЛИ replacement (не спорить, не просить вернуть) | Да |
| Wrong item | Извиниться + return flow + refund | Да |
| Непонятный кейс | Запросить Order ID, tracking, детали | Нет |

**Жёсткие правила Walmart:**
- ❌ Предлагать скидки
- ❌ Partial refund
- ❌ Просить клиента отменить заказ
- ❌ Обсуждать компенсации
- ❌ Игнорировать
- ❌ Frozen товары на Walmart (их нет)
- ✅ Быстро закрывать кейс
- ✅ Clear решение (replacement или refund)
- ✅ Минимум текста
- ✅ Нейтральный тон

**Формат ответа (4 шага):**
```
1. Hello [Name], We're sorry for the inconvenience.
2. [Факт: что произошло — по tracking/заказу]
3. [Решение: replacement / refund / действие]
4. Thank you for your understanding.
```

**Стиль: "Soft Defense"**
- Не признаём вину напрямую
- Но даём решение
- Не спорим
- Контролируем ситуацию

### API (Claude анализ скриншотов)

```
POST /api/customer-hub/walmart/analyze
Body: { images: ["base64...", "base64..."] }

Response: {
  channel: "Walmart",
  orderId: "...",
  customerName: "...",
  caseType: "delivered_not_received",
  risk: "LOW",
  action: "ask_check_surroundings",
  response: "Hello ...",
  internalNotes: "..."
}
```

> Когда появится Walmart API — этот endpoint заменится на автоматический sync, аналогично Amazon.

---

### Что считаем

| Тип события | Формула убытка | Источник данных |
|-------------|---------------|-----------------|
| **Full refund** | Сумма refund | SP-API / BuyerMessage |
| **Partial refund** | Сумма partial refund | SP-API / BuyerMessage |
| **A-to-Z проиграли** | `amountCharged` | AtozzClaim |
| **Chargeback проиграли** | `amountCharged` | AtozzClaim |
| **Replacement** | `sale_price × COGS_PERCENT + new_label_cost` | BuyerMessage + Settings |
| **A-to-Z выиграли (Amazon funded)** | **$0** | Не считать как loss |
| **Chargeback выиграли** | **$0** | Не считать как loss |

### Формула Replacement

```
COGS_PERCENT = 0.40  (настраивается в Settings, по умолчанию 40%)

replacement_loss = order_total × COGS_PERCENT + new_shipping_label_cost
```

**Пример:** товар $50, этикетка $12 → loss = $20 + $12 = **$32**

### Настройка в Settings

```
┌──────────────────────────────────────────────────────┐
│ 💰 Loss Calculation Settings                         │
│                                                      │
│ COGS % (cost of goods as % of sale price): [40]%    │
│                                                      │
│ ℹ️ Used to estimate loss when sending replacement.   │
│ Adjust based on your actual margins.                 │
└──────────────────────────────────────────────────────┘
```

### Отображение на Dashboard

**Фильтр периода:** Today | 7d | 30d | Custom range

```
┌────────────────────────────────────────────────────────────┐
│ 💸 Losses                              Period: [30 days ▼] │
│                                                            │
│ Total: $1,247.50                                          │
│                                                            │
│ Refunds:        $580.00  (8 orders)                       │
│ Partial refunds: $95.50  (3 orders)                       │
│ Replacements:   $384.00  (6 orders)                       │
│ A-to-Z lost:    $188.00  (2 claims)                       │
│ Chargebacks:     $0.00   (0 lost)                         │
│                                                            │
│ 💰 Saved (Amazon funded): $320.00  (4 claims won)         │
└────────────────────────────────────────────────────────────┘
```

> При переключении аккаунта — показывает losses только для выбранного.

### Модель для БД

Убытки не хранятся в отдельной таблице — считаются на лету из существующих моделей:
- `BuyerMessage` (action = full_refund / partial_refund / replacement, orderTotal, price)
- `AtozzClaim` (amazonDecision, amountCharged, amountSaved)

---

### Приоритеты

| Приоритет | Когда | Формат |
|-----------|-------|--------|
| 🔴 CRITICAL | A-to-Z claim, Chargeback, дедлайн < 2 дней | Немедленно + countdown |
| 🟡 HIGH | Negative feedback, C2/C3/C4 messages | В течение часа |
| 🟢 NORMAL | C1/C10 messages, positive feedback | Сводка 2 раза в день |

### Ежедневная сводка (утро)

```
📊 Customer Hub Summary — Apr 9, 2026

💬 Messages: 3 new (1 urgent)
⚡ Chargebacks: 0 active
🛡️ A-to-Z: 1 active (reply by Apr 11)
⭐ Feedback: 2 new (1 negative, 1 positive)
💸 Losses MTD: $150.64
🏥 ODR: Salutem 0.4% ✅ | Vladimir 0.2% ✅
```

---

## 💸 РАСЧЁТ УБЫТКОВ (LOSSES)

### Что считаем

| Тип события | Формула убытка | Источник данных |
|-------------|---------------|-----------------|
| **Full refund** | Сумма refund | SP-API / BuyerMessage |
| **Partial refund** | Сумма partial refund | SP-API / BuyerMessage |
| **A-to-Z проиграли** | `amountCharged` | AtozzClaim |
| **Chargeback проиграли** | `amountCharged` | AtozzClaim |
| **Replacement** | `sale_price × COGS_PERCENT + new_label_cost` | BuyerMessage + Settings |
| **A-to-Z выиграли (Amazon funded)** | **$0** | Не считать как loss |
| **Chargeback выиграли** | **$0** | Не считать как loss |

### Формула Replacement

```
COGS_PERCENT = 0.40  (настраивается в Settings, по умолчанию 40%)

replacement_loss = order_total × COGS_PERCENT + new_shipping_label_cost
```

**Пример:** товар $50, этикетка $12 → loss = $20 + $12 = **$32**

### Отображение на Dashboard

**Фильтр периода:** Today | 7d | 30d | Custom range

```
┌────────────────────────────────────────────────────────────┐
│ 💸 Losses                              Period: [30 days ▼] │
│                                                            │
│ Total: $1,247.50                                          │
│                                                            │
│ Refunds:        $580.00  (8 orders)                       │
│ Partial refunds: $95.50  (3 orders)                       │
│ Replacements:   $384.00  (6 orders)                       │
│ A-to-Z lost:    $188.00  (2 claims)                       │
│ Chargebacks:     $0.00   (0 lost)                         │
│                                                            │
│ 💰 Saved (Amazon funded): $320.00  (4 claims won)         │
└────────────────────────────────────────────────────────────┘
```

### Настройка COGS % в Settings

```
┌──────────────────────────────────────────────────────┐
│ 💰 Loss Calculation                                  │
│ COGS % (cost of goods as % of sale price): [40]%    │
└──────────────────────────────────────────────────────┘
```

---

## НАСТРОЙКИ (Settings)

### Gmail Accounts (новый раздел в Settings)

```
┌──────────────────────────────────────────────────────┐
│ 📧 Gmail Accounts                                    │
│                                                      │
│ ✅ kuzy.vladimir@gmail.com   [Connected] [Disconnect]│
│ ❌ amazon@salutem.solutions  [Connect OAuth]         │
│ ❌ (add new account)         [+ Add]                 │
│                                                      │
│ Each account needs Google OAuth consent to read      │
│ buyer messages and chargeback notifications.         │
└──────────────────────────────────────────────────────┘
```

### Store → Email Mapping

```
┌──────────────────────────────────────────────────────┐
│ 🏪 Store Email Mapping                               │
│                                                      │
│ Store 1: Salutem Solutions                           │
│   Amazon email: amazon@salutem.solutions             │
│   SP-API: ✅ Connected                               │
│   Gmail: ❌ Not connected                            │
│                                                      │
│ Store 2: Vladimir Personal                           │
│   Amazon email: kuzy.vladimir@gmail.com              │
│   SP-API: ✅ Connected                               │
│   Gmail: ✅ Connected                                │
└──────────────────────────────────────────────────────┘
```

---

## ENV ПЕРЕМЕННЫЕ (новые)

```env
# Gmail OAuth (для каждого подключённого ящика)
GMAIL_CLIENT_ID=<Google OAuth client ID>
GMAIL_CLIENT_SECRET=<Google OAuth client secret>

# Store 1 Gmail
GMAIL_REFRESH_TOKEN_STORE1=<refresh token for amazon@salutem.solutions>

# Store 2 Gmail (может использовать основной Gmail MCP коннектор)
GMAIL_REFRESH_TOKEN_STORE2=<refresh token for kuzy.vladimir@gmail.com>

# Telegram
TELEGRAM_BOT_TOKEN=<bot_token>
TELEGRAM_CHAT_ID=486456466
```

---

## ФАЙЛОВАЯ СТРУКТУРА

```
src/
├── app/
│   ├── customer-hub/
│   │   └── page.tsx                    # Единая страница с табами
│   └── api/
│       └── customer-hub/
│           ├── messages/
│           │   ├── route.ts            # GET список + POST sync
│           │   └── [id]/
│           │       ├── route.ts        # GET детали
│           │       └── send/route.ts   # POST отправить ответ
│           ├── atoz/
│           │   ├── route.ts
│           │   └── [id]/
│           │       ├── submit/route.ts
│           │       └── appeal/route.ts
│           ├── chargebacks/
│           │   └── route.ts
│           ├── feedback/
│           │   ├── route.ts
│           │   └── [id]/
│           │       ├── remove/route.ts
│           │       └── respond/route.ts
│           └── stats/route.ts
├── components/
│   └── customer-hub/
│       ├── CustomerHubTabs.tsx         # Табы
│       ├── MessagesTab.tsx             # Список сообщений
│       ├── MessageDetail.tsx           # Развёрнутая карточка
│       ├── AtozTab.tsx                 # A-to-Z claims
│       ├── AtozDetail.tsx
│       ├── ChargebacksTab.tsx
│       ├── ChargebackDetail.tsx
│       ├── FeedbackTab.tsx
│       ├── FeedbackDetail.tsx
│       ├── HubStatsCards.tsx           # Карточки статистики
│       └── StoreFilter.tsx            # Фильтр по аккаунту
└── lib/
    ├── customer-hub/
    │   ├── gmail-parser.ts            # Парсинг buyer messages из Gmail
    │   ├── chargeback-parser.ts       # Парсинг chargebacks из Gmail
    │   ├── message-enricher.ts        # Обогащение через SP-API + Veeqo
    │   ├── message-analyzer.ts        # Claude анализ + генерация ответа
    │   ├── response-sender.ts         # Отправка через SP-API Messaging
    │   └── feedback-sync.ts           # Синхронизация feedback
    └── gmail-api.ts                   # Gmail API client (OAuth)
```

---

## СВЯЗЬ С ДРУГИМИ МОДУЛЯМИ

### → Frozen Analytics
Когда BuyerMessage.category = "C3" (frozen thawed):
- Автоматически создать FrozenIncident
- Заполнить данные из контекста заказа + трекинг + погода
- Обновить SkuRiskProfile

### → Shipping Labels
Данные трекинга из ShippingPlanItem используются для обогащения сообщений.
Поле `boughtThroughVeeqo` определяет Buy Shipping Protection.

### → Account Health
ODR метрика отображается в Customer Hub dashboard.
A-to-Z claims влияют на ODR — отслеживать порог 1%.

### → Dashboard
Customer Hub stats (unread messages, active claims) показываются на главной.

---

## ПОРЯДОК РЕАЛИЗАЦИИ

### Step 1: Инфраструктура
- Prisma: добавить модель BuyerMessage
- lib/gmail-api.ts: Gmail API client с OAuth
- lib/customer-hub/gmail-parser.ts: парсинг писем

### Step 2: Messages таб
- API route: sync + list + send
- UI: MessagesTab + MessageDetail
- Claude интеграция для анализа

### Step 3: A-to-Z таб
- API route: sync + list + submit + appeal
- UI: AtozTab + AtozDetail
- Стратегии защиты (уже есть lib/claims/strategy.ts)

### Step 4: Chargebacks таб
- API route: sync через Gmail
- UI: ChargebacksTab + ChargebackDetail
- Шаблон ответа (7 пунктов)

### Step 5: Feedback таб
- API route: sync + removal + respond
- UI: FeedbackTab + FeedbackDetail
- Claude классификация (удаляемый/нет)

### Step 6: Интеграция
- Telegram уведомления
- Связь с Frozen Analytics
- Dashboard stats
- Sidebar cleanup

---

*Версия: v2.1 — 2026-04-09*
*Заменяет: CUSTOMER_HUB_ALGORITHM_v1.0.md + CS_ALGORITHM_v1.md*
*Ключевые изменения v2.0 → v2.1:*
*- Добавлен 5-слойный Decision Engine (классификация → риск → решение → чеклист → кто платит)*
*- 20 типов проблем (T1-T20) вместо 10 категорий (C1-C10)*
*- 4 уровня риска (LOW/MEDIUM/HIGH/CRITICAL) с конкретными действиями*
*- Экономическая лестница: clarification → redirect Amazon → replacement → partial refund → full refund*
*- Матрица "Кто должен платить" (Amazon vs мы vs carrier)*
*- SAFE-T vs Support разделение (carrier delay ≠ SAFE-T)*
*- Жёсткие правила агента из реального опыта кейсов*
*- Формат ответа: 4-8 предложений, структура thank you → факт → решение → close*
*- Frozen-специфика: timing replacement, address confirmation*
*Изменения v1 → v2.0:*
*- Убраны скриншоты — всё через API*
*- Gmail API как источник входящих сообщений покупателей*
*- SP-API для обогащения данных и отправки ответов*
*- Единая страница /customer-hub с 4 табами*
*- Новая модель BuyerMessage*

**Комплект документов (обновлённый):**
1. `MASTER_PROMPT_v3.1.md` — логика shipping labels
2. `N8N_SHIPPING_ARCHITECTURE_v1.1.md` — n8n архитектура
3. `CUSTOMER_HUB_ALGORITHM_v2.0.md` — **этот файл**
4. `FROZEN_ANALYTICS_v1.0.md` — аналитика frozen
5. `CLAUDE.md` — техспек проекта (нужно обновить!)
6. `SKU Shipping Database v2` (Google Sheets)
