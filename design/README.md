# SS Control Center — Design Mockups

Папка с HTML-мокапами дизайна для SS Control Center. Каждый файл — полностью рабочая страница (HTML + inline CSS), которую можно открыть в браузере и посмотреть как должен выглядеть модуль.

## Содержимое

| Файл | Модуль | Статус |
|------|--------|--------|
| `dashboard_salutem.html` | Dashboard (главный экран) | ✅ Готов, соответствует CLAUDE.md |
| `shipping_labels_salutem.html` | Shipping Labels | ✅ Готов, соответствует MASTER_PROMPT_v3.1.md |
| `adjustments_salutem.html` | Adjustments | ✅ Готов, соответствует CLAUDE_CODE_PROMPT_ADJUSTMENTS.md |
| `settings_salutem.html` | Settings → Integrations | ✅ Готов, показывает SP-API × 5 stores, Gmail × 5, Claude/OpenAI API, Veeqo, Sellbrite, Telegram, Google Drive/Sheets |
| `DESIGN_TOKENS.md` | Дизайн-система | Палитра, типографика, компоненты |

## Что НЕ загружено (будет сделано заново)

- **Customer Hub** — существующий `customer_hub_salutem.html` в чате сделан по устаревшему v1 алгоритму (скриншоты, C1-C10). Нужно пересоздать по **v2.1** (4 таба Messages / A-to-Z / Chargebacks / Feedback, Gmail API, типы T1-T20).
- **Account Health** — модуль есть в CLAUDE.md sidebar, но мокап ещё не сделан.
- **Frozen Analytics** — есть `docs/FROZEN_ANALYTICS_v1.0.md`, мокап пока не сделан.

Эти три страницы будут добавлены следующими.

## Sidebar (правильный, будет обновлён во всех файлах)

```
Operations:
  📊 Dashboard
  💓 Account Health         ← пересоздать
  🚚 Shipping Labels
  🎯 Customer Hub (v2.1)    ← пересоздать по v2.1
  🌡️ Frozen Analytics       ← новый
  📊 Adjustments

Phase 2 (disabled):
  🏷️ Product Listings
  💰 Sales Analytics

Settings (отдельно):
  ⚙️ Settings
```

Модуль `Shipment Monitor` из старого мокапа **удалён** — его нет в проекте, это было моё допущение.

## Как использовать

1. Открой любой `.html` файл напрямую в браузере — посмотришь полностью отрисованный мокап.
2. Скопируй дизайн-токены из `DESIGN_TOKENS.md` в Tailwind config или в `globals.css`.
3. Используй мокапы как reference когда даёшь Claude Code задачи на реализацию компонентов.

---

*Created: 2026-04-19*
*Design direction: Atelier (Variant C) refined to Salutem brand — forest green + silver on cool off-white*
