# SUPERSEDED — DO NOT EXECUTE

Owner decision
`owner-chat:2026-07-23:product-truth-donor-only-exact-sku-upc-preflight`
отменил этот request как prerequisite Walmart new-SKU workflow.

- Product source — только Product Truth / донорский справочный каталог.
- Полный seller-listing snapshot не требуется.
- Перед certification выполняются только exact staged-SKU absence и exact UPC
  `SPEC` search.
- Этот packet, plan, session и frozen executor сохранены только как audit evidence.
- Не создавать authorization, не отправлять ITEM v6 POST и не активировать catalog
  mirror.

# Walmart seller-listing snapshot — исторический owner preview

## Scope

Получить свежий all-status снимок **наших собственных листингов** в Walmart US,
store 1, seller `10001624309`. Он используется только как защита Bundle Factory
от дублей по seller SKU, UPC/GTIN, товарному варианту и bundle recipe.

Это не внешний товарный каталог Walmart. Product Truth и донорский справочный
каталог остаются источниками истины о товаре. Amazon в этом процессе не участвует.

## Prepared and verified offline

- Frozen executor manifest SHA-256:
  `1e87043d3cf0ab879f184c5a8bbbb5445e84e3ed4a2fd6e56b1951efb13cf575`.
- Frozen executor bundle SHA-256:
  `2afdb43f918be2fff93db8426f6e1bf683a846471a792288cff451847e07e7f3`.
- Fresh absence evidence SHA-256:
  `0c203bef0b14f199c6eca33560257adbf8baf4d17721950a6dfd765333be64a5`;
  valid through `2026-07-23T06:39:07.290Z`.
- Replacement plan SHA-256:
  `6d0de1ba35edf3ea9f65bbb85021700548979cbf74c2de4529bf168b1ec2a614`.
- Empty one-shot ledger SHA-256:
  `da45bf39385ada3b50e872c4a8a6ceefe4b7726512d8f86e4dce2a5281d6fada`.
- Focused executor and owner-control tests: `12/12 PASS`.
- Preparation calls: network `0`, Walmart `0`, database `0`, model `0`.

## Exact external effect after approval

1. Exactly one request asks Walmart to generate the ITEM v6 seller-listing report.
2. The one-shot authorization is consumed before transport; no automatic retry is
   possible after timeout, HTTP error, unknown response, or process interruption.
3. After a proven Walmart request ID, all remaining Walmart operations are
   read-only: status polling and report download.
4. The downloaded report is compiled and verified locally before it can become the
   duplicate-control input.

This approval does not authorize creating or changing listings, repricing,
delisting, database activation, paid model/provider calls, bulk SKU waves, or a
schedule.

## Plain-language approval

`Разрешаю получить свежий список наших Walmart-листингов для store 1: один запрос, без повторов и без публикации листингов.`
