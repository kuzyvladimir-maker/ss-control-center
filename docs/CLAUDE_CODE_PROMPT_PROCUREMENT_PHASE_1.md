# CLAUDE CODE PROMPT — Procurement Module Phase 1

> **Target repo:** `kuzyvladimir-maker/ss-control-center`
> **Date:** 2026-05-03
> **Reference spec:** `docs/wiki/procurement-module.md` (PROCUREMENT_ALGORITHM_v1_0.md)
> **Execution mode:** один цельный коммит в конце фазы

---

## 🎯 ЦЕЛЬ PHASE 1

Заложить фундамент для модуля **Procurement** — мобильно-ориентированного раздела для физического закупа товара в магазинах. В этой фазе мы делаем минимально работающий бэкенд + голую страницу, чтобы убедиться, что данные тянутся из Veeqo и фильтруются правильно.

**Что должно работать после Phase 1:**
- Можно открыть `https://salutemsolutions.info/procurement` и увидеть простой список товаров, которые нужно купить
- Список фильтруется правильно (нет заказов с тегами `Placed`, `Заказано у Майка`, `canceled`, `need to adjast`)

> `need to adjast` — внутренний workflow Vladimir: товар не найден ни в одном магазине → нужно сделать adjustment на маркетплейсе (снять листинг с продаж, оформить частичный возврат или отменить заказ). Такие заказы к физическому закупу не относятся, поэтому исключаем.
- Заказы с тегом `Need More` тоже в списке (значит докупаем)
- Multi-item заказы показаны как отдельные строки с группировкой по заказу
- Парсер internal notes корректно читает блок `[PROCUREMENT]`

**Что в Phase 1 НЕ делаем (придёт в следующих фазах):**
- Красивый UI (только функциональный список)
- Действия "купил всё / частично / откат"
- Photo lightbox с зумом
- Копирование названия
- Сортировка / поиск
- Магазины на SKU
- PWA / офлайн / уведомления

---

## 📚 СПРАВОЧНЫЕ ДОКУМЕНТЫ

ОБЯЗАТЕЛЬНО прочитать перед началом работы:

1. **`docs/wiki/procurement-module.md`** — полная спецификация модуля (общий контекст)
2. **`docs/MASTER_PROMPT_v3.1.md`** — там описана работа с Veeqo API (теги, заказы, продукты)
3. **`CLAUDE.md`** — структура проекта, env vars, стек

---

## 🏗️ ШАГ 1 — Prisma schema

### Открыть файл
`prisma/schema.prisma`

### Добавить три модели в конец файла

```prisma
// Procurement: где какой SKU покупать (приоритет магазинов)
model SKUStorePriority {
  id          String   @id @default(cuid())
  sku         String
  storeName   String
  priority    Int
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([sku, storeName])
  @@index([sku])
}

// Procurement: очередь действий для офлайн-режима (понадобится в Phase 6)
model ProcurementSyncQueue {
  id           String    @id @default(cuid())
  lineItemId   String
  orderId      String
  action       String
  payload      Json
  status       String    @default("pending")
  createdAt    DateTime  @default(now())
  syncedAt     DateTime?
  errorMessage String?

  @@index([status])
}

// Procurement: лог отправленных уведомлений (понадобится в Phase 7)
model ProcurementNotificationLog {
  id         String   @id @default(cuid())
  orderId    String   @unique
  notifiedAt DateTime @default(now())

  @@index([notifiedAt])
}
```

### Применить миграцию

> ⚠️ В этом проекте используется Turso (libsql), а не локальный SQLite. Поэтому НЕ запускай `prisma migrate dev` — он не работает с libsql напрямую.

**Для локальной разработки** (если есть локальный `dev.db`):
```bash
npx prisma db push
npx prisma generate
```

**Для production (Turso)** — это сделается автоматически при следующем деплое через скрипт `scripts/turso-push.sh`, который уже есть в проекте. Проверь, что он запускается на постдеплое в Vercel.

