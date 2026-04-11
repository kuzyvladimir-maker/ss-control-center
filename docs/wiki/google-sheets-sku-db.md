# 📊 SKU Shipping Database v2 — Google Sheets

## Суть
Единственный источник весов и размеров для покупки shipping labels. Google Sheets таблица, lookup по SKU.

## Таблица
- **ID:** `1H-bx0iZ_oL0i0CFbHN_QbfXzkGJC_f_hV90s-V6cqzY`
- **Sheet:** Sheet1

## Колонки
| Колонка | Заголовок | Использование |
|---------|-----------|---------------|
| A | SKU | Lookup key |
| B | Product Title | В план |
| C | Marketplace | Инфо |
| D | Category | Доп. Frozen/Dry |
| E | Length (in) | Dimensions → Veeqo |
| F | Width (in) | Dimensions → Veeqo |
| G | Height (in) | Dimensions → Veeqo |
| H | Weight (lbs) | Вес для UPS/USPS/FedEx |
| K | Weight FedEx (lbs) | ТОЛЬКО для FedEx One Rate (H × 1.25) |

## ⚠️ Важно
- Формулы расчёта ice_weight УБРАНЫ (v3.1). Таблица содержит финальные веса включая лёд.
- Если SKU нет → fallback на историю Veeqo → если нет нигде → СТОП.

## Связанные файлы
- `src/lib/google-sheets.ts` — API клиент

## 🔗 Связи
- **Используется в:** [Shipping Labels](shipping-labels.md), [n8n Автоматизация](n8n-automation.md)
- **Связан с:** [Adjustments Monitor](adjustments-monitor.md) (suggestedWeight → обновить таблицу)
- **См. также:** [Veeqo API](veeqo-api.md) (fallback на историю)

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
