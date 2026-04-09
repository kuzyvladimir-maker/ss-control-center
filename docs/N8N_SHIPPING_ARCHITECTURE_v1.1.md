# 📦 Shipping Label Automation — n8n Architecture
## На основе MASTER PROMPT v3.1

---

## 🏗️ ОБЗОР АРХИТЕКТУРЫ

Система состоит из **3 workflow**, работающих вместе:

| # | Workflow | Триггер | Задача |
|---|----------|---------|--------|
| 1 | **Order Analyzer** | Schedule (2 раза/день) | Собрать заказы → проанализировать → создать план |
| 2 | **Label Purchaser** | Webhook (команда "покупай") | Купить этикетки по плану |
| 3 | **Weekend Distributor** | Schedule (пт вечер + сб/вс) | Распределить frozen заказы на Пн/Вт |

---

## WORKFLOW 1: ORDER ANALYZER
*"Сбор и анализ заказов"*

### Схема нодов:

```
[Schedule Trigger]
    ↓
[Set Timezone] ← Code: определить "сегодня" по America/New_York
    ↓
[Fetch Orders Page 1] ← HTTP: GET /orders?status=awaiting_fulfillment&page_size=100&page=1
    ↓
[Loop Pages] ← Loop: page=2,3,4... пока response не пустой
    ↓
[Merge All Orders] ← Merge: объединить все страницы
    ↓
[Filter: Has "Placed" Tag] ← IF: order.tags contains "Placed"
    ↓
[Filter: Ship By = Today] ← Code: dispatch_date → UTC-7, сравнить с "сегодня" (NY)
    ↓
[Filter: Amazon or Walmart] ← Switch: channel_name
    ↓
[Filter: Walmart Weekend] ← Code: Walmart + weekend → пропустить (v3.1)
    ↓
[Split Items] ← SplitInBatches: по одному заказу
    ↓
[Get Product Tags] ← HTTP: GET /products/{product_id} → tags
    ↓
[Classify Frozen/Dry] ← Code: определить тип (логика ниже)
    ↓
[Check Mixed Order] ← Code: если Frozen+Dry в одном → stop
    ↓
[Lookup SKU Weight] ← Google Sheets: поиск по SKU в Database v2
    ↓
[Fallback: History] ← IF: не найден → поиск в истории Veeqo
    ↓
[Get Rates] ← HTTP: GET /shipping/rates/{allocation_id}
    ↓
[Select Best Rate] ← Code: логика выбора (см. ниже)
    ↓
[Check Budget] ← Code: проверка бюджета
    ↓
[Build Plan Row] ← Set: сформировать строку для таблицы
    ↓
[Write to Google Sheets] ← Google Sheets: записать план
    ↓
[Send Telegram] ← Telegram: уведомление со ссылкой
```

---

### ДЕТАЛИ КАЖДОГО НОДА:

---

#### 1. Schedule Trigger
```json
{
  "type": "n8n-nodes-base.scheduleTrigger",
  "parameters": {
    "rule": {
      "interval": [
        {
          "triggerAtHour": 9,
          "triggerAtMinute": 0
        },
        {
          "triggerAtHour": 14,
          "triggerAtMinute": 0
        }
      ]
    }
  },
  "notes": "Запуск в 9:00 AM и 2:00 PM ET (будни). Второй прогон = контрольный."
}
```

---

#### 2. Set Timezone (Code Node)
```javascript
// Определить "сегодня" по America/New_York
const now = new Date();
const nyDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));

const today = nyDate.toISOString().split('T')[0]; // YYYY-MM-DD
const dayOfWeek = nyDate.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
const hour = nyDate.getHours();

// Определить фактический день отгрузки
let actualShipDay = today;
if (dayOfWeek === 0) { // Sunday → Monday
  actualShipDay = addDays(today, 1);
} else if (dayOfWeek === 6) { // Saturday → Monday
  actualShipDay = addDays(today, 2);
}

const isAfterNoon = hour >= 12;
const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

return [{
  json: {
    today,
    dayOfWeek,
    dayName: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dayOfWeek],
    actualShipDay,
    isAfterNoon,
    isWeekend,
    hour
  }
}];

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}
```

