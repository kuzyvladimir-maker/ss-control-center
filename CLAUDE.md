# CLAUDE.md — Salutem Solutions Control Center

## 🎯 О ПРОЕКТЕ

**SS Control Center** — веб-платформа для управления e-commerce бизнесом на маркетплейсах (Amazon, Walmart). Единый интерфейс для управления заказами, доставкой, клиентским сервисом, аналитикой и здоровьем аккаунтов.

**Владелец:** Владимир (не разработчик). Объясняй простыми словами. Код с комментариями.

---

## 🏗️ ТЕХНИЧЕСКИЙ СТЕК

```
Frontend:  Next.js 14+ (App Router) + React 18 + TypeScript
Styling:   Tailwind CSS + shadcn/ui components
Backend:   Next.js API Routes (app/api/)
Database:  SQLite (Prisma ORM)
AI:        Anthropic Claude API + OpenAI (fallback)
Auth:      Пока нет
```

---

## 🏪 АККАУНТЫ AMAZON (5 штук)

| # | Аккаунт | Email | Store Index | SP-API | Gmail API |
|---|---------|-------|-------------|--------|-----------|
| 1 | Salutem Solutions | amazon@salutem.solutions | store1 | ✅ | ❌ (нужен OAuth) |
| 2 | Vladimir Personal | kuzy.vladimir@gmail.com | store2 | ✅ | ✅ |
| 3 | AMZ Commerce | TBD | store3 | ✅ | ❌ |
| 4 | Sirius International | TBD | store4 | ✅ | ❌ |
| 5 | Retailer Distributor | TBD | store5 | ✅ | ❌ |

Walmart — 1 аккаунт (API ключ пока отсутствует).

## 📚 СПРАВОЧНЫЕ ДОКУМЕНТЫ

| Файл | Содержание | Статус |
|------|-----------|--------|
| `docs/CUSTOMER_HUB_ALGORITHM_v2.2.md` | Customer Hub: Messages, A-to-Z, CB, Feedback, Decision Engine, Guardrails, Walmart | **Актуальный** |
| `docs/AMAZON_NOTIFICATIONS_MAP.md` | Маппинг уведомлений Amazon → модули CC + Gmail queries | **Актуальный** |
| `docs/MASTER_PROMPT_v3.1.md` | Shipping Labels | **Актуальный** |
| `docs/FROZEN_ANALYTICS_v1.0.md` | Frozen delivery analytics | **Актуальный** |

## 📝 ПРАВИЛА ДОКУМЕНТИРОВАНИЯ

1. Каждый модуль имеет свой документ-алгоритм в папке docs/
2. При критических изменениях — новая версия файла (vX.Y.md)
3. Старые версии НЕ удалять
4. Документы сохраняются в /docs/ проекта И на iMac через filesystem MCP

## ❌ ЧЕГО НИКОГДА НЕ ДЕЛАТЬ

- Не хардкодить API ключи
- Не угадывать тип товара (Frozen/Dry) — только по тегам Veeqo
- Не использовать SAFE-T для carrier delay
- Не спорить о безопасности еды с клиентом
- Не просить вернуть frozen товары (food safety)
- Не предлагать cancel для shipped orders
