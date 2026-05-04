# 📱 Claude Code Prompt — Mobile Adaptation Phase 1

**Scope:** App Shell (Sidebar → Drawer, Header → Hamburger, padding) + минорные полировки на странице Procurement.
**Дата:** 2026-05-03
**Зависимости:** Phase 0 audit (`docs/MOBILE_ADAPTATION_AUDIT.md`)
**Брейкпоинт:** `md = 768px` (Tailwind default)
**Оценка:** ~2–3 часа работы Claude Code, ~300 строк нового/изменённого кода

---

## 0. TL;DR

Сейчас на iPhone (380px) sidebar 236px занимает 60% экрана, а content-padding 32px съедает ещё больше. Цель — реализовать стандартный мобильный паттерн:

- На **`< 768px`** sidebar скрывается, появляется **hamburger-кнопка** в Header. Тап по hamburger открывает sidebar в виде **left drawer** (shadcn `Sheet`). Тап по nav-ссылке закрывает drawer. Также content-padding сжимается с 32px до 16px, search-bar в Header заменяется на иконку-кнопку.
- На **`≥ 768px`** всё работает как раньше — sidebar fixed-width слева, search-bar в Header.

**Procurement page** — отдельно. Страница уже mobile-first (использует cards вместо tables, имеет fullscreen lightbox с pinch-zoom). Нужны только мелкие точечные полировки (touch-targets 28px → 36px на иконочных кнопках).

---

## 1. Stack & Context

- **Next.js 16.2.2**, **React 19.2.4**, **Tailwind v4** (`@theme inline` в globals.css)
- **shadcn/ui** уже установлен; в частности `Sheet` (`src/components/ui/sheet.tsx`) на базе `@base-ui/react/dialog`
- **Salutem Design System** активен — все токены (`--green`, `--ink`, `--green-cream`, etc.) в `globals.css`
- **`viewport`** уже настроен в `src/app/layout.tsx` (`maximumScale: 5` — zoom разрешён, что хорошо)
- **PWA metadata** уже настроена (`apple-web-app: capable: true`)

---

## 2. ⚠️ Что НЕ трогать

1. **Salutem Design System** — `globals.css` color tokens, font tokens, spacing tokens. Не добавлять новых токенов.
2. **Бизнес-логика** — API routes (`src/app/api/`), Prisma schema, server actions, DAL (`src/lib/db/`).
3. **shadcn/ui base components** — `src/components/ui/*` остаются как есть.
4. **Все остальные страницы кроме `/procurement`** — Phase 1 трогает ТОЛЬКО layout (App Shell) и Procurement. Все табличные страницы (Customer Hub, Adjustments, Account Health и т.д.) — это Phase 2.
5. **`STANDALONE_PREFIXES` в `AppShell.tsx`** — Login и Invite страницы НЕ должны попадать в App Shell. Текущая логика `if (STANDALONE_PREFIXES.some(...)) return <>{children}</>;` — сохраняем.
6. **Цвета Tailwind по умолчанию** — НЕ использовать `bg-blue-*`, `text-blue-*`, `border-blue-*`, `text-gray-*`. Это известный баг в Login/Invite/cs/StoreTabs (см. audit § 4.11). Использовать ТОЛЬКО Salutem-токены: `bg-surface`, `text-ink`, `text-ink-2`, `text-ink-3`, `bg-green`, `bg-green-soft`, `bg-bg-elev`, etc.
7. **Russian UI в Procurement** — комментарии и строки на русском (`Закуплено`, `Нужно ещё`, и т.д.) — сохранять как есть.

---

## 3. Создаваемые файлы

### 3.1. `src/lib/use-is-mobile.ts` — useMediaQuery hook

Простой hook для определения мобильного брейкпоинта на клиенте. Может пригодиться в будущем для conditional rendering (например, для table → cards в Phase 2). В Phase 1 строго не нужен (все переключения через Tailwind `md:` classes), но создаём заранее.

```ts
"use client";

import { useEffect, useState } from "react";

/**
 * Returns true when window width is below `breakpoint` (default 768px).
 * SSR-safe: returns false on first render, then updates on mount.
 */
export function useIsMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const update = () => setIsMobile(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, [breakpoint]);

  return isMobile;
}
```

