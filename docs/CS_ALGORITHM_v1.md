# 💬 Customer Service Algorithm — Salutem Solutions
## Version 1.1 — 2026-04-05

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

### Veeqo Buy Shipping Protection — КЛЮЧЕВОЕ для Frozen

**Условия защиты (все три обязательны):**
1. ✅ Этикетка куплена через Veeqo (Amazon Buy Shipping)
2. ✅ Отправлено вовремя (по первому carrier scan, НЕ по confirm shipment)
3. ✅ Ответ на запрос покупателя в Buyer-Seller Messages в течение 48 часов

**Что даёт:**
- Amazon финансирует A-to-Z claim (не из кармана продавца)
- Claim НЕ считается против ODR (Order Defect Rate)
- OTDR (On-Time Delivery Rate) защищён от carrier delays
- 12x больше успешных Amazon-funded refunds по A-to-Z
- 10% больше успешных SAFE-T claim reimbursements

**SAFE-T Claims — новые сроки (с 16 февраля 2026):**
- Окно подачи: **30 дней** (было 60)
- Отсчёт: от скана возврата на складе ИЛИ даты refund (что позже)
- Для потерянных посылок: от последнего carrier scan
- Claims в процессе не затронуты

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
- **Магазин:** название аккаунта продавца
- **Order ID:** номер заказа
- **Имя клиента:** для персонализации ответа
- **Товар:** название продукта
- **Тип товара:** Frozen / Dry (по названию продукта или контексту)
- **Суть жалобы:** текст сообщения клиента
- **Язык клиента:** English или Spanish
- **Дата заказа / доставки:** если видно на скриншоте

### Шаг 2: Классифицировать проблему → Категория (C1–C10)

### Шаг 3: Применить алгоритм для категории (см. ниже)

### Шаг 4: Сгенерировать ответ на языке клиента

### Шаг 5: Вывести:
- Готовый текст ответа (copy-paste)
- Рекомендуемое действие (refund / replacement / escalate to Vladimir)
- Уровень срочности

---

## 📖 АЛГОРИТМЫ ПО КАТЕГОРИЯМ

---

### C1: WHERE IS MY ORDER / TRACKING

**Триггеры:** "where is my order", "tracking", "haven't received", "when will it arrive", "shipping update", "no me ha llegado"

**Алгоритм:**
```
1. Извлечь Order ID из скриншота
2. Определить статус:
   a) Заказ ещё в пути (в рамках EDD) → Ответ: REASSURE
   b) Заказ задерживается (после EDD) → Ответ: APOLOGIZE + предложить REPLACEMENT или REFUND
   c) Tracking показывает "Delivered" но клиент не получил → Ответ: INVESTIGATE
```

**Шаблон ответа (REASSURE) — English:**
```
Dear [Customer Name],

Thank you for reaching out! I checked your order [Order ID] and it is currently in transit. Based on the tracking information, your package is expected to arrive by [EDD].

Please allow until that date for delivery. If you haven't received it by then, please don't hesitate to contact us and we'll make it right.

Best regards,
[Store Name]
```

**Шаблон ответа (REASSURE) — Spanish:**
```
Estimado/a [Customer Name],

¡Gracias por comunicarse con nosotros! Revisé su pedido [Order ID] y actualmente está en tránsito. Según la información de seguimiento, su paquete debería llegar antes del [EDD].

Por favor espere hasta esa fecha para la entrega. Si no lo ha recibido para entonces, no dude en contactarnos y lo resolveremos.

Saludos cordiales,
[Store Name]
```

**Шаблон (APOLOGIZE + решение) — English:**
```
Dear [Customer Name],

I sincerely apologize for the delay with your order [Order ID]. I understand how frustrating this must be.

I'd like to make this right for you. I can offer you either:
1. A full replacement shipped immediately
2. A full refund

Please let me know which option you'd prefer, and I'll process it right away.

Best regards,
[Store Name]
```

**Шаблон (INVESTIGATE — delivered but not received) — English:**
```
Dear [Customer Name],

I'm sorry to hear you haven't received your order [Order ID], even though tracking shows it as delivered. I understand how concerning this is.

Could you please:
1. Check with household members or neighbors who may have accepted the package
2. Look around your delivery area (porch, mailbox, garage)

If you're still unable to locate it, please let me know and I'll arrange a replacement or refund immediately.

Best regards,
[Store Name]
```

