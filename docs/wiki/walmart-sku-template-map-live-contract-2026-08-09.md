# Walmart SKU_TEMPLATE_MAP: подтверждённый живой контракт

Дата проверки: 2026-08-09  
Канал: Walmart Marketplace US  
Режим: один SKU, один POST, без повторов

## Итог

`SKU_TEMPLATE_MAP` поддерживается аккаунтом. Все прежние фиды падали не из-за
аккаунта, shipping template, ship node, заголовка или значения
`sellingChannel`, а из-за неверного внешнего JSON-конверта.

Неверный контракт платформы:

```json
{
  "ItemFeed": [
    {
      "actionType": "Add",
      "fulfillmentCenterId": "10001624309",
      "shippingTemplateId": "202402999000149568",
      "sku": "AU-WMKW-CATL"
    }
  ],
  "ItemFeedHeader": {
    "locale": "en",
    "sellingChannel": "precisedelivery",
    "version": "1.0"
  }
}
```

Подтверждённый официальный и живой контракт:

```json
{
  "Item": [
    {
      "PreciseDelivery": {
        "shippingTemplateId": "202402999000149568",
        "fulfillmentCenterId": "10001624309",
        "actionType": "Add",
        "sku": "AU-WMKW-CATL"
      }
    }
  ],
  "ItemFeedHeader": {
    "sellingChannel": "precisedelivery",
    "locale": "en",
    "version": "1.0"
  }
}
```

Различие предметное: корневой массив называется `Item`, а каждая его строка
обёрнута в объект `PreciseDelivery`. Старый плоский `ItemFeed` не соответствует
схеме парсера Walmart. Это согласуется с историческим результатом
`itemsReceived=0` и `ERR_INT_DATA_01010092`/`PGW`/`NullPointerException`: ошибка
возникала до чтения SKU.

## Источник контракта

- Walmart Global Marketplace API Reference, Bulk item setup:
  <https://developer.walmart.com/global-marketplace/reference/itembulkuploads>
- Официальный архив US JSON feed samples:
  <https://developer.walmart.com/file/mp/us/feed-type-samples.zip>
- Файл в архиве: `feed-type-samples/US_SKU_TEMPLATE_MAP.json`.
- SHA-256 скачанного архива:
  `7189350564a6a9bfe328f31731b32a69d3a220f00f119c755cb3629e1ad8441b`.

Официальный sample использует тот же контракт:
`Item[].PreciseDelivery.{shippingTemplateId, fulfillmentCenterId, actionType,
sku}` и `ItemFeedHeader` с `sellingChannel=precisedelivery`, `locale=en`,
`version=1.0`.

## Read-only preflight

- `POST /v3/items/associations` для `AU-WMKW-CATL`: association отсутствовала.
- Shipping template `202402999000149568`: `Default Template`, `DEFAULT`,
  `ACTIVE`.
- Ship node `10001624309`: `STARFITSTORE - 10001624309 - MP`, `ACTIVE`.

Значит тест не менял уже существующую привязку и оба идентификатора были
действующими до POST.

## Единственный живой POST

- SKU: `AU-WMKW-CATL`
- Endpoint: `POST /v3/feeds?feedType=SKU_TEMPLATE_MAP`
- Размер компактного JSON: 234 bytes
- SHA-256 payload:
  `3424bfa6aa5316939b1f855f391ea5e86671b5153e933508694be4bee764657d`
- POST correlation ID: `7d48433f-3ecb-4dce-b308-a5ca3d757063`
- HTTP: `200`
- Feed ID: `18CA06A0F0905F1E8557C021FC9F6B6B@AX0BBgA`
- Повторных POST: `0`

Финальное состояние feed readback:

```text
feedStatus=PROCESSED
itemsReceived=1
itemsSucceeded=1
itemsFailed=0
itemsProcessing=0
sku=AU-WMKW-CATL
ingestionStatus=SUCCESS
feedSubmissionDate=2026-08-09T03:51:30.513Z
```

Это живое доказательство, что feed type применим к аккаунту и приведённый
payload принят Walmart до уровня конкретного SKU.

## Association readback

Walmart документирует отдельное окно распространения association от 30 минут
до 4 часов:
<https://developer.walmart.com/us-marketplace/docs/get-item-associations>.

На момент `2026-08-09T05:24:39Z`, спустя примерно 93 минуты после submission,
`/v3/items/associations` ещё возвращал пустой массив. За это время feed
повторно подтверждён как `PROCESSED`, а его единственный item — как `SUCCESS`.
Повторной отправки feed не было. Частый read-only монитор остановлен как не
дающий новой информации; состояние всё ещё находится внутри документированного
Walmart окна до 4 часов.

Следующая содержательная проверка — один readback после
`2026-08-09T07:51:31Z` (четыре часа после submission). Если association всё ещё
пуста, это уже не нормальная propagation delay: нужно фиксировать расхождение
между успешным ingestion и отсутствующим применением и эскалировать Walmart с
feed ID и correlation ID из этого отчёта. До такой проверки повторный POST
запрещён.

## Где текущий код расходится с доказанным контрактом

1. `ss-control-center/src/lib/bundle-factory/walmart-shipping-template-association.ts:34`
   описывает `ItemFeed`, которого нет в официальном sample.
2. Там же, строки 120–132, single-SKU builder формирует плоскую строку вместо
   `Item[].PreciseDelivery`.
3. Там же, строки 153–184, batch builder повторяет неверную форму.
4. Тесты
   `walmart-shipping-template-association.test.ts` и
   `walmart-sku-template-map-batch.test.ts` закрепляют ошибочный контракт, то
   есть зелёные тесты доказывают согласованность с собственным кодом, а не с
   Walmart.
5. `distribution/walmart-publish.ts:657` отправляет файл этого builder без
   преобразования, поэтому каждый реальный вызов наследует ошибку.

Код в рамках диагностической задачи не менялся. Перед возвращением publish
ветки в работу нужно заменить тип и оба builder-пути, переписать контрактные
тесты по официальному sample и отдельно сохранить правило: один SKU, один
POST, ноль retry; неизвестный исход выясняется только GET-запросами.
