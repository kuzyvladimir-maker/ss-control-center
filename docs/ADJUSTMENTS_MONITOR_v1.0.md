# 💸 Shipping Adjustments Monitor — Salutem Solutions Control Center
## Version 1.0 — 2026-04-07

---

## 🎯 ЗАДАЧА МОДУЛЯ

Маркетплейсы (Amazon и Walmart) автоматически измеряют посылки на своих объектах и если обнаруживают расхождение с заявленными размерами или весом — выставляют дополнительный чардж. Это называется **Shipping Adjustment**.

Модуль автоматически:
1. Периодически сканирует транзакции Amazon SP-API и Walmart на предмет adjustment-зарядов
2. Сопоставляет adjustment с конкретным заказом и этикеткой
3. Выявляет системные проблемы (один SKU постоянно корректируется)
4. Показывает суммарные потери за период
5. Предлагает исправить данные в SKU Database v2

---

## 📋 ДАННЫЕ ПО КАЖДОМУ ADJUSTMENT

| Поле | Источник | Пример |
|------|---------|--------|
| Adjustment ID | Amazon/Walmart API | ADJ-20260404-001 |
| Order ID | API | 113-4567890 |
| Adjustment Date | API | 2026-04-04 |
| Adjustment Amount | API | -$4.73 |
| Reason | API | "Weight Adjustment" / "DIM Adjustment" |
| Original label cost | shipping_labels table | $9.09 |
| Declared weight | shipping_labels / SKU DB | 8.5 lbs |
| Declared dims | SKU DB | 13x13x15 |
| Adjusted weight | API (if available) | 11.2 lbs |
| Carrier | shipping_labels | UPS |
| SKU | order | JD-SEBC-12CT |
| Channel | — | Amazon / Walmart |

---

*Version: v1.0 — 2026-04-07*
*Module: Shipping Adjustments Monitor*