---

### C2: ITEM ARRIVED DAMAGED

**Триггеры:** "damaged", "broken", "crushed", "dented", "opened", "ripped", "dañado", "roto"

**Алгоритм:**
```
1. ВСЕГДА запросить фото повреждения
2. После получения фото:
   a) Товар Dry → предложить REPLACEMENT или REFUND (на выбор клиента)
   b) Товар Frozen → см. C3
3. Клиенту НЕ нужно возвращать повреждённый товар
```

**Шаблон (запрос фото) — English:**
```
Dear [Customer Name],

I'm very sorry to hear that your order arrived damaged. That's definitely not the experience we want for our customers.

To help resolve this as quickly as possible, could you please send a photo of the damaged item? This will allow me to process your claim right away.

Thank you for your patience, and I apologize again for the inconvenience.

Best regards,
[Store Name]
```

**Шаблон (запрос фото) — Spanish:**
```
Estimado/a [Customer Name],

Lamento mucho saber que su pedido llegó dañado. Definitivamente no es la experiencia que deseamos para nuestros clientes.

Para ayudar a resolver esto lo más rápido posible, ¿podría enviar una foto del artículo dañado? Esto me permitirá procesar su reclamo de inmediato.

Gracias por su paciencia y disculpe nuevamente las molestias.

Saludos cordiales,
[Store Name]
```

**Шаблон (после фото — решение) — English:**
```
Dear [Customer Name],

Thank you for sending the photo. I can clearly see the damage, and I sincerely apologize for this.

I'd like to make this right. I can offer you:
1. A full replacement shipped right away — no need to return the damaged item
2. A full refund

Please let me know which you'd prefer, and I'll take care of it immediately.

Best regards,
[Store Name]
```

---

### C3: FROZEN ITEM ARRIVED THAWED / MELTED

**Триггеры:** "thawed", "melted", "not frozen", "warm", "defrosted", "room temperature", "derretido", "descongelado"

**Алгоритм:**
```
1. ВСЕГДА запросить фото (товар + упаковка)
2. После фото → определить ПРИЧИНУ:

   ── ВЕТКА A: ВИНА ПЕРЕВОЗЧИКА (Buy Shipping Protection) ──
   Условия (хотя бы одно):
   • Куплен быстрый сервис (Express/2Day/Ground), а доставка заняла 
     значительно дольше обещанного EDD
   • Tracking показывает "carrier delay", "in transit" дольше нормы
   • EDD из скриншота/данных ≤ 3 дня, но фактическая доставка > 3 дней
   
   Действие:
   → Клиенту: вежливо объяснить что мы отправили вовремя быстрым сервисом,
     задержка произошла по вине перевозчика
   → Направить клиента подать запрос через Amazon (A-to-Z Guarantee)
   → Amazon покроет refund (Buy Shipping Protection)
   → НЕ считается против нашего ODR
   → Параллельно: рассмотреть SAFE-T claim (в течение 30 дней!)
   
   ── ВЕТКА B: НАША ОТВЕТСТВЕННОСТЬ ──
   Условия:
   • Доставка была в рамках EDD, но товар всё равно thawed
   • Возможно проблема упаковки или неправильный сервис выбран
   
   Действие:
   → Предложить REPLACEMENT (приоритет) или REFUND
   → Replacement за наш счёт
   
3. НЕ просить вернуть товар (food safety)
4. Это ВЫСОКИЙ ПРИОРИТЕТ — ответить как можно быстрее
5. Тон: максимально извиняющийся, понимающий
6. ОБЯЗАТЕЛЬНО ответить в Buyer-Seller Messages в течение 48 часов 
   (иначе теряем Buy Shipping Protection!)
```

> ⚠️ **ВАЖНО:** Frozen — самая чувствительная категория. Тухлая еда = потенциальный health risk. Решать БЫСТРО.
> ⚠️ **КРИТИЧНО:** Даже если вина перевозчика — ответить покупателю в течение 48 часов! Иначе Buy Shipping Protection не работает.