---

#### 3. Fetch Orders (HTTP Request Node)
```json
{
  "type": "n8n-nodes-base.httpRequest",
  "parameters": {
    "method": "GET",
    "url": "https://api.veeqo.com/orders",
    "queryParameters": {
      "status": "awaiting_fulfillment",
      "page_size": "100",
      "page": "={{ $json.currentPage || 1 }}"
    },
    "headerParameters": {
      "x-api-key": "Vqt/5554f1df2e6b934f5e6e90d2f3dde79e"
    },
    "options": {
      "response": { "fullResponse": false }
    }
  }
}
```

---

#### 4. Pagination Loop (Loop Node)
```
Используем n8n Loop Over Items или рекурсивный sub-workflow:
- page = 1 → если response.length > 0 → page++ → повторить
- page = N → если response.length === 0 → стоп
- Merge все результаты
```

---

#### 5. Filter: Has "Placed" Tag (IF Node)
```json
{
  "type": "n8n-nodes-base.if",
  "parameters": {
    "conditions": {
      "string": [{
        "value1": "={{ JSON.stringify($json.tags) }}",
        "operation": "contains",
        "value2": "Placed"
      }]
    }
  },
  "notes": "Без тега Placed → пропустить молча. Товара физически нет."
}
```

---

#### 6. Filter: Ship By = Today (Code Node)
```javascript
// Конвертировать dispatch_date из UTC в UTC-7
const dispatchUtc = new Date($json.dispatch_date);
const dispatchPacific = new Date(dispatchUtc.getTime() - 7 * 60 * 60 * 1000);
const shipByDate = dispatchPacific.toISOString().split('T')[0];

// due_date → Delivery By (дедлайн)
const dueUtc = new Date($json.due_date);
const duePacific = new Date(dueUtc.getTime() - 7 * 60 * 60 * 1000);
const deliveryBy = duePacific.toISOString().split('T')[0];

const today = $('Set Timezone').first().json.today;

if (shipByDate !== today) {
  return []; // Пропустить — не сегодня
}

return [{
  json: {
    ...$json,
    shipByDate,
    deliveryBy,
    shipByConverted: shipByDate,
    deliveryByConverted: deliveryBy
  }
}];
```

---

#### 7. Filter: Amazon or Walmart (Switch Node)
```json
{
  "type": "n8n-nodes-base.switch",
  "parameters": {
    "dataType": "string",
    "value1": "={{ $json.channel?.name || $json.channel }}",
    "rules": [
      { "value2": "Amazon", "output": 0 },
      { "value2": "Walmart", "output": 0 }
    ],
    "fallbackOutput": 1
  },
  "notes": "Output 0 = обрабатываем. Output 1 (fallback) = пропускаем."
}
```

---

#### 8. Get Product Tags (HTTP Request)
```javascript
// Для каждого line_item получить теги продукта
const productId = $json.line_items[0].sellable.product.id;

// HTTP Request:
// GET https://api.veeqo.com/products/{productId}
// Header: x-api-key: ...
// Из response берём: response.tags
```

---

#### 8.5 Filter: Walmart + Weekend (Code Node) — NEW in v3.1
```javascript
const channel = $json.channel?.name || '';
const isWeekend = $('Set Timezone').first().json.isWeekend;

// Walmart в weekend → НЕ ПОКУПАТЬ
// Причина: Veeqo сразу шлёт Mark as Shipped → ломает статистику
if (channel.toLowerCase().includes('walmart') && isWeekend) {
  return []; // Пропустить — купим в рабочий день
}

return [$input.item];
```

---

