# 📱 Claude Code Prompt — Mobile Adaptation Phase 2 (FULL — все оставшиеся таблицы)

**Дата:** 2026-05-04
**Зависимости:** Phase 1 (App Shell + Procurement) уже выполнен. Phase 0 audit `docs/MOBILE_ADAPTATION_AUDIT.md` — справка.
**Брейкпоинт:** `md = 768px` (Tailwind default)
**Оценка:** 8–12 часов работы Claude Code (это БОЛЬШАЯ задача, разбита на 4 подэтапа)
**Стиль:** Clade Code должен сам поддерживать чек-лист прогресса в файле `docs/MOBILE_PHASE_2_PROGRESS.md` (см. § 1).

---

# 🚨 КАК РАБОТАТЬ С ЭТИМ ПРОМПТОМ

Это очень большой промпт — НЕ пытайся выполнить всё за один проход. Действуй так:

1. **Прочитай весь промпт целиком** (один раз, до начала работы)
2. **Создай файл `docs/MOBILE_PHASE_2_PROGRESS.md`** со списком всех задач из master-чеклиста (§ 1) — отметь все как `[ ]`
3. **Работай по этапам:** 2A → 2B → 2C → 2D последовательно. **После каждой задачи отмечай в progress-файле как `[x]`**
4. **После каждого этапа (2A, 2B, 2C, 2D)** делай отдельный git commit с предложенным сообщением (см. конец каждого этапа)
5. **Если что-то непонятно или ты сталкиваешься с неожиданным состоянием кода** — НЕ гадай, добавь заметку в progress-файл секцию `## ⚠️ Questions for Vladimir` и продолжай со следующей задачей. Vladimir прочитает утром.
6. **После всего** — выполни § 9 (грэпы и финальная проверка) и § 10 (wiki updates)

Это позволяет тебе работать всю ночь даже если будут перерывы — прогресс не потеряется.

---

# 0. TL;DR

После Phase 1 App Shell на мобиле работает (sidebar→drawer, hamburger, padding 16px). Теперь нужно адаптировать **~10 таблиц + точечные фиксы**, чтобы вся работа в SS Control Center была возможна с iPhone.

**Универсальный паттерн:** каждая таблица получает рядом с собой **mobile-cards версию**. На `< md` показываются карточки (`md:hidden`), на `≥ md` — оригинальная таблица (`hidden md:block`). Существующая логика данных, сортировка, фильтры, click handlers — всё переиспользуется.

---

# 1. Master Checklist

Создай этот чек-лист в `docs/MOBILE_PHASE_2_PROGRESS.md` сразу после прочтения промпта. Веди его в течение всей работы.

```md
# Mobile Phase 2 — Progress

## Phase 2A — Customer Hub (приоритет)
- [ ] 2A.1 — MessagesTab (9 колонок) → mobile-cards
- [ ] 2A.2 — AtozTab (8 колонок) → mobile-cards
- [ ] 2A.3 — ChargebacksTab (клон AtozTab) → mobile-cards
- [ ] 2A.4 — FeedbackTab → mobile-cards
- [ ] 2A.5 — MessageDetail action row → flex-wrap
- [ ] 2A — git commit

## Phase 2B — Dashboard + Adjustments
- [ ] 2B.1 — Dashboard awaiting-fulfilment (6 колонок) → mobile-cards
- [ ] 2B.2 — AdjustmentsTable (8 колонок) → mobile-cards
- [ ] 2B.3 — SkuIssuesPanel (7 колонок) → mobile-cards
- [ ] 2B — git commit

## Phase 2C — Frozen + Claims + Feedback + Account Health
- [ ] 2C.1 — Frozen IncidentsTable → mobile-cards
- [ ] 2C.2 — Frozen SkuRiskTable → mobile-cards
- [ ] 2C.3 — Claims AtozTable → mobile-cards
- [ ] 2C.4 — Feedback FeedbackTable → mobile-cards
- [ ] 2C.5 — Account Health MetricRow → flex-col sm:flex-row
- [ ] 2C — git commit

## Phase 2D — Shipping + Settings (самые сложные)
- [ ] 2D.1 — Shipping main grid → mobile-cards
- [ ] 2D.2 — Shipping skuModal grid-cols-4 → grid-cols-2 sm:grid-cols-4
- [ ] 2D.3 — Shipping tagModal & skuModal — рефикс blue palette → Salutem
- [ ] 2D.4 — Shipping error block bg-red-50 → bg-danger-tint
- [ ] 2D.5 — Settings SKU Database (9 колонок) → mobile-cards
- [ ] 2D.6 — Settings GmailAccountsPanel rows → flex-col sm:flex-row
- [ ] 2D.7 — Settings SpApiStoresPanel rows → flex-col sm:flex-row
- [ ] 2D.8 — Settings AiProvidersPanel selects → w-52 → w-full sm:w-52
- [ ] 2D — git commit

## Bonus / опциональные
- [ ] B.1 — Procurement badge: добавить ordersToBuy в /api/dashboard/summary

## Финал
- [ ] § 9 — Универсальная grep-проверка
- [ ] § 10 — Wiki update (mobile-adaptation.md, CONNECTIONS.md, index.md)
- [ ] Финальный git push

## ⚠️ Questions for Vladimir
(добавляй сюда заметки если столкнёшься с неожиданным состоянием кода)
```

---

# 2. Stack & Context

- **Next.js 16.2.2**, **React 19.2.4**, **Tailwind v4** (`@theme inline` в `globals.css`)
- **shadcn/ui** уже установлен — `Card`, `CardContent`, `Badge`, `Button`, `Table`, `Dialog`, `Sheet` доступны
- **Salutem Design System** активен — все токены (`--green`, `--ink`, `--ink-2`, `--ink-3`, `--ink-4`, `--green-cream`, `--bg-elev`, `--surface`, `--surface-tint`, `--rule`, `--rule-strong`, `--green-soft`, `--green-soft2`, `--green-ink`, `--warn-tint`, `--warn-strong`, `--danger`, `--danger-tint`, `--info`, `--info-tint`)
- **Phase 1 уже добавил:** `MobileNavProvider` в `layout.tsx`, hamburger в Header, `useIsMobile` hook в `src/lib/use-is-mobile.ts` (можешь использовать если потребуется conditional logic, но **предпочитай Tailwind `md:` classes** — они SSR-safe и не требуют hydration)

---

# 3. ⚠️ Что НЕ трогать

1. **Бизнес-логика** — не менять API routes (`src/app/api/`), Prisma schema, server actions, DAL (`src/lib/db/`), fetch-вызовы, useEffect логика, state management.
2. **Salutem Design System tokens** — все цвета и spacing берутся из существующих CSS variables. Не добавлять новых токенов.
3. **shadcn/ui base components** — `src/components/ui/*` остаются как есть (Phase 1 их не трогал, и Phase 2 тоже не должен).
4. **Текстовые тексты** — labels, headers, placeholder'ы остаются как есть. Не переводить английский на русский или наоборот без явной просьбы.
5. **Существующие responsive grids** (`sm:grid-cols-2`, `lg:grid-cols-4`, etc.) — они уже работают, не ломать.
6. **Phase 1 файлы** (`SidebarContent.tsx`, `MobileNav.tsx`, `mobile-nav-context.tsx`, `use-is-mobile.ts`, `Header.tsx` после Phase 1, `AppShell.tsx` после Phase 1) — НЕ изменять.
7. **Запрещённые цвета:**
   - `bg-blue-*`, `text-blue-*`, `border-blue-*`, `from-blue-*`, `to-indigo-*`
   - `bg-gray-*`, `text-gray-*`, `border-gray-*`
   - `text-slate-*`, `border-slate-*`, `bg-slate-*`
   - `bg-red-*`, `text-red-*` (использовать `bg-danger-tint` / `text-danger`)
   - `text-white` на зелёном фоне (использовать `text-green-cream`)
   - `text-black` (использовать `text-ink`)
   - **Mapping** см. в `docs/CLAUDE_CODE_PROMPT_LEGACY_REBRAND.md` § 2 (применённый в Login/Invite/StoreTabs).