**Шаблон (запрос фото) — English:**
```
Dear [Customer Name],

I'm so sorry to hear that your frozen item arrived thawed. I completely understand your frustration — this is absolutely unacceptable and I take this very seriously.

Could you please send a photo of the item and the packaging? I want to resolve this for you as quickly as possible.

Please do NOT consume the product if it arrived thawed, as food safety is our top priority.

Best regards,
[Store Name]
```

**Шаблон (запрос фото) — Spanish:**
```
Estimado/a [Customer Name],

Lamento mucho saber que su producto congelado llegó descongelado. Entiendo completamente su frustración — esto es absolutamente inaceptable y lo tomo muy en serio.

¿Podría enviar una foto del artículo y del empaque? Quiero resolver esto lo más rápido posible.

Por favor NO consuma el producto si llegó descongelado, ya que la seguridad alimentaria es nuestra máxima prioridad.

Saludos cordiales,
[Store Name]
```

**Шаблон (ВЕТКА A — вина перевозчика) — English:**
```
Dear [Customer Name],

Thank you for the photo. I'm truly sorry about this experience.

After reviewing your order, I can confirm that we shipped your package on [Ship Date] using [Service Name], which should have delivered within [X] days. Unfortunately, the carrier experienced a significant delay that was beyond our control — the actual delivery took [Y] days.

Since this order was shipped through Amazon's Buy Shipping program, you are fully covered under Amazon's A-to-Z Guarantee. I recommend filing a claim directly with Amazon, and they will issue you a full refund.

To do this, please go to Your Orders → find order [Order ID] → click "Problem with order" → select "Package arrived damaged/defective" → request a refund.

Please do NOT consume the thawed product. I sincerely apologize for this inconvenience — we did everything in our power to ensure timely delivery.

Best regards,
[Store Name]
```

**Шаблон (ВЕТКА A — вина перевозчика) — Spanish:**
```
Estimado/a [Customer Name],

Gracias por la foto. Lamento mucho esta experiencia.

Después de revisar su pedido, puedo confirmar que enviamos su paquete el [Ship Date] utilizando [Service Name], que debería haberse entregado en [X] días. Desafortunadamente, el transportista experimentó un retraso significativo que estuvo fuera de nuestro control — la entrega real tomó [Y] días.

Dado que este pedido fue enviado a través del programa Buy Shipping de Amazon, usted está completamente cubierto por la Garantía A-to-Z de Amazon. Le recomiendo presentar un reclamo directamente con Amazon, y ellos le emitirán un reembolso completo.

Para hacerlo, vaya a Sus Pedidos → busque el pedido [Order ID] → haga clic en "Problema con el pedido" → seleccione "El paquete llegó dañado/defectuoso" → solicite un reembolso.

Por favor NO consuma el producto descongelado. Me disculpo sinceramente por este inconveniente — hicimos todo lo posible para garantizar una entrega oportuna.

Saludos cordiales,
[Store Name]
```

**Шаблон (ВЕТКА B — наша ответственность, replacement) — English:**
```
Dear [Customer Name],

Thank you for the photo. I'm truly sorry this happened. Your satisfaction and safety are our top priorities.

I'm arranging a replacement to be shipped to you right away. You do NOT need to return the thawed item — please dispose of it safely.

You should receive your replacement within [X] business days. I'll send you the tracking information as soon as it ships.

Again, I sincerely apologize for this experience.

Best regards,
[Store Name]
```

**Шаблон (ВЕТКА B — наша ответственность, replacement) — Spanish:**
```
Estimado/a [Customer Name],

Gracias por la foto. Lamento mucho que esto haya sucedido. Su satisfacción y seguridad son nuestras máximas prioridades.

Estoy organizando el envío de un reemplazo de inmediato. NO necesita devolver el producto descongelado — por favor deséchelo de manera segura.

Debería recibir su reemplazo dentro de [X] días hábiles. Le enviaré la información de seguimiento tan pronto como se envíe.

Nuevamente, me disculpo sinceramente por esta experiencia.

Saludos cordiales,
[Store Name]
```

> **ВНУТРЕННЕЕ ДЕЙСТВИЕ (не для клиента):**
> - Ветка A: Подготовить данные для SAFE-T claim (Order ID, tracking, EDD, actual delivery date)
> - Ветка A: Подать SAFE-T claim в течение 30 дней
> - Ветка B: Проверить — повторяется ли проблема с этим SKU? Если да → уведомить Владимира о проблеме с упаковкой

