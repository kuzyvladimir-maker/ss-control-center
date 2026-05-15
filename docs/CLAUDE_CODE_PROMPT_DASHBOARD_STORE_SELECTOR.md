# CLAUDE CODE PROMPT — Dashboard Store Selector (multi-select) v1.0

> **Target repo:** `kuzyvladimir-maker/ss-control-center`
> **Date:** 2026-05-12
> **Prepared by:** Vladimir (via Claude chat)
> **Branch:** `feature/dashboard-store-selector`
> **Execution mode:** поэтапно, коммит после каждого этапа

---

## 🎯 КОНТЕКСТ

На главной странице `/` (Dashboard) в левом верхнем углу сайдбара есть селектор магазинов с надписью **"All stores · 5"**. Сейчас он **сломан**:

1. Клик на стрелку — dropdown не открывается (нет обработчика).
2. Цифра "5" — неправильная. У нас 5 Amazon + 1 Walmart = **6 магазинов**. Walmart (SIRIUS TRADING INTERNATIONAL LLC, Seller ID `10001624309`) был добавлен ранее, но в селекторе он не учтён.
3. В правом верхнем углу шапки тоже плашка **"5 stores live"** — она тоже считает только Amazon.
4. Селектор ни на что не влияет — все карточки Dashboard всегда показывают данные по всем магазинам сразу.

Нужно сделать **рабочий мульти-селект** магазинов, который **глобально фильтрует все данные Dashboard** (карточки, таблицу Awaiting fulfilment, Shipping progress, Customer queue) в реальном времени.

### ⚠️ Принципы (не нарушать)

- **Никакого `localStorage`** — selection не персистится между сессиями. При каждом открытии страницы — выбраны ВСЕ магазины по умолчанию.
- **Live filtering** — при клике на чекбокс фильтр применяется мгновенно, без кнопки Apply.
- **Walmart-карточки** (нижний ряд: Walmart 30D / Returns / Refunds 7D / Health) **скрываются полностью** (display: none, не "—"), если в выборе нет ни одного Walmart-магазина.
- **Дизайн-система Salutem v1.0** — соблюдать `docs/CLAUDE_CODE_PROMPT_DESIGN_SYSTEM.md` (никакого чисто чёрного текста — `--ink: #15201B`; на зелёном фоне только `--green-cream: #F0E8D0`, никогда белый; `tabular-nums` на числах; Inter Tight + JetBrains Mono; радиусы 6/10/14px).
- **shadcn/ui компоненты** — Popover, Checkbox, ScrollArea, Separator. Не писать свой dropdown с нуля.
- **camelCase Prisma fields** — если будут изменения в БД (не должно быть, но на всякий случай).
- **Не трогать другие страницы** — только Dashboard. Глобальный store-filter context создаётся как infrastructure, но применяется в этом промпте только на Dashboard. Customer Hub / Adjustments / Account Health подключим к нему отдельными промптами потом.

---

## 📐 АРХИТЕКТУРА РЕШЕНИЯ

### 1. Источник правды о магазинах

Таблица `Store` в Prisma. Должна содержать **6 записей**:

| # | name | channel | sellerId | isActive |
|---|------|---------|----------|----------|
| 1 | Salutem Solutions | Amazon | (refresh token store1) | true |
| 2 | Vladimir Personal | Amazon | (store2) | true |
| 3 | AMZ Commerce | Amazon | (store3) | true |
| 4 | Sirius International | Amazon | (store4) | true |
| 5 | Retailer Distributor | Amazon | (store5) | true |
| 6 | SIRIUS TRADING INTERNATIONAL LLC | Walmart | 10001624309 | true |

**Первое действие:** прочитать `prisma/schema.prisma` и убедиться что:
- Модель `Store` существует и содержит поля минимум: `id`, `name`, `channel` (Amazon | Walmart), `isActive`
- Walmart-запись (`channel = "Walmart"`, sellerId `10001624309`) **существует в БД**

Если Walmart-записи нет — создать миграцию-сидер `prisma/seeds/walmart-store.ts`:

```typescript
// prisma/seeds/walmart-store.ts
import { PrismaClient } from "@/generated/prisma";
const prisma = new PrismaClient();

async function main() {
  const existing = await prisma.store.findFirst({
    where: { channel: "Walmart", sellerId: "10001624309" }
  });

  if (!existing) {
    await prisma.store.create({
      data: {
        name: "SIRIUS TRADING INTERNATIONAL LLC",
        channel: "Walmart",
        sellerId: "10001624309",
        isActive: true,
        // остальные поля по схеме (createdAt etc.)
      }
    });
    console.log("✅ Walmart store seeded");
  } else {
    console.log("ℹ️ Walmart store already exists, skipped");
  }
}

main().finally(() => prisma.$disconnect());
```

Запустить: `npx tsx prisma/seeds/walmart-store.ts`

> **Если в схеме `Store` нет поля `channel`** — добавь его (тип `String`, default `"Amazon"`), миграция `add-store-channel`, и проставь всем существующим записям `channel = "Amazon"`.

---

### 2. Endpoint списка магазинов

**`src/app/api/stores/route.ts`** (если ещё нет — создать):

```typescript
// GET /api/stores
// Response: { stores: Store[] }
//
// Возвращает ВСЕ активные магазины (isActive = true), отсортированные:
// 1. Сначала channel = "Amazon" (по id или createdAt)
// 2. Потом channel = "Walmart"
//
// Каждая запись: { id, name, channel, sellerId, isActive }
```

---

### 3. Глобальный State (React Context)

**`src/lib/store-filter/StoreFilterContext.tsx`** (новый файл):

```typescript
"use client";

import { createContext, useContext, useState, useEffect, ReactNode } from "react";

export type Store = {
  id: string;
  name: string;
  channel: "Amazon" | "Walmart";
  sellerId?: string | null;
  isActive: boolean;
};

type StoreFilterContextValue = {
  // Все магазины из БД
  allStores: Store[];
  // ID выбранных магазинов
  selectedStoreIds: string[];
  // Производные значения
  selectedStores: Store[];
  hasAmazon: boolean;      // в выборе есть хотя бы 1 Amazon
  hasWalmart: boolean;     // в выборе есть хотя бы 1 Walmart
  isAllSelected: boolean;  // выбраны все
  // Действия
  toggleStore: (storeId: string) => void;
  selectAll: () => void;
  clearAll: () => void;
  setSelected: (ids: string[]) => void;
  // Загрузка
  isLoading: boolean;
  error: string | null;
};

const StoreFilterContext = createContext<StoreFilterContextValue | null>(null);

export function StoreFilterProvider({ children }: { children: ReactNode }) {
  const [allStores, setAllStores] = useState<Store[]>([]);
  const [selectedStoreIds, setSelectedStoreIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Загрузка списка магазинов при mount — БЕЗ localStorage, всегда выбраны все
  useEffect(() => {
    fetch("/api/stores")
      .then((r) => r.json())
      .then((data) => {
        const stores: Store[] = data.stores || [];
        setAllStores(stores);
        // Default: все магазины выбраны
        setSelectedStoreIds(stores.map((s) => s.id));
        setIsLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setIsLoading(false);
      });
  }, []);

  const toggleStore = (storeId: string) => {
    setSelectedStoreIds((prev) =>
      prev.includes(storeId)
        ? prev.filter((id) => id !== storeId)
        : [...prev, storeId]
    );
  };

  const selectAll = () => setSelectedStoreIds(allStores.map((s) => s.id));
  const clearAll = () => setSelectedStoreIds([]);
  const setSelected = (ids: string[]) => setSelectedStoreIds(ids);

  const selectedStores = allStores.filter((s) => selectedStoreIds.includes(s.id));
  const hasAmazon = selectedStores.some((s) => s.channel === "Amazon");
  const hasWalmart = selectedStores.some((s) => s.channel === "Walmart");
  const isAllSelected =
    allStores.length > 0 && selectedStoreIds.length === allStores.length;

  return (
    <StoreFilterContext.Provider
      value={{
        allStores,
        selectedStoreIds,
        selectedStores,
        hasAmazon,
        hasWalmart,
        isAllSelected,
        toggleStore,
        selectAll,
        clearAll,
        setSelected,
        isLoading,
        error,
      }}
    >
      {children}
    </StoreFilterContext.Provider>
  );
}

export function useStoreFilter() {
  const ctx = useContext(StoreFilterContext);
  if (!ctx) throw new Error("useStoreFilter must be inside StoreFilterProvider");
  return ctx;
}
```