### 3.2. `src/lib/mobile-nav-context.tsx` — Sidebar drawer state

Глобальный контекст для управления состоянием drawer'а (open/closed). Provider оборачивается в `layout.tsx` (см. § 4.1), Hook вызывается в `Header.tsx` (для hamburger-кнопки) и `MobileNav.tsx` (для самого drawer).

```tsx
"use client";

import { createContext, useContext, useState } from "react";

interface MobileNavContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const MobileNavContext = createContext<MobileNavContextValue | null>(null);

export function MobileNavProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <MobileNavContext.Provider value={{ open, setOpen }}>
      {children}
    </MobileNavContext.Provider>
  );
}

export function useMobileNav(): MobileNavContextValue {
  const ctx = useContext(MobileNavContext);
  if (!ctx) {
    throw new Error("useMobileNav must be used inside <MobileNavProvider>");
  }
  return ctx;
}
```

### 3.3. `src/components/layout/SidebarContent.tsx` — extracted sidebar internals

Извлекаем содержимое текущего `Sidebar.tsx` (всё, что внутри `<aside>`) в отдельный компонент. Принимает опциональный `onNavigate` callback, который вызывается при клике на nav-ссылку (нужен на мобиле, чтобы автоматически закрыть drawer).

**Что делаем:**

1. Скопировать всё содержимое функции `export default function Sidebar()` из текущего `src/components/layout/Sidebar.tsx`, **кроме** обёртки `<aside>` и её атрибутов.
2. Завернуть в новый компонент `SidebarContent` с `onNavigate?: () => void` пропом.
3. Изменить `NavLink` так, чтобы при клике на ссылку (если `item.disabled` false) вызывался `onNavigate`.
4. **ВАЖНО:** Sidebar.tsx содержит helper-card "Daily plan ready" внизу — его тоже включить в SidebarContent.

**Шаблон структуры:**

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  HeartPulse,
  Truck,
  MessageSquare,
  Thermometer,
  Receipt,
  Tags,
  TrendingUp,
  Package,
  Settings,
  ChevronDown,
  ShoppingCart,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";

interface NavItem {
  title: string;
  href: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  pillCount?: number;
  pillVariant?: "active" | "warn";
  disabled?: boolean;
}

interface DashboardSummary {
  orders?: { awaitingShipment?: number };
  customerService?: { openCases?: number };
  claims?: { active?: number };
  health?: { issues?: number };
  walmart?: { healthIssues?: number };
}

const operationsItems = (s: DashboardSummary): NavItem[] => [
  // ... скопировать как в исходном Sidebar.tsx
];

const phase2Items: NavItem[] = [
  // ... скопировать
];

const settingsItem: NavItem = {
  title: "Settings",
  href: "/settings",
  icon: Settings,
};