#### 9. Classify Frozen/Dry (Code Node) — КЛЮЧЕВАЯ ЛОГИКА
```javascript
const channel = $json.channel?.name || '';
const productTags = $json.productTags || [];
const lineItems = $json.line_items || [];

// ПРАВИЛО 1: Walmart = всегда Dry (frozen на Walmart ЗАПРЕЩЁН)
if (channel.toLowerCase().includes('walmart')) {
  // Проверить: нет ли ошибочного тега Frozen на Walmart
  const hasFrozenTag = productTags.some(t => t.toLowerCase().includes('frozen'));
  if (hasFrozenTag) {
    return [{
      json: {
        ...$json,
        productType: 'ERROR',
        stopReason: '⚠️ Ошибка: обнаружен тег Frozen на Walmart-заказе. Сообщить Владимиру.',
        action: 'STOP'
      }
    }];
  }
  return [{ json: { ...$json, productType: 'Dry', classificationSource: 'Walmart=Dry (frozen запрещён)' } }];
}

// ПРАВИЛО 2: Amazon — по тегу
let types = [];
for (const item of lineItems) {
  const tags = item._productTags || productTags;
  if (tags.some(t => t.toLowerCase().includes('frozen'))) {
    types.push('Frozen');
  } else if (tags.some(t => t.toLowerCase().includes('dry'))) {
    types.push('Dry');
  } else {
    // Нет тега → СТОП
    return [{
      json: {
        ...$json,
        productType: 'UNKNOWN',
        stopReason: '⚠️ Нужна информация: не проставлен тег Frozen/Dry',
        action: 'STOP'
      }
    }];
  }
}

// ПРАВИЛО 3: Mixed order → СТОП
const uniqueTypes = [...new Set(types)];
if (uniqueTypes.length > 1) {
  return [{
    json: {
      ...$json,
      productType: 'MIXED',
      stopReason: '⚠️ Mixed order: Frozen и Dry в одном заказе',
      action: 'STOP'
    }
  }];
}

return [{
  json: {
    ...$json,
    productType: uniqueTypes[0],
    classificationSource: 'Veeqo tag'
  }
}];
```

---

#### 10. Lookup SKU Weight (Google Sheets Node)
```json
{
  "type": "n8n-nodes-base.googleSheets",
  "parameters": {
    "operation": "lookup",
    "documentId": "1H-bx0iZ_oL0i0CFbHN_QbfXzkGJC_f_hV90s-V6cqzY",
    "sheetName": "Sheet1",
    "lookupColumn": "A",
    "lookupValue": "={{ $json.line_items[0].sellable.sku }}",
    "returnAllMatches": false
  },
  "notes": "ЕДИНСТВЕННЫЙ источник веса. Колонка H = Weight (UPS/USPS), K = Weight FedEx One Rate (H × 1.25). Никаких формул расчёта ice weight — всё уже учтено в таблице."
}
```

> ⚠️ **v3.1:** Формулы расчёта веса (ice_weight = product_weight × 0.8) УБРАНЫ. Таблица SKU Database v2 содержит финальные веса включая лёд.

**Если SKU нет в таблице → Fallback: History Veeqo**
Поиск в прошлых shipments с нотой `✅ Label Purchased`.

**Если нет ни в таблице, ни в истории:**
```javascript
// Employee note с конкретным SKU
const sku = $json.line_items[0].sellable.sku;
return [{
  json: {
    ...$json,
    action: 'STOP',
    stopReason: `⚠️ Нужна информация: нет данных по SKU ${sku}. Владимир, внеси данные в таблицу SKU Database v2.`
  }
}];
```

---