---

# 4. Universal Mobile-Card Pattern (СНАЧАЛА ПРОЧИТАЙ И ВНУТРЕННЕ ОСВОЙ)

Это шаблон, который ты будешь применять ко **всем** таблицам в Phase 2. Один раз привыкнешь — потом будешь применять его к каждой таблице за 5-10 минут.

## 4.1. Базовый паттерн — две версии в одном компоненте

```tsx
// Внутри компонента, который раньше рендерил <Table>:

return (
  <Card>
    <CardContent className="p-0">
      {/* ── Filters/toolbar (общие для обеих версий) ── */}
      <div className="...filter bar...">...</div>

      {/* ── Empty/loading states (общие) ── */}
      {loading && <LoadingState />}
      {!loading && items.length === 0 && <EmptyState />}

      {/* ── DESKTOP: original table (≥ md) ── */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>...</TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.id} ...>
                <TableCell>...</TableCell>
                ...
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* ── MOBILE: cards (< md) ── */}
      <div className="md:hidden divide-y divide-rule">
        {items.map((item) => (
          <MobileCard key={item.id} item={item} ...handlers... />
        ))}
      </div>
    </CardContent>
  </Card>
);
```

**Ключевые правила:**
1. **Один источник данных** — items.map() рендерится дважды (раз в Table, раз в cards), но данные одни и те же.
2. **Click handlers одни и те же** — если в Table тапнули на row → открыть detail panel, то в card тапнули на card → то же самое.
3. **Filters/empty states/toolbar — один раз** перед обоими блоками.
4. **`hidden md:block`** на Table — он не рендерится в DOM на мобиле (важно для performance).
5. **`md:hidden`** на cards — они не рендерятся на desktop.

## 4.2. Структура mobile card

```tsx
function MobileCard({ item, onClick, isSelected }) {
  return (
    <div
      onClick={onClick}
      className={cn(
        // Базовый стиль карточки
        "px-4 py-3 cursor-pointer transition-colors hover:bg-surface-tint active:bg-bg-elev",
        // Selected/active state
        isSelected && "bg-green-soft"
      )}
    >
      {/* HEAD: главная инфа сверху, важная справа */}
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-medium text-ink truncate">
            {/* Главное поле — например, customer name или product name */}
            {item.primaryField}
          </div>
          <div className="text-[11px] text-ink-3 mt-0.5">
            {/* Subline — например, store + date */}
            {item.subline}
          </div>
        </div>
        <div className="shrink-0">
          {/* Badge / status / urgency справа */}
          <Badge>...</Badge>
        </div>
      </div>

      {/* BODY: дополнительные поля (опционально, не более 2-3 строк) */}
      <div className="text-[12px] text-ink-2 line-clamp-2">
        {item.preview}
      </div>

      {/* FOOTER: meta-инфа мелким шрифтом */}
      <div className="mt-2 flex items-center justify-between gap-2 text-[10.5px] text-ink-3">
        <span className="font-mono truncate">{item.orderId}</span>
        <span className="tabular shrink-0">{item.timestamp}</span>
      </div>
    </div>
  );
}
```

## 4.3. Принципы выбора что показывать

Когда у таблицы 9 колонок, **не пытайся уместить всё** в карточку. Применяй приоритеты:

**Приоритет 1 — главное (всегда видно):**
- Идентификатор (имя клиента, имя продукта, номер заказа)
- Время / дедлайн
- Статус / срочность

**Приоритет 2 — важное (видно):**
- Категория / тип
- Сумма (если применимо)
- Магазин / channel

**Приоритет 3 — детали (можно скрыть или показать в footer мелким):**
- Carrier / service
- SKU
- Tracking
- Notes

**Приоритет 4 — скрыть на мобиле:**
- Технические колонки (`_productId`, etc.)
- Длинные timestamps (показать как `2h`, `5d` через timeAgo)

**Размеры:** font main `text-[13.5px]`, secondary `text-[12px]`, footer `text-[10.5px]`. Padding `px-4 py-3`. Gap `gap-2`. Между карточками — `divide-y divide-rule`.

## 4.4. Touch targets в карточках

Все интерактивные элементы внутри карточки должны быть минимум **36×36px (h-9 w-9)** на мобиле. Если элемент маленький (например, badge), сама карточка должна быть кликабельной. Если на карточке несколько action-buttons — используй `e.stopPropagation()` чтобы не сработал основной click.

## 4.5. Полный worked example (MessagesTab) — увидишь в § 4.A.1

Для MessagesTab я даю готовый код mobile-card компонента целиком. Используй его как референс при адаптации остальных таблиц.

---

# 4.A. PHASE 2A — Customer Hub (СТАРТ ОТСЮДА)

## 4.A.1. Задача 2A.1 — MessagesTab (9 колонок → mobile-cards)

**Файл:** `src/components/customer-hub/MessagesTab.tsx`

### Текущая структура таблицы (что заменяем)

9 колонок:
1. Status dot (10px кружок цвета статуса)
2. Date (короткий формат: "Jan 15")
3. Store (имя магазина)
4. Customer (имя клиента + Repeat badge для T20)
5. Order (Amazon Order ID, обрезанный)
6. Category (T-код + название)
7. Risk (LOW/MEDIUM/HIGH/CRITICAL — цветной badge)
8. Action (REPLACEMENT/REFUND/etc. — цветной badge)
9. Respond By (`<ResponseDeadline>` компонент)

Click on row → `setSelectedId(message.id)` → ниже рендерится `<MessageDetail messageId={selectedId} />`.

### Mobile-card layout

**Что показываем:**
- HEAD: Customer name + Status dot (слева). Risk Badge (справа).
- SUB: Store · Category code/name · Repeat если T20
- ACTION row: Action badge + ResponseDeadline (срочность ВАЖНА)
- FOOTER: Order ID (mono, обрезанный) · Date

### Готовый код (вставить в MessagesTab.tsx)

Найди блок `{messages.length === 0 ? (...) : (<Table>...</Table>)}` и замени `<Table>` секцию так, чтобы было два варианта:

```tsx
{messages.length === 0 ? (
  // ... существующий empty state без изменений
) : (
  <>
    {/* DESKTOP: original table (≥ md) */}
    <div className="hidden md:block">
      <Table>
        <TableHeader>
          {/* ... всё что было — без изменений */}
        </TableHeader>
        <TableBody>
          {messages.map((m) => (
            <TableRow key={m.id} ...>
              {/* ... все 9 колонок — без изменений ... */}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>

    {/* MOBILE: cards (< md) */}
    <div className="md:hidden divide-y divide-rule">
      {messages.map((m) => (
        <button
          key={m.id}
          onClick={() => setSelectedId(selectedId === m.id ? null : m.id)}
          className={`w-full text-left px-4 py-3 transition-colors hover:bg-surface-tint active:bg-bg-elev ${selectedId === m.id ? "bg-green-soft" : ""}`}
        >
          {/* HEAD: customer + status dot + risk badge */}
          <div className="flex items-start justify-between gap-2 mb-1.5">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <span
                className={`inline-block h-2.5 w-2.5 rounded-full shrink-0 ${statusDot[m.status] || "bg-ink-4"}`}
                title={m.status}
              />
              <span className="text-[13.5px] font-medium text-ink truncate">
                {m.customerName || "Customer"}
              </span>
              {m.problemType === "T20" && (
                <Badge className="bg-danger-tint text-danger text-[9px] px-1 py-0 shrink-0">
                  Repeat
                </Badge>
              )}
            </div>
            {m.riskLevel && (
              <Badge className={`${riskColors[m.riskLevel] || ""} shrink-0 text-[10px]`}>
                {m.riskLevel}
              </Badge>
            )}
          </div>

          {/* SUB: store + category */}
          <div className="text-[11.5px] text-ink-3 mb-1.5 truncate">
            {m.storeName}
            {m.category && (
              <>
                <span className="mx-1.5 text-ink-4">·</span>
                <span className="font-mono">{m.category}</span>
                {m.categoryName && <span> {m.categoryName}</span>}
              </>
            )}
          </div>

          {/* ACTION row: action badge + deadline */}
          <div className="flex items-center justify-between gap-2 mb-1">
            {m.action ? (
              <Badge className={`${actionColors[m.action] || "bg-bg-elev text-ink-2"} text-[10px]`}>
                {m.action}
              </Badge>
            ) : (
              <span className="text-ink-4 text-[10.5px]">Not analyzed</span>
            )}
            <div className="shrink-0">
              <ResponseDeadline
                createdAt={m.receivedAt || m.createdAt}
                status={m.status}
              />
            </div>
          </div>

          {/* FOOTER: order id + date */}
          <div className="flex items-center justify-between gap-2 text-[10.5px] text-ink-3">
            <span className="font-mono truncate">
              {m.amazonOrderId ? m.amazonOrderId.substring(0, 19) + "…" : "—"}
            </span>
            <span className="tabular shrink-0">
              {new Date(m.createdAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              })}
            </span>
          </div>
        </button>
      ))}
    </div>
  </>
)}
```

**ВАЖНО:** Я обернул mobile-card в `<button>` потому что вся карточка кликабельная. Это лучше для accessibility (keyboard nav, screen readers), чем `<div onClick>`. Везде в Phase 2 используй `<button>` для интерактивных карточек.

### Дополнительно — fix существующих legacy цветов в MessagesTab

В файле сейчас есть:
- `bg-danger-tint0` (опечатка? должно быть `bg-danger-tint`?) — проверь и исправь если опечатка
- `bg-green-soft0`, `bg-green-soft2` — это валидные Salutem токены
- `bg-yellow-500` — это Tailwind palette, ЗАПРЕЩЁН. Заменить на `bg-warn-strong`
- `bg-red-600 text-white` (в `riskColors.CRITICAL`) — заменить на `bg-danger text-green-cream`
- `bg-orange-100 text-orange-700` (в `actionColors.REFUND`) — заменить на `bg-warn-tint text-warn-strong`
- `border-slate-100` (в filter tabs) — заменить на `border-rule`
- `bg-slate-300` (в status dot fallback) — заменить на `bg-ink-4`

Также внимательно: `bg-green-soft0` и `bg-danger-tint0` могут быть опечатками. Если grep покажет что таких токенов в `globals.css` нет — это опечатки, исправь на `bg-green-soft` и `bg-danger-tint`.

---

## 4.A.2. Задача 2A.2 — AtozTab (8 колонок → mobile-cards)

**Файл:** `src/components/customer-hub/AtozTab.tsx`

### Колонки (читать из текущего файла)

8 колонок: status + store + orderId + carrier + amount + deadline + whoPaid + strategy. Плюс над таблицей summary `grid-cols-2 md:grid-cols-5` — он уже responsive ✅, не трогать.

### Mobile-card layout

- HEAD: Order ID (mono, главное) + amount (`$XX.XX`, справа)
- SUB: Store · Carrier · Strategy (badge)
- ACTION row: Status (badge) · Deadline (если есть)
- FOOTER: Who pays (small text)

### Применить паттерн из § 4.1

Используй ту же двойную структуру `<div className="hidden md:block">` + `<div className="md:hidden divide-y divide-rule">`. Mobile-card построй по образцу из 2A.1 — adapt fields.

**Если есть expand-row** (некоторые таблицы customer-hub имеют expand):
- В desktop expand-row остаётся через `<TableRow>` под основной row
- В mobile тапни на карточку → она расширяется inline (используй local state `expandedId`)
- Внутри expanded card используй `grid-cols-1 sm:grid-cols-2` (1 колонка на мобиле, 2 на ширях)

### Dialog (Add Claim) — точечный fix

В AtozTab есть Dialog для добавления claim'а с `grid-cols-2 gap-2` (Amount, Deadline). Это OK для мобилы (2 колонки по 50% — нормально). НЕ трогать.

---

## 4.A.3. Задача 2A.3 — ChargebacksTab

**Файл:** `src/components/customer-hub/ChargebacksTab.tsx`

ChargebacksTab — клон AtozTab (тот же паттерн). Применить тот же mobile-card подход.

### Колонки

Скорее всего идентичны AtozTab (status + store + orderId + carrier + amount + deadline + whoPaid + strategy). Если структура разная — адаптируй по принципам § 4.3.

---

## 4.A.4. Задача 2A.4 — FeedbackTab

**Файл:** `src/components/customer-hub/FeedbackTab.tsx`

FeedbackTab — вариация. Колонки скорее всего: rating (1-5 stars) + date + order + comment + status + ai-action.

### Mobile-card layout

- HEAD: Rating (5 звёзд) + status badge
- SUB: Customer name · Date
- BODY: Comment (line-clamp-3 — обрезаем длинные)
- FOOTER: Order ID · AI suggested action

---

## 4.A.5. Задача 2A.5 — MessageDetail action row → flex-wrap

**Файл:** `src/components/customer-hub/MessageDetail.tsx`

В файле есть action button row с **6+ кнопками** (Copy / Edit / Re-analyze / Rewrite ▾ / Responded in SC / Send) которые сейчас в `flex gap-2 mt-2` без wrap. На мобиле (< 380px) они переполняются за пределы экрана.

### Fix

Найди блок с этими кнопками (поиск по `Re-analyze` или `Rewrite` или `Send` в файле):

```tsx
// BEFORE:
<div className="flex gap-2 mt-2">
  <Button>Copy</Button>
  <Button>Edit</Button>
  <Button>Re-analyze</Button>
  ...
</div>

// AFTER:
<div className="flex flex-wrap gap-2 mt-2">
  <Button>Copy</Button>
  ...
</div>
```

