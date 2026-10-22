# Третье независимое ревью mixed Walmart listings — 2026-08-08

## Объём и вердикт

Проверен текущий `main` на коммите
`4b543a6ba686aaec4579a8ba1c67470fc7b8e434` (`bundle-factory: одна коробка
вместо N, полная цепочка у каждого вкуса, состав переживает Use this,
партионные записи атомарны`). Код не исправлялся, коммиты, production-записи и
Walmart POST не выполнялись.

**Вердикт:** заявленные исправления формулы одной коробки, раннего admission по
размеру и атомарных локальных batch-переходов действительно внесены. Но ветка
ещё не готова к подключению живой партионной отправки. Найдены два критичных
дефекта транспортного контура: общий Walmart client сам повторяет `POST /feeds`,
а полученный `feedId` не записывается до второго внешнего POST. Кроме того,
`Use this` сохраняет только число вкусов, но не точное число единиц каждого
вкуса, а Product Truth validator не проверяет новые evidence chains второго и
последующих компонентов.

## Реально сломается

### 1. Критично: `POST /feeds` автоматически повторяется внутри Walmart client

- Batch transport вызывает общий `requestRaw("POST", "/feeds")` для MP_ITEM и
  SKU_TEMPLATE_MAP:
  `src/lib/bundle-factory/distribution/walmart-batch-submit.ts:238-258,272-292`.
- `requestRaw()` имеет общий цикл до пяти попыток (`MAX_RETRIES = 4`) и повторяет
  запрос после сетевой ошибки, HTTP 429 и HTTP 5xx:
  `src/lib/walmart/client.ts:28,470-474,498-534,556-583`.
- Специального one-shot режима для feed POST нет; `noRetryOn429` отключает
  только один из классов повторов.

**Воспроизведено локально:** тестовый HTTP endpoint вернул первый раз HTTP 500,
затем 200. Один вызов `requestRaw("POST", "/feeds")` отправил **два POST** и
вернул успех второго. При timeout после фактического приёма первого POST риск
ещё выше: клиент не знает исхода, но отправляет следующий POST с новым
correlation ID.

Это прямо нарушает обязательный контракт «один POST, ноль retry». Внешний
`try/catch` batch-submit этого не видит: повтор уже произошёл внутри клиента.
Тест `src/lib/walmart/__tests__/client-feed-transport.test.ts:6-80` проверяет
multipart только при немедленном 200 и потому дефект не ловит.

**Вход:** временный 5xx, 429 или network exception после отправки feed.
**Следствие:** повторная запись одного и того же feed, неоднозначный результат и
возможные дубли.

### 2. Критично: первый `feedId` остаётся только в памяти до второго внешнего POST

MP_ITEM `feedId` получается в
`src/lib/bundle-factory/distribution/walmart-batch-submit.ts:238-250`. Затем код
сначала отправляет отдельный SKU_TEMPLATE_MAP POST
(`walmart-batch-submit.ts:272-292`) и только после него записывает MP_ITEM
`feedId` всем попыткам транзакцией
(`walmart-batch-submit.ts:294-305`).

**Вход:** процесс завершается, зависает или получает исключение после успешного
MP_ITEM ответа, но до `acceptWalmartSubmissions()`; отдельно — сама транзакция
accept не может записаться.

**Следствие:** Walmart уже принял item feed, но durable attempts остаются
`REQUESTING` без точного `feedId`. По этому feed уже нельзя выполнить точное
GET-reconciliation; повторный POST запрещён. Атомарность «feed ID всем или
никому» закрывает частично записанную партию, но не закрывает окно «успешный
внешний POST, затем никому».

### 3. Высоко: `Use this` не сохраняет точное `units_per_flavor`

- UI собирает новый prompt как
  `"${search_query}, ${flavors} kinds, ${units} of each"`:
  `src/app/bundle-factory/new/page.tsx:481-493`.
- Детерминированный parser распознаёт английский unit count только в форме
  `4 cans|units|items of each`; голое `4 of each` его regex не принимает:
  `src/lib/bundle-factory/walmart-studio-request.ts:95-98`.
- Затем отсутствующее число выводится заново из текущего поля Pack Count:
  `walmart-studio-request.ts:202-218`.

**Воспроизведено:** строка `Campbells soup, 2 kinds, 4 of each` разбирается как
`flavors=2`, `units=null`. С полем Pack Count = 8 счастливый путь случайно даёт
2 × 4. Если оператор после `Use this` меняет поле на 10, исходный запрос «по 4»
молча становится 2 × 5 без blocker. Без поля pack он деградирует до default
Pack of 2, 2 × 1.

**Следствие:** точный одобренный состав не переживает кнопку; поле оператора
может молча переписать число банок каждого вкуса.

### 4. Высоко: противоречивое модельное ТЗ можно применить и превратить в single-flavor

Модельный нормализатор теперь правильно записывает противоречие в
`unsupported` и обнуляет состав:
`src/lib/bundle-factory/walmart-request-interpreter.ts:168-201,259-295`.
UI показывает красное предупреждение, но кнопка `Use this` остаётся активной:
`src/app/bundle-factory/new/page.tsx:936-947`.

**Воспроизведено:** модельные `pack=8, flavors=3, units=3` дают сообщение
`3 kinds of 3 does not add up to 8 units`. Нажатие `Use this` оставляет только
`Campbells soup` и поле Pack Count = 8. Следующий детерминированный разбор не
видит mix и возвращает `flavors=1, units=8, blockers=[]`.