---

### C4: WRONG ITEM RECEIVED

**Триггеры:** "wrong item", "different product", "not what I ordered", "incorrect item", "artículo equivocado"

**Алгоритм:**
```
1. ВСЕГДА запросить фото (того что получили + название того что заказывали)
2. После фото:
   a) Подтвердить ошибку → REPLACEMENT правильного товара
   b) Если товар Frozen и пришёл неправильный → REPLACEMENT + не возвращать
   c) Если товар Dry → предложить REPLACEMENT, возврат не обязателен
```

**Шаблон (запрос фото) — English:**
```
Dear [Customer Name],

I'm sorry to hear you received the wrong item. I understand how disappointing that must be.

Could you please send a photo of the item you received? This will help me identify the issue and get the correct product to you as quickly as possible.

Best regards,
[Store Name]
```

**Шаблон (после фото — решение) — English:**
```
Dear [Customer Name],

Thank you for the photo. I can confirm this is not what you ordered, and I sincerely apologize for the mix-up.

I'm sending the correct item to you right away. You do not need to return the incorrect product.

Your replacement should arrive within [X] business days. I'll provide tracking information once it ships.

Best regards,
[Store Name]
```

---

### C5: REFUND REQUEST (GENERAL)

**Триггеры:** "refund", "money back", "return", "reembolso", "devolución"

**Алгоритм:**
```
1. ВСЕГДА запросить фото и причину
2. Определить причину:
   a) Повреждённый → см. C2
   b) Frozen/thawed → см. C3
   c) Неправильный товар → см. C4
   d) Просто не понравился → стандартный Amazon/Walmart return process
   e) Не получил → см. C1
3. После фото → предложить REFUND или REPLACEMENT
```

**Шаблон (уточнение причины) — English:**
```
Dear [Customer Name],

I'm sorry to hear you'd like a refund for your order [Order ID]. I'd be happy to help.

Could you please let me know the reason for the refund request and, if applicable, send a photo of the item? This will help me process your request as quickly as possible.

Best regards,
[Store Name]
```

---

### C6: AMAZON A-TO-Z GUARANTEE CLAIM 🔴

**Триггеры:** "A-to-Z", "guarantee claim", скриншот с A-to-Z claim page

**Алгоритм:**
```
⚠️ КРИТИЧЕСКАЯ СИТУАЦИЯ — влияет на Account Health

1. НЕМЕДЛЕННО уведомить Владимира (Telegram)
2. Определить причину claim:
   a) INR (Item Not Received) → проверить tracking
   b) SNAD (Significantly Not As Described) → проверить что отправляли
   c) Defective → проверить историю жалоб на этот SKU
3. Подготовить ответ для Amazon (не клиенту, а в claim)
4. Предложить refund клиенту ПАРАЛЛЕЛЬНО с ответом на claim
5. ДЕДЛАЙН: ответить в течение 48 часов (лучше за 24)
```

> 🔴 **A-to-Z claims напрямую влияют на ODR (Order Defect Rate).** Если ODR > 1%, Amazon может заблокировать аккаунт.

**Шаблон (ответ клиенту — параллельно с claim) — English:**
```
Dear [Customer Name],

I see that you've filed a claim regarding your order [Order ID]. I sincerely apologize for the experience that led to this.

I want to resolve this for you immediately. I am processing a full refund for your order right now. You should see it reflected in your account within 3-5 business days.

There is no need to return the item. I hope this resolves the matter to your satisfaction.

Best regards,
[Store Name]
```

**Шаблон (ответ в A-to-Z claim — для Amazon) — English:**
```
We have contacted the customer directly and issued a full refund of $[amount] on [date]. 

[If INR]: Tracking number [tracking] shows the package was [status]. We have issued a full refund regardless to ensure customer satisfaction.

[If SNAD]: We apologize for the issue. We have refunded the customer in full and they do not need to return the item.

We take customer satisfaction seriously and have addressed this issue to prevent recurrence.
```

**Действие:** → 🔴 ESCALATE to Vladimir + auto-refund

---

### C7: WALMART CASE ESCALATION 🔴

