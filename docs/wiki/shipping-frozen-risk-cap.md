# 🌡️ Shipping — Frozen risk-level → calendar-day cap override

## Суть
Для Frozen-Amazon заказов алгоритм выбора рейта ограничивает максимальный
транзит в календарных днях от `physicalShipDate`. Master Prompt v3.4
ужесточил правило: если есть pending `FrozenRiskAlert` с
`riskLevel = "critical"` — потолок **2 дня** вместо стандартных **3**.
Любой Ground / Saver вариант с EDD > 2 cal.day у такого заказа в pool
не попадает.

Зачем: critical-уровень риска ставится `frozen-analytics` rules-engine'ом
когда:
- destZip ожидает экстремальную жару (>30-летней нормы на много градусов)
- multi-day high-temp в маршруте
- комбинация origin-Tampa + destination в Аризоне/Техасе летом

В таких случаях даже on-time доставка с 3-day транзитом подвергает
food-safety риску. Vladimir прямо сформулировал 2026-06-07:
> "если у нас определяется статус Frozen risk critical, то мы тогда
> выбираем рейт не 3 календарных дня, а 2 календарных дня."

## Связано с
- [docs/MASTER_PROMPT_v3.4.md](../MASTER_PROMPT_v3.4.md) §5 FROZEN — спека
- [shipping-frozen-transit-anchor](shipping-frozen-transit-anchor.md) — где меряем "N days" (must be в Pacific TZ от actualShipDay)
- `src/app/api/shipping/plan/route.ts` — функция `frozenMaxCalDays(riskLevel)`, batch FrozenRiskAlert lookup + проброс
- `src/lib/frozen-analytics/rules-engine.ts` — `LEVEL_ORDER` = `["ok","low","medium","high","critical"]`
- `prisma/schema.prisma` — model `FrozenRiskAlert.riskLevel` String

---

## 🔁 Flow

### 1. Один SQL up-front в `/plan`
Перед циклом по orders:
```ts
const alertRows = await prisma.frozenRiskAlert.findMany({
  where: { orderId: { in: orderNumbersForRisk }, status: "pending" },
  select: { orderId: true, riskLevel: true },
});
```
Один заказ может иметь несколько alert rows (разные ship dates) — берём
**максимальный** riskLevel по rank `ok<low<medium<high<critical` чтобы
cap был conservativem.

### 2. Проброс в `selectBestRate`
Сигнатура: `selectBestRate(rates, productType, deliveryBy, actualShipDay, dayName, isAfterNoon, frozenRiskLevel?: string|null)`.
- today-pick call: `frozenRiskLevel = frozenRiskByOrderNumber.get(order.number) ?? null`
- Monday-shift trick call: тот же riskLevel (одна и та же еда)

### 3. Cap
```ts
function frozenMaxCalDays(riskLevel) {
  return (riskLevel ?? "").toLowerCase() === "critical" ? 2 : 3;
}
```
Внутри `selectBestRate` Frozen branch:
```ts
const maxCalDays = frozenMaxCalDays(frozenRiskLevel);
let pool = enriched.filter(r => r.calDays <= maxCalDays);
```
Дальше всё как раньше: Wed → no Ground, Fri → no FedEx Express,
tolerance window, sort by calDays/EDD/price.

### 4. Surface в UI
- `notes` плана содержит `[frozen-rate] ... risk=CRITICAL→max2d ...` когда правило сработало.
- `stopReason` для no-rate case: `Frozen — none of N/M on-time rates deliver within 2 calendar days (food safety) — risk=CRITICAL tightens cap to 2 days. Monday-shift trick also didn't help.`
- Карточка показывает FrozenRiskBadge `CRITICAL · 95` — этот же сигнал, операторcontext не пропадает.

---

## 🤔 Что НЕ изменилось
- Если alert.status != "pending" (applied / ignored / resolved) — он не
  учитывается, дефолтный ≤3-day cap.
- Если FrozenRiskAlert вообще нет (свежий заказ, frozen-analytics ещё не прогнался) — дефолтный ≤3-day cap.
- Для не-Frozen и не-Amazon — никаких изменений. Dry-логика осталась `cheapest-meeting-deadline`.

---

## 📝 История
- **2026-06-07** — Vladimir's запрос после того как UI mismatch (EDD 6/11 vs 6/12 в модалке) был починен. Новое правило `critical → 2 days` — добавление к Master Prompt без модификации существующего поведения для других risk levels.
