# 🏪 Walmart — multi-warehouse inventory (multiple ship nodes)

## Суть
Аккаунт Vladimir-а в Walmart Seller Center имеет несколько fulfillment
centers (=ship nodes). На скриншоте 2026-06-07 видно как минимум:
- `Warehouse 1162` — основной склад
- `STARFITSTORE - 10001624309 - MP` — partner store
- (третий ship node `730896778776272897` тоже виден в API dumps)

Walmart `PUT /v3/inventory?sku=X` без параметра `shipNode` обновляет
**только default ship node**. Остальные warehouses остаются с своим
stock'ом и продолжают продавать товар. Это объясняет почему "снятие с
продажи" через UI/Jackie казалось успешным (наш GET readback тоже без
shipNode возвращал 0), а Walmart Seller Center показывал 48 единиц
inventory на этом же SKU.

## Связано с
- `src/lib/walmart/inventory.ts` — **новый файл**, содержит
  `getKnownShipNodes`, `readInventoryAcrossNodes`, `setInventoryAllNodes`
- `src/app/api/walmart/retire-listing/execute/route.ts` — переписан на
  multi-node fan-out
- `src/app/api/walmart/retire-listing/sku-details/route.ts` —
  `currentQty` теперь sum по всем nodes (UI больше не показывает "сток 0"
  когда другой склад имеет 50 единиц)
- `src/lib/jackie-mcp/tools/walmart-inventory.ts` — `walmart_inventory_update`
  получил `all_ship_nodes: true` опцию для retire-flow
- [Walmart API](walmart-api.md) — эндпоинты inventory и ship-node discovery
- [Walmart catalog cache](walmart-catalog-cache.md) — связанный баг рассинхрона каталога

---

## 🔁 API endpoint reference

| Endpoint | Поведение |
|----------|-----------|
| `GET /v3/inventory?sku=X` | Default ship node only |
| `GET /v3/inventory?sku=X&shipNode=N` | Specific ship node |
| `PUT /v3/inventory?sku=X` body=`{quantity}` | Updates default ship node only |
| `PUT /v3/inventory?sku=X&shipNode=N` body=`{quantity}` | Updates specific node |
| `GET /v3/inventories` (плюрал) | **Игнорирует sku filter**, возвращает paginated all inventory с `nodes[]` breakdown. Единственный способ discover'ить ship nodes (другие пытались endpoints: `/v3/shipnodes`, `/v3/ship-nodes`, `/v3/seller/shipnodes` — все 404) |

### Live probe (FaisalX-1288, 2026-06-07)
```
GET /v3/inventory?sku=FaisalX-1288                           → 0 (default node)
GET /v3/inventory?sku=FaisalX-1288&shipNode=730896778776272897 → 0
GET /v3/inventory?sku=FaisalX-1288&shipNode=10001624309        → 0
GET /v3/inventory?sku=FaisalX-1288&shipNode=685099568484274177 → 50 ← Warehouse 1162
```
Default читает один из обнулённых, остаток 50 в Warehouse 1162 невиден.

---

## 🔧 Algorithm

### Ship-node discovery
1. Module-level `nodeCache: Map<storeIndex, {nodes, fetchedAt}>` — TTL 1h.
2. `getKnownShipNodes()` paginate'ит `/v3/inventories` до 3 страниц
   (Walmart возвращает 10 items/page; за 3 страницы 30 items × ~3 nodes/item почти
   гарантированно покрывает все unique shipNodes аккаунта).
3. Union distinct `shipNode` values из `elements.inventories[].nodes[]`.
4. На любом Walmart-error возвращает `[]` (не throw) — caller fall-back'ит на default-node behaviour.

### Multi-node read
`readInventoryAcrossNodes(client, storeIndex, sku)`:
- Получает known shipNodes
- Для каждого: `GET /v3/inventory?sku=X&shipNode=N`
- Возвращает `{ nodes: [{shipNode, qty}], totalQty }`
- Per-node failure → `qty: null` для этого node (но цикл продолжается)

### Multi-node write
`setInventoryAllNodes(client, storeIndex, sku, amount)`:
- Получает known shipNodes
- Для каждого: `PUT /v3/inventory?sku=X&shipNode=N` body `{quantity: {unit:"EACH", amount}}`
- Возвращает `[{shipNode, ok, error?}]`
- Per-node failure не abort'ит: лучше обнулить 2 из 3, чем abort после первой ошибки и оставить inventory live.

---

## ✅ Updated retire flow
```
1. before = readInventoryAcrossNodes(sku)     // sum across nodes = previousQty
2. writes = setInventoryAllNodes(sku, 0)      // fan-out PUT
3. if any write fails:
     audit row + error "${failedCount}/${total} ship-node PUT(s) failed"
     STOP
4. after = readInventoryAcrossNodes(sku)
5. if after.totalQty > 0:
     audit row + error "Walmart accepted PUTs but stock is still N (perNode breakdown)"
6. else: audit row + ok, with perNode + writes details
```

UI получает:
- `previousQty` — сколько было всего
- `verifiedQty` — сколько осталось всего
- `perNode` — детальный breakdown какой warehouse как себя ведёт
- `writes` — какие PUT прошли / failed

---

## ⚠️ Edge cases
- **Discovery failed (empty node list)**: fall back на single-node default
  behaviour чтобы не блочить retire полностью. Less safe, but no worse than
  до фикса. Cron-job warning logs.
- **Per-SKU node distribution**: разные SKU могут быть в разных subsets nodes.
  GET без `shipNode` на SKU которого нет в этом node возвращает 404 (или 0?).
  Helper тихо trеats как qty=0/null — sum считает правильно.
- **Новый warehouse появился после last cache refresh**: до 1h задержка.
  Можно вручную invalidate через `invalidateShipNodeCache(storeIndex)` или
  подождать TTL.
- **Walmart inventory updates async**: UI labels "Updates may take up to 1 hour" —
  но GET readback в нашем коде происходит через ~500ms. Reads после write
  обычно возвращают свежее значение (eventually consistent через секунды).

---

## 📝 История
- **2026-06-07** Vladimir показал screenshots: 4 SKU в нашем UI помечены
  "Снят, сток 0", но Walmart Seller Center показывает inventory 48, 49,
  21, 42 на тех же SKU. Inventory модалка в Seller Center показывает
  Warehouse 1162 с on hand 50 / available 21 (residual + reserved
  variance), второй warehouse (STARFITSTORE) с 0. Это раскрыло multi-node
  setup. Live probe с FaisalX-1288 подтвердил — третий ship node
  `685099568484274177` (Warehouse 1162) держит 50 единиц, наш default-node
  PUT туда не достучался.
- Fix реализован тем же днём: helpers, retire-listing fix, sku-details fix,
  Jackie tool extension.

---

## 🔜 TODO (отдельные тикеты)
- **Catalog cache mismatch**: тот же screenshot показал 6 SKU в Walmart Seller
  Center search, но наш cache нашёл только 4 ("Arnold Potato Buns"). Не
  multi-node-related — отдельный bug в catalog sync. Нужен отдельный заход.
- **Periodic re-sweep**: cron'ом раз в день проходить по WalmartListingRetirement
  rows с `ok=false` после fix'а, и автоматически dorefait их с новым multi-node
  кодом. Можно вручную trigger через UI пока.
