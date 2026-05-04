# 📱 Mobile Adaptation — Аудит и план

## Суть
Адаптация SS Control Center под мобильные устройства (< 768px). Текущая версия — **полностью desktop-only**. Sidebar 236px, фиксированные таблицы 6–9 колонок, тулбары с 3–6 кнопками — всё это ломается на телефоне.

**Стратегия:** не редизайн, а точечная адаптация. Salutem Design System остаётся как есть, добавляются только responsive-паттерны: drawer вместо sidebar, cards вместо таблиц, гамбургер вместо search-bar в header.

## Связанные файлы
- `docs/MOBILE_ADAPTATION_AUDIT.md` — полный аудит с разбором по страницам и компонентам
- (будущий) `docs/CLAUDE_CODE_PROMPT_MOBILE_ADAPTATION.md` — промпт для Claude Code

## Ключевые решения
- **Брейкпоинт:** `md` (768px). Всё < md = "мобила", применяются drawer + cards.
- **Sidebar → Drawer:** на мобиле через shadcn `Sheet`, гамбургер в Header.
- **Tables → Cards:** карточный вид строк, паттерн `<div className="hidden md:block"><Table/></div>` + `<div className="md:hidden">cards</div>`.
- **PageHead actions:** горизонтальный скролл `overflow-x-auto no-scrollbar md:overflow-visible`.
- **Padding:** мобильный = 16px, десктопный = 28/32/40px.
- **Touch targets:** минимум 44×44px для интерактивных элементов на мобиле.

## 🔗 Связи
- **Зависит от:** [Архитектура проекта](project-architecture.md) (Next.js 16, Tailwind v4, shadcn/ui), [Design System](design/index.md) (цвета и токены остаются как есть)
- **Связан с:** [Dashboard](dashboard.md), [Customer Hub](customer-hub.md), [Shipping Labels](shipping-labels.md), [Adjustments Monitor](adjustments-monitor.md) — все основные страницы требуют mobile-cards
- **См. также:** будущий `CLAUDE_CODE_PROMPT_MOBILE_ADAPTATION.md`

## 🚩 Roadmap (фиксированный порядок)

**Требование Vladimir:** довести mobile-версию всего проекта, но в определённом порядке.

### Phase 0 — Полный аудит проекта ✅ ЗАВЕРШЁН
Инспекция всех страниц и компонентов на предмет mobile-readiness закончена.

**Прочитано и проанализировано:**
- ✅ Фундамент (layout, AppShell, Sidebar, Header, kit/PageHead, kit/KpiCard, kit/Card, kit/FilterTabs)
- ✅ Все страницы: Dashboard, Procurement, Customer Hub, Shipping Labels, Adjustments, Account Health, Frozen Analytics, Claims/AtoZ, Feedback, Settings, Login/Invite, Integrations
- ✅ Ключевые субкомпоненты: AdjustmentsTable, SkuIssuesPanel, AtozTable, FeedbackTable, IncidentsTable, MessagesTab, CustomerHubTabs, HubStatsCards, LossesDashboard, AtozTab, MessageDetail (полностью), StoreHealthCard, WalmartPerformancePanel, StoreTabs (cs)
- ✅ Procurement субкомпоненты: ProcurementCard, ProcurementList, StorePriorityPopup, PhotoLightbox

**Не читал детально (паттерн ясен, дополнительный аудит не требуется):**
- ChargebacksTab (клон AtozTab)
- FeedbackTab (вариация AtozTab)
- AtozDetail / FeedbackDetail (вариации MessageDetail)
- WalmartCaseModal (Dialog с формой)
- SkuRiskTable, PatternsDashboard, TransitTimeline, WeatherBlock, WalmartBaselineCard (Frozen Analytics)
- ComingSoon component (Phase 2 disabled плейсхолдер)

**Найдены 3 бага вне mobile-задачи:**
1. `/login` — синяя Tailwind-палитра вместо Salutem (`from-blue-50`, `bg-blue-600`, `text-gray-900`)
2. `/invite/[token]` — такая же проблема
3. `cs/StoreTabs.tsx` — использует `text-blue-600 bg-blue-50/50 border-blue-600`. Видимо легаси от доперехода на Salutem.
Рекомендация: отдельный промпт на ребрендинг (~30 минут Claude Code).

**Общие паттерны проблем (для общего промпта):**
- ~10 таблиц нуждаются в mobile-cards: Dashboard, Customer Hub Messages, Shipping Labels, AdjustmentsTable, SkuIssuesPanel, IncidentsTable, SkuRiskTable, AtozTable, FeedbackTable, AtozTab, ChargebacksTab, FeedbackTab, SKU Database (Settings)
- 3 страницы без PageHead (Claims, Feedback, Settings) — не критично для mobile, но непоследовательно
- App Shell (Sidebar/Header/AppShell/padding) — главный блокер
- MessageDetail action row — точечный фикс (`flex-wrap`)
- MetricRow в Account Health — точечный фикс (`flex-col sm:flex-row` или скрыть второстепенное)
- skuModal в Shipping (`grid-cols-4` → `grid-cols-2 sm:grid-cols-4`) — точечный фикс

### Phase 1 — App Shell + Procurement Mobile ✅ ЗАВЕРШЁН (2026-05-04)

