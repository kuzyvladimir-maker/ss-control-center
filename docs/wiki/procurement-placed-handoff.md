# Procurement → Shipping: когда заказ считается купленным (fix 2026-10-19)

## Симптом
В Procurement отмечаешь товар купленным, карточка исчезает. В Shipping labels заказ остаётся
бледным с надписью «Waiting for procurement (no Placed tag yet)», кнопки покупки лейбла нет.
Повторялось неоднократно. 19.10 так висели 4 заказа: Jimmy Dean ×3, Freshpet ×2, Garden Lites.

## Корень
Модули по-разному понимали «куплено»:
- **Procurement** прячет строку, когда в заметке заказа (блок `[PROCUREMENT]` в employee_notes)
  она записана как `bought`. Код прямо называет заметку источником истины, а метку —
  «визуальным сахаром» (`order-state-update.ts`).
- **Shipping** (dashboard, plan, merge) смотрел только на Veeqo-метку `Placed`.

Veeqo иногда отвечает на `POST /bulk_tagging` кодом 200, но метка не появляется. В логах Vercel
за 4 дня все вызовы `/bought` вернули 200, а метки на этих заказах нет. Заметка записана,
метки нет, и заказ проваливается между модулями.

## Что сделано
1. `src/lib/procurement/placed.ts`: одно общее правило. Заказ куплен, если есть метка `Placed`
   **или** заметка отмечает купленными все строки (та же логика `decideOrderTags`, что и при
   простановке метки). Используется в `/api/shipping/dashboard`, `/api/shipping/plan`
   (оба гейта тарифов) и `/api/shipping/merge`.
2. `order-state-update.ts`: после простановки меток заказ перечитывается. Если метка не
   появилась, она ставится повторно, через секунду проверяется ещё раз. Результат идёт в лог
   (`[procurement] tag did not land` / `tag still missing after retry`) и в поле
   `tagsVerified` ответа.
3. В ответе dashboard у каждого заказа есть `placedVia`: `"tag"`, `"notes"` или `null`.
   Значение `"notes"` означает, что метки в Veeqo нет, но по заметке всё куплено.
4. Тесты: `npm run test:procurement-placed`.

## Что не меняется
- Rollback Purchase по-прежнему откатывает и заметку, и метку, после чего заказ возвращается
  в Procurement.
- Частичная покупка (`remain:N`) и нетронутые строки по-прежнему держат заказ в ожидании.
- Merged-заказы Veeqo создаёт без заметки и метки, для них остаётся кнопка Mark as Placed.

## Диагностика
Локальный `VEEQO_API_KEY` в `.env.local` устарел: ключ в Vercel заменён ~2026-10-04 и помечен
как sensitive, поэтому `vercel env pull` отдаёт пустое значение. Читать данные можно через сайт
с токеном `SSCC_API_TOKEN` (только GET): `/api/shipping/dashboard`, `/api/procurement/items`.

## Скрытые технические заказы (2026-10-19)
Заказ `TEST-RATE-DELETE-ME-2` (Veeqo id 2164588032, канал Phone / DIRECT, $1) — технический,
для сайта StillFrozen. По решению владельца он не показывается нигде в Command Center: ни в
Procurement, ни в Shipping, ни в счётчиках меню, ни в статистике и поиске. В самом Veeqo заказ
остаётся без изменений.

Список: `src/lib/veeqo/hidden-orders.ts`. Фильтр стоит на всех общих точках чтения заказов из Veeqo:
`fetchAllOrders`, `fetchOrdersInRange`, `searchOrders`, загрузка Procurement, а также поиск
по базе в Shipping. Чтобы скрыть ещё один заказ, добавь его Veeqo id и номер в этот список.