#### 11. Select Best Rate (Code Node) — САМАЯ СЛОЖНАЯ ЛОГИКА
```javascript
const rates = $json.availableRates; // из GET /shipping/rates/
const productType = $json.productType; // 'Frozen' или 'Dry'
const deliveryBy = new Date($json.deliveryByConverted);
const actualShipDay = new Date($('Set Timezone').first().json.actualShipDay);
const dayName = $('Set Timezone').first().json.dayName;
const isAfterNoon = $('Set Timezone').first().json.isAfterNoon;

// Фильтр: конвертировать EDD в UTC-7
let validRates = rates.map(rate => {
  const eddUtc = new Date(rate.delivery_promise_date);
  const eddPacific = new Date(eddUtc.getTime() - 7 * 60 * 60 * 1000);
  const edd = eddPacific.toISOString().split('T')[0];
  const eddDate = new Date(edd);

  // Календарные дни от факт. отгрузки до EDD
  const calDays = Math.round((eddDate - actualShipDay) / (1000 * 60 * 60 * 24));

  return {
    ...rate,
    eddConverted: edd,
    eddDate,
    calendarDays: calDays,
    meetsDeadline: eddDate <= deliveryBy
  };
});

// === DRY ===
if (productType === 'Dry') {
  // Фильтр: EDD ≤ Delivery By
  let dryRates = validRates.filter(r => r.meetsDeadline);

  // После 12:00 ET → убрать USPS если есть альтернативы
  if (isAfterNoon) {
    const nonUsps = dryRates.filter(r =>
      !r.carrier_name?.toLowerCase().includes('usps')
    );
    if (nonUsps.length > 0) dryRates = nonUsps;
  }

  if (dryRates.length === 0) {
    return [{ json: { ...$json, action: 'STOP', stopReason: '⚠️ Нет сервиса до дедлайна' } }];
  }

  // Сортировка по цене
  dryRates.sort((a, b) => parseFloat(a.total_net_charge) - parseFloat(b.total_net_charge));

  // Правило ≤10%: если UPS на ≤10% дороже чем самый дешёвый → выбрать UPS
  const cheapest = dryRates[0];
  const cheapestPrice = parseFloat(cheapest.total_net_charge);

  for (const rate of dryRates) {
    const price = parseFloat(rate.total_net_charge);
    const diff = (price - cheapestPrice) / cheapestPrice;
    if (diff <= 0.10 && rate.carrier_name?.toLowerCase().includes('ups')) {
      return [{ json: { ...$json, selectedRate: rate, action: 'BUY' } }];
    }
  }

  // Правило ≤$0.50: при близкой цене → более ранний EDD
  const within50cents = dryRates.filter(r =>
    parseFloat(r.total_net_charge) - cheapestPrice <= 0.50
  );
  if (within50cents.length > 1) {
    within50cents.sort((a, b) => a.eddDate - b.eddDate);
    return [{ json: { ...$json, selectedRate: within50cents[0], action: 'BUY' } }];
  }

  return [{ json: { ...$json, selectedRate: cheapest, action: 'BUY' } }];
}

// === FROZEN ===
if (productType === 'Frozen') {

  // Фильтр: ОБА условия
  let frozenRates = validRates.filter(r =>
    r.calendarDays <= 3 && r.meetsDeadline
  );

  // Среда: ground = 5 кал. дней → убрать ground
  if (dayName === 'Wed') {
    const expressOnly = frozenRates.filter(r =>
      !r.service_name?.toLowerCase().includes('ground')
    );
    if (expressOnly.length > 0) frozenRates = expressOnly;
  }

  // Пятница: убрать FedEx Express
  if (dayName === 'Fri') {
    frozenRates = frozenRates.filter(r =>
      !(r.carrier_name?.toLowerCase().includes('fedex') &&
        r.service_name?.toLowerCase().includes('express'))
    );
  }

  if (frozenRates.length === 0) {
    // Четверг/Пятница: нет ставок → нужен Ship Date трюк
    if (dayName === 'Thu' || dayName === 'Fri') {
      return [{
        json: {
          ...$json,
          action: 'SHIP_DATE_TRICK',
          note: 'Нет ставок на сегодня → попробовать с Ship Date = Monday'
        }
      }];
    }
    return [{ json: { ...$json, action: 'STOP', stopReason: '⚠️ Нет сервиса Frozen ≤3 дня' } }];
  }

  // Сортировка по цене
  frozenRates.sort((a, b) => parseFloat(a.total_net_charge) - parseFloat(b.total_net_charge));

  // Правило ~10%: чуть дороже но на 1-2 дня быстрее → предпочтительнее
  const cheapestFrozen = frozenRates[0];
  const cheapestFrozenPrice = parseFloat(cheapestFrozen.total_net_charge);

  for (const rate of frozenRates) {
    const price = parseFloat(rate.total_net_charge);
    const priceDiff = (price - cheapestFrozenPrice) / cheapestFrozenPrice;
    const daysSaved = cheapestFrozen.calendarDays - rate.calendarDays;

    if (priceDiff <= 0.10 && priceDiff > 0 && daysSaved >= 1) {
      return [{ json: { ...$json, selectedRate: rate, action: 'BUY' } }];
    }
  }

  // При близкой цене → более ранний EDD
  const within50centsFrz = frozenRates.filter(r =>
    parseFloat(r.total_net_charge) - cheapestFrozenPrice <= 0.50
  );
  if (within50centsFrz.length > 1) {
    within50centsFrz.sort((a, b) => a.eddDate - b.eddDate);
    return [{ json: { ...$json, selectedRate: within50centsFrz[0], action: 'BUY' } }];
  }

  return [{ json: { ...$json, selectedRate: cheapestFrozen, action: 'BUY' } }];
}
```