**Триггеры:** Walmart case page screenshot, "case escalated", "Walmart support"

**Алгоритм:**
```
⚠️ КРИТИЧЕСКАЯ СИТУАЦИЯ — влияет на Seller Scorecard

1. НЕМЕДЛЕННО уведомить Владимира
2. Определить тип case
3. Подготовить ответ
4. ДЕДЛАЙН: ответить в течение 24 часов
```

> 🔴 **Walmart отслеживает Response Rate и On-Time Shipment Rate.** Низкие показатели → потеря Buy Box или suspension.

**Шаблон (ответ на Walmart case) — English:**
```
Dear [Customer Name],

Thank you for bringing this to our attention. I sincerely apologize for the inconvenience.

I have reviewed your order [Order ID] and I'm processing a [refund/replacement] for you immediately. 

[If refund]: Your refund will be processed within 3-5 business days.
[If replacement]: Your replacement will ship within 1-2 business days.

Please don't hesitate to reach out if you need anything else.

Best regards,
[Store Name]
```

**Действие:** → 🔴 ESCALATE to Vladimir + resolve ASAP

---

### C8: NEGATIVE REVIEW 🔴

**Триггеры:** скриншот с отзывом, "review", "stars", "feedback"

**Алгоритм:**
```
⚠️ ВАЖНО — влияет на рейтинг товара и продажи

1. Определить платформу:
   a) Amazon → ответить через Seller Central (Contact Buyer)
   b) Walmart → ответить через Seller Center
2. НЕ просить удалить отзыв (нарушение политики)
3. НЕ предлагать компенсацию за удаление (нарушение политики)  
4. Предложить решение проблемы
5. Тон: максимально профессиональный, без оправданий
```

> ⚠️ **Amazon запрещает:** просить клиента изменить/удалить отзыв, предлагать деньги за изменение, угрожать клиенту.

**Шаблон (ответ на негативный отзыв через Contact Buyer) — English:**
```
Dear [Customer Name],

Thank you for your feedback regarding [Product Name]. I'm sorry to hear about your experience, and I take your concerns very seriously.

I'd like to make this right. I can offer you a full replacement or refund — whichever you prefer. Please let me know and I'll process it immediately.

Your satisfaction is very important to us, and we appreciate the opportunity to resolve this.

Best regards,
[Store Name]
```

**Действие:** → 🔴 NOTIFY Vladimir + respond within 24h

---

### C9: PRODUCT QUALITY COMPLAINT

**Триггеры:** "quality", "taste", "doesn't work", "not as described", "calidad"

**Алгоритм:**
```
1. Запросить фото
2. Определить:
   a) Реальный дефект → REPLACEMENT или REFUND
   b) Субъективное (не понравился вкус) → REFUND + вежливый ответ
3. Если повторная жалоба на тот же SKU → уведомить Владимира (проблема с партией?)
```

**Шаблон — English:**
```
Dear [Customer Name],

I'm sorry to hear the product didn't meet your expectations. Your feedback is very valuable to us.

Could you please share a photo and describe the issue in more detail? I want to make sure we address this properly and improve our products.

I'll have a resolution for you as soon as I review the details.

Best regards,
[Store Name]
```

---

### C10: GENERAL QUESTION (PRE-SALE)

**Триггеры:** "is this product...", "does it contain...", "ingredients", "allergens", "how many", "shelf life"

**Алгоритм:**
```
1. Ответить на вопрос (по данным листинга)
2. Если не знаешь ответ → вежливо сказать что уточнишь
3. Тон: дружелюбный, информативный
```

**Шаблон — English:**
```
Dear [Customer Name],

Thank you for your interest in [Product Name]! 

[Answer to the specific question]

If you have any other questions, please don't hesitate to ask. We're happy to help!

Best regards,
[Store Name]
```

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

## 🔧 КАК РАБОТАЕТ МОДУЛЬ В CONTROL CENTER

### Интерфейс:

