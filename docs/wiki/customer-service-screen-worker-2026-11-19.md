# Customer Service: прямой экранный источник — приёмка 19.11.2026

Задача: `20261119T213456Z-517a14`. Все времена ниже — America/New_York.

## Результаты обслуживания

- **Sharon, 114-8686665-2821053 — sent_verified.** Прочитана единственная ветка в полной истории, перед отправкой дубля не было. Вставлен `approvedBody` из ранее сохранённого поручения. Содержимое поля сверено через копирование из UI с исходным текстом (766 символов, SHA256 `1003d79870e4e23a2b47a378120af6e0ef6a57a75588e60ce51f48ca8ea4c49c`). Одна отправка. После перезагрузки Sent Messages текст прочитан, Processing Response исчез, case Open. Проверено 16:44:44 ET. Запись в `/api/customer-hub/executions` — sent_verified; повторное выполнение не планируется.
- **Mary, 113-2368331-6725010 — только карточка.** Полная ветка содержит сообщение об отсутствии холодового элемента; порча, повреждение коробки и болезнь не заявлены. FedEx 384876291258: приём 16.11 17:17, доставка 18.11 14:19 (~45 часов), Amazon deliver-by 21.11. Черновик уточняет температуру товара при получении и целостность упаковки; возврат/замена не обещаны. Опубликована карточка [1788](https://t.me/c/3924739153/1788), три callback-кнопки приняты Telegram без degradedDelivery; PUBLISHED подтверждено MCP. Покупателю не отправляли.
- **Scott, 111-9633582-9233033.** A-to-z → All → поиск полного номера: `No claims found`. Это результат конкретного поиска, не подтверждение отсутствия всех претензий и не тождество Reported unresolved. Информационный отчёт передан в тему 42; новых ответов/изменений статуса нет.

## Дефект → причина → исправление → доказательство → остаток

| Дефект | Причина | Исправление | Доказательство | Остаток |
|---|---|---|---|---|
| Почтовая проверка падала и трактовалась как очередь | Старый watcher вызывал архивный скрипт без `--history-only` | Подтверждено disabled; новый источник не использует почту | Scoped cron-list: `cs-mail-unanswered-watch enabled=false` | Архивный скрипт сохранён, старый cron не включался |
| Не было автономных экранных циклов | Ранее только ручные снимки | `cs_screen_worker.py` + systemd service/timer | Независимые запуски 16:50:27, 16:54:01; таймер 17:00:41 | OCR привязан к проверенной раскладке 1366×768; неоднозначность даёт unknown |
| Нельзя было считать транспорт доказанным | Адрес/имя узла и формат fingerprint были неоднозначны | Сохранены проверенные серверные исправления: node ID + DNS + Windows NTLM identity + pinned TLS certificate; tailnet-only адрес | preflight.json, quser.txt каждого цикла | Никаких публичных RDP fallback, изменения профилей или защиты |
| Конкурирующие экранные сеансы | Нет права брать активную Windows-сессию | Exclusive lease; отказ при Active quser/чужом транспорте; down до release | Каждый успешный цикл завершает транспорт и освобождает lease | При неопределённом старте lease сохраняется для явного восстановления |
| Ложные нули/смешивание метрик | Отсутствующий источник/почта могли восприниматься как текущая очередь | Только screen snapshot; четыре независимых nullable метрики; отдельные failure и последнее успешное время | API/MCP: Response needed 1, Over SLA 0, unresolved 1, unread null; mail snapshot отвергнут HTTP 400 | Непрочитанные этим экраном не подтверждаются |
| Не видно автономного источника | UI сообщал о ручных проверках | Collector provenance и текст расписания | `hub-queue-live.png`: fresh, 17:00:41 EST, Mary, отдельные метрики | Refresh view перечитывает API, не инициирует RDP |
| Карточка Mary потеряла кнопки | Callback с длинным ID превысил Telegram 64-byte limit после кодирования | Короткий стабильный ID; предыдущая карточка SUPERSEDED, сообщение 1785 заменено ссылкой на 1788 | Telegram receipt 1788 без warning/degradedDelivery, cs_card_published ok | Кнопки одобрения не нажимались при тестировании |
| Повторные уведомления/неопределённая отправка | Повторный цикл/сбой внешней доставки | Durable reservation до отправки, файловый lock, receipt; повторная активизация ветки — новый episode; одна ошибка на причину/2 часа | Unit tests на ambiguity/throttle/reopen, notification ledger | pending при неопределённом внешнем результате требует проверки, не слепого retry |

## Автономность и границы

`cs-screen-worker.timer`: каждые 30 минут 08:00–21:30 и 22:00 ET; Persistent=false, Restart=no. В 17:00 сработал **сам таймер**, не человек. Первые два приёмочных прогона инициированы командой запуска, но подключение, чтение, OCR, проверка, публикация и освобождение выполнялись скриптом без ручных действий. Путь: OpenClaw → Tailscale → SS; экран через ss_hands, без CDP/DOM.

Сборщик читает Response needed и Reported unresolved раздельно. Over SLA вычисляется только из явно распознанных Due/Over SLA всех прочитанных веток. Unread остаётся null. Сверяются account, полный номер заказа, число уникальных веток и повторно счётчики после обновления страницы. Текущий bounded reader принимает до трёх полностью видимых строк; overflow, другая раскладка, неполный список, нераспознанный SLA/нулевой экран приводят к unknown, а не частичному списку или нулю. Расширение на многостраничную очередь требует отдельной экранной приёмки; такой сценарий не заявлен проверенным.

Новое обращение создаёт информационную карточку на основе подтверждённой очереди. Полный разбор фактов/готовый ответ требуют review-карточки; worker не выдумывает черновик из одного имени/номера заказа. Он не содержит операций Send/Resolve/Refund/Replacement. Одобрение карточки не включает автоматический транспорт покупателю.

`cs_digest.py` больше не импортирует mail publisher; читает `/api/customer-hub/open-threads`, требует fresh screen source. `cs-open-reminder` сохраняет своё расписание 09/13/17/21 ET и явно запрещает почту/историю как очередь. Остальные приостановленные задания не возобновлялись.

## Проверки и материалы

- 107 TypeScript-тестов Customer Hub, включая sent verification и новый screen-review validation; tsc и ESLint изменённых TS-файлов.
- 21 Python-тест (preflight, lease, digest, screen parsing, notification ambiguity/throttle, повторное открытие ветки).
- UI harness: unknown/fresh/stale, независимые счётчики, ошибка API сохраняет последнее успешное время и убирает текущие цифры.
- Реальный production API/MCP и UI через прямой SS VPS. Для проверки UI использованы уже сохранённые учётные данные сайта; значения не читались/не выводились.
- Vercel production deployment: `dpl_FhAsfopwgPMeUa7v1fMrXLP5WbZ5`, alias `salutemsolutions.info`. Код хаба: `04e896230`; первый основной коммит `6758a86e5`. Последующие изменения Python-worker выкладываются отдельно на OpenClaw.

Основной каталог на OpenClaw: `/root/.openclaw/workspace/data/customer-hub-screen/20261119/`.

- `sharon-before.png`, `sharon-thread.png`, `sharon-all-loaded.png`, `sharon-sent-final.png`.
- Точный текст, авторизация, время и статус Sharon: `/root/.openclaw/workspace/data/customer-hub-screen/sharon-20261119/result.json`.
- `mary-full.png`, `mary-tracking.png`, `mary-tracking-detail.png`, `mary-review-request.json`, `mary-card-v2.json`, `mary-card-v2-telegram.json`.
- `scott-atoz.png`.
- `prod-api.json`, `hub-queue-live.png`.
- `/root/.openclaw/workspace/data/customer-hub-screen/worker/<UTC-cycle>/`: `preflight.json`, `quser.txt`, `queue.png`, `thread-0.png`, `queue-confirm.png`, `snapshot.json`, `api.json`, `result.json` (либо `failure.json`).
- Проверенные циклы: `20261119T214948Z`, `20261119T215322Z`, `20261119T220000Z`, `20261119T220313Z`; дополнительные финальные receipts записываются в тот же каталог.

Копии основных доказательств: `ss-control-center/data/cs-screen-20261119/` (не добавляются в git). Runtime-журнал: `journalctl -u cs-screen-worker.service`; расписание: `systemctl list-timers cs-screen-worker.timer`.
