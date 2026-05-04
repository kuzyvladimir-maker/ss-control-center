# Legacy Rebrand — Login / Invite / StoreTabs (2026-05)

## Контекст
В ходе Phase 0 mobile audit (2026-05-03) обнаружено, что 3 файла используют стандартную Tailwind-палитру (синие/серые цвета) вместо Salutem Design System. Это легаси от до-Salutem периода разработки.

## Что было исправлено
- `src/app/login/page.tsx` — переведён на Salutem
- `src/app/invite/[token]/page.tsx` — переведён на Salutem
- `src/components/cs/StoreTabs.tsx` — переведён на Salutem

## Принцип
Все Tailwind palette классы (`bg-blue-*`, `text-gray-*`, `border-slate-*`, etc.) заменены на Salutem токены через стандартный mapping (см. `docs/CLAUDE_CODE_PROMPT_LEGACY_REBRAND.md` § 2).

## Ключевые правила Salutem (для будущих компонентов)
- Текст на зелёном фоне = `text-green-cream` (НЕ `text-white`)
- Основной текст = `text-ink` (НЕ `text-black` или `text-gray-900`)
- Границы инпутов = `border-rule-strong`
- Focus = `focus:ring-green-mid`
- Error = `text-danger` + `bg-danger-tint`
- Brand button = `bg-green hover:bg-green-deep text-green-cream`

## 🔗 Связи
← Salutem Design System v1.0 (`/design/DESIGN_TOKENS.md`)
← Mobile Adaptation audit (Phase 0, обнаружил баги)
→ Auth System (login UI)
→ Customer Hub (StoreTabs)