function NavLink({
  item,
  active,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  const className = cn(
    "group flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors",
    item.disabled
      ? "cursor-not-allowed opacity-50 text-ink-3"
      : active
        ? "bg-green-soft text-green-ink"
        : "text-ink-2 hover:bg-bg-elev hover:text-ink"
  );

  const content = (
    <>
      <Icon size={15} strokeWidth={1.7} />
      <span className="flex-1 truncate">{item.title}</span>
      {item.pillCount !== undefined && (
        <span
          className={cn(
            "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold tabular",
            item.pillVariant === "warn"
              ? "bg-warn-tint text-warn-strong"
              : "bg-green-soft2 text-green-ink"
          )}
        >
          {item.pillCount}
        </span>
      )}
      {item.disabled && (
        <span className="rounded bg-bg-elev px-1.5 py-px text-[9px] font-mono uppercase tracking-wider text-ink-3">
          Soon
        </span>
      )}
    </>
  );

  if (item.disabled) {
    return <div className={className}>{content}</div>;
  }
  return (
    <Link href={item.href} className={className} onClick={onNavigate}>
      {content}
    </Link>
  );
}

function NavSection({ label }: { label: string }) {
  return (
    <div className="px-2.5 pb-1.5 pt-3 text-[10px] font-mono uppercase tracking-[0.14em] text-ink-3">
      {label}
    </div>
  );
}

export default function SidebarContent({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const [summary, setSummary] = useState<DashboardSummary>({});

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch("/api/dashboard/summary")
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (j && !cancelled) setSummary(j);
        })
        .catch(() => undefined);
    load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <div className="flex h-full flex-col">
      {/* Brand block */}
      <div className="flex items-center gap-2.5 border-b border-rule px-4 py-3.5">
        <div className="grid h-8 w-8 place-items-center rounded-md bg-green text-green-cream font-semibold">
          S
        </div>
        <div className="leading-tight">
          <div className="text-[13px] font-semibold text-ink">Salutem</div>
          <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-ink-3">
            Control · v1.4
          </div>
        </div>
      </div>

      {/* Workspace switcher */}
      <div className="mx-3 mt-3 flex items-center gap-2 rounded-md border border-rule bg-surface-tint px-2.5 py-1.5 text-[12px] text-ink">
        <span className="live-dot" />
        <span className="flex-1">All stores</span>
        <span className="rounded bg-bg-elev px-1.5 text-[10px] font-semibold text-ink-2">
          5
        </span>
        <ChevronDown size={13} className="text-ink-3" />
      </div>

      {/* Operations */}
      <NavSection label="Operations" />
      <nav className="space-y-0.5 px-2">
        {operationsItems(summary).map((item) => (
          <NavLink
            key={item.href}
            item={item}
            active={isActive(item.href)}
            onNavigate={onNavigate}
          />
        ))}
      </nav>

      {/* Phase 2 */}
      <NavSection label="Phase 2" />
      <nav className="space-y-0.5 px-2">
        {phase2Items.map((item) => (
          <NavLink key={item.href} item={item} active={false} />
        ))}
      </nav>

      <div className="flex-1" />

      {/* Settings (always at bottom) */}
      <div className="px-2 pb-2">
        <NavLink
          item={settingsItem}
          active={isActive("/settings")}
          onNavigate={onNavigate}
        />
      </div>

      {/* Helper card */}
      {(summary.orders?.awaitingShipment ?? 0) > 0 && (
        <div className="m-3 rounded-lg border border-rule bg-green-soft px-3 py-2.5 text-green-ink">
          <div className="text-[11px] font-semibold">Daily plan ready</div>
          <div className="mt-0.5 text-[11px] text-green-ink/80 tabular">
            {summary.orders?.awaitingShipment} shipments queued
          </div>
          <Link
            href="/shipping"
            onClick={onNavigate}
            className="mt-2 inline-flex text-[11px] font-medium text-green hover:text-green-deep"
          >
            Continue →
          </Link>
        </div>
      )}
    </div>
  );
}
```

### 3.4. `src/components/layout/MobileNav.tsx` — Sheet wrapper

Тонкая обёртка над shadcn `Sheet`, использует `SidebarContent` внутри. Управляется через `useMobileNav` hook.

```tsx
"use client";

import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { useMobileNav } from "@/lib/mobile-nav-context";
import SidebarContent from "./SidebarContent";