Если такого скрипта нет — создай файл `scripts/turso-push.sh`:
```bash
#!/bin/bash
DATABASE_URL="${TURSO_DATABASE_URL}?authToken=${TURSO_AUTH_TOKEN}" \
  npx prisma db push --skip-generate --accept-data-loss
```

И сделай его исполняемым: `chmod +x scripts/turso-push.sh`.

---

## 🏗️ ШАГ 2 — Veeqo client extensions

### 2.1 Создать `src/lib/veeqo/tags.ts`

Этот модуль управляет тегами на заказе.

```typescript
import { veeqoFetch } from './client'; // существующий хелпер для Veeqo API

const PROCUREMENT_TAG_NAMES = {
  PLACED: 'Placed',
  NEED_MORE: 'Need More',
  ORDERED_BY_MIKE: 'Заказано у Майка',
  CANCELED: 'canceled',
  NEED_TO_ADJUST: 'need to adjast', // опечатка в Veeqo — оставляем как есть
} as const;

export const PROCUREMENT_TAGS = PROCUREMENT_TAG_NAMES;

export type ProcurementTag = typeof PROCUREMENT_TAG_NAMES[keyof typeof PROCUREMENT_TAG_NAMES];

/**
 * Возвращает список имён тегов на заказе.
 */
export function getOrderTagNames(order: any): string[] {
  if (!order?.tags || !Array.isArray(order.tags)) return [];
  return order.tags.map((t: any) => (typeof t === 'string' ? t : t.name)).filter(Boolean);
}

/**
 * Проверка наличия конкретного тега (точное совпадение, case-sensitive).
 */
export function hasTag(order: any, tagName: string): boolean {
  return getOrderTagNames(order).includes(tagName);
}

/**
 * Поставить тег на заказ. Veeqo API: PUT /orders/{id} с массивом tags.
 * Сохраняем существующие теги и добавляем новый.
 */
export async function addTagToOrder(orderId: string | number, tagName: string): Promise<void> {
  const order = await veeqoFetch(`/orders/${orderId}`);
  const currentTags = getOrderTagNames(order);
  if (currentTags.includes(tagName)) return; // уже стоит

  const newTags = [...currentTags, tagName];
  await veeqoFetch(`/orders/${orderId}`, {
    method: 'PUT',
    body: JSON.stringify({ tags: newTags }),
  });
}

/**
 * Снять тег с заказа.
 */
export async function removeTagFromOrder(orderId: string | number, tagName: string): Promise<void> {
  const order = await veeqoFetch(`/orders/${orderId}`);
  const currentTags = getOrderTagNames(order);
  const newTags = currentTags.filter((t) => t !== tagName);
  if (newTags.length === currentTags.length) return; // тега не было

  await veeqoFetch(`/orders/${orderId}`, {
    method: 'PUT',
    body: JSON.stringify({ tags: newTags }),
  });
}
```

> ⚠️ **Перед написанием кода проверь точный API Veeqo для управления тегами.** В `MASTER_PROMPT_v3.1.md` указано, что `POST /orders/{id}/tags` НЕ работает. Возможно, теги ставятся через `PUT /orders/{id}` с массивом, или через другой эндпоинт. Если PUT с tags не работает — попробуй `PUT /orders/{id}/tags` или ищи в Veeqo API docs. Если ничего не работает — оставь TODO-комментарий и сообщи Vladimir.

### 2.2 Создать `src/lib/veeqo/notes.ts`

Управление internal notes на заказе.

```typescript
import { veeqoFetch } from './client';

/**
 * Получить internal notes заказа (поле может называться по-разному
 * в разных версиях Veeqo API: employee_notes, internal_notes, notes).
 * Проверь актуальное поле в реальном response.
 */
export function getInternalNotes(order: any): string {
  return order?.employee_notes ?? order?.internal_notes ?? order?.notes ?? '';
}

/**
 * Полностью перезаписать internal notes заказа.
 */
export async function setInternalNotes(orderId: string | number, notes: string): Promise<void> {
  await veeqoFetch(`/orders/${orderId}`, {
    method: 'PUT',
    body: JSON.stringify({ employee_notes: notes }),
  });
}
```

