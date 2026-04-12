# 📦 Shipment Monitor

## Статус: Спроектирован (реализация после Phase 1)

## Что делает
Автоматически мониторит все отправки через Veeqo, выявляет проблемные доставки (потерянные, задержанные, застрявшие) и готовит данные для подачи claims перевозчикам.

## Ключевые решения
- **MVP на Veeqo tracking API** — бесплатно, покрывает 80% кейсов. Carrier API (UPS/FedEx/USPS) подключаются позже как Level 2
- **Rule-based детекция** — 10 типов проблем с настраиваемыми порогами
- **Confidence score** — автоматическая оценка обоснованности claim (0-1)
- **Ежедневный cron** — sync → detect → notify

## Связанные документы
- Спецификация: `docs/SHIPMENT_MONITOR_SPEC_v1_0.md`
- Veeqo API: `wiki/veeqo-api.md`
- Frozen Analytics: `wiki/frozen-analytics.md`
- Carrier APIs: `wiki/carrier-tracking-apis.md`
- Telegram: `wiki/telegram-notifications.md`

## Зависимости
- Veeqo API (tracking events endpoint)
- Shipping Labels модуль (БД с label данными)
- Telegram (уведомления)
- Опционально: UPS/FedEx/USPS API (Level 2)