**Где обернуть провайдером:** в `src/app/layout.tsx` (root layout). Обернуть весь app — селектор живёт в sidebar, который часть layout. Не оборачивай только Dashboard — провайдер нужен везде, где будет читаться `useStoreFilter` (а это и Header, и Sidebar).

```tsx
// src/app/layout.tsx
import { StoreFilterProvider } from "@/lib/store-filter/StoreFilterContext";

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        <StoreFilterProvider>
          {/* AppShell с Sidebar и Header */}
          {children}
        </StoreFilterProvider>
      </body>
    </html>
  );
}
```

---

### 4. UI компонент селектора

**`src/components/layout/StoreFilterSelector.tsx`** (новый файл):

```tsx
"use client";

import { useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useStoreFilter } from "@/lib/store-filter/StoreFilterContext";
import { cn } from "@/lib/utils";

export function StoreFilterSelector() {
  const {
    allStores,
    selectedStoreIds,
    selectedStores,
    isAllSelected,
    toggleStore,
    selectAll,
    clearAll,
    isLoading,
  } = useStoreFilter();
  const [open, setOpen] = useState(false);

  // Label логика
  let label: string;
  let badge: number | null;
  if (isLoading) {
    label = "Loading…";
    badge = null;
  } else if (selectedStoreIds.length === 0) {
    label = "No stores";
    badge = 0;
  } else if (selectedStoreIds.length === 1) {
    label = selectedStores[0].name;
    badge = null;
  } else if (isAllSelected) {
    label = "All stores";
    badge = allStores.length;
  } else {
    label = `${selectedStoreIds.length} of ${allStores.length} stores`;
    badge = null;
  }

  const amazonStores = allStores.filter((s) => s.channel === "Amazon");
  const walmartStores = allStores.filter((s) => s.channel === "Walmart");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            // Стилизация согласно Salutem design system:
            // зелёная точка слева, текст --ink, font Inter Tight,
            // высота 36px, padding 12px, радиус 10px,
            // border на hover/open
            "flex items-center justify-between w-full px-3 py-2",
            "text-[13.5px] font-medium text-[var(--ink)]",
            "rounded-[10px] border border-transparent",
            "hover:border-[var(--border)] transition-colors",
            open && "border-[var(--border)] bg-[var(--surface-2)]"
          )}
          aria-label="Select stores"
        >
          <span className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-[var(--accent-green)]" />
            <span>{label}</span>
            {badge !== null && (
              <span className="tabular-nums text-[var(--muted)]">
                {badge}
              </span>
            )}
          </span>
          <ChevronDown
            className={cn(
              "h-4 w-4 text-[var(--muted)] transition-transform",
              open && "rotate-180"
            )}
          />
        </button>
      </PopoverTrigger>

      <PopoverContent
        className="w-[260px] p-0 rounded-[10px]"
        align="start"
        sideOffset={4}
      >
        <div className="p-2">
          {/* Master "All stores" */}
          <button
            type="button"
            onClick={() => (isAllSelected ? clearAll() : selectAll())}
            className={cn(
              "flex items-center gap-2 w-full px-2 py-2",
              "text-[13.5px] font-medium text-[var(--ink)]",
              "rounded-[6px] hover:bg-[var(--surface-2)]"
            )}
          >
            <Checkbox
              checked={
                isAllSelected
                  ? true
                  : selectedStoreIds.length === 0
                    ? false
                    : "indeterminate"
              }
              // Не handle onCheckedChange здесь — обработка в onClick кнопки
            />
            <span>All stores</span>
            <span className="ml-auto tabular-nums text-[var(--muted)]">
              {allStores.length}
            </span>
          </button>
        </div>

        <Separator />

        <ScrollArea className="max-h-[320px]">
          <div className="p-2">
            {/* Amazon секция */}
            {amazonStores.length > 0 && (
              <>
                <div className="px-2 py-1.5 text-[11px] uppercase tracking-wider text-[var(--muted)] font-mono">
                  Amazon
                </div>
                {amazonStores.map((store) => (
                  <StoreRow
                    key={store.id}
                    store={store}
                    checked={selectedStoreIds.includes(store.id)}
                    onToggle={() => toggleStore(store.id)}
                  />
                ))}
              </>
            )}

            {/* Walmart секция */}
            {walmartStores.length > 0 && (
              <>
                <div className="px-2 py-1.5 mt-1 text-[11px] uppercase tracking-wider text-[var(--muted)] font-mono">
                  Walmart
                </div>
                {walmartStores.map((store) => (
                  <StoreRow
                    key={store.id}
                    store={store}
                    checked={selectedStoreIds.includes(store.id)}
                    onToggle={() => toggleStore(store.id)}
                  />
                ))}
              </>
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

function StoreRow({
  store,
  checked,
  onToggle,
}: {
  store: { id: string; name: string };
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "flex items-center gap-2 w-full px-2 py-2",
        "text-[13.5px] text-[var(--ink)]",
        "rounded-[6px] hover:bg-[var(--surface-2)]",
        "text-left"
      )}
    >
      <Checkbox checked={checked} />
      <span className="truncate">{store.name}</span>
    </button>
  );
}
```

