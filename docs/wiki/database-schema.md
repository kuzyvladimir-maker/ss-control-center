# 🗄️ Database Schema (Prisma)

## Суть
SQLite через Prisma ORM. 19 моделей. Файл: `prisma/schema.prisma`. Generated client: `src/generated/prisma/`.

## Модели по модулям

### Customer Hub
| Модель | Назначение |
|--------|-----------|
| `BuyerMessage` | Сообщения покупателей (Gmail + скриншоты) |
| `AtozzClaim` | A-to-Z claims + Chargebacks |
| `SellerFeedback` | Отзывы продавца |
| `ProductReview` | Отзывы на товар |
| `CsCase` | Legacy CS кейсы |

### Shipping
| Модель | Назначение |
|--------|-----------|
| `ShippingPlan` | Планы доставки |
| `ShippingPlanItem` | Позиции в плане |
| `ProductTypeOverride` | Frozen/Dry переопределения |

### Analytics
| Модель | Назначение |
|--------|-----------|
| `FrozenIncident` | Инциденты frozen |
| `SkuRiskProfile` | Риск-профили SKU |
| `ShippingAdjustment` | Корректировки |
| `SkuAdjustmentProfile` | Профили корректировок |

### Account Health
| Модель | Назначение |
|--------|-----------|
| `AccountHealthSnapshot` | Снимки метрик |
| `AccountAlert` | Алерты |

### System
| Модель | Назначение |
|--------|-----------|
| `Store` | Магазины |
| `Setting` | Настройки |
| `AmazonOrder` | Синхронизированные заказы |
| `ReportSyncJob` | Задачи синхронизации |
| `SyncLog` | Логи синхронизации |

## Связанные файлы
- `prisma/schema.prisma` — определение схемы
- `src/lib/prisma.ts` — клиент
- `src/generated/prisma/` — generated client
- `dev.db` — файл базы данных

## 🔗 Связи
- **Используется в:** все модули
- **См. также:** [Customer Hub](customer-hub.md), [Shipping Labels](shipping-labels.md), [Account Health](account-health.md), [Frozen Analytics](frozen-analytics.md), [Adjustments Monitor](adjustments-monitor.md)

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
