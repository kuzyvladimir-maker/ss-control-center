# 📄 Label PDF Filename Format

## Суть
Стандарт именования PDF-файлов shipping labels при сохранении в Google Drive.

## Формат
```
(EDD Mmm DD | DL Mmm DD) Product Name -- Qty.pdf
```

## Примеры
- `(EDD Apr 07 | DL Apr 09) Chocolate Gift Box -- 2.pdf`
- `+ (EDD Apr 08 | DL Apr 10) Ice Cream Set -- 1.pdf`

## Префикс "+"
Frozen заказ с 4-дневной доставкой (с согласия Владимира). Помечается вручную в плане.

## Google Drive структура
```
Shipping Labels / MM Month / DD / Channel /
```
Пример: `Shipping Labels / 04 April / 07 / Amazon /`

## 🔗 Связи
- **Часть:** [Shipping Labels](shipping-labels.md), [n8n Автоматизация](n8n-automation.md)

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
