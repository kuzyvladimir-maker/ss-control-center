# Walmart Shadow — квалификация prior-visual и remediation evidence

Статус: обязательный fail-closed контракт для real Shadow-50  
Дата: 2026-07-18  
Связанная цель: `WALMART_LISTING_INTEGRITY_CHARTER.md`

## Назначение

Prior-visual и remediation evidence используются только для формирования
репрезентативной Shadow-50 выборки. Они не определяют Product Truth, не заменяют
buyer-facing snapshot и не доказывают качество листинга сами по себе.

Каждая строка полного источника имеет точную case-sensitive идентичность:

```text
channel = WALMART_US
store_index = положительное целое
sku = исходный SKU без trim/normalization
listing_key = walmart:{store_index}:{sku}
```

Seller WPID, UPC/GTIN и public numeric Walmart item ID не являются ключом полного
population. Numeric buyer item ID обязателен только для отобранного кейса после
точного SKU → GTIN → unique buyer-item resolution.

## Общие законы доказательств

1. Body SHA-256 доказывает неизменность переданного тела, но не его авторство и
   достоверность. Каждый compiled source обязан связываться с исходными sealed
   артефактами и перепроверяться против них.
2. Population всегда строится из одного authoritative ITEM-report source. Ни
   historical remediation table, ни текущая DB mirror не могут добавлять или
   удалять строки population.
3. Отсутствие квалифицированного evidence означает `NOT_AUDITED` или
   `NOT_APPLIED`. Оно никогда не превращается в `PASS`, `BAD` или
   `VERIFIED_APPLIED` по догадке.
4. Дубликат или конфликт по `listing_key`, неканонический timestamp, неверный
   seal, missing referenced artifact или несогласованная хронология останавливают
   весь compile. Частичный «успех» запрещён.
5. Любое evidence, относящееся к предыдущей версии buyer-facing карточки,
   перестаёт описывать текущую версию после более позднего подтверждённого
   изменения MAIN или текста.

## Квалифицированный prior-visual verdict

Строка может получить `BAD` или `PASS` только при одновременном наличии:

- sealed buyer-facing snapshot v3 с exact seller SKU → GTIN → unique numeric
  item ID → buyer PDP binding;
- локальных immutable MAIN bytes, совпадающих с manifest по SHA-256, длине,
  формату и dimensions;
- approved Product Truth revision, повторно скомпилированной из общей Product
  Truth Platform;
- trusted human label либо окончательной adjudication двух независимых
  reviewers; label сделан после snapshot и до cutoff источника;
- binding label к exact `listing_key`, buyer snapshot ID/body hash, Product Truth
  case ID/body hash и MAIN asset SHA-256;
- отсутствия более позднего подтверждённого изменения MAIN до source cutoff.

Исторический AI verdict, donor comparison, title-derived quantity, seller image
URL, DB flag и прежний remediation plan могут быть candidate evidence, но не
квалифицированным verdict. Без человеческой квалификации строка остаётся
`NOT_AUDITED`.

`PASS` и `BAD` относятся только к зафиксированным bytes и truth revision. Они не
переносятся автоматически на gallery, текст или новую версию изображения.

## Квалифицированный remediation status

`VERIFIED_APPLIED` означает только доказанную доставку утверждённого изменения до
buyer-facing PDP. Это не означает, что изменение правильное: remediated-кейс
может и должен остаться `BAD`, если применённое исправление ошибочно.

Для `VERIFIED_APPLIED` одновременно обязательны:

- exact mutation intent: store, raw SKU, тип изменения, before value/hash,
  intended after value/hash, approval ID и timestamp;
- immutable Walmart submission receipt и per-item result, доказывающие успех
  именно этой строки, а не только общий статус feed;
- sealed post-write buyer snapshot v3, снятый после item-level success;
- доказательство, что intended after value действительно наблюдается на PDP:
  для изображения — совпадение decoded asset bytes SHA-256, а не только URL;
- post-write `PUBLISHED` и `ACTIVE` на exact resolved listing;
- отсутствие более поздней mutation до snapshot либо отдельная строгая цепочка,
  доказывающая итоговое состояние;
- source-aware verification всех referenced bodies и bytes.

Строка `WalmartListingRemediation.ok=1`, `feedStatus=PROCESSED`, наличие `feedId`
или сохранённый `mainImageUrl` сами по себе недостаточны. Общий feed мог быть
успешным при ошибке конкретной строки; CDN URL мог измениться; buyer PDP мог не
принять intended asset или уже содержать более позднее изменение.

Если хотя бы одно обязательное доказательство отсутствует, строка получает
`NOT_APPLIED` для целей Shadow selection. Исторический action при этом не
удаляется: он сохраняется как неквалифицированный candidate для последующей
проверки.

## Полные source artifacts

Prior-visual и remediation source должны содержать по одной строке на каждый
`listing_key` authoritative PUBLISHED population и сильные upstream bindings:

- ITEM-report published source ID/body SHA-256;
- qualified evidence-ledger ID/body SHA-256;
- exact cutoff;
- count reconciliation: population, evidence accepted, evidence rejected,
  output rows;
- zero duplicate/conflict/malformed counters;
- детерминированную code-unit сортировку.

Source-aware verifier заново компилирует весь источник из ITEM population и
ledger. Проверка только собственного `body_sha256` не даёт operational GO.

## Безопасное начальное состояние

До появления квалифицированных ledgers разрешён бесплатный zero-evidence
compile:

- полный prior-visual source: все строки `NOT_AUDITED`;
- полный remediation source: все строки `NOT_APPLIED`.

Такой compile полезен для проверки population joins, но честно не может
удовлетворить remediated quotas Shadow-50. Квоты не ослабляются после просмотра
данных: сначала квалифицируются достаточные реальные кейсы, затем выполняется
Shadow.

## Operational GO

Prior/remediation слой готов только когда:

- оба source-aware verifier проходят на реальных frozen inputs;
- exact population equality с catalog и performance sources доказано;
- минимум 15 различных eligible `VERIFIED_APPLIED` listing keys доступны для
  frozen remediated quotas;
- все отобранные кейсы имеют approved Product Truth и exact active buyer
  snapshots;
- ни один historical flag не был повышен до доказанного статуса без обязательной
  цепочки evidence.