### 2.3 Создать `src/lib/veeqo/procurement-notes-parser.ts`

Парсер блока `[PROCUREMENT]` внутри internal notes.

```typescript
const BLOCK_START = '[PROCUREMENT]';
const BLOCK_END = '[/PROCUREMENT]';

export type LineItemStatus =
  | { kind: 'bought' }
  | { kind: 'remain'; remaining: number };

export interface ProcurementBlock {
  // Map: lineItemId -> status
  items: Map<string, LineItemStatus>;
}

/**
 * Распарсить блок [PROCUREMENT] из notes.
 * Если блока нет — возвращает пустой Map.
 */
export function parseProcurementBlock(notes: string): ProcurementBlock {
  const items = new Map<string, LineItemStatus>();
  if (!notes) return { items };

  const startIdx = notes.indexOf(BLOCK_START);
  const endIdx = notes.indexOf(BLOCK_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return { items };
  }

  const blockContent = notes.slice(startIdx + BLOCK_START.length, endIdx).trim();
  const lines = blockContent.split('\n').map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    // Формат: "lineItemId | shortName | status"
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length < 3) continue;
    const [lineItemId, , statusRaw] = parts;
    if (!lineItemId) continue;

    if (statusRaw === 'bought') {
      items.set(lineItemId, { kind: 'bought' });
    } else if (statusRaw.startsWith('remain:')) {
      const num = parseInt(statusRaw.slice('remain:'.length), 10);
      if (!isNaN(num) && num > 0) {
        items.set(lineItemId, { kind: 'remain', remaining: num });
      }
    }
  }

  return { items };
}

/**
 * Сериализовать блок [PROCUREMENT] обратно в строку.
 * @param shortNames - Map lineItemId -> короткое имя товара (для читабельности в Veeqo)
 */
export function serializeProcurementBlock(
  block: ProcurementBlock,
  shortNames: Map<string, string>,
): string {
  if (block.items.size === 0) return '';
  const lines: string[] = [BLOCK_START];
  for (const [lineItemId, status] of block.items) {
    const name = shortNames.get(lineItemId) ?? '?';
    const statusStr = status.kind === 'bought' ? 'bought' : `remain:${status.remaining}`;
    lines.push(`${lineItemId} | ${name} | ${statusStr}`);
  }
  lines.push(BLOCK_END);
  return lines.join('\n');
}

/**
 * Заменить блок [PROCUREMENT] в существующих notes на новый.
 * Если блока не было — дописать в конец.
 * Если новый блок пустой — удалить старый.
 */
export function replaceProcurementBlockInNotes(notes: string, newBlockText: string): string {
  const startIdx = notes.indexOf(BLOCK_START);
  const endIdx = notes.indexOf(BLOCK_END);

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    // Блока не было
    if (!newBlockText) return notes;
    return notes.trimEnd() + '\n\n' + newBlockText + '\n';
  }

  // Блок есть — заменяем
  const before = notes.slice(0, startIdx).trimEnd();
  const after = notes.slice(endIdx + BLOCK_END.length).trimStart();

  if (!newBlockText) {
    // Удаляем блок
    return [before, after].filter(Boolean).join('\n\n');
  }

  return [before, newBlockText, after].filter(Boolean).join('\n\n');
}
```

---

## 🏗️ ШАГ 3 — Логика фильтрации

### Создать `src/lib/procurement/filter-rules.ts`

```typescript
import { hasTag, PROCUREMENT_TAGS } from '@/lib/veeqo/tags';

/**
 * Заказ должен попасть в Procurement-список?
 * Правило:
 *   - Включаем если: НЕТ тегов Placed/Заказано у Майка/canceled/need to adjast
 *   - При этом тег Need More — это нормально (включаем)
 */
export function shouldIncludeOrderInProcurement(order: any): boolean {
  if (hasTag(order, PROCUREMENT_TAGS.PLACED)) return false;
  if (hasTag(order, PROCUREMENT_TAGS.ORDERED_BY_MIKE)) return false;
  if (hasTag(order, PROCUREMENT_TAGS.CANCELED)) return false;
  if (hasTag(order, PROCUREMENT_TAGS.NEED_TO_ADJUST)) return false;
  return true;
}
```