Также проверь два других сжатых ряда:
- AI Analysis блок `grid-cols-2 gap-2 text-xs` — на мобиле бадж может переполняться. Замени на `grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs`. (Бадж займёт всю ширину, но он короткий — будет ок)
- Shipping & Tracking блок `grid-cols-2 gap-x-4 gap-y-1` — оставить как есть. На 380px ужмётся, но поля короткие (carrier, status, etc.).

### НЕ трогать

- Bilingual EN/RU блоки — они уже `grid-cols-1 md:grid-cols-2` ✅
- Save to KB Dialog — `max-w-lg` Dialog на мобиле = full width, OK.

---

### Phase 2A — git commit

После завершения всех 2A.1-2A.5:
```bash
git add -A
git commit -m "feat(mobile): Phase 2A — Customer Hub tables → mobile-cards

- MessagesTab (9 cols) responsive table+cards
- AtozTab (8 cols) responsive
- ChargebacksTab responsive
- FeedbackTab responsive
- MessageDetail action row: flex-wrap (was overflowing < 380px)

Mobile-card pattern: <div className=\"hidden md:block\"><Table/></div>
plus <div className=\"md:hidden divide-y divide-rule\">cards</div>.
Click handlers, data, filters reused — only presentation differs.

Refs: docs/CLAUDE_CODE_PROMPT_MOBILE_PHASE_2.md § 4.A
"
```

Отметь в `MOBILE_PHASE_2_PROGRESS.md` `2A — git commit` как `[x]` и переходи к Phase 2B.

---

# 5. PHASE 2B — Dashboard + Adjustments

## 5.1. Задача 2B.1 — Dashboard awaiting-fulfilment table

**Файл:** `src/app/page.tsx`

### Текущая структура

В Dashboard есть Panel "Awaiting fulfilment" с обычной HTML `<table>` (НЕ shadcn `<Table>`). 6 колонок: Order, Store, Product, Type, Ship by, Status. Есть hover на rows.

### Mobile-card layout

- HEAD: Order ID (mono) + Status chip (справа)
- BODY (одна строка): Store с avatar + Product (truncate)
- FOOTER: Type tag · Ship by time

### Применить паттерн

Замени `<table>...</table>` на двойную структуру:

```tsx
{/* DESKTOP table */}
<div className="hidden md:block">
  <table className="w-full text-[12.5px]">
    <thead>...</thead>
    <tbody>...</tbody>
  </table>
</div>

{/* MOBILE cards */}
<div className="md:hidden divide-y divide-rule">
  {orders.map((o) => (
    <div key={o.id} className="px-4 py-3">
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <span className="font-mono text-[13px] text-ink truncate">{o.id}</span>
        <StatusChip variant={o.status === "Shipped" ? "delivered" : "ready"}>
          {o.status}
        </StatusChip>
      </div>
      <div className="flex items-center gap-2 mb-1.5">
        <StoreAvatar
          store={storeKeyFor({
            marketplace: o.marketplace,
            storeIndex: o.storeIndex,
            storeName: o.storeName,
          })}
          size="sm"
        />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] text-ink truncate">{o.storeName ?? "—"}</div>
          <div className="text-[10px] font-mono uppercase tracking-wider text-ink-3">
            {o.marketplace}
          </div>
        </div>
      </div>
      <div className="text-[12px] text-ink-2 truncate mb-1.5">
        {o.productName ?? "—"}
      </div>
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <TypeTag type={o.productType} />
        <span className="text-ink-3 tabular">
          {formatTime(o.shipBy)}
        </span>
      </div>
    </div>
  ))}
</div>
```

Empty state и loading state — оставь как есть, они уже работают.

### НЕ трогать

- Customer queue Panel — уже карточный формат ✅
- KPI grid — `sm:grid-cols-2 lg:grid-cols-4` ✅
- Walmart KPI grid — `sm:grid-cols-4` ✅
- Shipping progress Panel — уже компактный ✅
- Layout `grid-cols-[1fr_320px]` — работает ✅ (на мобиле стекается в 1 колонку, потому что нет lg: префикса... подожди, ОН ЕСТЬ — `lg:grid-cols-[1fr_320px]`. Проверь и убедись)

---

## 5.2. Задача 2B.2 — AdjustmentsTable (8 колонок → mobile-cards)

**Файл:** `src/components/adjustments/AdjustmentsTable.tsx`

### Колонки

8 колонок с expand-rows: expand + date + channel + orderId + sku + type + amount + status.

### Mobile-card layout

- HEAD: Order ID (mono) + Amount (`$XX.XX`, цвет по signum)
- SUB: SKU · Type
- ACTION row: Channel · Status badge
- FOOTER: Date (formatted)
- На tap → expand inline с дополнительными деталями

### Expand-row на mobile

```tsx
{expandedId === item.id && (
  <div className="px-4 pb-3 -mt-1 grid grid-cols-1 sm:grid-cols-2 gap-3 text-[11.5px]">
    <div>
      <div className="text-ink-3">Description</div>
      <div className="text-ink-2">{item.description}</div>
    </div>
    <div>
      <div className="text-ink-3">Notes</div>
      <div className="text-ink-2">{item.notes ?? "—"}</div>
    </div>
    {/* ... ещё поля из desktop expand-row ... */}
  </div>
)}
```

Использовать `expandedId` state (уже есть в существующем коде для desktop) — переиспользовать.

---

## 5.3. Задача 2B.3 — SkuIssuesPanel (7 колонок → mobile-cards)

**Файл:** `src/components/adjustments/SkuIssuesPanel.tsx`

### Колонки

7 колонок: sku + product + corrections + totalLoss + type + suggestedWeight + status.

### Mobile-card layout

- HEAD: SKU (mono) + Status badge
- SUB: Product (truncate)
- BODY (grid 2 cols): Corrections count · Total loss `$XX`
- FOOTER: Type · Suggested weight `X.X lb`

---

### Phase 2B — git commit

```bash
git add -A
git commit -m "feat(mobile): Phase 2B — Dashboard + Adjustments → mobile-cards

- Dashboard 'Awaiting fulfilment' table (6 cols) responsive
- AdjustmentsTable (8 cols, expand-rows) responsive
- SkuIssuesPanel (7 cols) responsive

Refs: docs/CLAUDE_CODE_PROMPT_MOBILE_PHASE_2.md § 5
"
```

---

# 6. PHASE 2C — Frozen + Claims + Feedback + Account Health

## 6.1. Задача 2C.1 — IncidentsTable (Frozen Analytics)

**Файл:** `src/components/frozen-analytics/IncidentsTable.tsx`

Большая таблица с **12+ полей** на incident: orderId, sku, productName, carrier, service, shipDate, promisedEdd, actualDelivery, daysInTransit, daysLate, originTempF, destTempF, outcome, resolution, notes.

### Стратегия

12 полей в карточку **не помещаются**. Используй expand-row pattern:

**Свёрнутая карточка (видно сразу):**
- HEAD: Order ID (mono) + Outcome badge (Thawed/OK/Unclear)
- SUB: SKU · Product (truncate)
- ACTION row: Carrier + Service
- FOOTER: Ship date · Days late (если есть, цветом)

**Развёрнутая карточка (на tap):**
Дополнительно показываем:
- Promised EDD vs Actual delivery (grid 1 col)
- Origin temp / Dest temp (можно компактно через WeatherBlock компонент или просто текст)
- Notes (если есть)
- Resolution

### Применить паттерн