> ⚠️ Если каких-то shadcn компонентов нет — установить:
> ```bash
> npx shadcn@latest add popover checkbox scroll-area separator
> ```

---

### 5. Замена селектора в Sidebar

Найди в `src/components/layout/Sidebar.tsx` (или где сейчас живёт сломанный селектор) блок с "All stores 5". Замени на `<StoreFilterSelector />`.

Если сейчас там просто статичный JSX без обработчика — снести его и подставить новый компонент.

---

### 6. Обновление индикатора "X stores live" в Header

Найди в `src/components/layout/Header.tsx` (или AppShell) плашку **"5 stores live"** справа сверху рядом с уведомлениями.

Замени её содержимое на динамический расчёт через `useStoreFilter`:

```tsx
"use client";
import { useStoreFilter } from "@/lib/store-filter/StoreFilterContext";

function StoresLiveBadge() {
  const { selectedStoreIds, allStores, isAllSelected } = useStoreFilter();

  let label: string;
  if (selectedStoreIds.length === 0) label = "No stores selected";
  else if (isAllSelected) label = `All ${allStores.length} stores live`;
  else label = `${selectedStoreIds.length} of ${allStores.length} stores`;

  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--surface-2)] text-[12px] text-[var(--ink)]">
      <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent-green)]" />
      <span className="tabular-nums">{label}</span>
    </div>
  );
}
```

---

### 7. Применение фильтра к Dashboard данным

Все API endpoints, которые подают данные на Dashboard, должны принимать query param `storeIds` (csv).

Найди endpoint(ы) которые сейчас дёргает Dashboard. Скорее всего это:
- `/api/dashboard/summary` — общие карточки
- Возможно отдельные: `/api/dashboard/awaiting-fulfilment`, `/api/dashboard/shipping-progress`, `/api/dashboard/customer-queue`

Если есть один общий `/api/dashboard/summary` — добавь туда поддержку:

```typescript
// GET /api/dashboard/summary?storeIds=id1,id2,id3
// Если storeIds не передан или пустой — вернуть данные по ВСЕМ магазинам (default = all)
// Если передан — фильтровать каждый запрос по `WHERE storeId IN (...)`

const url = new URL(request.url);
const storeIdsParam = url.searchParams.get("storeIds");
const storeIds = storeIdsParam
  ? storeIdsParam.split(",").filter(Boolean)
  : null; // null = все

// в запросах:
// const where = storeIds ? { storeId: { in: storeIds } } : {};
// const orders = await prisma.amazonOrder.findMany({ where });
```

