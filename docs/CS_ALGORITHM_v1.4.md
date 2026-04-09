# 💬 Customer Service Algorithm — Salutem Solutions
## Version 1.4 — 2026-04-08

---

## 🎯 ОБЩАЯ ЗАДАЧА МОДУЛЯ

Модуль Customer Service в Control Center принимает скриншот кейса (Amazon или Walmart), автоматически:
1. Определяет **канал** (Amazon / Walmart) и **аккаунт** (по имени магазина на скриншоте)
2. Определяет **тип проблемы** (категорию кейса)
3. Определяет **тип товара** (Frozen / Dry)
4. Извлекает **данные заказа** (Order ID, Product, Customer Name, дату)
5. Генерирует **готовый ответ** по алгоритму
6. Предлагает **действие** (refund / replacement / escalate)

**Языки ответов:** English + Spanish (определяется по языку сообщения клиента)

---

## 📋 МАГАЗИНЫ (заполнить позже)

| # | Канал | Название магазина | Подпись в ответах |
|---|-------|-------------------|-------------------|
| 1 | Amazon | _TBD_ | _TBD_ |
| 2 | Amazon | _TBD_ | _TBD_ |
| 3 | Amazon | _TBD_ | _TBD_ |
| 4 | Amazon | _TBD_ | _TBD_ |
| 5 | Amazon | _TBD_ | _TBD_ |
| 6 | Walmart | _TBD_ | _TBD_ |

> Подпись = имя магазина. Определяется автоматически по скриншоту.

---

## 🛡️ ПОЛИТИКИ МАРКЕТПЛЕЙСОВ — ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА

> ⚠️ Нарушение этих правил может привести к ограничению messaging-привилегий или suspension аккаунта.

### Amazon — Communication Guidelines (актуально на апрель 2026)

**РАЗРЕШЕНО в сообщениях:**
- Решение проблем с заказом / fulfillment
- Вопросы по возврату (только если нужна доп. информация)
- Отправка инвойса
- Запрос product review или seller feedback (ОДИН раз за заказ, нейтральным языком)
- Подтверждение кастомного дизайна
- Всё, что необходимо покупателю для получения заказа

**ЗАПРЕЩЕНО в сообщениях:**
- ❌ Промо-контент, маркетинг, купоны, upsell
- ❌ Эмодзи и анимированные GIF
- ❌ Внешние ссылки (кроме secure https, необходимых для заказа)
- ❌ Логотипы со ссылками на сайт
- ❌ Просьба оставить ПОЛОЖИТЕЛЬНЫЙ отзыв
- ❌ Стимулирование отзывов (деньги, скидки, подарки, refund в обмен)
- ❌ Просьба изменить или удалить отзыв
- ❌ Opt-out ссылки
- ❌ Отправка подтверждений заказа/доставки (Amazon делает это сам)
- ❌ "Thank you" сообщения без привязки к заказу
- ❌ Личные email-адреса, телефоны, перенаправление за пределы Amazon
- ❌ Вложения, не связанные с заказом

**Технические требования:**
- Все proactive messages должны содержать **17-значный Order ID**
- Proactive messages — в течение **30 дней** после завершения заказа
- Ответ на запрос покупателя — в течение **48 часов**
- Для Buy Shipping protection — ответ на Buyer-Seller Message в течение **48 часов** обязателен

**Последствия нарушений:**
1. Предупреждение
2. Ограничение messaging-привилегий (только Amazon templates)
3. Suspension аккаунта

### Walmart — Customer Care Policy (актуально на апрель 2026)

**РАЗРЕШЕНО:**
- Ответы на запросы клиентов до и после покупки
- Использование шаблонов для ответов
- Вложения до 5 шт., каждое ≤ 5 MB

**ЗАПРЕЩЕНО:**
- ❌ Рекламные материалы, маркетинг, промо в коммуникации
- ❌ Гиперссылки, URL на личные/бизнес-сайты, соцсети, другие маркетплейсы
- ❌ Нежелательные сообщения (кроме необходимых для заказа)
- ❌ Автоответы как замена личного ответа (не считается valid response)
- ❌ Предложение альтернатив вместо возврата (если не настроен Partial Keep It Rules заранее)