---

## 🏗️ ШАГ 4 — Fetch + filter helper

### Создать `src/lib/veeqo/orders-procurement.ts`

```typescript
import { veeqoFetch } from './client';
import { shouldIncludeOrderInProcurement } from '@/lib/procurement/filter-rules';
import { getInternalNotes } from './notes';
import { parseProcurementBlock, LineItemStatus } from './procurement-notes-parser';

export interface ProcurementCard {
  // Уникальный ключ карточки
  lineItemId: string;
  // Заказ
  orderId: string;
  orderNumber: string;
  channel: string;       // "Amazon" | "Walmart" | "eBay" | ...
  storeName: string;     // имя конкретного магазина (один из 5 Amazon-аккаунтов и т.п.)
  // Товар
  productId: string;
  productTitle: string;
  productImageUrl: string | null;
  sku: string;
  // Количество
  quantityOrdered: number;
  // Что осталось купить (если статус "купил частично")
  remaining: number;     // = quantityOrdered если ничего не куплено, или N если куплено частично, или 0 если bought
  // Статус из notes
  status: LineItemStatus | null;
  // Срок отгрузки
  shipBy: string | null;  // ISO date
  expectedDispatchDate: string | null;  // ISO date
  // Приоритет
  isPremium: boolean;
  shippingMethod: string | null;
}

/**
 * Главный fetcher для Procurement-страницы.
 * 1) Тянет все awaiting_fulfillment заказы (с пагинацией)
 * 2) Фильтрует по тегам
 * 3) Раскладывает на line items
 * 4) Парсит [PROCUREMENT] блок и подставляет статусы
 */
export async function fetchProcurementCards(): Promise<ProcurementCard[]> {
  const allOrders: any[] = [];
  let page = 1;

  while (true) {
    const orders = await veeqoFetch(
      `/orders?status=awaiting_fulfillment&page_size=100&page=${page}`
    );
    if (!Array.isArray(orders) || orders.length === 0) break;
    allOrders.push(...orders);
    if (orders.length < 100) break;
    page++;
    if (page > 50) break; // safety
  }

  const cards: ProcurementCard[] = [];

  for (const order of allOrders) {
    if (!shouldIncludeOrderInProcurement(order)) continue;

    const notes = getInternalNotes(order);
    const block = parseProcurementBlock(notes);

    for (const li of order.line_items ?? []) {
      const lineItemId = String(li.id);
      const status = block.items.get(lineItemId) ?? null;
      const quantityOrdered = li.quantity ?? 0;

      let remaining = quantityOrdered;
      if (status?.kind === 'bought') remaining = 0;
      else if (status?.kind === 'remain') remaining = status.remaining;

      // Если уже всё куплено — не показываем (на случай если refresh
      // ещё не успел снять тег)
      if (status?.kind === 'bought') continue;

      const sellable = li.sellable ?? {};
      const product = sellable.product ?? {};
      const images = product.images ?? [];

      cards.push({
        lineItemId,
        orderId: String(order.id),
        orderNumber: order.number ?? String(order.id),
        channel: order.channel?.type_code ?? order.channel?.name ?? 'Unknown',
        storeName: order.channel?.name ?? 'Unknown',
        productId: String(product.id ?? ''),
        productTitle: product.title ?? sellable.title ?? '?',
        productImageUrl: images[0]?.src ?? images[0]?.url ?? null,
        sku: sellable.sku_code ?? sellable.sku ?? '',
        quantityOrdered,
        remaining,
        status,
        shipBy: order.deliver_by ?? null,
        expectedDispatchDate: order.expected_dispatch_date ?? null,
        isPremium: Boolean(order.is_premium ?? order.priority === 'premium'),
        shippingMethod: order.delivery_method?.name ?? null,
      });
    }
  }

  return cards;
}
```