Двойная структура `hidden md:block` / `md:hidden`. Для mobile cards используй local state `expandedId` (если в desktop таблице expand-row уже использует state — переиспользуй).

### Filter row (selectors)

Текущий filter row уже `flex flex-wrap` ✅ — на мобиле работает (селекты переносятся). НЕ трогать.

---

## 6.2. Задача 2C.2 — SkuRiskTable (Frozen Analytics)

**Файл:** скорее всего `src/components/frozen-analytics/SkuRiskTable.tsx` (если другое имя — найди в `src/components/frozen-analytics/`)

Не читал детально. Применяй универсальный паттерн § 4 — column inventory смотри в файле, выбери приоритеты по § 4.3.

Скорее всего колонки: SKU, Product, Risk score, Incident count, Last incident, Action.

### Mobile-card layout (рекомендация)

- HEAD: SKU (mono) + Risk badge (LOW/MEDIUM/HIGH)
- SUB: Product (truncate)
- FOOTER: `N incidents` · `Last: X days ago` · Action button

---

## 6.3. Задача 2C.3 — Claims AtozTable

**Файл:** `src/components/claims/AtozTable.tsx`

8 колонок: expand + urgent + type + orderId + amount + strategy + deadline + status. Похож на customer-hub AtozTab но это **отдельный компонент** для страницы /claims/atoz.

### Mobile-card layout

- HEAD: Order ID (mono) + Amount + urgent flag (если есть)
- SUB: Type · Strategy badge
- ACTION row: Status badge · Deadline
- На tap → expand с подробностями (используй existing expand state)

### Также fix expand-row

Внутри expand-row есть `grid-cols-2 gap-2`. На мобиле это `grid-cols-1 sm:grid-cols-2`.

---

## 6.4. Задача 2C.4 — Feedback FeedbackTable

**Файл:** `src/components/feedback/FeedbackTable.tsx`

7 колонок: expand + rating + date + order + comment + ai + status.

### Mobile-card layout

- HEAD: 5 звёзд (rating) + Status badge
- SUB: Customer/order · Date
- BODY: Comment (line-clamp-3)
- FOOTER: AI suggested action (если есть)
- На tap → expand с full comment + AI analysis

### НЕ трогать

- Product Reviews (вторая вкладка) — уже карточный формат ✅

---

## 6.5. Задача 2C.5 — Account Health MetricRow

**Файл:** скорее всего `src/components/account-health/StoreHealthCard.tsx` (если другое имя — найди в `src/components/account-health/` или ищи `MetricRow` через grep)

В StoreHealthCard есть `<MetricRow>` компонент с тремя полями: label / value / threshold (или похожая структура), сейчас в `flex items-center justify-between` который тесно на мобиле.

### Fix

```tsx
// BEFORE:
<div className="flex items-center justify-between ...">
  <span>{label}</span>
  <span>{value}</span>
  <span>{threshold}</span>
</div>

// AFTER:
<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-3 ...">
  <span>{label}</span>
  <div className="flex items-center justify-between sm:justify-end gap-3">
    <span>{value}</span>
    <span className="text-ink-3 text-[10.5px]">{threshold}</span>
  </div>
</div>
```

Точная структура зависит от текущего кода. Главная идея: на мобиле label сверху, value+threshold снизу в одной строке. На `sm:` всё в одной строке как раньше.

---

### Phase 2C — git commit

```bash
git add -A
git commit -m "feat(mobile): Phase 2C — Frozen + Claims + Feedback + Account Health → mobile-cards

- IncidentsTable (Frozen, 12+ fields) responsive with expand
- SkuRiskTable (Frozen) responsive
- AtozTable (Claims, 8 cols, expand) responsive
- FeedbackTable (Feedback, 7 cols, expand) responsive
- Account Health MetricRow flex-col sm:flex-row

Refs: docs/CLAUDE_CODE_PROMPT_MOBILE_PHASE_2.md § 6
"
```

---

# 7. PHASE 2D — Shipping + Settings (САМЫЕ СЛОЖНЫЕ)

## 7.1. Задача 2D.1 — Shipping main grid → mobile-cards

**Файл:** `src/app/shipping/page.tsx`

### Текущая структура

CSS Grid с фиксированными колонками:
```
grid-cols-[36px_minmax(160px,1.3fr)_minmax(180px,1.8fr)_90px_90px_140px_minmax(120px,1fr)_120px]
```
8 колонок: checkbox + Order/Store + Product + Type + Weight + Ship to/by + Service + Status. Минимальная ширина ~936px. **Не помещается даже на iPad**.

Также есть header row (с такими же grid-cols классами) с лейблами `Order / Store / Product / Type / Weight / Ship to / by / Service / Status`.

Сложность: **bulk select** через checkbox в первой колонке. Это нужно сохранить на мобиле.

### Mobile-card layout

```tsx
<div className="md:hidden divide-y divide-rule">
  {plan.orders.map((item) => {
    const isSelectable = item.status === "pending";
    const isChecked = selected.has(item.id);
    const isBought = item.status === "bought";
    const needsAttention = item.status === "stop" || item.status === "error";
    const channelIsWalmart = /walmart/i.test(item.channel);

    return (
      <div
        key={item.id}
        className={cn(
          "px-4 py-3 transition-colors",
          isBought && "opacity-70",
          needsAttention && "bg-warn-tint/30",
          isChecked && !needsAttention && "bg-green-soft/40"
        )}
      >
        {/* HEAD: checkbox + order# + status */}
        <div className="flex items-start gap-2 mb-2">
          <input
            type="checkbox"
            checked={isChecked}
            onChange={() => toggleSelect(item.id)}
            disabled={!isSelectable || buying}
            className="h-5 w-5 mt-0.5 shrink-0 rounded border-silver-line accent-[var(--green)] disabled:opacity-30"
          />
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[13px] text-ink">{item.orderNumber}</div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <StoreAvatar
                store={channelIsWalmart ? "walmart" : storeKeyFor({ storeName: item.channel })}
                size="sm"
              />
              <span className="truncate text-[11.5px] text-ink-2">{item.channel}</span>
            </div>
          </div>
          <div className="shrink-0">
            <StatusChip variant={statusVariantFor(item.status)}>
              {statusLabels[item.status] || item.status}
            </StatusChip>
          </div>
        </div>

        {/* BODY: product + sku */}
        <div className="mb-2">
          <div className="text-[12.5px] text-ink truncate">{item.product}</div>
          <div className="mt-0.5 font-mono text-[10.5px] uppercase tracking-wider text-ink-3">
            {item.sku}
          </div>
        </div>

        {/* META row: type + weight + ship-to */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] mb-2">
          <TypeTag type={item.productType} />
          {item.weight != null && (
            <span className="tabular text-ink-2">
              {item.weight}<span className="text-[10px] text-ink-3 ml-0.5">lb</span>
            </span>
          )}
          {item.notes?.match(/to \w+/)?.[0] && (
            <span className="text-ink-2">{item.notes.match(/to \w+/)![0]}</span>
          )}
          {item.deliveryBy ? (
            <span className="tabular text-ink-3">by <span className="text-ink">{item.deliveryBy}</span></span>
          ) : item.edd ? (
            <span className="tabular text-ink-3">EDD {item.edd}</span>
          ) : null}
        </div>

        {/* SERVICE row: carrier + price */}
        {item.carrier && (
          <div className="flex items-center justify-between gap-2 mb-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <CarrierBadge carrier={item.carrier} />
              <span className="truncate text-[11.5px] text-ink-2">{item.service ?? ""}</span>
            </div>
            {item.price != null && (
              <div className="text-[13px] font-semibold tabular text-ink shrink-0">
                ${item.price.toFixed(2)}
              </div>
            )}
          </div>
        )}

        {/* TRACKING (if bought) */}
        {item.status === "bought" && item.trackingNumber &&
          typeof item.trackingNumber === "string" &&
          !item.trackingNumber.startsWith("[") && (
            <div className="font-mono text-[10.5px] text-ink-3 mt-1">
              {item.trackingNumber}
            </div>
          )}

        {/* NOTES (if any) */}
        {item.notes && (
          <div
            className={cn(
              "text-[10.5px] leading-tight mt-1",
              needsAttention ? "text-warn-strong" : "text-ink-3",
              isClickableError(item.notes) && "cursor-pointer underline"
            )}
            onClick={() => isClickableError(item.notes) && handleErrorClick(item)}
          >
            {item.notes}
          </div>
        )}
      </div>
    );
  })}
</div>
```