App Shell адаптирован под мобильные устройства:
- Sidebar превращается в drawer на `< 768px` (shadcn Sheet, slide from left, 280px)
- Hamburger button в Header открывает drawer
- Search bar заменён на иконку-кнопку на мобиле (full search UX — Phase 2)
- Content padding уменьшен с 32px до 16px на мобиле
- Procurement card touch-targets подняты до 36px на мобиле (`h-9 w-9 md:h-7 md:w-7`)
- Procurement search input минимум 40px на мобиле для удобного тапа

**Новые файлы:**
- `src/lib/use-is-mobile.ts` — useMediaQuery hook (заготовка для Phase 2 conditional rendering)
- `src/lib/mobile-nav-context.tsx` — MobileNavProvider + useMobileNav hook
- `src/components/layout/SidebarContent.tsx` — извлечённый контент sidebar для переиспользования
- `src/components/layout/MobileNav.tsx` — обёртка над shadcn Sheet с SidebarContent внутри

**Изменённые файлы:**
- `src/app/layout.tsx` — обёрнут в MobileNavProvider
- `src/components/layout/AppShell.tsx` — рендерит и Sidebar, и MobileNav; padding через Tailwind вместо CSS-var
- `src/components/layout/Sidebar.tsx` — превращён в desktop-only обёртку (`hidden md:flex`)
- `src/components/layout/Header.tsx` — hamburger (md:hidden), responsive search
- `src/app/procurement/page.tsx` — search input высота
- `src/app/procurement/components/ProcurementCard.tsx` — copy-button touch target
- `src/app/procurement/components/StorePriorityPopup.tsx` — ↑/↓/удалить touch targets

**Что осталось на Phase 2 / отдельные задачи (упомянуто в исходном промпте):**
- ~10 таблиц → mobile-cards
- MessageDetail action row `flex-wrap`
- MetricRow в Account Health StoreCard
- skuModal в Shipping `grid-cols-4` → `grid-cols-2 sm:grid-cols-4`
- Settings GmailAccountsPanel/SpApiStoresPanel rows
- Полноценный mobile search-функционал (сейчас иконка-плейсхолдер)
- Ребрендинг легаси страниц на синей Tailwind-палитре (Login, Invite, cs/StoreTabs) — отдельный промпт

### Phase 2 — Mobile для остальных страниц
После Procurement — общий фундаментальный промпт на все остальные модули: `docs/CLAUDE_CODE_PROMPT_MOBILE_ADAPTATION.md`. Включает:
- Sidebar → Drawer (Sheet)
- Header + гамбургер
- Tables → Cards по всем основным модулям
- PageHead actions → horizontal scroll
- Модалки и формы
- Touch targets

### Phase 3 — Тестирование и фиксы
Real-device тест + Chrome DevTools mobile + точечные исправления.

## 🔄 Стратегия работы против зависания
Раньше Claude зависал при попытке сделать всё в одном ответе (читать 50+ файлов, писать огромные документы). Решение: работа разбивается на чанки по 1 модулю/странице на ответ. Каждый чанк:
1. Читает 1–3 файла (через read_multiple_files)
2. Сразу обновляет docs/MOBILE_ADAPTATION_AUDIT.md с находками
3. Двигается к следующему

Это даёт результат даже если сессия прервется.

## Оценка трудозатрат
- Claude Code по чёткому промпту (Procurement): 2–4 часа
- Claude Code (остальные страницы): 1 день
- Тестирование + фиксы: 0.5 дня

## История
- **2026-05-04: Phase 1 ЗАВЕРШЁН Claude Code'ом.** Все 4 новых файла + 7 изменённых сделаны как в промпте. Бонусы сверх промпта: (1) `usePullToRefresh` hook на странице Procurement (pull-to-refresh жест на мобиле), (2) `safe-area-inset-bottom` для bulk action bar (учёт home indicator на iPhone), (3) hamburger получил `border + bg-surface-tint + size 40px` для лучшей видимости (вместо minimal style из промпта), (4) добавлен pillCount для Procurement в sidebar (badge с `procurement.ordersToBuy` — пока поле не реализовано в `/api/dashboard/summary`, badge не показывается, что безопасно). Russian aria-labels (`Открыть меню`) — приятный штрих под общий стиль Procurement. Wiki обновлён самим Claude Code согласно § 6 промпта.
- 2026-05-03 (ночь): **Phase 1 промпт готов.** `docs/CLAUDE_CODE_PROMPT_MOBILE_PHASE_1.md` — детальный план для Claude Code: 4 новых файла + 7 изменённых. Ожидаемые действия — выполнить в Claude Code и протестировать.
- 2026-05-03 (финал): **Phase 0 АУДИТ ЗАВЕРШЁН.** Найдены 3 бага с синей палитрой вместо Salutem (Login, Invite, cs/StoreTabs). Около 10 таблиц требуют mobile-cards. App Shell — главный блокер. Готовы писать промпты.
- 2026-05-03 (вечер): Procurement аудирован детально — страница уже mobile-ready, блокер только App Shell.
- 2026-05-03 (день): Wiki-статья создана. Аудит фундамента выполнен (12 файлов). Добавлен Phase 1 приоритет = Procurement по запросу Vladimir.