---

#### 12. Check Budget (Code Node)
```javascript
const rate = $json.selectedRate;
const labelCost = parseFloat(rate.total_net_charge);
const orderTotal = parseFloat($json.total_price || 0);
const shippingCharged = parseFloat($json.delivery_cost || 0);
const channel = $json.channel?.name || '';
const productType = $json.productType;

// Абсолютный лимит 50%
const maxAbsolute = 0.50 * (orderTotal + shippingCharged);
if (labelCost > maxAbsolute) {
  return [{ json: { ...$json, action: 'STOP',
    stopReason: `⚠️ На ревью: $${labelCost} > 50% от $${orderTotal + shippingCharged}`
  }}];
}

// Формулы по каналу и типу
let maxBudget;
const margin = orderTotal - shippingCharged;

if (channel.toLowerCase().includes('walmart')) {
  // Walmart Dry: 10%
  maxBudget = Math.max(0.10 * margin + shippingCharged, 10);
} else if (productType === 'Frozen') {
  // Amazon Frozen: 15%, min $15
  maxBudget = Math.max(0.15 * margin + shippingCharged, 15);
} else {
  // Amazon Dry: 15%, min $10
  maxBudget = Math.max(0.15 * margin + shippingCharged, 10);
}

if (labelCost > maxBudget) {
  return [{ json: { ...$json, action: 'STOP',
    stopReason: `⚠️ На ревью: $${labelCost} > бюджет $${maxBudget.toFixed(2)}`
  }}];
}

return [{ json: {
  ...$json,
  budgetMax: maxBudget.toFixed(2),
  budgetOk: true,
  action: 'BUY'
}}];
```

---

#### 13. Build Plan Row (Set Node)
```javascript
// Формируем строку для Google Sheets
const rate = $json.selectedRate;
const edd = rate?.eddConverted || 'N/A';
const tz = $('Set Timezone').first().json;

return [{
  json: {
    orderNumber: $json.number,
    channel: $json.channel?.name,
    product: $json.line_items?.map(i => i.sellable?.product_title).join('; '),
    sku: $json.line_items?.map(i => i.sellable?.sku).join('; '),
    qty: $json.line_items?.map(i => i.quantity).join('; '),
    type: $json.productType,
    weight: $json.lookupWeight || 'N/A',
    box: $json.boxSize || 'N/A',
    budgetMax: $json.budgetMax,
    carrier: rate?.carrier_name || 'N/A',
    service: rate?.service_name || 'N/A',
    price: rate?.total_net_charge || 'N/A',
    edd: edd,
    deliveryBy: $json.deliveryByConverted,
    actualShipDay: tz.actualShipDay,
    notes: $json.stopReason || '',
    status: $json.action === 'STOP' ? '❌ ' + $json.stopReason : '⏳ Ожидает одобрения',
    // Данные для покупки (скрытые колонки)
    _allocationId: $json.allocations?.[0]?.id,
    _carrierId: rate?.carrier_id,
    _remoteShipmentId: rate?.remote_shipment_id,
    _serviceType: rate?.service_type,
    _subCarrierId: rate?.sub_carrier_id,
    _serviceCarrier: rate?.service_carrier,
    _totalNetCharge: rate?.total_net_charge,
    _baseRate: rate?.base_rate,
    _orderId: $json.id
  }
}];
```