**Ключевые метрики (enforced с апреля 2026):**
- **Seller Response Rate** — процент ответов на сообщения
- **Return Rate** — процент возвратов
- **Item Not Received Rate** — процент "не получил"
- **Negative Feedback Rate** — процент негативных отзывов
- **On-Time Delivery Rate** — своевременность доставки
- **Cancellation Rate** — отмены

**Требования к поддержке:**
- Поддержка на English для US-транзакций обязательна
- Должна быть toll-free телефонная линия
- Voicemail когда агент недоступен
- Ответ на сообщения — в установленные сроки (иначе Walmart может отменить заказ)

### Amazon Buy Shipping Protection — ПРАВИЛЬНАЯ МЕХАНИКА (v1.2)

> ⚠️ **ВАЖНОЕ ИСПРАВЛЕНИЕ v1.2:** Buy Shipping Protection и SAFE-T — это РАЗНЫЕ инструменты. SAFE-T работает только для FBA (потери на складе Amazon). Для FBM (наш случай) работает только Claims Protection через A-to-Z. Логика ниже исправлена.

#### Как реально работает Buy Shipping Claims Protection:

**Условия получения защиты (все четыре обязательны):**
1. ✅ Этикетка куплена через Amazon Buy Shipping (Veeqo) с badge **"Claims Protected"** — НЕ "Late Delivery Risk"
2. ✅ Первый carrier scan подтверждает отправку вовремя (в день Ship By или на следующий)
3. ✅ Продавец ответил покупателю в Buyer-Seller Messages **в течение 48 часов**
4. ✅ Покупатель подаёт **A-to-Z Guarantee claim** (именно через A-to-Z, не напрямую к продавцу)

**Что даёт:**
- Amazon финансирует refund покупателю — деньги списываются с Amazon, НЕ с продавца
- A-to-Z claim НЕ считается против ODR (Order Defect Rate)
- OTDR (On-Time Delivery Rate) защищён

**❌ ЧТО НЕ РАБОТАЕТ:**
- Продавец выдал refund напрямую → Amazon не компенсирует → деньги потеряны
- Клиент написал жалобу, но не открыл A-to-Z → Amazon не компенсирует автоматически
- Этикетка с "Late Delivery Risk" badge → защиты нет вообще

**Главное правило агента при вине перевозчика:**
> НЕ делать refund немедленно. Сначала ответить, посочувствовать, а затем тактично направить клиента открыть A-to-Z. Amazon сам возместит клиенту — и нас не тронет.

#### Как определить "Claims Protected" vs "Late Delivery Risk":
- Видно в Veeqo/Amazon Buy Shipping UI в момент покупки этикетки
- Видно в деталях заказа после покупки (секция "Shipping label purchase")
- Control Center должен сохранять этот badge при покупке этикетки

---

## 🚨 CARRIER DELAY DETECTION (v1.2+)

### Что такое Carrier Delay?

Когда заказ был отправлен вовремя через Amazon Buy Shipping, но перевозчик доставил позже обещанного EDD — это carrier delay. Amazon покрывает такие случаи через A-to-Z Guarantee, если соблюдены условия Buy Shipping Protection.

### Алгоритм определения Carrier Delay:

```
1. Извлечь из скриншота:
   - Promised EDD (обещанная дата доставки)
   - Actual delivery date (фактическая дата доставки)
   - Shipping label badge ("Claims Protected" / "Late Delivery Risk")
   - Ship date (дата отправки)

2. Определить carrierDelayDetected:
   IF actual delivery > promised EDD → carrierDelayDetected = true
   ELSE → carrierDelayDetected = false

3. Определить carrierBadge:
   - "Claims Protected" → полная защита, A-to-Z funded by Amazon
   - "Late Delivery Risk" → нет защиты, наша ответственность
   - "Unknown" → не видно на скриншоте, нужна проверка

4. Определить shippedOnTime:
   IF первый carrier scan ≤ dispatch_date → shippedOnTime = true
   ELSE → shippedOnTime = false

5. Рассчитать daysLate:
   daysLate = actual delivery - promised EDD (в календарных днях)
```

### Carrier Self-Declared Delay (v1.4):