**Следствие:** оператор видит предупреждение на промежуточном экране, но после
доступной кнопки противоречие и состав исчезают, и генератор получает
однотоварную восьмёрку.

### 5. Высоко: полная evidence chain записывается для каждого вкуса, но не валидируется

Builder исправлен: каждый mixed component теперь несёт собственные identity,
content и price:
`src/lib/bundle-factory/walmart-studio-listing.ts:319-349,352-418`.
Однако validator проверяет только top-level chain первого товара:
`src/lib/bundle-factory/validation/validators/validator-walmart-product-truth.ts:120-163`.
Внизу он проверяет только сумму quantities и наличие ingredients у recipe
components (`validator-walmart-product-truth.ts:210-219`); `evidence.components`
не читается вообще.

**Воспроизведено:** у второго компонента заменены content role на `PRICE`,
обнулён observation ID, записана отрицательная цена и подменены matcher hashes.
`validatorWalmartProductTruth()` всё равно вернул `passed: true`, потому что
top-level chain первого компонента остался корректным.

**Следствие:** сохранение полной цепочки само по себе не даёт fail-closed
гарантии. Испорченный или подменённый источник второго вкуса может пройти этот
validator.

### 6. Средне: cleanup claims после локального batch-сбоя остаётся неатомарным

`releaseAll()` освобождает элементы последовательно и прекращает цикл при
первом исключении:
`src/lib/bundle-factory/distribution/walmart-batch-submit.ts:432-445`.

**Вход:** общая транзакция `markWalmartSubmissionsRequesting()` корректно
откатывается из-за guard-конфликта одного элемента, после чего cleanup того же
элемента также не проходит.

**Следствие:** элементы после него не освобождаются и остаются в `CLAIMED`, хотя
POST не выполнялся. Это не создаёт повторный POST, но способно удержать fences
до ручного восстановления.

## Исправлено и подтверждено

1. **Одна коробка — закрыто.**
   `estimateWalmartStudioShippingPackage()` суммирует net mass всех компонентов
   и один раз применяет tare/outer packaging:
   `src/lib/bundle-factory/walmart-studio-listing.ts:195-255`. Контрпример
   4 × 10.5 oz + 4 × 18.8 oz даёт 140.8 oz и 10 × 8 × 6.
2. **Разные retail sizes — ранний fail-closed закрыт.**
   Draft engine сравнивает canonical Product Truth size до создания черновика:
   `src/lib/bundle-factory/walmart-studio-draft-engine.ts:308-327`.
3. **Evidence builder — хранение закрыто.** Байты evidence меняются при замене
   content/price chain второго компонента. Открыт именно последующий validator,
   описанный в пункте 5.
4. **Model contradiction — сообщение закрыто.** `unsupported` теперь содержит
   точную арифметическую причину. Открыта возможность применить такое ТЗ.
5. **Локальные batch transitions — атомарность закрыта.**
   REQUESTING ставится всем или никому одной транзакцией
   (`walmart-publish-lifecycle.ts:769-815`), а один MP_ITEM `feedId` принимается
   всеми или никем (`walmart-publish-lifecycle.ts:825-884`). Открыты внешние
   границы вокруг POST, описанные в пунктах 1–2.
6. **Duplicate mixed identity и составные fingerprints** по результатам
   повторных негативных проверок сохраняют весь отсортированный состав.

## Стилистика и качество тестов

Это не отдельные продуктовые поломки, а причины, почему профильные тесты зелёные
при воспроизводимых дефектах выше.

1. Нет теста `Use this` на фактически синтезированную строку `4 of each` и
   последующее изменение Pack Count.
2. Нет негативного теста validator на повреждение nested evidence второго
   компонента.
3. Нет теста `submitWalmartBatch()` на реальный `WalmartClient.requestRaw()` с
   первым 5xx/network exception. Существующие one-shot проверки смотрят число
   внешних вызовов mock-метода и не видят внутренние retries клиента.
4. Нет crash-point теста между получением MP_ITEM `feedId` и его durable
   записью.
5. Нет прямого теста раннего admission для 10.5 oz + 18.8 oz; код проверен
   чтением и негативным вызовом, но регрессия не закреплена тестом.

## Выполненные проверки

- `npx tsc --noEmit -p tsconfig.json` — **pass**.
- Целевые mixed/interpreter/validator/duplicate/listing/batch/lifecycle/one-shot
  тесты — **68/68 pass**.
- Все `*.test.ts`: **2087 tests; 2074 pass; 12 fail; 1 skipped**.
  Двенадцать падений — та же известная посторонняя группа: три Amazon pricing,
  Walmart knowledge-base, четыре style/manifest, Product Truth materialization
  и два listing-integrity file suites. Нового mixed-Walmart падения нет.
- Pure diagnostics: одна общая коробка; UI prompt parsing; model conflict →
  `Use this`; подмена nested evidence; внутренний 5xx → повторный feed POST.
- Живой Walmart feed не отправлялся; production-данные не изменялись.

## Рекомендация

Не подключать `submitWalmartBatch` к UI/cron queue и не выполнять первый живой
multi-item feed, пока не закрыты пункты 1 и 2. До массовой генерации mixed briefs
также закрыть пункты 3–5, иначе состав либо provenance могут измениться после
операторского подтверждения. Формулу упаковки и ранний size admission повторно
переделывать не нужно — они выдержали третью проверку.