И обернуть существующий desktop grid в `<div className="hidden md:block">`. Header row с лейблами (`Order / Store / Product / Type / Weight / Ship to / by / Service / Status`) — тоже внутри desktop block.

### Toolbar выше таблицы

Toolbar `<div className="flex flex-wrap items-center gap-2 ...">` уже использует `flex-wrap`, на мобиле адаптируется ✅. НЕ трогать.

### Sticky action bar внизу

`sticky bottom-0` — уже работает. НЕ трогать.

---

## 7.2. Задача 2D.2 — Shipping skuModal grid-cols-4

**Файл:** `src/app/shipping/page.tsx`

В `<Dialog>` для skuModal сейчас:

```tsx
<div className="grid grid-cols-4 gap-3">
  <div><Label>Weight (lbs)</Label>...</div>
  <div><Label>Length (in)</Label>...</div>
  <div><Label>Width (in)</Label>...</div>
  <div><Label>Height (in)</Label>...</div>
</div>
```

На iPhone 380px каждое поле получает ~80px — слишком узко для двузначных значений.

### Fix

```tsx
<div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
  ...
</div>
```

На мобиле 2×2 layout (2 колонки), на `sm:` (≥ 640px) — 4 колонки в ряд как раньше.

Также `<div className="w-1/2">` для FedEx One Rate Weight input — заменить на `<div className="w-full sm:w-1/2">`.

---

## 7.3. Задача 2D.3 — Shipping tagModal & skuModal — рефикс blue palette

**Файл:** `src/app/shipping/page.tsx`

В обоих диалогах есть **запрещённые цвета**:

```tsx
// tagModal Submit button:
className="bg-blue-600 hover:bg-blue-700"

// skuModal Submit button (то же самое):
className="bg-blue-600 hover:bg-blue-700"

// Labels внутри dialogs:
<Label className="text-slate-500">Product</Label>
<Label className="text-slate-500">SKU</Label>
<Label className="text-slate-500">Order</Label>

// Helper text:
<p className="text-[10px] text-slate-400 mt-0.5">

// SKU input:
<Input value={skuModal.sku} disabled className="font-mono" />
```

### Замены

```tsx
// Submit buttons (tagModal "Set Frozen" и skuModal "Save to SKU Database"):
className="bg-green hover:bg-green-deep text-green-cream"

// Labels:
<Label className="text-ink-3">Product</Label>
<Label className="text-ink-3">SKU</Label>
<Label className="text-ink-3">Order</Label>

// Helper text:
<p className="text-[10px] text-ink-4 mt-0.5">
```

(`<Input>` без явных цветов — оставь как есть, shadcn Input использует токены)

---

## 7.4. Задача 2D.4 — Shipping error block bg-red-50

**Файл:** `src/app/shipping/page.tsx`

Найди блок:
```tsx
{error && (
  <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
    {error}
  </div>
)}
```

### Fix

```tsx
{error && (
  <div className="rounded-md bg-danger-tint p-3 text-sm text-danger">
    {error}
  </div>
)}
```

---

## 7.5. Задача 2D.5 — Settings SKU Database (9 колонок → mobile-cards) — САМАЯ СЛОЖНАЯ

**Файл:** `src/app/settings/page.tsx`

### Текущая структура

В разделе "Section 5 — Data" есть Card "SKU Database" с таблицей `<Table>` внутри `<div className="max-h-[500px] overflow-auto rounded-md border">`. 9 колонок: SKU, Product Title, Marketplace, Category, L (in), W (in), H (in), Weight (lbs), FedEx 1R (lbs).

Sticky header: `<TableHead className="sticky top-0 bg-white">`. **`bg-white` — заменить на `bg-surface`**.

### Mobile-card layout

```tsx
{/* DESKTOP table */}
<div className="hidden md:block max-h-[500px] overflow-auto rounded-md border">
  <Table>
    <TableHeader>...</TableHeader>
    <TableBody>
      {/* ... existing rows ... */}
    </TableBody>
  </Table>
</div>

{/* MOBILE cards */}
<div className="md:hidden max-h-[500px] overflow-auto rounded-md border divide-y divide-rule">
  {filteredSkus.length === 0 ? (
    <div className="text-center text-sm text-ink-3 py-8">
      {skuSearch ? "No SKUs match your search" : "No data"}
    </div>
  ) : (
    filteredSkus.map((row) => (
      <div
        key={row.sku}
        className={cn(
          "px-4 py-3",
          !row.hasCompleteData && "bg-danger-tint"
        )}
      >
        {/* HEAD: SKU + warning + category */}
        <div className="flex items-start justify-between gap-2 mb-1.5">
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            <span className="font-mono text-[13px] font-medium text-ink truncate">
              {row.sku}
            </span>
            {!row.hasCompleteData && (
              <AlertTriangle size={13} className="text-danger shrink-0" />
            )}
          </div>
          <Badge
            variant="outline"
            className={cn(
              "shrink-0 text-[10px]",
              row.category === "Frozen" && "border-green-soft2 text-green"
            )}
          >
            {row.category || "—"}
          </Badge>
        </div>

        {/* SUB: product title */}
        <div className="text-[12px] text-ink-2 line-clamp-2 mb-2">
          {row.productTitle}
        </div>

        {/* DIMENSIONS grid: 2 columns */}
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11.5px] tabular">
          <div className="flex justify-between">
            <span className="text-ink-3">L:</span>
            <span className={cn(row.length === null ? "text-danger font-medium" : "text-ink")}>
              {row.length ?? "—"} <span className="text-ink-3">in</span>
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-ink-3">W:</span>
            <span className={cn(row.width === null ? "text-danger font-medium" : "text-ink")}>
              {row.width ?? "—"} <span className="text-ink-3">in</span>
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-ink-3">H:</span>
            <span className={cn(row.height === null ? "text-danger font-medium" : "text-ink")}>
              {row.height ?? "—"} <span className="text-ink-3">in</span>
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-ink-3">Wt:</span>
            <span className={cn(row.weight === null ? "text-danger font-medium" : "text-ink")}>
              {row.weight ?? "—"} <span className="text-ink-3">lb</span>
            </span>
          </div>
          {row.weightFedex !== null && (
            <div className="flex justify-between col-span-2">
              <span className="text-ink-3">FedEx 1R:</span>
              <span className="text-ink">
                {row.weightFedex} <span className="text-ink-3">lb</span>
              </span>
            </div>
          )}
        </div>

        {/* FOOTER: marketplace */}
        <div className="mt-1.5 text-[10.5px] text-ink-3">
          {row.marketplace}
        </div>
      </div>
    ))
  )}
</div>
```