Если tracking ЯВНО содержит статус "Delayed" (официальный статус от перевозчика):
- Это ДОКУМЕНТАЛЬНОЕ ДОКАЗАТЕЛЬСТВО вины перевозчика
- Amazon канал: немедленно активировать Buy Shipping Protection → направить на A-to-Z
- Зафиксировать скриншот трекинга для carrier compensation claim
- internalNotes ОБЯЗАТЕЛЬНО: "CARRIER SELF-DECLARED DELAY — статус 'Delayed' на трекинге. Сохранить скриншот. Добавить в модуль Buy Shipping Claims для компенсации."

### Правила действий при Carrier Delay:

```
IF carrierDelayDetected = true AND carrierBadge = "Claims Protected" AND shippedOnTime = true:
  → action = "A2Z_GUARANTEE"
  → Направить клиента подать A-to-Z Guarantee claim
  → НЕ предлагать прямой refund от продавца
  → Amazon финансирует refund
  → Claim НЕ считается против ODR

IF carrierDelayDetected = true AND (carrierBadge = "Late Delivery Risk" OR carrierBadge = "Unknown"):
  → action = "REPLACEMENT" или "REFUND"
  → Наша ответственность

IF carrierDelayDetected = false OR не видно данных на скриншоте:
  → carrierDelayDetected = false
  → По умолчанию Branch B (наша ответственность)
```

---

## 🔀 КЛАССИФИКАЦИЯ КЕЙСОВ

### Категории проблем:

| ID | Категория | Приоритет | Опасность |
|----|-----------|-----------|-----------|
| C1 | **Where is my order / Tracking** | Средний | Низкая |
| C2 | **Item arrived damaged** | Высокий | Средняя |
| C3 | **Frozen item arrived thawed/melted** | Высокий | Высокая |
| C4 | **Wrong item received** | Высокий | Средняя |
| C5 | **Refund request (general)** | Средний | Средняя |
| C6 | **A-to-Z Guarantee Claim** | 🔴 Критический | 🔴 Очень высокая |
| C7 | **Walmart Case Escalation** | 🔴 Критический | 🔴 Очень высокая |
| C8 | **Negative Review** | 🔴 Критический | Высокая |
| C9 | **Product quality complaint** | Средний | Средняя |
| C10 | **General question (pre-sale)** | Низкий | Низкая |

---

## 🧠 АЛГОРИТМ ОБРАБОТКИ

### Шаг 1: Извлечь данные из скриншота

Из скриншота AI извлекает:
- **Канал:** Amazon или Walmart
- **Магазин:** название аккаунта продавца (имя магазина в переписке)
- **Order ID:** номер заказа
- **Имя клиента:** для персонализации ответа
- **Товар:** название продукта
- **Тип товара:** Frozen / Dry — определять по правилам ниже
- **Суть жалобы:** текст ПОСЛЕДНЕГО сообщения клиента
- **Язык клиента:** English или Spanish
- **Дата заказа / доставки / Ship By:** если видно на скриншоте
- **EDD (обещанная дата доставки):** если видно
- **Фактическая дата доставки:** из трекинга если виден
- **Статус трекинга:** In Transit / Delayed / Delivered / Lost
- **Это повторное обращение?** — читать ВСЮ историю переписки на скриншоте

#### Правила определения типа товара (Frozen / Dry):

| Признак в названии | Тип |
|-------------------|-----|
| Ice Cream, Frozen, Beef (сырой), Fish (сырое), Shrimp, Meat, Sausage, Wings, Burgers, Waffles (Eggo) | **Frozen** |
| Beef Stock, Broth, Soup, Sauce, Canned, Crackers, Nuts, Dried, Powder, Supplement, Protein Bar | **Dry** |
| Jimmy Dean → Sausage = Frozen, Biscuit = Frozen |
| Walmart канал → **всегда Dry** (Frozen на Walmart запрещён) |
| Не удаётся определить → **Unknown**, написать в internalNotes |

#### Правила чтения истории переписки:

Если на скриншоте видна вся история сообщений — **читать её полностью**:
- Сколько раз клиент уже обращался? Если повторно → СРАЗУ предлагать решение
- Был ли уже ответ от магазина? Если "wait" → НЕ повторять
- Клиент просит конкретное решение? → Уважать просьбу
- Клиент нервничает? → Более извиняющийся тон

### Шаг 1.5: Анализ статуса доставки и carrier delay

Определить точный статус: A (в пути), B (delayed/stuck), C (delivered/INR), D (lost), E (never shipped).