> ⚠️ **Поля Veeqo:** некоторые имена полей выше — предположение (`order.channel.type_code`, `order.is_premium`, и т.д.). Когда напишешь код — сделай один тестовый GET-запрос, посмотри реальную структуру JSON, и поправь геттеры под реальные имена. Если что-то не находится — оставь TODO и заполни хоть что-то для отладки.

---

## 🏗️ ШАГ 5 — API endpoint

### Создать `src/app/api/procurement/items/route.ts`

```typescript
import { NextResponse } from 'next/server';
import { fetchProcurementCards } from '@/lib/veeqo/orders-procurement';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const cards = await fetchProcurementCards();
    // Сортировка по умолчанию: по shipBy возрастающе (срочные сверху)
    cards.sort((a, b) => {
      const aDate = a.shipBy ? new Date(a.shipBy).getTime() : Number.POSITIVE_INFINITY;
      const bDate = b.shipBy ? new Date(b.shipBy).getTime() : Number.POSITIVE_INFINITY;
      return aDate - bDate;
    });
    return NextResponse.json({ cards, total: cards.length });
  } catch (e: any) {
    console.error('[procurement/items] error', e);
    return NextResponse.json(
      { error: e?.message ?? 'Unknown error' },
      { status: 500 }
    );
  }
}
```

---

## 🏗️ ШАГ 6 — Минимальная страница `/procurement`

### Создать `src/app/procurement/page.tsx`

Голая страница без красоты. Цель — показать данные.

```tsx
'use client';

import { useEffect, useState } from 'react';

interface Card {
  lineItemId: string;
  orderId: string;
  orderNumber: string;
  channel: string;
  storeName: string;
  productTitle: string;
  productImageUrl: string | null;
  sku: string;
  quantityOrdered: number;
  remaining: number;
  status: { kind: string; remaining?: number } | null;
  shipBy: string | null;
  isPremium: boolean;
  shippingMethod: string | null;
}

export default function ProcurementPage() {
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/procurement/items');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCards(data.cards ?? []);
    } catch (e: any) {
      setError(e?.message ?? 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  // Группировка по orderId — для визуального разделения
  const grouped = cards.reduce<Record<string, Card[]>>((acc, c) => {
    (acc[c.orderId] ??= []).push(c);
    return acc;
  }, {});

  return (
    <div style={{ padding: 16, maxWidth: 800, margin: '0 auto' }}>
      <h1 style={{ fontSize: 22, fontWeight: 600 }}>Procurement (Phase 1 — bare bones)</h1>
      <button onClick={load} disabled={loading} style={{ margin: '12px 0' }}>
        {loading ? 'Loading...' : '🔄 Refresh'}
      </button>
      {error && <div style={{ color: 'red' }}>Error: {error}</div>}
      <div style={{ fontSize: 13, color: '#666', marginBottom: 12 }}>
        Total cards: {cards.length}
      </div>

      {Object.entries(grouped).map(([orderId, items]) => (
        <div
          key={orderId}
          style={{
            border: '1px solid #ddd',
            borderRadius: 8,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>
            Order {items[0].orderNumber} · {items[0].channel}
            {items[0].isPremium && ' · 🚨 Premium'}
            {items[0].shipBy && ` · Ship by ${items[0].shipBy.slice(0, 10)}`}
          </div>
          {items.map((c) => (
            <div
              key={c.lineItemId}
              style={{
                display: 'flex',
                gap: 12,
                padding: '8px 0',
                borderTop: '1px dashed #eee',
              }}
            >
              {c.productImageUrl ? (
                <img
                  src={c.productImageUrl}
                  alt=""
                  style={{ width: 60, height: 60, objectFit: 'cover', borderRadius: 4 }}
                />
              ) : (
                <div
                  style={{
                    width: 60,
                    height: 60,
                    background: '#f0f0f0',
                    borderRadius: 4,
                  }}
                />
              )}
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500 }}>{c.productTitle}</div>
                <div style={{ fontSize: 12, color: '#666' }}>SKU: {c.sku}</div>
                <div style={{ fontSize: 14, fontWeight: 600, marginTop: 4 }}>
                  {c.status?.kind === 'remain'
                    ? `Осталось купить: ${c.remaining} из ${c.quantityOrdered}`
                    : `Купить: ${c.quantityOrdered} шт`}
                </div>
              </div>
            </div>
          ))}
        </div>
      ))}

      {!loading && cards.length === 0 && !error && (
        <div style={{ color: '#888' }}>Список пуст — всё закуплено 🎉</div>
      )}
    </div>
  );
}
```