Если эндпоинты разрозненные — добавь во все, которые показывают данные на Dashboard.

**Walmart-карточки** (Walmart 30D, Returns, Refunds 7D, Health) — должны фильтроваться только по выбранным Walmart-магазинам. Логика:

```typescript
// Получить из storeIds только те, у которых channel = "Walmart"
const walmartStoreIds = await prisma.store
  .findMany({ where: { id: { in: storeIds ?? [] }, channel: "Walmart" } })
  .then((rows) => rows.map((r) => r.id));

// Walmart-данные ВСЕГДА фильтруются только по walmartStoreIds
// (если он пуст — Walmart-секцию вообще не считать на бэке, на фронте скрыть)
```

---

### 8. Изменения в `src/app/page.tsx` (Dashboard)

Главная страница Dashboard. Что нужно сделать:

1. **Подтянуть selected stores из контекста:**

```tsx
"use client";
import { useStoreFilter } from "@/lib/store-filter/StoreFilterContext";

export default function DashboardPage() {
  const { selectedStoreIds, hasWalmart, hasAmazon, isLoading } = useStoreFilter();

  // Fetch с фильтром
  const queryString = selectedStoreIds.length > 0
    ? `?storeIds=${selectedStoreIds.join(",")}`
    : "";
  
  // SWR / React Query / fetch:
  const { data, isLoading: dataLoading } = useSWR(
    `/api/dashboard/summary${queryString}`,
    fetcher,
    { revalidateOnFocus: false }
  );

  if (isLoading || dataLoading) return <DashboardSkeleton />;
  if (selectedStoreIds.length === 0) return <EmptyState />;

  return (
    <div>
      {/* Header строка с заголовком и кнопками Refresh / Generate plan */}
      
      {/* 1-й ряд: 4 общих карточки */}
      <CardsRow>
        <Card>Orders 30D</Card>
        <Card>Awaiting Ship</Card>
        <Card>Cases Open</Card>
        <Card>Health Issues</Card>
      </CardsRow>

      {/* 2-й ряд: 4 Walmart-карточки — показываются ТОЛЬКО если hasWalmart */}
      {hasWalmart && (
        <CardsRow>
          <Card>Walmart 30D</Card>
          <Card>Walmart Returns</Card>
          <Card>Walmart Refunds 7D</Card>
          <Card>Walmart Health</Card>
        </CardsRow>
      )}

      {/* Awaiting fulfilment / Shipping progress / Customer queue блоки */}
      {/* Все они тоже получают данные с учётом storeIds */}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-[var(--muted)]">
      <p className="text-sm">Select at least one store to view dashboard data.</p>
    </div>
  );
}
```

2. **Adaptive layout** — когда Walmart-ряд скрыт, не оставляй пустое пространство. Grid должен быть compact.

3. **Орёл-карточка "Orders 30D"** — если выбраны только Walmart магазины, число должно быть из Walmart (как 718 на сегодняшнем скриншоте). Если выбраны и те и другие — общая сумма Amazon orders + Walmart orders за 30 дней. Если только Amazon — только Amazon orders.

4. **Карточка "Health Issues"** — суммировать Amazon Account Health alerts (по выбранным Amazon stores) + Walmart Performance violations (по выбранным Walmart stores).

5. **Карточка "Cases Open"** — сейчас на скриншоте показывает "3, 15 A-to-Z active". Это count из BuyerMessage (Customer Hub) WHERE store ∈ selectedStoreIds AND status = OPEN. Walmart кейсы тоже учитывать (channel = "Walmart" в BuyerMessage).

---

### 9. Awaiting fulfilment / Shipping progress / Customer queue

Эти три блока в нижней части Dashboard тоже фильтровать:

- **Awaiting fulfilment** (таблица заказов внизу): WHERE storeId IN (selectedStoreIds). Если в выборе нет Walmart — Walmart-заказы не показывать. Колонка "Store" в таблице должна показывать иконку магазина (Amazon/Walmart) и его имя — сейчас на скриншоте видно проблему: иконка не прорисована (вопросительный знак ?), просто "AMAZON". Это отдельно — но раз уж трогаем, сделай корректную привязку к магазину (имя магазина из storeId через `selectedStores`).

- **Shipping progress** (правая колонка): "0 / 11 labels purchased today" — должно фильтроваться по выбранным магазинам.

- **Customer queue** (правая колонка): C7 / C5 / C7 / C5 — Walmart кейсы. Эти видны только если Walmart в выборе. Если выбраны Amazon stores — показывать их кейсы.

---

## 📊 ИТОГОВАЯ КАРТИНКА UX

### Сценарий 1: открыл страницу впервые
- В сайдбаре селектор показывает **"All stores · 6"** с зелёной точкой.
- В шапке справа **"All 6 stores live"** с зелёной точкой.
- На Dashboard видны оба ряда карточек (4 общих + 4 Walmart).
- Все данные — суммарные по 6 магазинам.

### Сценарий 2: кликнул на селектор, снял Walmart
- В сайдбаре сразу обновляется на **"5 of 6 stores"**.
- В шапке справа **"5 of 6 stores"**.
- Walmart-ряд карточек **исчезает с анимацией** (или просто mount/unmount).
- Все остальные карточки пересчитались под 5 Amazon-аккаунтов.
- Customer queue показывает только Amazon кейсы.

### Сценарий 3: оставил только Salutem Solutions
- Сайдбар: **"Salutem Solutions"** (только имя, без числа).
- Шапка: **"1 of 6 stores"**.
- Карточки показывают данные только по Salutem.
- Walmart-ряд скрыт.

### Сценарий 4: оставил только Walmart
- Сайдбар: **"SIRIUS TRADING INTERNATIONAL LLC"** (truncate если не помещается).
- Шапка: **"1 of 6 stores"**.
- Верхний ряд карточек показывает только Walmart данные.
- Нижний ряд Walmart-карточек тоже виден (детализация).

### Сценарий 5: снял все
- Сайдбар: **"No stores"** с цифрой 0.
- Шапка: **"No stores selected"** (точка серая или красная).
- На Dashboard — EmptyState: "Select at least one store to view dashboard data."

---

## 🗂️ СТРУКТУРА ФАЙЛОВ

```
src/
├── app/
│   ├── layout.tsx                              # обернуть в StoreFilterProvider
│   ├── page.tsx                                # Dashboard — переделать с useStoreFilter
│   └── api/
│       ├── stores/
│       │   └── route.ts                        # GET /api/stores (новый или существующий)
│       └── dashboard/
│           └── summary/route.ts                # добавить поддержку storeIds
├── components/
│   └── layout/
│       ├── Sidebar.tsx                         # заменить статичный селектор на StoreFilterSelector
│       ├── Header.tsx                          # заменить "5 stores live" на StoresLiveBadge
│       └── StoreFilterSelector.tsx             # ← НОВЫЙ
├── lib/
│   └── store-filter/
│       └── StoreFilterContext.tsx              # ← НОВЫЙ (Provider + hook)
└── components/ui/
    ├── popover.tsx                              # shadcn (если нет — добавить)
    ├── checkbox.tsx                             # shadcn
    ├── scroll-area.tsx                          # shadcn
    └── separator.tsx                            # shadcn

prisma/
├── schema.prisma                                # проверить модель Store (channel field)
└── seeds/
    └── walmart-store.ts                         # ← НОВЫЙ (если Walmart нет в БД)
```

---

## 🧪 ACCEPTANCE CRITERIA (Vladimir проверит вручную)

После реализации убедись что **ВСЕ** пункты работают:

