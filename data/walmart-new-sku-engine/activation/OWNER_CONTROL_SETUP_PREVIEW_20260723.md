# Walmart owner-control — автоматическая настройка завершена

## Что это даёт

Одна защищённая «кнопка владельца» для трёх разных действий:

1. запросить один полный ITEM v6 report;
2. активировать проверенный seller catalog в нашей базе;
3. опубликовать один exact Walmart SKU после финального preview.

У действий разные signing domains. Подтверждение report нельзя использовать для
catalog activation или публикации SKU.

## Чего эта настройка не делает

- не обращается к Walmart;
- не открывает production DB;
- не публикует и не изменяет листинги;
- не применяет migration;
- не вызывает платные сервисы или модели;
- не выдаёт Claude Code право подтверждать действия.

## Результат

Настройка выполнена автоматически 2026-07-23. Владельцу не нужно придумывать,
вводить или хранить пароль.

В private custody создаются:

- `walmart-owner-control-private-key.pem` — зашифрованный private key, остаётся только
  у владельца;
- `walmart-owner-control-public-enrollment.json` — несекретный public key, который
  Codex проверяет и закрепляет в audited release.

Случайный machine secret хранится в macOS login Keychain. Реальный локальный doctor
успешно прочитал его, расшифровал private key в памяти и сверил public fingerprint:

- status: `OWNER_CONTROL_READY`;
- key id: `walmart-owner-control-2026-01`;
- fingerprint:
  `ca74a2134808ab46eb162b14dfe481730fc69df00b57283cffd7a7bb1d37883a`;
- user-managed password required: `false`;
- network/Walmart/database/model calls: `0`.

Private key и machine secret недоступны Claude Code. Создание ключа само по себе
ничего не разрешает: для каждого будущего report/catalog/listing действия всё равно
показывается отдельный exact preview.

## Что сделано и что осталось

1. [x] Проверен public enrollment, Ed25519 type, schema и allowed domains.
2. [x] Только public key закреплён в production trust root.
3. [x] Раздельный report/catalog/new-SKU regression: `92/92 PASS`.
4. [ ] Выпустить новые immutable report и Bundle Factory Walmart releases.
5. [ ] Обновить внутренний all-status Walmart seller catalog.
6. [ ] Подготовить понятный owner preview на один пилотный SKU.