---

#### 14. Write to Google Sheets
```json
{
  "type": "n8n-nodes-base.googleSheets",
  "parameters": {
    "operation": "append",
    "documentId": "{{ создать новый или найти существующий }}",
    "sheetName": "Plan",
    "columns": "orderNumber,channel,product,sku,qty,type,weight,box,budgetMax,carrier,service,price,edd,deliveryBy,actualShipDay,notes,status"
  }
}
```

---

#### 15. Send Telegram
```json
{
  "type": "n8n-nodes-base.telegram",
  "parameters": {
    "chatId": "486456466",
    "text": "📋 План готов {{ $json.today }}: {{ $json.sheetUrl }}\nГотово: {{ $json.readyCount }} заказов / Требует внимания: {{ $json.stopCount }}",
    "parseMode": "HTML"
  }
}
```

---

## WORKFLOW 2: LABEL PURCHASER
*"Покупка по плану после одобрения"*

### Триггер: Webhook
Владимир пишет "покупай" в Telegram → бот вызывает webhook.

```
[Webhook Trigger] ← POST /webhook/buy-labels
    ↓
[Read Google Sheets Plan] ← фильтр: status = "⏳ Ожидает одобрения"
    ↓
[Loop Each Row] ← SplitInBatches
    ↓
[Check Duplicate] ← HTTP: GET order → employee_notes contains "Label Purchased"?
    ↓ (Нет дубля)
[Buy Label] ← HTTP: POST /shipping/shipments (см. ниже)
    ↓
[Download PDF] ← HTTP: GET label PDF URL
    ↓
[Format Filename] ← Code: (EDD Mmm DD | DL Mmm DD) Product -- Qty.pdf
    ↓
[Upload to Google Drive] ← Google Drive: upload to correct folder
    ↓
[Add Employee Note] ← HTTP: PUT /orders/{id} (employee_notes_attributes)
    ↓
[Update Sheet Status] ← Google Sheets: status = "✅ Куплено"
    ↓
[Next Row]
```

### Buy Label (HTTP Request)
```json
{
  "method": "POST",
  "url": "https://api.veeqo.com/shipping/shipments",
  "headers": {
    "x-api-key": "Vqt/5554f1df2e6b934f5e6e90d2f3dde79e",
    "Content-Type": "application/json"
  },
  "body": {
    "carrier": "amazon_shipping_v2",
    "shipment": {
      "allocation_id": "={{ $json._allocationId }}",
      "carrier_id": "={{ $json._carrierId }}",
      "remote_shipment_id": "={{ $json._remoteShipmentId }}",
      "service_type": "={{ $json._serviceType }}",
      "notify_customer": false,
      "sub_carrier_id": "={{ $json._subCarrierId }}",
      "service_carrier": "={{ $json._serviceCarrier }}",
      "payment_method_id": null,
      "total_net_charge": "={{ $json._totalNetCharge }}",
      "base_rate": "={{ $json._baseRate }}",
      "value_added_service__VAS_GROUP_ID_CONFIRMATION": "NO_CONFIRMATION"
    }
  }
}
```

### Format Filename (Code Node)
```javascript
const edd = $json.edd; // "2026-04-07"
const dl = $json.deliveryBy; // "2026-04-09"
const product = $json.product;
const qty = $json.qty;
const type = $json.type;

function formatDate(dateStr) {
  const d = new Date(dateStr);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')}`;
}

let filename = `(EDD ${formatDate(edd)} | DL ${formatDate(dl)}) ${product} -- ${qty}.pdf`;

// Frozen 4 дня (с согласия) → добавить +
// Это должно быть помечено вручную в плане
if ($json.notes?.includes('4 дня')) {
  filename = '+ ' + filename;
}