- [ ] При открытии Dashboard в селекторе видно **"All stores · 6"**.
- [ ] В шапке справа видно **"All 6 stores live"**.
- [ ] Клик на селектор открывает dropdown с двумя секциями: AMAZON (5 чекбоксов) и WALMART (1 чекбокс).
- [ ] Над секциями есть master чекбокс "All stores" с цифрой 6.
- [ ] При клике на чекбокс одного магазина — данные на Dashboard обновляются **сразу**, без кнопки Apply.
- [ ] Когда снимаешь все Walmart-чекбоксы — нижний ряд карточек (Walmart 30D / Returns / Refunds / Health) исчезает.
- [ ] Когда оставляешь только Walmart — верхний ряд показывает Walmart данные (Orders 30D = 718 как в Walmart 30D карточке).
- [ ] Когда выбрано **1** — селектор показывает имя магазина.
- [ ] Когда выбрано **несколько (не все)** — селектор показывает "N of 6 stores".
- [ ] Когда снято всё — Dashboard показывает Empty State с текстом "Select at least one store…".
- [ ] При **F5 (refresh страницы)** — выбор сбрасывается на "All stores · 6" (НЕ персистится).
- [ ] При закрытии и открытии Popover — выбор сохраняется (внутри сессии).
- [ ] Никаких ошибок в консоли. Никаких TypeScript ошибок: `npm run build` проходит.
- [ ] Dropdown стилизован под Salutem design system (radius 10px, текст --ink, фон зеленовато-кремовый при hover).
- [ ] На "Awaiting fulfilment" таблице ниже — колонка Store правильно показывает имя магазина (сейчас на скриншоте — вопросительный знак, нужно поправить).
- [ ] Walmart-store существует в БД (`SELECT * FROM Store WHERE channel = 'Walmart'` возвращает 1 строку).

---

## 📋 ЭТАПЫ И КОММИТЫ

Делай маленькими шагами, коммитя после каждого:

1. `chore(db): verify Store schema has channel field, add if missing` — миграция channel (если нужна)
2. `feat(db): seed Walmart store SIRIUS TRADING INTERNATIONAL LLC` — seed скрипт + запуск
3. `feat(api): GET /api/stores endpoint` — список всех магазинов
4. `feat(state): add StoreFilterContext provider` — глобальный state
5. `chore(layout): wrap app with StoreFilterProvider` — в layout.tsx
6. `feat(ui): StoreFilterSelector component (multi-select popover)` — новый компонент
7. `feat(sidebar): replace static "All stores" with StoreFilterSelector` — замена в Sidebar
8. `feat(header): dynamic "X stores live" badge` — замена в Header
9. `feat(api): support storeIds filter in /api/dashboard/summary` — фильтрация на бэке
10. `feat(dashboard): apply store filter to all cards and tables` — переделать page.tsx
11. `feat(dashboard): hide Walmart cards row when no Walmart selected` — adaptive layout
12. `fix(dashboard): correct store name in Awaiting fulfilment table` — заодно поправить вопросики
13. `docs(wiki): document store filter system` — wiki

---

## 📚 WIKI + ДОКУМЕНТАЦИЯ (обязательно)

По правилам проекта — после реализации:

### `docs/wiki/store-filter-system.md` (новый)

```markdown
# Global Store Filter — System Notes

## Цель
Глобальный фильтр выбора магазинов в SS Control Center. Применяется в Dashboard (Phase 1), будет расширен на Customer Hub, Adjustments, Account Health, Shipping Labels (Phase 2).

## Источник правды
Таблица `Store` в Prisma. 6 активных магазинов:
- 5 Amazon: Salutem Solutions, Vladimir Personal, AMZ Commerce, Sirius International, Retailer Distributor
- 1 Walmart: SIRIUS TRADING INTERNATIONAL LLC (Seller ID 10001624309)

## State management
React Context (`src/lib/store-filter/StoreFilterContext.tsx`)
- Не персистится в localStorage (намеренно — каждая сессия начинается с All stores).
- Provider в root layout (`src/app/layout.tsx`).
- Hook: `useStoreFilter()`.

## UI компоненты
- `StoreFilterSelector` (`src/components/layout/StoreFilterSelector.tsx`) — в Sidebar.
- `StoresLiveBadge` (в `Header.tsx`) — в Topbar.

## API
- `GET /api/stores` — список всех магазинов.
- Все Dashboard endpoints принимают `?storeIds=id1,id2,id3` query param.

## Связи
- store-filter-system → dashboard
- store-filter-system ← prisma.Store
- store-filter-system ⊂ ss-control-center

## Phase 2 — расширение
- Customer Hub (`/customer-hub`) — заменить локальный фильтр аккаунта на глобальный.
- Adjustments (`/adjustments`) — заменить локальный store dropdown.
- Account Health — фильтр по выбранным магазинам.
- Shipping Labels — фильтр awaiting_fulfillment по магазинам.
```