```
┌──────────────────────────────────────────────┐
│  📸 Upload Screenshot                         │
│  [Drag & drop or click to upload]            │
│                                               │
│  ─────────────────────────────────────────── │
│                                               │
│  📊 Analysis Results:                         │
│  Channel: Amazon                              │
│  Store: [detected]                            │
│  Order ID: 123-456-789                        │
│  Customer: John Smith                         │
│  Product: Jimmy Dean Sausage 12ct             │
│  Type: Frozen                                 │
│  Category: C3 — Frozen arrived thawed         │
│  Language: English                            │
│  Priority: 🔴 HIGH                           │
│                                               │
│  ─────────────────────────────────────────── │
│                                               │
│  💬 Recommended Response:                     │
│  ┌─────────────────────────────────────────┐ │
│  │ Dear John,                               │ │
│  │                                          │ │
│  │ I'm so sorry to hear that your frozen   │ │
│  │ item arrived thawed...                   │ │
│  │                                          │ │
│  │ Best regards,                            │ │
│  │ [Store Name]                             │ │
│  └─────────────────────────────────────────┘ │
│  [📋 Copy to Clipboard]  [✏️ Edit]          │
│                                               │
│  🎯 Recommended Action: REPLACEMENT          │
│  ⏰ Urgency: Respond within 12 hours         │
│                                               │
└──────────────────────────────────────────────┘
```

### Workflow:
1. Владимир загружает скриншот кейса
2. AI (Claude) анализирует скриншот → извлекает данные
3. Система классифицирует проблему (C1–C10)
4. Генерируется ответ по шаблону + подставляются данные
5. Владимир копирует ответ → вставляет в Seller Central / Walmart
6. Если 🔴 критический — push-уведомление в Telegram

---

## 📐 РАЗЛИЧИЯ МЕЖДУ КАНАЛАМИ

### Amazon:
- Ответы через **Buyer-Seller Messaging** (анонимизированный email)
- A-to-Z claims через **Claim Response** в Seller Central
- Reviews через **Contact Buyer** (но нельзя просить изменить/удалить)
- Лимит: **48 часов** на ответ (для Buy Shipping Protection)
- Все messages должны содержать **17-значный Order ID**
- Proactive messages — только в течение **30 дней** после заказа
- Amazon хранит ВСЕ сообщения навсегда (нельзя удалить)
- Запрещено: внешние ссылки (кроме https для заказа), эмодзи, маркетинг, промо, просьбы о положительных отзывах, личные контакты
- Не отправлять: подтверждения заказа/доставки (Amazon делает сам), "thank you" без привязки к заказу

### Walmart:
- Ответы через **Seller Center → Inbox → Customer Messages**
- Cases через **Case Management**
- Лимит: **своевременный ответ** (влияет на Seller Response Rate)
- Автоответы **НЕ считаются** valid response
- Можно использовать шаблоны, но нужен личный ответ
- Вложения: до 5 шт., каждое ≤ 5 MB
- Frozen товаров **НЕТ** на Walmart
- Запрещено: внешние ссылки, URL, соцсети, промо, реклама
- Нельзя предлагать альтернативу возврату (если не настроен Partial Keep It Rules)
- Обязательна: toll-free телефонная поддержка на English

---

## 🚀 БУДУЩИЕ УЛУЧШЕНИЯ (v2+)

1. **Интеграция с ChannelReply + Freshdesk** → автоматическое получение кейсов без скриншотов
2. **Auto-response** → для простых кейсов (C1, C10) отправлять ответ автоматически
3. **Repeat offender detection** → отслеживать клиентов с множеством жалоб
4. **SKU health tracking** → если на один SKU > 3 жалоб в месяц → alert
5. **Response analytics** → какие ответы приводят к лучшим результатам

---

*Версия: v1.1 — 2026-04-05*
*Для: Salutem Solutions Control Center*
*Модуль: Customer Service*
*Изменения v1.0 → v1.1:*
*- Добавлен раздел "Политики маркетплейсов" (Amazon Communication Guidelines, Walmart Customer Care Policy)*
*- C3 разделён на ветку A (вина перевозчика → Buy Shipping Protection / A-to-Z) и ветку B (наша ответственность → replacement)*
*- Добавлена информация о Veeqo Buy Shipping Protection и условиях защиты*
*- Обновлены сроки SAFE-T claims (30 дней с 16 февраля 2026)*
*- Добавлены шаблоны ответов на Spanish для ветки A*
*- Расширен раздел "Различия между каналами" с полными правилами*