### Также fix sticky header bg-white

В `<TableHead>` найди `className="sticky top-0 bg-white"` (повторяется 9 раз) и замени на `className="sticky top-0 bg-surface"`.

### CardHeader — flex-col на мобиле

CardHeader для SKU Database сейчас:
```tsx
<CardHeader className="flex flex-row items-center justify-between">
  <div>...title + description...</div>
  <div className="flex items-center gap-2">...badges + buttons...</div>
</CardHeader>
```

На мобиле эти две части не помещаются в одну строку. Замени на:
```tsx
<CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
  ...
</CardHeader>
```

Также проверь CardHeader в SyncPanel — у него тот же паттерн, тоже исправить.

### Также fix bg-white в search input

```tsx
// BEFORE:
className="w-full rounded-md border border-rule bg-white py-2 pl-10 pr-4 text-sm ..."

// AFTER:
className="w-full rounded-md border border-rule bg-surface py-2 pl-10 pr-4 text-sm ..."
```

---

## 7.6. Задача 2D.6 — Settings GmailAccountsPanel rows → flex-col sm:flex-row

**Файл:** `src/app/settings/page.tsx` (внутри `function GmailAccountsPanel()`)

### Текущая структура каждой row

```tsx
<div
  key={acct.storeIndex}
  className="flex items-center justify-between gap-4 py-2 border-b border-rule last:border-0"
>
  <div className="flex items-center gap-3 min-w-0">
    {/* icon + store name + email + test results */}
  </div>
  <div className="flex items-center gap-2 shrink-0">
    {/* Badge + Connect/Disconnect button */}
  </div>
</div>
```

### Fix

```tsx
<div
  key={acct.storeIndex}
  className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4 py-3 border-b border-rule last:border-0"
>
  <div className="flex items-center gap-3 min-w-0">
    {/* без изменений */}
  </div>
  <div className="flex items-center gap-2 sm:shrink-0 self-start sm:self-center">
    {/* Badge + Connect/Disconnect — на мобиле занимают полный ряд снизу */}
  </div>
</div>
```

Также: в "Test all connections" controls ряду — `<div className="flex items-center justify-between gap-2 ..."> ` — добавь `flex-col sm:flex-row sm:items-center` чтобы текст и кнопка не уплотнялись.

---

## 7.7. Задача 2D.7 — Settings SpApiStoresPanel rows

**Файл:** `src/app/settings/page.tsx` (внутри `function SpApiStoresPanel()`)

Тот же паттерн что и 2D.6 — те же замены `flex items-center justify-between` → `flex flex-col sm:flex-row sm:items-center sm:justify-between`.

Также конкретно Auth/Advanced ряд внизу:
```tsx
// BEFORE:
<div className="flex items-center justify-between">
  <p>...</p>
  <a href="/settings/api-test">...</a>
</div>

// AFTER:
<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
  <p>...</p>
  <a href="/settings/api-test">...</a>
</div>
```

---

## 7.8. Задача 2D.8 — Settings AiProvidersPanel selects

**Файл:** `src/app/settings/page.tsx` (внутри `function AiProvidersPanel()`)

### Проблема

3 `<select>` с `className="w-52 rounded border border-rule px-2 py-1 text-sm ..."` — это 208px. На iPhone 380px viewport вместе с label слева получается тесно.

### Fix

Все 3 selects:
```tsx
// BEFORE:
className="w-52 rounded border border-rule px-2 py-1 text-sm focus:border-green focus:outline-none"

// AFTER:
className="w-full sm:w-52 rounded border border-rule px-2 py-1 text-sm focus:border-green focus:outline-none"
```

И каждый ряд с label+select:
```tsx
// BEFORE:
<div className="flex items-center justify-between gap-4">
  <label>...</label>
  <select className="w-52 ...">...</select>
</div>

// AFTER:
<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-4">
  <label>...</label>
  <select className="w-full sm:w-52 ...">...</select>
</div>
```

Также 3 status rows с `<Badge>` в правом верхнем углу:
```tsx
// BEFORE:
<div className="flex items-center justify-between gap-4 py-2 border-b border-rule last:border-0">
  ...
</div>

// AFTER:
<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4 py-3 border-b border-rule last:border-0">
  ...
</div>
```

И `LossSettingsPanel` — у него тот же `flex items-center justify-between gap-4` для label+input. Применить тот же fix.

---

### Phase 2D — git commit

```bash
git add -A
git commit -m "feat(mobile): Phase 2D — Shipping + Settings → mobile-cards

- Shipping main grid (8 cols, ~936px) responsive table+cards
- Shipping skuModal grid-cols-4 → grid-cols-2 sm:grid-cols-4
- Shipping tagModal/skuModal blue→Salutem rebrand
- Shipping error block bg-red-50 → bg-danger-tint
- Settings SKU Database (9 cols) responsive — biggest table in project
- Settings GmailAccountsPanel/SpApiStoresPanel rows flex-col sm:flex-row
- Settings AiProvidersPanel selects w-full sm:w-52
- Settings SKU Database header bg-white → bg-surface

Phase 2 mobile adaptation complete — full mobile coverage achieved.

Refs: docs/CLAUDE_CODE_PROMPT_MOBILE_PHASE_2.md § 7
"
```

---

# 8. Bonus task — Procurement badge в /api/dashboard/summary

**(Опционально, можешь пропустить если устаёшь к концу)**

В Phase 1 Claude Code добавил `procurement?.ordersToBuy` поле в `DashboardSummary` interface в SidebarContent.tsx, чтобы в sidebar показывался badge с количеством procurement-заказов. Но API `/api/dashboard/summary` это поле сейчас не возвращает.

### Файл

`src/app/api/dashboard/summary/route.ts`

### Что нужно

Найди существующий response объект (что-то вроде `return Response.json({ orders: {...}, customerService: {...}, claims: {...}, ... })`) и добавь:

```ts
procurement: {
  ordersToBuy: <число открытых procurement-заказов>,
}
```

### Логика подсчёта

`ordersToBuy` = количество **distinct order IDs** из `ProcurementItem` в Prisma, у которых `status` ещё `null` или `'remain'` (т.е. не помечены как 'bought').

Что-то вроде:
```ts
import { prisma } from "@/lib/prisma";

const procurementItems = await prisma.procurementItem.findMany({
  where: {
    OR: [
      { status: null },
      { status: { startsWith: "remain" } },
    ],
  },
  select: { orderId: true },
});

const ordersToBuy = new Set(procurementItems.map(p => p.orderId)).size;
```

(Точная схема ProcurementItem в `prisma/schema.prisma` — проверь существующие поля. Если структура другая — адаптируй.)

После этого badge в sidebar (Phase 1) автоматически начнёт показывать число.

---

# 9. Универсальная финальная проверка

После всех phase'ов запусти эти команды и убедись что результаты корректны.

## 9.1. Grep на запрещённые цвета