### `docs/wiki/CONNECTIONS.md` — добавить

```markdown
## Global Store Filter

store-filter-system.md → dashboard
store-filter-system.md ← prisma.Store (channel field)
store-filter-system.md → /api/stores
store-filter-system.md → /api/dashboard/summary (storeIds param)
store-filter-system.md ⇔ sidebar.StoreFilterSelector
store-filter-system.md ⇔ header.StoresLiveBadge

## Phase 2 connections (planned)
store-filter-system.md → customer-hub-algorithm-v2.1
store-filter-system.md → adjustments-algorithm-v1.0
store-filter-system.md → account-health
```

### `docs/wiki/index.md` — добавить

```markdown
- [Store Filter System](store-filter-system.md) — Global multi-select store filter (Dashboard Phase 1) — 2026-05-12
```

### `docs/STORE_FILTER_SYSTEM_SPEC_v1_0.md`

Создать reference-level spec на основе этого промпта — детали API, edge cases, расширение на другие модули в Phase 2.

---

## ❓ ЕСЛИ ВОЗНИКНЕТ НЕОПРЕДЕЛЁННОСТЬ

1. **Если модель `Store` в Prisma имеет другие поля (например `marketplace` вместо `channel`)** — использовать существующее имя, не переименовывать. Главное — фильтровать по Amazon/Walmart.

2. **Если `/api/dashboard/summary` сейчас отдаёт всё одним JSON** — добавь поддержку фильтра через WHERE. Если в Dashboard несколько разных fetch'ей — обнови каждый.

3. **Если SWR / React Query не используется в проекте, и Dashboard fetch'ает через `useEffect`** — пересохрани логику, добавь зависимость от `selectedStoreIds` в массив зависимостей, чтобы fetch перезапускался при изменении выбора.

4. **Если в Sidebar.tsx селектор склеен с другой логикой (расширение/сворачивание sidebar)** — изоляровать селектор в отдельный компонент чтобы не сломать остальное.

5. **Если задача "поправить вопросики в Awaiting fulfilment store column" окажется большой** — отложи в отдельный коммит, не блокируй основной фикс.

**НЕ делать:**
- Не использовать localStorage / sessionStorage / IndexedDB для выбора магазинов.
- Не делать кнопку "Apply" — фильтр live.
- Не отображать Walmart-карточки с прочерками — полностью скрывать ряд.
- Не трогать другие страницы (Customer Hub, Adjustments, etc.) — это Phase 2.
- Не менять схему БД сверх необходимости (только если поля `channel` нет).
- Не коммитить вместе с другими фичами — этот промпт = одна изолированная feature branch.

---

## 🏁 FINISH CRITERIA

Этап считается завершённым когда:

1. Все 13 пунктов из ACCEPTANCE CRITERIA выполнены.
2. `npm run build` без warnings и errors.
3. `npx prisma generate && npx prisma migrate dev` без ошибок.
4. Walmart-store существует в БД (verified через `npx prisma studio`).
5. Wiki обновлено (4 файла: `store-filter-system.md`, `CONNECTIONS.md`, `index.md`, `STORE_FILTER_SYSTEM_SPEC_v1_0.md`).
6. Все 13 коммитов на ветке `feature/dashboard-store-selector`.
7. Pull Request открыт (или merge в main если работаешь напрямую).

После этого — дать знать Vladimir для приёмки.