### Шаг 1.6: Проверка необходимости заказа у поставщика (Supplier Reorder)

Когда action = REPLACEMENT → internalNotes ОБЯЗАТЕЛЬНО включает:
```
🛒 SUPPLIER REORDER NEEDED: заказать [товар] × [количество] у поставщика
для отправки замены клиенту [имя] по заказу [Order ID]
```

> ⚠️ Владимир — перекупщик, товара нет на складе. Без заказа у поставщика замену отправить невозможно.

---

## 🛒 SUPPLIER REORDER — ОБЯЗАТЕЛЬНОЕ ПРАВИЛО

| Ситуация | Supplier Reorder |
|----------|---------|
| action = "REPLACEMENT" | ✅ ОБЯЗАТЕЛЬНО |
| action = "REFUND" | ❌ Не нужно |
| action = "A2Z_GUARANTEE" | ❌ Не нужно |
| action = "PHOTO_REQUEST" | ❌ Не нужно |

---

## ⚡ ПРАВИЛА ПРИНЯТИЯ РЕШЕНИЙ

### Матрица: Тип проблемы × Тип товара × Канал

| Проблема | Frozen | Dry | Amazon | Walmart |
|----------|--------|-----|--------|---------|
| Thawed/melted | Replacement (приоритет) | N/A | Стандарт | N/A (нет frozen) |
| Damaged | Replacement или Refund | Replacement или Refund | Стандарт | Стандарт |
| Wrong item | Replacement | Replacement или Refund | Стандарт | Стандарт |
| Not received | Replacement или Refund | Replacement или Refund | Проверить tracking | Проверить tracking |
| A-to-Z | 🔴 Auto-refund | 🔴 Auto-refund | ESCALATE | N/A |
| Walmart escalation | N/A | 🔴 Resolve ASAP | N/A | ESCALATE |

### Общие правила:

1. **Всегда запрашивать фото** перед принятием решения
2. **Frozen товары не возвращать** (food safety)
3. **Одинаковое отношение** независимо от стоимости заказа
4. **Ответ в течение 24 часов** (идеально — в течение 12)
5. **A-to-Z и Walmart escalations** → немедленно уведомить Владимира
6. **Negative reviews** → ответить в течение 24 часов

---

## 📐 РАЗЛИЧИЯ МЕЖДУ КАНАЛАМИ

### Amazon:
- Ответы через **Buyer-Seller Messaging** (анонимизированный email)
- A-to-Z claims через **Claim Response** в Seller Central
- Reviews через **Contact Buyer** (но нельзя просить изменить/удалить)
- Лимит: **48 часов** на ответ (для Buy Shipping Protection)
- Все messages должны содержать **17-значный Order ID**
- Proactive messages — только в течение **30 дней** после заказа
- Запрещено: внешние ссылки, эмодзи, маркетинг, промо, просьбы о положительных отзывах, личные контакты

### Walmart:
- Ответы через **Seller Center → Inbox → Customer Messages**
- Cases через **Case Management**
- Лимит: **своевременный ответ** (влияет на Seller Response Rate)
- Автоответы **НЕ считаются** valid response
- Frozen товаров **НЕТ** на Walmart
- Запрещено: внешние ссылки, URL, соцсети, промо, реклама

---

*Версия: v1.4 — 2026-04-08*
*Для: Salutem Solutions Control Center*
*Модуль: Customer Service*

*Изменения v1.3 → v1.4:*
*- Статус B: добавлена логика "Carrier Self-Declared Delay" — если трекинг явно показывает "Delayed"*
*- При официальном "Delayed" статусе → автоматически фиксировать для carrier compensation*
*- internalNotes при Delayed: "сохранить скриншот для Buy Shipping Claims модуля"*

*Изменения v1.1 → v1.2 → v1.3:*
*- Добавлен раздел "Carrier Delay Detection"*
*- Исправлена механика Buy Shipping Protection (SAFE-T = FBA only, для FBM только A-to-Z)*
*- Добавлены шаблоны для DELAYED/Stuck (первое и повторное обращение)*
*- Добавлен Supplier Reorder Check — напоминание о заказе у поставщика при REPLACEMENT*
*- Добавлены правила чтения истории переписки*
*- Добавлены правила определения типа товара (Frozen/Dry)*