export default function MobileNav() {
  const { open, setOpen } = useMobileNav();

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="left"
        // Override default w-3/4 — sidebar narrower, comfortable on iPhone SE (375px)
        className="w-[280px] !max-w-[280px] p-0 bg-surface"
      >
        {/* Visually-hidden title for a11y — required by Radix/base-ui Dialog */}
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <SheetDescription className="sr-only">
          Main navigation menu
        </SheetDescription>
        <SidebarContent onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
```

**Note по `max-w`:** shadcn `SheetContent` имеет дефолтный `data-[side=left]:sm:max-w-sm` (24rem = 384px). Чтобы наш фиксированный 280px не растянулся до 384px на широких экранах, используем `!max-w-[280px]` (с `!` для override).

---

## 4. Изменяемые файлы

### 4.1. `src/app/layout.tsx` — обернуть в MobileNavProvider

**Изменение:** добавить импорт `MobileNavProvider` и обернуть `<AppShell>` им.

**Before:**
```tsx
import AppShell from "@/components/layout/AppShell";
// ...
<body suppressHydrationWarning={true} className="flex h-screen overflow-hidden bg-bg text-ink">
  <AppShell>{children}</AppShell>
</body>
```

**After:**
```tsx
import AppShell from "@/components/layout/AppShell";
import { MobileNavProvider } from "@/lib/mobile-nav-context";
// ...
<body suppressHydrationWarning={true} className="flex h-screen overflow-hidden bg-bg text-ink">
  <MobileNavProvider>
    <AppShell>{children}</AppShell>
  </MobileNavProvider>
</body>
```

**Почему именно тут:** `MobileNavProvider` должен быть **снаружи** `AppShell`, потому что `AppShell` содержит ранний return для `STANDALONE_PREFIXES` (login/invite). Если бы `Provider` был внутри `AppShell`, hook бы крашился на login/invite (хотя они не используют hook напрямую — но на всякий случай чище снаружи).

### 4.2. `src/components/layout/AppShell.tsx` — рендерить и Sidebar и MobileNav

**Изменения:**
1. Импортировать `MobileNav`.
2. Рендерить `<MobileNav />` рядом с `<Sidebar />`.
3. Заменить inline `style={{ padding: "var(--content-padding)" }}` на Tailwind responsive padding: на мобиле 16px, на desktop сохраняется текущее значение через CSS var.

**Before:**
```tsx
return (
  <TooltipProvider>
    <Sidebar />
    <div className="flex flex-1 flex-col overflow-hidden bg-bg">
      <Header />
      <main className="flex-1 overflow-auto" style={{ padding: "var(--content-padding)" }}>
        <div className="mx-auto" style={{ maxWidth: "var(--content-max)" }}>
          {children}
        </div>
      </main>
    </div>
  </TooltipProvider>
);
```

**After:**
```tsx
import MobileNav from "@/components/layout/MobileNav";
// ...
return (
  <TooltipProvider>
    {/* Desktop sidebar (rendered above md breakpoint via Sidebar's own classes) */}
    <Sidebar />
    {/* Mobile drawer (rendered below md breakpoint, controlled by MobileNavContext) */}
    <MobileNav />
    <div className="flex flex-1 flex-col overflow-hidden bg-bg">
      <Header />
      <main
        className="flex-1 overflow-auto p-4 md:p-0"
        style={
          // На desktop восстанавливаем оригинальный CSS-token padding (28/32/40)
          // На мобиле он заменяется Tailwind p-4 (= 16px со всех сторон)
          undefined
        }
      >
        <div
          className="mx-auto md:[padding:var(--content-padding)]"
          style={{ maxWidth: "var(--content-max)" }}
        >
          {children}
        </div>
      </main>
    </div>
  </TooltipProvider>
);
```

**Альтернатива (проще, рекомендую):** перенести padding с `<main>` на внутренний `<div>` через Tailwind:

```tsx
<main className="flex-1 overflow-auto">
  <div
    className="mx-auto px-4 pt-4 pb-6 md:px-8 md:pt-7 md:pb-10"
    style={{ maxWidth: "var(--content-max)" }}
  >
    {children}
  </div>
</main>
```

Здесь `px-4 pt-4 pb-6` на мобиле = 16px по сторонам, 16px сверху, 24px снизу. На `md:` уходит `px-8 pt-7 pb-10` = 32px / 28px / 40px (что соответствует существующему `--content-padding: 28px 32px 40px`).

> Если значение `--content-padding` в globals.css отличается от `28px 32px 40px` — подкорректируйте Tailwind классы (`md:px-X md:pt-Y md:pb-Z`) под фактические значения. Запросите у Vladimir, если нужно.

### 4.3. `src/components/layout/Sidebar.tsx` — desktop-only wrapper

Заменить весь файл этим (вся логика теперь живёт в `SidebarContent`):

```tsx
"use client";

import SidebarContent from "./SidebarContent";

/**
 * Desktop sidebar — always visible at md+ breakpoint, hidden on mobile.
 * On mobile, the same content is rendered inside `<MobileNav />` as a drawer.
 */
export default function Sidebar() {
  return (
    <aside
      className="hidden md:flex h-screen flex-col border-r border-rule bg-surface"
      style={{ width: "var(--sidebar-width)" }}
    >
      <SidebarContent />
    </aside>
  );
}
```

**Ключевая часть:** `hidden md:flex` — на мобиле sidebar полностью скрыт (даже не занимает место в DOM-flow для layout flex).

### 4.4. `src/components/layout/Header.tsx` — hamburger + responsive search

**Изменения:**
1. Импортировать `Menu` icon из `lucide-react` и `useMobileNav` hook.
2. Добавить hamburger-кнопку слева, видимую только на мобиле (`md:hidden`).
3. Search bar превратить в desktop-only (`hidden md:flex`).
4. Добавить иконку-кнопку поиска для мобилы (`md:hidden`).
5. Уменьшить gap и padding на мобиле (например, `gap-2 px-3` на мобиле, `gap-3 px-6` на desktop).

**Полный новый Header.tsx:**

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Bell, LogOut, Menu, Search, ShieldCheck } from "lucide-react";
import { useMounted } from "@/lib/use-mounted";
import { useMobileNav } from "@/lib/mobile-nav-context";

interface MeUser {
  username: string;
  displayName: string | null;
  role: string;
}

export default function Header() {
  const router = useRouter();
  const mounted = useMounted();
  const [me, setMe] = useState<MeUser | null>(null);
  const { setOpen: setMobileNavOpen } = useMobileNav();

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && j?.user) setMe(j.user);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const initials =
    me?.displayName
      ?.split(/\s+/)
      .map((p) => p[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() ||
    me?.username?.slice(0, 2).toUpperCase() ||
    "U";

  return (
    <header
      className="flex shrink-0 items-center gap-2 border-b border-rule bg-surface px-3 md:gap-3 md:px-6"
      style={{ height: "var(--topbar-height)" }}
    >
      {/* Hamburger (mobile only) */}
      <button
        onClick={() => setMobileNavOpen(true)}
        aria-label="Open navigation menu"
        className="grid h-9 w-9 place-items-center rounded-md text-ink-2 hover:bg-bg-elev hover:text-ink md:hidden"
      >
        <Menu size={18} />
      </button>

      {/* Search bar (desktop only) */}
      <div className="hidden md:flex flex-1 items-center gap-2 max-w-[380px] rounded-md border border-rule bg-surface-tint px-3 py-1.5 text-[12.5px] text-ink-3">
        <Search size={14} className="text-ink-3" />
        <span className="flex-1 truncate">Search orders, cases, SKUs…</span>
        <span className="kbd">⌘K</span>
      </div>

      {/* Search icon button (mobile only) */}
      <button
        aria-label="Search"
        className="grid h-9 w-9 place-items-center rounded-md text-ink-2 hover:bg-bg-elev hover:text-ink md:hidden"
      >
        <Search size={18} />
      </button>

      <div className="flex-1" />

      {/* Live pill (≥ sm) */}
      <div className="hidden items-center gap-1.5 rounded-md bg-green-soft px-2.5 py-1 text-[11px] font-medium text-green-ink sm:inline-flex">
        <span className="live-dot" />
        <span>5 stores live</span>
      </div>

      {/* Notifications */}
      <button
        aria-label="Notifications"
        className="grid h-8 w-8 place-items-center rounded-md text-ink-2 hover:bg-bg-elev hover:text-ink"
      >
        <Bell size={16} />
      </button>

      {/* User chip */}
      {me && mounted && (
        <div className="flex items-center gap-2 rounded-full border border-rule bg-surface-tint pr-3">
          <div className="grid h-7 w-7 place-items-center rounded-full bg-green text-[11px] font-semibold text-green-cream">
            {initials}
          </div>
          <div className="hidden flex-col leading-tight sm:flex">
            <div className="flex items-center gap-1 text-[12px] font-medium text-ink">
              {me.displayName || me.username}
              {me.role === "admin" && (
                <ShieldCheck size={11} className="text-green" />
              )}
            </div>
          </div>
          <button
            onClick={logout}
            title="Sign out"
            aria-label="Sign out"
            className="grid h-7 w-7 place-items-center rounded-full text-ink-3 hover:text-ink"
          >
            <LogOut size={13} />
          </button>
        </div>
      )}
    </header>
  );
}
```

**Что изменилось:**
- `gap-3 px-6` → `gap-2 px-3 md:gap-3 md:px-6` (меньше промежутков на мобиле).
- Добавлен Hamburger button (md:hidden).
- Search bar теперь `hidden md:flex` (только desktop).
- Добавлен Search icon button (md:hidden) — клик пока ничего не делает (search-функционал для мобилы — Phase 2 или отдельная задача).
- `flex-1` spacer перенесён в правильное место — между search-button и live-pill.

### 4.5. `src/app/procurement/page.tsx` — search input высота

В коде Procurement page есть search-input в верхней части страницы. Найти его и убедиться, что высота на мобиле — минимум 40px (комфортно для пальца). Если сейчас `py-1.5` (~32px) или `h-9` (36px) — на мобиле увеличить до `h-10` (40px).

**Паттерн изменения** (искать в `src/app/procurement/page.tsx`):

```tsx
// Before:
<input
  type="search"
  placeholder="..."
  className="... py-1.5 ..."
/>

// After:
<input
  type="search"
  placeholder="..."
  className="... h-10 md:h-9 ..."
/>
```

Если в текущем коде `h-9` уже стоит — оставить как есть, на 36px тоже OK для тапа.

### 4.6. `src/app/procurement/components/ProcurementCard.tsx` — touch targets

Найти все иконочные кнопки (Copy, Edit, и т.д.) которые сейчас имеют **`h-7 w-7`** (28px). Заменить на:

```tsx
// Before:
className="... h-7 w-7 ..."

// After:
className="... h-9 w-9 md:h-7 md:w-7 ..."
```

Это даст 36px на мобиле (комфортно для тапа) и сохранит компактные 28px на desktop.

**Применить ко всем кнопкам с `h-7 w-7` в `ProcurementCard.tsx`.** Другие размеры (`h-8 w-8`, `h-9 w-9`) — не трогать, они уже OK.

### 4.7. `src/app/procurement/components/StorePriorityPopup.tsx` — touch targets

Аналогично 4.6 — найти кнопки `h-7 w-7` (это ↑/↓/удалить кнопки в списке магазинов) и применить:

```tsx
className="... h-9 w-9 md:h-7 md:w-7 ..."
```

---

## 5. Testing checklist

После реализации в Chrome DevTools (Cmd+Option+I → toggle device toolbar) проверить на следующих viewport-ах:

### iPhone SE (375 × 667)
- [ ] При открытии любой страницы (например `/`) sidebar **не виден**, занимает 0px ширины.
- [ ] В Header слева видна иконка hamburger ≡, по центру/справа — иконка лупы 🔍, далее уведомления, user chip.
- [ ] **Тап по hamburger** открывает drawer слева (ширина 280px), затемняет фон.
- [ ] Drawer содержит весь sidebar: Brand, Workspace switcher, Operations, Phase 2, Settings, Daily plan helper card.
- [ ] **Тап по любой nav-ссылке** (например "Procurement") переходит на эту страницу И автоматически закрывает drawer.
- [ ] **Тап по затемнённому фону** или по `X` в drawer закрывает drawer.
- [ ] Тап по disabled item (Listings/Suppliers/Sales) НЕ закрывает drawer и НЕ переходит никуда.
- [ ] Content padding на странице ~16px (не 32px).
- [ ] Procurement page работает: cards помещаются, copy/edit кнопки 36×36px.

### iPad (768 × 1024)
- [ ] Sidebar **виден** слева как обычно (236px).
- [ ] Hamburger-кнопка и search-icon button **скрыты**.
- [ ] Search bar в Header **виден** (как раньше).
- [ ] Content padding desktop (~32px).

### MacBook (1280 × 800)
- [ ] Всё как раньше — никаких визуальных изменений на desktop.

### Edge cases
- [ ] **Login страница** (`/login`) — drawer и hamburger **не появляются** (страница использует `STANDALONE_PREFIXES` ранний return).
- [ ] **Invite страница** (`/invite/[token]`) — то же самое, drawer не появляется.
- [ ] **При rotate iPhone в landscape** (667 × 375): остаётся в мобильном режиме (так как 375 < 768).
- [ ] **При resize окна на десктопе** через 768px брейкпоинт: drawer закрывается автоматически (если был открыт), sidebar появляется fixed.
   - Если drawer остаётся открытым — это OK, он просто будет невидимым (под sidebar). Пользователь сам закроет.

### Functional regression
- [ ] Все ссылки в sidebar работают (как desktop, так и mobile).
- [ ] `pillCount` (badge с цифрами) виден и обновляется каждые 60 секунд.
- [ ] Helper card "Daily plan ready" появляется только когда есть `awaitingShipment > 0`.
- [ ] Logout button работает на всех breakpoint'ах.

---

## 6. После завершения

### 6.1. Wiki update

В файле `docs/wiki/mobile-adaptation.md` заменить секцию "Phase 1" так:

```md
### Phase 1 — Procurement Mobile ✅ ЗАВЕРШЁН (2026-XX-XX)

App Shell адаптирован под мобильные устройства:
- Sidebar превращается в drawer на `< 768px` (shadcn Sheet, slide from left, 280px)
- Hamburger button в Header открывает drawer
- Search bar заменён на иконку-кнопку на мобиле
- Content padding уменьшен с 32px до 16px на мобиле
- Procurement card touch-targets подняты до 36px на мобиле

**Новые файлы:**
- `src/lib/use-is-mobile.ts`
- `src/lib/mobile-nav-context.tsx`
- `src/components/layout/SidebarContent.tsx`
- `src/components/layout/MobileNav.tsx`

**Изменённые файлы:**
- `src/app/layout.tsx` (wrap в MobileNavProvider)
- `src/components/layout/AppShell.tsx` (рендер MobileNav, padding)
- `src/components/layout/Sidebar.tsx` (hidden md:flex)
- `src/components/layout/Header.tsx` (hamburger, responsive search)
- `src/app/procurement/page.tsx` (search input высота)
- `src/app/procurement/components/ProcurementCard.tsx` (touch targets)
- `src/app/procurement/components/StorePriorityPopup.tsx` (touch targets)
```

### 6.2. CONNECTIONS.md update

В `docs/wiki/CONNECTIONS.md` добавить:

```md
## mobile-adaptation
- mobile-adaptation ⊂ AppShell (фундамент изменился в Phase 1)
- mobile-adaptation ⊂ Sidebar
- mobile-adaptation ⊂ Header
- mobile-adaptation ⊂ Procurement (touch-targets)
- mobile-adaptation ← MobileNavContext (новый)
- mobile-adaptation ← shadcn/ui:Sheet
```

### 6.3. Git commit message

```
feat(mobile): Phase 1 — App Shell mobile adaptation

- Sidebar converts to drawer on < 768px (shadcn Sheet)
- Hamburger button in Header for mobile
- Responsive search (full bar on desktop, icon on mobile)
- Content padding 32px → 16px on mobile
- Procurement touch-targets 28px → 36px on mobile

Files: 4 new, 7 modified.
Refs: docs/MOBILE_ADAPTATION_AUDIT.md (Phase 0 audit)
```

---

## 7. Что НЕ входит в Phase 1 (для Phase 2)

Эти задачи помечены в audit, но решаются в следующих промптах:

1. **~10 таблиц → mobile-cards** — Dashboard awaiting-fulfillment, Customer Hub Messages, Shipping Labels, AdjustmentsTable, SkuIssuesPanel, IncidentsTable, AtozTable, FeedbackTable, AtozTab/ChargebacksTab/FeedbackTab, SKU Database в Settings.
2. **MessageDetail action row** — `flex-wrap` на 6+ кнопках.
3. **MetricRow в Account Health StoreCard** — `flex-col sm:flex-row`.
4. **skuModal в Shipping** — `grid-cols-4` → `grid-cols-2 sm:grid-cols-4`.
5. **Settings GmailAccountsPanel/SpApiStoresPanel rows** — `flex-col sm:flex-row` с `min-w-0` + `truncate`.
6. **Search-функционал на мобиле** — сейчас `<button aria-label="Search">` не реагирует. Phase 2 может открывать modal-search (Cmd+K equivalent).

## 8. Отдельная задача (вне mobile)

В audit найдены 3 файла на синей Tailwind-палитре вместо Salutem Design System:
- `src/app/login/page.tsx`
- `src/app/invite/[token]/page.tsx`
- `src/components/cs/StoreTabs.tsx`

Это **легаси-баг**, не связанный с mobile. Рекомендация — отдельный промпт на ребрендинг (~30 минут). НЕ объединять с Phase 1.

---

**Конец промпта.** После реализации Vladimir тестирует на iPhone, фиксы (если есть) — отдельным промптом или прямыми правками.