return [{ json: { ...$json, filename } }];
```

### Google Drive Folder Logic (Code Node)
```javascript
const actualShipDay = $json.actualShipDay; // "2026-04-07"
const channel = $json.channel; // "Amazon" или "Walmart"
const rootFolderId = '1vq_nT4g3F8i5MDiaKQymsPuEI0itTtVt';

const d = new Date(actualShipDay);
const monthNum = String(d.getMonth() + 1).padStart(2, '0');
const monthNames = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];
const monthName = monthNames[d.getMonth()];
const day = String(d.getDate()).padStart(2, '0');

// Путь: Shipping Labels / 04 April / 07 / Amazon /
const folderPath = `${monthNum} ${monthName}/${day}/${channel}`;

return [{ json: { ...$json, folderPath, rootFolderId } }];
```

---

## WORKFLOW 3: WEEKEND DISTRIBUTOR
*"Распределение Frozen заказов Пт+Сб+Вс на Пн/Вт"*

### Триггер: Schedule (пятница 17:00 ET)

```
[Schedule Trigger] ← Friday 5 PM ET
    ↓
[Fetch Fri+Sat+Sun Frozen Orders]
    ↓
[Sort by Delivery By] ← Code: срочные первые
    ↓
[Split 50/50] ← Code: первая половина → Пн, вторая → Вт
    ↓
[Validate Deadlines] ← Code: все ли успевают? Если нет → двигать в Пн
    ↓
[Set Ship Date in Veeqo] ← HTTP: обновить dispatch_date
    ↓
[Output Plan] ← Google Sheets: записать план с колонкой "Отгрузка (факт)"
```

### Split Logic (Code Node)
```javascript
const orders = $input.all().map(i => i.json);

// Сортировать по delivery_by (срочные первые)
orders.sort((a, b) => new Date(a.deliveryBy) - new Date(b.deliveryBy));

const half = Math.ceil(orders.length / 2);
const monday = orders.slice(0, half).map(o => ({ ...o, actualShipDay: 'Monday' }));
const tuesday = orders.slice(half).map(o => ({ ...o, actualShipDay: 'Tuesday' }));

// Валидация: если вторничный заказ не успевает → перенести в понедельник
const finalMonday = [...monday];
const finalTuesday = [];

for (const order of tuesday) {
  const tuesdayDate = getNextTuesday();
  const eddFromTue = addDays(tuesdayDate, 3); // max 3 кал. дня
  if (new Date(order.deliveryBy) < eddFromTue) {
    // Не успевает со вторника → в понедельник
    finalMonday.push({ ...order, actualShipDay: 'Monday', note: 'Moved: deadline tight' });
  } else {
    finalTuesday.push(order);
  }
}

return [...finalMonday, ...finalTuesday].map(o => ({ json: o }));
```

---

## WORKFLOW 2.5: SHIP DATE TRICK (Sub-workflow)
*"Для Четверга/Пятницы Frozen когда нет подходящих ставок"*

```
[Вход: orderId, allocationId]
    ↓
[Save Original Ship Date] ← GET order → запомнить dispatch_date
    ↓
[Set Ship Date = Monday] ← PUT order → dispatch_date = next Monday
    ↓
[Wait 2 sec]
    ↓
[Get Rates with Monday] ← GET /shipping/rates/{allocationId}
    ↓
[Restore Ship Date] ← PUT order → dispatch_date = original (четверг/пятница)
    ↓
[Select Rate from Monday Rates] ← Code: EDD от пн ≤ 3 дня + ≤ DL
    ↓
