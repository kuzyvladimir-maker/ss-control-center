# 🗑️ Discard Label fix + App-wide Toasts — 2026-06-08

## Суть
Кнопка **"Discard Label"** на `/shipping` (войдинг уже купленного лейбла —
carrier refund + заказ остаётся в Shipping Labels для re-quote) воспринималась
как «мёртвая»: при клике визуально ничего не происходило.

## Диагноз (важно — это НЕ был сломанный event listener)
Обработчик был подключён корректно и запрос **уходил**. «Мёртвость» —
следствие отсутствия обратной связи:

1. **Нет confirm-диалога** — клик сразу запускал реальный carrier refund без
   какого-либо подтверждения.
2. **Фидбэк был невидим.** Единственная обратная связь шла в крошечный серый
   page-level `buyMsg`-span наверху страницы (в самом коде помечен как
   "small and easy to miss").
3. **Ошибка discard для Amazon-bought заказа не рендерилась нигде.** `buyError`
   показывается только в ветках `wmBought` (Walmart) и `isReady`. Для обычной
   `isBought` строки (Amazon, «Label already purchased.») ошибка уходила в
   `buyErrors[orderId]` и не отображалась вообще → провал был 100% невидим.
4. После успешного discard строка меняется только на следующем рефреше из
   Veeqo (он флипает заказ обратно в awaiting), что лагает.

Итог для нетех-пользователя: запрос падал/проходил молча → «кнопка не работает».

## Что сделано
- **Новая toast-система** `src/components/ui/toast.tsx` — dependency-free,
  sonner-подобный API (`toast.success/error/info/loading`, `toast.dismiss`).
  Module-level store + `<Toaster />`, смонтирован один раз в
  `src/app/layout.tsx`. Любой client-компонент может дёрнуть тост без
  провайдеров. В проекте раньше toast-библиотеки **не было вообще** — это
  переиспользуемая инфраструктура для всего приложения.
- **Confirm-диалог** перед discard (через существующий `dialog.tsx`,
  base-ui). Кнопка теперь открывает диалог (`setDiscardConfirm(o)`), сам
  discard запускается из кнопки "Discard label" в диалоге.
- **`discardLabel` переписан** на `toast.loading` → транзформируется in-place
  в `toast.success` / `toast.error` (по тому же `id`). Inline `buyErrors`
  оставлен (всё ещё полезен на wmBought / isReady строках).

## Побочный эффект (диагностический)
Если у discard есть скрытая серверная ошибка (Veeqo refund / Walmart lookup),
теперь она видна как красный toast с текстом ошибки — следующий клик сам
покажет, что именно не так.

## Файлы
- `src/components/ui/toast.tsx` (новый)
- `src/app/layout.tsx` (+`<Toaster />`)
- `src/app/shipping/page.tsx` (confirm state + dialog, `discardLabel` на toast,
  кнопка → confirm)
- Бекенд `src/app/api/shipping/discard-label/route.ts` — **не менялся**,
  логика войдинга через Veeqo refund / Walmart DELETE корректна.

## Связано с
- [Shipping Labels — Модуль](shipping-labels.md) — где живёт кнопка Discard Label
- [Dashboard — Модуль](dashboard.md) — потребитель той же toast-системы
