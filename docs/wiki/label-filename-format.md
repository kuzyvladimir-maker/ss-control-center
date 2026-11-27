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

Для этикеток, купленных через `/api/shipping/buy`, месяц и день папки берутся из **`Ship` (`physicalShipDate`)** — даты передачи посылки перевозчику. Папка канала выбирается по каналу заказа.

```
Shipping Labels / MM Month / DD / Channel /
```

Например, если для Amazon указаны `Label` = `2026-11-27` и `Ship` = `2026-11-30`, PDF сохраняется в `Shipping Labels / 11 November / 30 / Amazon /`. Склад ищет этикетку среди отправлений на 30 ноября. Формат имени PDF по-прежнему содержит EDD и DL.

## 🔗 Связи
- **Часть:** [Shipping Labels](shipping-labels.md), [n8n Автоматизация](n8n-automation.md)

## История
- 2026-11-27: Зафиксировано правило выбора папки Google Drive по `physicalShipDate` при независимой ручной правке `Label` и `Ship`.
- 2026-04-10: Wiki-статья создана при полной индексации проекта