### Добавить пункт в Sidebar

Открыть файл sidebar (вероятно `src/components/layout/Sidebar.tsx`). Добавить в массив навигации новый пункт:

```ts
{ href: '/procurement', label: 'Procurement', icon: ShoppingCart }
```

(иконку взять из `lucide-react`). Рядом с другими пунктами навигации.

---

## 🏗️ ШАГ 7 — Защита роута авторизацией

В проекте уже есть NextAuth и middleware. Убедись, что `/procurement` подпадает под общую авторизацию (проверяется в `middleware.ts`). Если нет — добавь `/procurement` в matcher.

---

## ✅ ПРОВЕРКА (acceptance criteria)

После имплементации проверь:

1. **`npm run build`** проходит без ошибок типизации.
2. **`npm run dev`** локально, открыть `http://localhost:3000/procurement` — видишь список заказов.
3. **Боевой деплой** — после `git push` на Vercel страница `https://salutemsolutions.info/procurement` открывается, требует авторизации.
4. **Фильтрация:**
   - Заказ с тегом `Placed` → не видим в списке.
   - Заказ без тегов → видим.
   - Заказ с тегом `Need More` → видим.
   - Заказ с `canceled` → не видим.
5. **Multi-item заказ** показан как несколько строк, сгруппированных рамкой.
6. **Notes parsing:** если у заказа в Veeqo вручную добавить блок:
   ```
   [PROCUREMENT]
   12345 | Wings | remain:3
   [/PROCUREMENT]
   ```
   (где `12345` — реальный line_item.id), на странице должно отображаться `Осталось купить: 3 из X` для соответствующей строки.

---

## 📦 ФИНАЛИЗАЦИЯ

1. Прогнать `npm run build` — убедиться что нет ошибок.
2. Закоммитить:
   ```bash
   git add .
   git commit -m "feat(procurement): phase 1 — backend + minimal page"
   git push
   ```
3. Дождаться деплоя на Vercel (~2 мин).
4. Проверить `https://salutemsolutions.info/procurement` с десктопа и с iPhone.
5. **Сообщить Vladimir что Phase 1 готова — можно идти в Phase 2.**

---

## 🚧 ВОЗМОЖНЫЕ ПРОБЛЕМЫ

### "Veeqo PUT /orders/{id} с tags не работает"

В `MASTER_PROMPT_v3.1.md` сказано, что `POST /orders/{id}/tags` — устаревший. Но способ ставить теги через API не описан. Если PUT не работает — нужно ресёрчить:
- Попробовать `PUT /orders/{id}` с `{ tag_list: [...] }` или `{ tag_ids: [...] }`
- Сходить в Veeqo Developer docs
- Если совсем не получается — оставить функции `addTagToOrder`/`removeTagFromOrder` со заглушкой `throw new Error('TODO')` и сообщить Vladimir. В Phase 1 эти функции не вызываются (только в Phase 3), поэтому не блокирует.

### "Поле internal_notes называется по-другому"

Проверь актуальное имя в реальном response. Может быть `employee_notes`, `internal_notes`, `notes`. Подстрой в `getInternalNotes` и `setInternalNotes`.

### "Премиум-флаг не там"

`order.is_premium` — гипотеза. Реальное поле может быть `order.priority`, `order.flags`, или вообще теги. Посмотри реальный response — на скриншоте у Vladimir виден оранжевый бейдж "Premium", значит поле есть.

---

**End of Phase 1 prompt** — Vladimir feeds this file to Claude Code in VS Code.