```bash
cd /Users/amazon/ss-control-center/ss-control-center
grep -rnE "bg-(blue|gray|red|slate)-[0-9]+|text-(blue|gray|red|slate)-[0-9]+|border-(blue|gray|red|slate)-[0-9]+|from-blue-|to-indigo-" src/app src/components 2>&1 | grep -v node_modules
```

Ожидаемый результат: пусто. Если что-то выводится — упущенный класс, поправь.

**Допустимые исключения** (не запрещены, оставить):
- `from-bg`, `to-bg-elev`, `from-green`, etc. (Salutem токены)
- `text-warn-strong`, `bg-warn-tint`, `text-danger`, `bg-danger-tint`
- `text-orange`, `text-yellow` если внутри файлов которые трогать НЕ должны (например, существующие иконки в Procurement которые работают)

## 9.2. Grep на text-white

```bash
grep -rn "text-white" src/app src/components 2>&1 | grep -v node_modules
```

`text-white` допустим ТОЛЬКО на dark backgrounds которые НЕ зелёные. На зелёном фоне всегда `text-green-cream`. Если grep находит `text-white` рядом с `bg-green*` — это баг.

## 9.3. Build check

```bash
cd /Users/amazon/ss-control-center/ss-control-center
npm run build
```

Должен пройти без ошибок. Если ошибки TypeScript — поправь до того как считать Phase 2 завершённым.

## 9.4. Manual mobile check

Открой проект в Chrome DevTools, переключи на iPhone SE (375×667). Пройди по всем модулям и убедись что таблиц нет, везде карточки:
- [ ] `/` Dashboard — Awaiting fulfilment карточки
- [ ] `/customer-hub` Messages tab — карточки
- [ ] `/customer-hub` AtoZ tab — карточки
- [ ] `/customer-hub` Chargebacks tab — карточки
- [ ] `/customer-hub` Feedback tab — карточки
- [ ] `/adjustments` AdjustmentsTable + SkuIssuesPanel — карточки
- [ ] `/account-health` MetricRow — flex-col на мобиле
- [ ] `/frozen-analytics` IncidentsTable + SkuRiskTable — карточки
- [ ] `/claims/atoz` AtozTable — карточки
- [ ] `/feedback` FeedbackTable — карточки (Product Reviews уже карточки ✅)
- [ ] `/shipping` main grid — карточки + skuModal layout 2×2
- [ ] `/settings` SKU Database — карточки
- [ ] `/settings` Gmail/SpApi panels — info+buttons stacked

---

# 10. Wiki update

После завершения всех phase'ов обнови wiki.

## 10.1. `docs/wiki/mobile-adaptation.md`

В секцию `## 🚩 Roadmap` после Phase 1 добавь:

```md
### Phase 2 — Все остальные таблицы → mobile-cards ✅ ЗАВЕРШЁН (2026-XX-XX)

Адаптировано **~13 таблиц + 5 точечных фиксов** на мобильные карточки.

**Phase 2A — Customer Hub:**
- MessagesTab (9 колонок) → mobile-cards
- AtozTab, ChargebacksTab, FeedbackTab → mobile-cards
- MessageDetail action row → flex-wrap

**Phase 2B — Dashboard + Adjustments:**
- Dashboard awaiting-fulfilment table (6 колонок) → cards
- AdjustmentsTable (8 колонок, expand) → cards
- SkuIssuesPanel (7 колонок) → cards

**Phase 2C — Frozen + Claims + Feedback + Account Health:**
- IncidentsTable (12+ полей, expand) → cards
- SkuRiskTable → cards
- AtozTable (Claims, 8 колонок, expand) → cards
- FeedbackTable (Feedback, 7 колонок, expand) → cards
- Account Health MetricRow → flex-col sm:flex-row

**Phase 2D — Shipping + Settings:**
- Shipping main grid (8 колонок, ~936px) → cards
- Shipping skuModal grid-cols-4 → grid-cols-2 sm:grid-cols-4
- Shipping tagModal/skuModal — рефикс blue palette → Salutem
- Settings SKU Database (9 колонок) → cards (самая сложная)
- Settings Gmail/SpApi/AiProviders panels → flex-col sm:flex-row

**Универсальный паттерн:** каждая таблица обёрнута в `<div className="hidden md:block">`, рядом — `<div className="md:hidden divide-y divide-rule">{cards}</div>`. Click handlers, filters, data — переиспользованы.

**Время выполнения:** ~10 часов работы Claude Code.
```

В секции `## История` добавь сверху:
```md
- 2026-XX-XX: **Phase 2 ЗАВЕРШЁН.** ~13 таблиц + 5 точечных фиксов адаптированы на мобильные карточки. SS Control Center полностью работает с iPhone. Universal pattern: `hidden md:block` Table + `md:hidden` cards.
```

## 10.2. `docs/wiki/CONNECTIONS.md`

В секцию `### [Mobile Adaptation]` обнови:
```md
### [Mobile Adaptation](mobile-adaptation.md)
**Phase 2 завершён 2026-XX-XX** — все таблицы проекта поддерживают мобильное отображение через паттерн "table + cards в одном компоненте". Phase 1 (App Shell) и Phase 2 (таблицы) вместе покрывают весь UI.

← [Design System](design/index.md) (токены не менялись), [Архитектура проекта](project-architecture.md)
⇔ ВСЕ модули (Dashboard, Customer Hub, Adjustments, Frozen Analytics, Claims, Feedback, Shipping, Settings, Account Health) — каждый имеет mobile-version
⊂ AppShell (Phase 1), Sidebar→drawer (Phase 1), Header→hamburger (Phase 1), 13 таблиц→cards (Phase 2)
← MobileNavContext, shadcn/ui:Sheet
```

## 10.3. `docs/wiki/index.md`

Обнови дату внизу: `Последнее обновление: 2026-XX-XX (+ mobile-adaptation Phase 2)`.

---

# 11. Финальный git push

После всего:
```bash
cd /Users/amazon/ss-control-center
git add -A
git commit -m "docs(mobile): Phase 2 wiki update — all tables responsive"
git push
```

И обнови `docs/MOBILE_PHASE_2_PROGRESS.md` — отметь все задачи как `[x]` и добавь финальную секцию:

```md
## ✅ Phase 2 ЗАВЕРШЁН (2026-XX-XX HH:MM)

Все ~13 таблиц + 5 точечных фиксов реализованы. Build проходит без ошибок.
Grep на запрещённые цвета: чисто.

Готово к финальной приёмке Vladimir.
```

---

# 🎯 Что Vladimir будет проверять утром

1. **Build не ломается** — `npm run dev` запускается без ошибок
2. **Все 4 коммита в git** — Phase 2A, 2B, 2C, 2D
3. **Прогресс-файл `MOBILE_PHASE_2_PROGRESS.md`** — все `[x]`, нет `[ ]`
4. **На iPhone (375×667)** — все таблицы → карточки, всё помещается
5. **Wiki обновлён**

Если Vladimir увидит `## ⚠️ Questions for Vladimir` секцию в progress-файле — он ответит и Claude Code следующей сессией доделает.

---

**Конец промпта.** Удачной работы, Claude Code! 🌙

Помни: лучше сделать 80% качественно, чем 100% криво. Если уверенности нет — оставь TODO в progress-файле и иди дальше.