[Return Best Rate or STOP]
```

> ⚠️ **КРИТИЧНО:** Ship Date ОБЯЗАТЕЛЬНО вернуть обратно перед покупкой.
> Покупка с Ship Date = четверг/пятница, но rate посчитан от понедельника.
> Amazon видит покупку в четверг → статистика ✅
> Физически шипим в понедельник ✅

---

## 🔌 CREDENTIALS (n8n)

| Credential | Тип | Значение |
|-----------|-----|----------|
| Veeqo API | HTTP Header Auth | `x-api-key: Vqt/5554f1df2e6b934f5e6e90d2f3dde79e` |
| Google Sheets | OAuth2 | `kuzy.vladimir@gmail.com` |
| Google Drive | OAuth2 | `kuzy.vladimir@gmail.com` |
| Telegram Bot | Bot Token | Jackie bot token |

---

## 📊 ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ (n8n)

```
VEEQO_API_KEY=Vqt/5554f1df2e6b934f5e6e90d2f3dde79e
VEEQO_BASE_URL=https://api.veeqo.com
SKU_SHEET_ID=1H-bx0iZ_oL0i0CFbHN_QbfXzkGJC_f_hV90s-V6cqzY
SKU_SHEET_URL=https://docs.google.com/spreadsheets/d/1H-bx0iZ_oL0i0CFbHN_QbfXzkGJC_f_hV90s-V6cqzY/edit
DRIVE_ROOT_FOLDER=1vq_nT4g3F8i5MDiaKQymsPuEI0itTtVt
TELEGRAM_CHAT_ID=486456466
TIMEZONE_DISPLAY=America/New_York
TIMEZONE_VEEQO=UTC-7
```

### 📋 SKU Shipping Database v2 — справочная таблица

> ⚠️ **ОБЯЗАТЕЛЬНЫЙ КОМПОНЕНТ.** n8n workflow не работает без этой таблицы — все веса и размеры берутся отсюда.

**Название:** `SKU Shipping Database v2`
**Ссылка:** https://docs.google.com/spreadsheets/d/1H-bx0iZ_oL0i0CFbHN_QbfXzkGJC_f_hV90s-V6cqzY/edit

**Колонки, используемые в n8n:**

| Колонка | Заголовок | Использование в n8n |
|---------|-----------|---------------------|
| **A** | SKU | Lookup key — поиск по артикулу |
| **B** | Product Title | Запись в Shipping Plan (колонка Product) |
| **C** | Marketplace | Информация |
| **D** | Category | Доп. источник Frozen/Dry (основной — теги Veeqo) |
| **E** | Length (in) | Dimensions → передаётся в Veeqo при покупке |
| **F** | Width (in) | Dimensions → передаётся в Veeqo при покупке |
| **G** | Height (in) | Dimensions → передаётся в Veeqo при покупке |
| **H** | Weight (lbs) | Вес для UPS, USPS, FedEx (без One Rate) |
| **I** | Sample Count | Не используется в n8n |
| **J** | Notes | Не используется в n8n |
| **K** | Weight FedEx (lbs) | Вес ТОЛЬКО для FedEx One Rate тарифов |

**В коде n8n нод Lookup SKU Weight:**
```javascript
// Определить какую колонку веса использовать
const isFedExOneRate = selectedRate.service_name?.toLowerCase().includes('one rate');
const weight = isFedExOneRate
  ? $json.lookupResult.K  // FedEx One Rate weight
  : $json.lookupResult.H; // Standard weight
```

---

## ⚡ ERROR HANDLING

Каждый workflow должен иметь Error Trigger node:

```
[Error Trigger]
    ↓
[Format Error Message]
    ↓
[Telegram: Send to Vladimir]
    ↓
[Log to Google Sheets: "Errors" tab]
```

**Обязательные retry:**
- HTTP requests к Veeqo → retry 3 раза с задержкой 5 сек
- Google Sheets/Drive → retry 2 раза

**Обязательные проверки:**
- Перед покупкой: employee_notes НЕ содержит "Label Purchased" (защита от дублей)
- После покупки: проверить response.status = success
- После upload PDF: проверить файл существует в Drive

---

*Версия: n8n Architecture v1.1 — 2026-04-05*
*Основа: MASTER PROMPT v3.1*
*Изменения v1 → v1.1: убрана ice formula, добавлен Walmart weekend filter, Frozen на Walmart = ошибка, notification с SKU*
