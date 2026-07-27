import assert from "node:assert/strict";
import test from "node:test";

import {
  WALMART_FROZEN_180D_PERFORMANCE_SOURCE_SCHEMA,
  WALMART_PERFORMANCE_POPULATION_SCHEMA,
  WALMART_PERFORMANCE_ASSURANCE,
  WALMART_RAW_ORDERS_PAGES_SCHEMA,
  WALMART_RAW_RETURNS_PAGES_SCHEMA,
  compileWalmartFrozen180DayPerformanceSource,
  sealWalmartPerformancePopulation,
  sealWalmartRawOrdersPages,
  sealWalmartRawReturnsPages,
  verifyWalmartFrozen180DayPerformanceSource,
  verifyWalmartFrozen180DayPerformanceSourceAgainstRaw,
  verifyWalmartFrozen180DayPerformanceOperationalReadinessAgainstCaptures,
  walmartPerformanceCanonicalSha256,
  walmartOrdersPartitionId,
  walmartRawPageFromBytes,
} from "../frozen-performance-source.ts";

const START = "2026-01-01T00:00:00.000Z";
const END = "2026-06-30T00:00:00.000Z";
const BASELINE_END = "2026-06-29T23:59:59.999Z";
const TAIL_START = "2026-06-29T23:59:59.998Z";
const TAIL_CAPTURED = "2026-06-30T00:00:00.001Z";
const CUTOFF = "2026-07-10T00:00:00.000Z";
const CAPTURED = "2026-07-11T00:00:00.000Z";
const HASH = "a".repeat(64);
const ACCOUNT = "d".repeat(64);
const RETURN_API_END = "2026-07-09T23:59:59.999Z";

function listing(sku, storeIndex = 1) {
  return {
    channel: "WALMART_US",
    store_index: storeIndex,
    sku,
    listing_key: `walmart:${storeIndex}:${sku}`,
  };
}

function rawQuery(entries) {
  return entries.map(([key, value]) => (
    `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
  )).join("&");
}

function requestQuery(kind, request, cursor) {
  if (cursor !== null) return cursor.startsWith("?") ? cursor.slice(1) : cursor;
  return kind === "orders"
    ? rawQuery([
      ["createdStartDate", request.api_created_start_date_exclusive],
      ["createdEndDate", request.api_created_end_date_exclusive],
      ["limit", String(request.limit)],
      ["productInfo", "true"],
      ["shipNodeType", request.ship_node_type],
      ["replacementInfo", "true"],
    ])
    : rawQuery([
      ["returnCreationStartDate", request.api_return_creation_start_date_inclusive],
      ["returnCreationEndDate", request.api_return_creation_end_date_inclusive],
      ["limit", String(request.limit)],
      ["replacementInfo", "true"],
      ["isWFSEnabled", request.wfs_enabled],
    ]);
}

function page(kind, pageIndex, requestCursor, response, request, correlationKey, at) {
  const correlation = walmartPerformanceCanonicalSha256({ correlationKey, pageIndex });
  return walmartRawPageFromBytes(
    kind,
    pageIndex,
    requestCursor,
    requestQuery(kind, request, requestCursor),
    Buffer.from(JSON.stringify(response), "utf8"),
    {
      requested_at: at,
      completed_at: at,
      request_correlation_id_sha256: correlation,
      response_correlation_id_sha256: correlation,
    },
  );
}

function orderLine({
  lineNumber,
  sku,
  quantity,
  amount,
  currency = "USD",
  statuses,
}) {
  return {
    lineNumber: String(lineNumber),
    item: { sku },
    charges: {
      charge: [{
        chargeType: "PRODUCT",
        chargeName: "ItemPrice",
        chargeAmount: { currency, amount },
      }],
    },
    orderLineQuantity: { unitOfMeasurement: "EACH", amount: String(quantity) },
    orderLineStatuses: {
      orderLineStatus: statuses.map(([status, qty]) => ({
        status,
        statusQuantity: { unitOfMeasurement: "EACH", amount: String(qty) },
      })),
    },
  };
}

function order(purchaseOrderId, orderDate, lines, orderType = "REGULAR") {
  return {
    purchaseOrderId,
    orderDate,
    orderType,
    orderLines: { orderLine: lines },
  };
}

function returnLine({
  returnOrderLineNumber = 1,
  purchaseOrderId,
  purchaseOrderLineNumber,
  sku,
  quantity,
  refundedQty = 0,
  currentRefundStatus = refundedQty > 0 ? "REFUND_COMPLETED" : "NOT_REFUNDED",
  status = "COMPLETED",
  cancellationReason = null,
  eventTag = "RETURN_INITIATED",
  currentTrackingStatuses,
}) {
  return {
    returnOrderLineNumber,
    purchaseOrderId,
    purchaseOrderLineNumber,
    item: { sku },
    quantity: { unitOfMeasure: "EACH", measurementValue: quantity },
    refundedQty,
    currentRefundStatus,
    status,
    returnCancellationReason: cancellationReason,
    returnTrackingDetail: [{ eventTag }],
    ...(currentTrackingStatuses ? { currentTrackingStatuses } : {}),
  };
}

function returnOrder({ id, date, type, lines, replacementCustomerOrderId }) {
  return {
    returnOrderId: id,
    returnOrderDate: date,
    returnType: type,
    ...(replacementCustomerOrderId ? { replacementCustomerOrderId } : {}),
    returnOrderLines: lines,
  };
}

function accountScope(storeIndex = 1, fingerprint = ACCOUNT) {
  return {
    channel: "WALMART_US",
    store_index: storeIndex,
    seller_account_fingerprint_sha256: fingerprint,
  };
}

function populationBody(storeIndex = 1, skus = ["SKU-A", "Sku-A", "ZERO"]) {
  return {
    schema_version: WALMART_PERFORMANCE_POPULATION_SCHEMA,
    captured_at: CAPTURED,
    channel: "WALMART_US",
    store_index: storeIndex,
    account_scope: accountScope(storeIndex),
    published_population_complete: true,
    upstream_source: {
      schema_version: "walmart-item-report-published-source/v1",
      source_id: `item-report-source-${storeIndex}`,
      body_sha256: HASH,
      raw_transport_sha256: "b".repeat(64),
      decoded_report_sha256: "c".repeat(64),
      cutoff_at: CAPTURED,
    },
    rows: skus.map((sku) => ({
      ...listing(sku, storeIndex),
      published_status: "PUBLISHED",
    })),
  };
}

function ordersRequest(shipNodeType, partition = "baseline") {
  const partitionStart = partition === "baseline" ? START : TAIL_START;
  const partitionEnd = partition === "baseline" ? BASELINE_END : END;
  return ordersRequestInterval(shipNodeType, partitionStart, partitionEnd);
}

function ordersRequestInterval(shipNodeType, partitionStart, partitionEnd) {
  return {
    sales_window_starts_at_exclusive: START,
    sales_window_ends_at_exclusive: END,
    partition_starts_at_exclusive: partitionStart,
    partition_ends_at_exclusive: partitionEnd,
    api_created_start_date_exclusive: partitionStart,
    api_created_end_date_exclusive: partitionEnd,
    limit: 200,
    product_info: true,
    ship_node_type: shipNodeType,
    replacement_info: true,
    product_charge_amount_scope: "UNPROVEN_UNIT_VS_LINE_TOTAL",
  };
}

function ordersPartitionId(request, storeIndex = 1, fingerprint = ACCOUNT) {
  return walmartOrdersPartitionId({
    store_index: storeIndex,
    seller_account_fingerprint_sha256: fingerprint,
    ship_node_type: request.ship_node_type,
    sales_window_starts_at_exclusive: request.sales_window_starts_at_exclusive,
    sales_window_ends_at_exclusive: request.sales_window_ends_at_exclusive,
    partition_starts_at_exclusive: request.partition_starts_at_exclusive,
    partition_ends_at_exclusive: request.partition_ends_at_exclusive,
  });
}

function returnsRequest(wfsEnabled) {
  return {
    observation_starts_at_inclusive: START,
    observation_cutoff_at_exclusive: CUTOFF,
    api_return_creation_start_date_inclusive: START,
    api_return_creation_end_date_inclusive: RETURN_API_END,
    limit: 200,
    replacement_info: true,
    wfs_enabled: wfsEnabled,
  };
}

function ordersBody() {
  const orderOne = order("PO-1", "2026-01-01T00:00:00.001Z", [
    orderLine({
      lineNumber: 1,
      sku: "SKU-A",
      quantity: 3,
      amount: "30.00",
      statuses: [["Delivered", 2], ["Cancelled", 1]],
    }),
    orderLine({
      lineNumber: 2,
      sku: "Sku-A",
      quantity: 1,
      amount: 0.1,
      statuses: [["Shipped", 1]],
    }),
  ]);
  const orderTwo = order("PO-2", "2026-06-29T23:59:59.990Z", [
    orderLine({
      lineNumber: 1,
      sku: "SKU-A",
      quantity: 2,
      amount: 10.23,
      statuses: [["Delivered", 2]],
    }),
  ]);
  const request = ordersRequest("SellerFulfilled");
  return {
    schema_version: WALMART_RAW_ORDERS_PAGES_SCHEMA,
    partition_id: ordersPartitionId(request),
    captured_at: BASELINE_END,
    channel: "WALMART_US",
    store_index: 1,
    account_scope: accountScope(),
    request,
    pages: [
      page("orders", 0, null, {
        list: {
          meta: { totalCount: 2, limit: 200, nextCursor: "?limit=200&hasMoreElements=true&poIndex=1" },
          elements: { order: [orderOne] },
        },
      }, request, "orders-1-SellerFulfilled", BASELINE_END),
      page("orders", 1, "?limit=200&hasMoreElements=true&poIndex=1", {
        list: {
          meta: { totalCount: "2", limit: 200 },
          elements: { order: [orderTwo] },
        },
      }, request, "orders-1-SellerFulfilled", BASELINE_END),
    ],
  };
}

function emptyOrdersBody(shipNodeType, storeIndex = 1, partition = "baseline") {
  const request = ordersRequest(shipNodeType, partition);
  const at = partition === "baseline" ? BASELINE_END : TAIL_CAPTURED;
  return {
    schema_version: WALMART_RAW_ORDERS_PAGES_SCHEMA,
    partition_id: ordersPartitionId(request, storeIndex),
    captured_at: at,
    channel: "WALMART_US",
    store_index: storeIndex,
    account_scope: accountScope(storeIndex),
    request,
    pages: [page("orders", 0, null, {
      list: { meta: { totalCount: 0, limit: 200 }, elements: { order: [] } },
    }, request, `orders-${storeIndex}-${shipNodeType}-${partition}`, at)],
  };
}

function ordersBodyForInterval(
  shipNodeType,
  storeIndex,
  partitionStart,
  partitionEnd,
  capturedAt,
  records = [],
  correlationKey = `${shipNodeType}-${partitionStart}-${partitionEnd}`,
) {
  const request = ordersRequestInterval(shipNodeType, partitionStart, partitionEnd);
  return {
    schema_version: WALMART_RAW_ORDERS_PAGES_SCHEMA,
    partition_id: ordersPartitionId(request, storeIndex),
    captured_at: capturedAt,
    channel: "WALMART_US",
    store_index: storeIndex,
    account_scope: accountScope(storeIndex),
    request,
    pages: [page("orders", 0, null, {
      list: {
        meta: { totalCount: records.length, limit: 200 },
        elements: { order: records },
      },
    }, request, correlationKey, capturedAt)],
  };
}

function returnsBody() {
  const rows = [
    returnOrder({
      id: "R-1",
      date: "2026-07-01T00:00:00.000Z",
      type: "PREORDER",
      lines: [returnLine({
        purchaseOrderId: "PO-1",
        purchaseOrderLineNumber: 1,
        sku: "SKU-A",
        quantity: 2,
        refundedQty: 1,
      })],
    }),
    returnOrder({
      id: "R-2",
      date: "2026-07-02T00:00:00.000Z",
      type: "REPLACEMENT",
      replacementCustomerOrderId: "REPLACEMENT-ORDER-2",
      lines: [returnLine({
        purchaseOrderId: "PO-2",
        purchaseOrderLineNumber: 1,
        sku: "SKU-A",
        quantity: 1,
      })],
    }),
    returnOrder({
      id: "R-3",
      date: "2026-07-03T00:00:00.000Z",
      type: "PREORDER",
      lines: [returnLine({
        purchaseOrderId: "PO-2",
        purchaseOrderLineNumber: 1,
        sku: "SKU-A",
        quantity: 1,
        status: "COMPLETED",
        cancellationReason: null,
        eventTag: "RETURN_INITIATED",
        currentTrackingStatuses: [{ status: "CANCELLED" }],
      })],
    }),
    returnOrder({
      id: "R-4",
      date: "2026-07-04T00:00:00.000Z",
      type: "PREORDER",
      lines: [returnLine({
        purchaseOrderId: "PO-BEFORE-WINDOW",
        purchaseOrderLineNumber: 1,
        sku: "SKU-A",
        quantity: 1,
      })],
    }),
  ];
  const request = returnsRequest("N");
  return {
    schema_version: WALMART_RAW_RETURNS_PAGES_SCHEMA,
    captured_at: CUTOFF,
    channel: "WALMART_US",
    store_index: 1,
    account_scope: accountScope(),
    request,
    pages: [page("returns", 0, null, {
      meta: { totalCount: 4, limit: 200 },
      returnOrders: rows,
    }, request, "returns-1-N", CUTOFF)],
  };
}

function emptyReturnsBody(wfsEnabled, storeIndex = 1) {
  const request = returnsRequest(wfsEnabled);
  return {
    schema_version: WALMART_RAW_RETURNS_PAGES_SCHEMA,
    captured_at: CUTOFF,
    channel: "WALMART_US",
    store_index: storeIndex,
    account_scope: accountScope(storeIndex),
    request,
    pages: [page("returns", 0, null, {
      meta: { totalCount: 0, limit: 200 },
      returnOrders: [],
    }, request, `returns-${storeIndex}-${wfsEnabled}`, CUTOFF)],
  };
}

function ordersBodyWithRecords(shipNodeType, storeIndex, records) {
  const body = emptyOrdersBody(shipNodeType, storeIndex);
  const response = decodedPage(body, 0);
  response.list.meta.totalCount = records.length;
  response.list.elements.order = records;
  return replacePageResponse(body, 0, response);
}

function returnsBodyWithRecords(wfsEnabled, storeIndex, records) {
  const body = emptyReturnsBody(wfsEnabled, storeIndex);
  const response = decodedPage(body, 0);
  response.meta.totalCount = records.length;
  response.returnOrders = records;
  return replacePageResponse(body, 0, response);
}

function fixture() {
  const published = sealWalmartPerformancePopulation(populationBody());
  const orders = sealWalmartRawOrdersPages(ordersBody());
  const wfsOrders = sealWalmartRawOrdersPages(emptyOrdersBody("WFSFulfilled"));
  const threePlOrders = sealWalmartRawOrdersPages(emptyOrdersBody("3PLFulfilled"));
  const ordersTail = sealWalmartRawOrdersPages(emptyOrdersBody("SellerFulfilled", 1, "tail"));
  const wfsOrdersTail = sealWalmartRawOrdersPages(emptyOrdersBody("WFSFulfilled", 1, "tail"));
  const threePlOrdersTail = sealWalmartRawOrdersPages(emptyOrdersBody("3PLFulfilled", 1, "tail"));
  const returns = sealWalmartRawReturnsPages(returnsBody());
  const wfsReturns = sealWalmartRawReturnsPages(emptyReturnsBody("Y"));
  return {
    published,
    orders,
    returns,
    input: {
      published_populations: [published],
      orders: [
        orders, ordersTail, wfsOrders, wfsOrdersTail, threePlOrders, threePlOrdersTail,
      ],
      returns: [returns, wfsReturns],
    },
  };
}

function replacePageResponse(body, pageIndex, response) {
  const clone = structuredClone(body);
  const oldPage = clone.pages[pageIndex];
  clone.pages[pageIndex] = walmartRawPageFromBytes(
    oldPage.request_path === "/v3/orders" ? "orders" : "returns",
    pageIndex,
    oldPage.request_cursor,
    oldPage.request_query_raw,
    Buffer.from(JSON.stringify(response), "utf8"),
    {
      requested_at: oldPage.requested_at,
      completed_at: oldPage.completed_at,
      request_correlation_id_sha256: oldPage.request_correlation_id_sha256,
      response_correlation_id_sha256: oldPage.response_correlation_id_sha256,
    },
    oldPage.response_content_type_raw,
  );
  return clone;
}

function replaceOrderScope(input, source) {
  return input.orders.map((candidate) => (
    candidate.store_index === source.store_index
      && candidate.request.ship_node_type === source.request.ship_node_type
      && candidate.request.partition_starts_at_exclusive
        === source.request.partition_starts_at_exclusive
      && candidate.request.partition_ends_at_exclusive
        === source.request.partition_ends_at_exclusive
      ? source
      : candidate
  ));
}

function replaceReturnScope(input, source) {
  return input.returns.map((candidate) => (
    candidate.store_index === source.store_index
      && candidate.request.wfs_enabled === source.request.wfs_enabled
      ? source
      : candidate
  ));
}

function rebindFirstQuery(body) {
  const clone = structuredClone(body);
  const kind = clone.schema_version === WALMART_RAW_ORDERS_PAGES_SCHEMA ? "orders" : "returns";
  clone.pages[0].request_query_raw = requestQuery(kind, clone.request, null);
  return clone;
}

function decodedPage(body, index) {
  return JSON.parse(Buffer.from(body.pages[index].response_body_base64, "base64").toString("utf8"));
}

function resealPerformance(source, mutate) {
  const body = structuredClone(source);
  delete body.snapshot_id;
  delete body.body_sha256;
  mutate(body);
  const bodySha = walmartPerformanceCanonicalSha256(body);
  return {
    ...body,
    snapshot_id: `walmart-shadow-performance-${bodySha.slice(0, 16)}`,
    body_sha256: bodySha,
  };
}

test("compiles exact same-cohort metrics, preserves SKU case, zero-fills population, and freezes output", () => {
  const { input } = fixture();
  const source = compileWalmartFrozen180DayPerformanceSource(input);
  assert.equal(source.schema_version, WALMART_FROZEN_180D_PERFORMANCE_SOURCE_SCHEMA);
  assert.equal(source.sales_window.days, 180);
  assert.deepEqual(source.cohort_semantics.outcome_precedence, ["REPLACEMENT", "REFUND", "RETURN"]);
  assert.deepEqual(source.rows, [
    { ...listing("SKU-A"), gross_sales_cents: 3023, units_sold: 4, units_returned: 1, units_refunded: 1, units_replaced: 1 },
    { ...listing("Sku-A"), gross_sales_cents: 10, units_sold: 1, units_returned: 0, units_refunded: 0, units_replaced: 0 },
    { ...listing("ZERO"), gross_sales_cents: 0, units_sold: 0, units_returned: 0, units_refunded: 0, units_replaced: 0 },
  ]);
  assert.equal(source.source_reconciliation.cancelled_outcome_units_excluded, 1);
  assert.equal(source.source_reconciliation.outcome_units_outside_sales_cohort, 1);
  assert.equal(source.source_reconciliation.outcome_units_suppressed_by_precedence, 2);
  assert(Object.isFrozen(source));
  assert(Object.isFrozen(source.rows));
  assert.deepEqual(verifyWalmartFrozen180DayPerformanceSource(source), source);
});

test("strong verifier rebuilds from exact sealed raw sources and rejects a different valid source set", () => {
  const base = fixture();
  const source = compileWalmartFrozen180DayPerformanceSource(base.input);
  assert.deepEqual(
    verifyWalmartFrozen180DayPerformanceSourceAgainstRaw(source, base.input),
    source,
  );

  const modifiedBody = structuredClone(ordersBody());
  const response = decodedPage(modifiedBody, 1);
  response.list.elements.order[0].orderLines.orderLine[0].charges.charge[0].chargeAmount.amount = "9.99";
  const modifiedOrders = sealWalmartRawOrdersPages(replacePageResponse(modifiedBody, 1, response));
  assert.throws(() => verifyWalmartFrozen180DayPerformanceSourceAgainstRaw(source, {
    ...base.input,
    orders: replaceOrderScope(base.input, modifiedOrders),
  }), /does not exactly rebuild/);
});

test("source and output body seals reject mutation", () => {
  const base = fixture();
  const damagedOrders = structuredClone(base.orders);
  damagedOrders.pages[0].response_body_base64 = `${damagedOrders.pages[0].response_body_base64.slice(0, -4)}AAAA`;
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    orders: replaceOrderScope(base.input, damagedOrders),
  }), /body_sha256|response_body_sha256/);

  const source = compileWalmartFrozen180DayPerformanceSource(base.input);
  const damagedOutput = structuredClone(source);
  damagedOutput.rows[0].units_sold += 1;
  assert.throws(() => verifyWalmartFrozen180DayPerformanceSource(damagedOutput), /body_sha256/);
});

test("requires a terminal complete cursor chain", () => {
  const base = fixture();
  const body = structuredClone(ordersBody());
  const response = decodedPage(body, 1);
  response.list.meta.nextCursor = "uncaptured-cursor";
  const incomplete = sealWalmartRawOrdersPages(replacePageResponse(body, 1, response));
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    orders: replaceOrderScope(base.input, incomplete),
  }), /all cursor pages are required/);

  const brokenCursorBody = structuredClone(ordersBody());
  brokenCursorBody.pages[1].request_cursor = "wrong-cursor";
  brokenCursorBody.pages[1].request_query_raw = "wrong-cursor";
  const brokenCursor = sealWalmartRawOrdersPages(brokenCursorBody);
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    orders: replaceOrderScope(base.input, brokenCursor),
  }), /does not continue/);
});

test("reconciles advertised totals and rejects conflicting duplicate IDs", () => {
  const base = fixture();
  const countBody = structuredClone(ordersBody());
  const last = decodedPage(countBody, 1);
  last.list.meta.totalCount = 3;
  const wrongCount = sealWalmartRawOrdersPages(replacePageResponse(countBody, 1, last));
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    orders: replaceOrderScope(base.input, wrongCount),
  }), /conflicting totalCount/);

  const duplicateBody = structuredClone(ordersBody());
  const second = decodedPage(duplicateBody, 1);
  second.list.elements.order[0].purchaseOrderId = "PO-1";
  const conflict = sealWalmartRawOrdersPages(replacePageResponse(duplicateBody, 1, second));
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    orders: replaceOrderScope(base.input, conflict),
  }), /conflicts with duplicate purchaseOrderId/);
});

test("rejects malformed money, excess precision, unsafe magnitude, and non-USD", () => {
  const base = fixture();
  for (const [amount, currency, pattern] of [
    [0.001, "USD", /at most two decimal places/],
    [Number.MAX_SAFE_INTEGER + 1, "USD", /safe JSON number/],
    ["10.00", "EUR", /currency must be USD/],
  ]) {
    const body = structuredClone(ordersBody());
    const response = decodedPage(body, 0);
    const charge = response.list.elements.order[0].orderLines.orderLine[0].charges.charge[0].chargeAmount;
    charge.amount = amount;
    charge.currency = currency;
    const source = sealWalmartRawOrdersPages(replacePageResponse(body, 0, response));
    assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
      ...base.input,
      orders: replaceOrderScope(base.input, source),
    }), pattern);
  }
});

test("gross sales uses exact PRODUCT charge allowlist and ignores PRODUCT_TAX and SHIPPING", () => {
  const base = fixture();
  const body = structuredClone(ordersBody());
  const response = decodedPage(body, 1);
  const charges = response.list.elements.order[0].orderLines.orderLine[0].charges.charge;
  charges.push(
    { chargeType: "PRODUCT_TAX", chargeName: "ProductTax", chargeAmount: { currency: "USD", amount: "999.99" } },
    { chargeType: "SHIPPING", chargeName: "Shipping", chargeAmount: { currency: "USD", amount: "88.88" } },
  );
  const source = sealWalmartRawOrdersPages(replacePageResponse(body, 1, response));
  const compiled = compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    orders: replaceOrderScope(base.input, source),
  });
  assert.equal(compiled.rows[0].gross_sales_cents, 3023);
});

test("rejects malformed quantity, status partitions, dates, and SKU whitespace", () => {
  const base = fixture();
  const cases = [
    ["orderLineQuantity", (line) => { line.orderLineQuantity.amount = "1.5"; }, /canonical non-negative integer/],
    ["status partition", (line) => { line.orderLineStatuses.orderLineStatus[0].statusQuantity.amount = "3"; }, /do not reconcile/],
    ["SKU", (line) => { line.item.sku = "SKU-A "; }, /already-trimmed/],
  ];
  for (const [, mutate, pattern] of cases) {
    const body = structuredClone(ordersBody());
    const response = decodedPage(body, 0);
    mutate(response.list.elements.order[0].orderLines.orderLine[0]);
    const source = sealWalmartRawOrdersPages(replacePageResponse(body, 0, response));
    assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
      ...base.input,
      orders: replaceOrderScope(base.input, source),
    }), pattern);
  }

  const dateBody = structuredClone(ordersBody());
  const response = decodedPage(dateBody, 0);
  response.list.elements.order[0].orderDate = "2026-02-30T00:00:00Z";
  const malformedDate = sealWalmartRawOrdersPages(replacePageResponse(dateBody, 0, response));
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    orders: replaceOrderScope(base.input, malformedDate),
  }), /not a valid ISO-8601/);
});

test("open Orders boundaries and half-open Returns endpoint are rejected", () => {
  const base = fixture();
  const orderBodyValue = structuredClone(ordersBody());
  const orderResponse = decodedPage(orderBodyValue, 1);
  orderResponse.list.elements.order[0].orderDate = END;
  const endOrder = sealWalmartRawOrdersPages(replacePageResponse(orderBodyValue, 1, orderResponse));
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    orders: replaceOrderScope(base.input, endOrder),
  }), /outside (?:its exact open partition interval|the open sales window)/);

  const startBodyValue = structuredClone(ordersBody());
  const startResponse = decodedPage(startBodyValue, 0);
  startResponse.list.elements.order[0].orderDate = START;
  const startOrder = sealWalmartRawOrdersPages(replacePageResponse(startBodyValue, 0, startResponse));
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    orders: replaceOrderScope(base.input, startOrder),
  }), /outside (?:its exact open partition interval|the open sales window)/);

  const returnBodyValue = structuredClone(returnsBody());
  const returnResponse = decodedPage(returnBodyValue, 0);
  returnResponse.returnOrders[0].returnOrderDate = CUTOFF;
  const endReturn = sealWalmartRawReturnsPages(replacePageResponse(returnBodyValue, 0, returnResponse));
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    returns: replaceReturnScope(base.input, endReturn),
  }), /outside the half-open outcome observation/);
});

test("exact PO + purchaseOrderLineNumber + SKU join is mandatory", () => {
  const base = fixture();
  const body = structuredClone(returnsBody());
  const response = decodedPage(body, 0);
  response.returnOrders[0].returnOrderLines[0].item.sku = "Sku-A";
  const mismatch = sealWalmartRawReturnsPages(replacePageResponse(body, 0, response));
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    returns: replaceReturnScope(base.input, mismatch),
  }), /conflicts with the exact joined order line SKU/);
});

test("risk attached to a cohort line with zero eligible sold units is a NO-GO", () => {
  const base = fixture();
  const body = structuredClone(ordersBody());
  const response = decodedPage(body, 1);
  response.list.elements.order[0].orderLines.orderLine[0].orderLineStatuses.orderLineStatus = [{
    status: "Cancelled",
    statusQuantity: { unitOfMeasurement: "EACH", amount: "2" },
  }];
  const noSale = sealWalmartRawOrdersPages(replacePageResponse(body, 1, response));
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    orders: replaceOrderScope(base.input, noSale),
  }), /zero eligible sold units/);
});

test("pending/null refund status remains valid but does not create refunded units", () => {
  const base = fixture();
  const body = structuredClone(returnsBody());
  const response = decodedPage(body, 0);
  response.returnOrders.push(returnOrder({
    id: "R-PENDING",
    date: "2026-07-05T00:00:00.000Z",
    type: "REFUND",
    lines: [returnLine({
      returnOrderLineNumber: 2,
      purchaseOrderId: "PO-1",
      purchaseOrderLineNumber: 2,
      sku: "Sku-A",
      quantity: 1,
      refundedQty: 0,
      currentRefundStatus: null,
      status: "INITIATED",
    })],
  }));
  response.meta.totalCount = 5;
  const pending = sealWalmartRawReturnsPages(replacePageResponse(body, 0, response));
  const compiled = compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    returns: replaceReturnScope(base.input, pending),
  });
  const row = compiled.rows.find((candidate) => candidate.sku === "Sku-A");
  assert.equal(row.units_refunded, 0);
  assert.equal(row.units_returned, 1);
  assert.equal(row.units_replaced, 0);
});

test("replacement outranks a refund for the same single sold unit", () => {
  const base = fixture();
  const body = structuredClone(returnsBody());
  const response = decodedPage(body, 0);
  response.returnOrders.push(returnOrder({
    id: "R-REPLACEMENT-REFUND",
    date: "2026-07-05T00:00:00.000Z",
    type: "REPLACEMENT",
    replacementCustomerOrderId: "REPLACEMENT-CUSTOMER-ORDER",
    lines: [returnLine({
      returnOrderLineNumber: 2,
      purchaseOrderId: "PO-1",
      purchaseOrderLineNumber: 2,
      sku: "Sku-A",
      quantity: 1,
      refundedQty: 1,
    })],
  }));
  response.meta.totalCount = 5;
  const replacement = sealWalmartRawReturnsPages(replacePageResponse(body, 0, response));
  const compiled = compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    returns: replaceReturnScope(base.input, replacement),
  });
  const row = compiled.rows.find((candidate) => candidate.sku === "Sku-A");
  assert.equal(row.units_replaced, 1);
  assert.equal(row.units_refunded, 0);
  assert.equal(compiled.source_reconciliation.outcome_units_suppressed_by_precedence, 4);
});

test("all three Orders and both Returns scopes are mandatory and unique", () => {
  const base = fixture();
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    orders: base.input.orders.filter((source) => source.request.ship_node_type !== "WFSFulfilled"),
  }), /store_index set|missing WFSFulfilled/);
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    returns: base.input.returns.filter((source) => source.request.wfs_enabled !== "Y"),
  }), /store_index set|missing Y/);
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    orders: [...base.input.orders, base.input.orders[0]],
  }), /duplicate partition_id/);
});

test("binds the exact first query and appends Walmart cursor query strings as-is", () => {
  const first = structuredClone(ordersBody());
  first.pages[0].request_query_raw += "&status=Delivered";
  assert.throws(
    () => sealWalmartRawOrdersPages(first),
    /request_query_raw does not exactly match/,
  );

  const continuation = structuredClone(ordersBody());
  continuation.pages[1].request_query_raw = `nextCursor=${encodeURIComponent(
    continuation.pages[1].request_cursor,
  )}`;
  assert.throws(
    () => sealWalmartRawOrdersPages(continuation),
    /request_query_raw does not exactly match/,
  );
});

test("replacement shipment orders never inflate the sales denominator", () => {
  const base = fixture();
  const replacementOrder = order(
    "PO-REPLACEMENT-SHIPMENT",
    "2026-06-01T00:00:00.000Z",
    [orderLine({
      lineNumber: 1,
      sku: "SKU-A",
      quantity: 3,
      amount: "0.00",
      statuses: [["Delivered", 3]],
    })],
    "REPLACEMENT",
  );
  const source = sealWalmartRawOrdersPages(
    ordersBodyWithRecords("WFSFulfilled", 1, [replacementOrder]),
  );
  const compiled = compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    orders: replaceOrderScope(base.input, source),
  });
  assert.equal(compiled.rows.find((row) => row.sku === "SKU-A").units_sold, 4);
  assert.equal(compiled.source_reconciliation.replacement_order_lines_excluded, 1);
});

test("WFS sales and WFS returns join into the same exact SKU cohort", () => {
  const base = fixture();
  const wfsOrder = order("PO-WFS", "2026-06-01T00:00:00.000Z", [orderLine({
    lineNumber: 1,
    sku: "SKU-A",
    quantity: 1,
    amount: "5.00",
    statuses: [["Delivered", 1]],
  })]);
  const wfsReturn = returnOrder({
    id: "R-WFS",
    date: "2026-07-05T00:00:00.000Z",
    type: "PREORDER",
    lines: [returnLine({
      purchaseOrderId: "PO-WFS",
      purchaseOrderLineNumber: 1,
      sku: "SKU-A",
      quantity: 1,
    })],
  });
  const ordersSource = sealWalmartRawOrdersPages(
    ordersBodyWithRecords("WFSFulfilled", 1, [wfsOrder]),
  );
  const returnsSource = sealWalmartRawReturnsPages(
    returnsBodyWithRecords("Y", 1, [wfsReturn]),
  );
  const compiled = compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    orders: replaceOrderScope(base.input, ordersSource),
    returns: replaceReturnScope(base.input, returnsSource),
  });
  const row = compiled.rows.find((candidate) => candidate.sku === "SKU-A");
  assert.equal(row.units_sold, 5);
  assert.equal(row.gross_sales_cents, 3523);
  assert.equal(row.units_returned, 2);
});

test("cross-scope duplicate order IDs are a fail-closed capture conflict", () => {
  const base = fixture();
  const conflicting = order("PO-1", "2026-05-01T00:00:00.000Z", [orderLine({
    lineNumber: 99,
    sku: "SKU-A",
    quantity: 1,
    amount: "1.00",
    statuses: [["Delivered", 1]],
  })]);
  const source = sealWalmartRawOrdersPages(
    ordersBodyWithRecords("WFSFulfilled", 1, [conflicting]),
  );
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    orders: replaceOrderScope(base.input, source),
  }), /appears in mutually exclusive scopes/);
});

test("official raw return types are enforced and initiated REFUND remains return risk", () => {
  const base = fixture();
  const body = structuredClone(returnsBody());
  const response = decodedPage(body, 0);
  response.returnOrders[0].returnType = "RETURN";
  const invalid = sealWalmartRawReturnsPages(replacePageResponse(body, 0, response));
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    returns: replaceReturnScope(base.input, invalid),
  }), /must be PREORDER, REFUND, or REPLACEMENT/);
});

test("account fingerprints and per-request correlations cannot be rebound silently", () => {
  const base = fixture();
  const accountBody = structuredClone(emptyOrdersBody("WFSFulfilled"));
  accountBody.account_scope.seller_account_fingerprint_sha256 = "e".repeat(64);
  accountBody.partition_id = ordersPartitionId(accountBody.request, 1, "e".repeat(64));
  const wrongAccount = sealWalmartRawOrdersPages(accountBody);
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    orders: replaceOrderScope(base.input, wrongAccount),
  }), /account fingerprints do not match/);

  const echoBody = structuredClone(ordersBody());
  echoBody.pages[0].response_correlation_id_sha256 = "f".repeat(64);
  assert.throws(
    () => sealWalmartRawOrdersPages(echoBody),
    /conflicts with the request correlation/,
  );

  const reusedBody = structuredClone(emptyOrdersBody("WFSFulfilled"));
  reusedBody.pages[0].request_correlation_id_sha256 =
    base.input.orders.find((source) => source.request.ship_node_type === "SellerFulfilled")
      .pages[0].request_correlation_id_sha256;
  reusedBody.pages[0].response_correlation_id_sha256 =
    reusedBody.pages[0].request_correlation_id_sha256;
  const reused = sealWalmartRawOrdersPages(reusedBody);
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    orders: replaceOrderScope(base.input, reused),
  }), /reuse a request correlation ID/);
});

test("capture chronology and observation coverage are fail-closed", () => {
  const base = fixture();
  assert.throws(() => sealWalmartRawReturnsPages({
    ...returnsBody(),
    captured_at: "2026-07-09T23:59:59.999Z",
  }), /captured_at must equal the maximum page completed_at/);

  const lateStartBody = structuredClone(returnsBody());
  lateStartBody.request.observation_starts_at_inclusive = "2026-01-02T00:00:00.000Z";
  lateStartBody.request.api_return_creation_start_date_inclusive = "2026-01-02T00:00:00.000Z";
  const lateStart = sealWalmartRawReturnsPages(rebindFirstQuery(lateStartBody));
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    returns: replaceReturnScope(base.input, lateStart),
  }), /must start exactly at the sales-window start/);

  const shortCutoffBody = structuredClone(returnsBody());
  shortCutoffBody.request.observation_cutoff_at_exclusive = "2026-06-29T00:00:00.000Z";
  shortCutoffBody.request.api_return_creation_end_date_inclusive = "2026-06-28T23:59:59.999Z";
  const shortCutoff = sealWalmartRawReturnsPages(rebindFirstQuery(shortCutoffBody));
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    returns: replaceReturnScope(base.input, shortCutoff),
  }), /cutoff cannot precede/);

  const reversedPage = structuredClone(ordersBody());
  reversedPage.pages[0].completed_at = "2026-06-29T23:59:59.998Z";
  assert.throws(
    () => sealWalmartRawOrdersPages(reversedPage),
    /completed_at cannot precede requested_at/,
  );

  const staleHorizon = structuredClone(ordersBody());
  for (const sourcePage of staleHorizon.pages) {
    sourcePage.requested_at = "2026-06-30T00:00:00.001Z";
    sourcePage.completed_at = "2026-06-30T00:00:00.001Z";
  }
  staleHorizon.captured_at = "2026-06-30T00:00:00.001Z";
  assert.throws(
    () => sealWalmartRawOrdersPages(staleHorizon),
    /outside Walmart's 180-day Orders horizon|partition start outside Walmart's 180-day Orders horizon/,
  );
});

test("transport metadata, decoded lengths, record caps, and field caps are bound", () => {
  const body = structuredClone(ordersBody());
  body.pages[0].response_status = 500;
  assert.throws(() => sealWalmartRawOrdersPages(body), /response_status must be 200/);

  const lengthBody = structuredClone(ordersBody());
  lengthBody.pages[0].response_body_byte_length += 1;
  assert.throws(() => sealWalmartRawOrdersPages(lengthBody), /byte_length does not match/);

  const base = fixture();
  const capBody = structuredClone(ordersBody());
  const capResponse = decodedPage(capBody, 0);
  capResponse.list.meta.totalCount = 10_000;
  capResponse.list.meta.nextCursor = undefined;
  capResponse.list.elements.order = [];
  capBody.pages = [replacePageResponse(capBody, 0, capResponse).pages[0]];
  const capped = sealWalmartRawOrdersPages(capBody);
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    orders: replaceOrderScope(base.input, capped),
  }), /ambiguous 10,000-order cap/);

  const skuBody = structuredClone(ordersBody());
  const skuResponse = decodedPage(skuBody, 0);
  skuResponse.list.elements.order[0].orderLines.orderLine[0].item.sku = "S".repeat(513);
  const longSku = sealWalmartRawOrdersPages(replacePageResponse(skuBody, 0, skuResponse));
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    orders: replaceOrderScope(base.input, longSku),
  }), /exceeds 512 characters/);

  const aggregateBody = structuredClone(emptyOrdersBody("SellerFulfilled"));
  aggregateBody.pages = Array.from({ length: 257 }, (_, index) => ({
    ...structuredClone(aggregateBody.pages[0]),
    page_index: index,
    response_body_byte_length: 1024 * 1024,
  }));
  assert.throws(
    () => sealWalmartRawOrdersPages(aggregateBody),
    /aggregate decoded transport cap/,
  );
});

test("two stores compile once each without cross-store multiplication", () => {
  const base = fixture();
  const storeTwoPopulation = sealWalmartPerformancePopulation(
    populationBody(2, ["STORE2"]),
  );
  const storeTwoOrder = order("PO-STORE2", "2026-05-01T00:00:00.000Z", [orderLine({
    lineNumber: 1,
    sku: "STORE2",
    quantity: 1,
    amount: "2.00",
    statuses: [["Delivered", 1]],
  })]);
  const storeTwoReturn = returnOrder({
    id: "R-STORE2",
    date: "2026-07-01T00:00:00.000Z",
    type: "PREORDER",
    lines: [returnLine({
      purchaseOrderId: "PO-STORE2",
      purchaseOrderLineNumber: 1,
      sku: "STORE2",
      quantity: 1,
    })],
  });
  const storeTwoOrders = [
    sealWalmartRawOrdersPages(
      ordersBodyWithRecords("SellerFulfilled", 2, [storeTwoOrder]),
    ),
    sealWalmartRawOrdersPages(emptyOrdersBody("WFSFulfilled", 2)),
    sealWalmartRawOrdersPages(emptyOrdersBody("3PLFulfilled", 2)),
    sealWalmartRawOrdersPages(emptyOrdersBody("SellerFulfilled", 2, "tail")),
    sealWalmartRawOrdersPages(emptyOrdersBody("WFSFulfilled", 2, "tail")),
    sealWalmartRawOrdersPages(emptyOrdersBody("3PLFulfilled", 2, "tail")),
  ];
  const storeTwoReturns = [
    sealWalmartRawReturnsPages(returnsBodyWithRecords("N", 2, [storeTwoReturn])),
    sealWalmartRawReturnsPages(emptyReturnsBody("Y", 2)),
  ];
  const compiled = compileWalmartFrozen180DayPerformanceSource({
    published_populations: [...base.input.published_populations, storeTwoPopulation],
    orders: [...base.input.orders, ...storeTwoOrders],
    returns: [...base.input.returns, ...storeTwoReturns],
  });
  const storeOne = compiled.rows.find((row) => row.listing_key === "walmart:1:SKU-A");
  const storeTwo = compiled.rows.find((row) => row.listing_key === "walmart:2:STORE2");
  assert.deepEqual(storeOne, {
    ...listing("SKU-A"),
    gross_sales_cents: 3023,
    units_sold: 4,
    units_returned: 1,
    units_refunded: 1,
    units_replaced: 1,
  });
  assert.deepEqual(storeTwo, {
    ...listing("STORE2", 2),
    gross_sales_cents: 200,
    units_sold: 1,
    units_returned: 1,
    units_refunded: 0,
    units_replaced: 0,
  });
  assert.equal(compiled.source_reconciliation.unique_orders, 3);
  assert.equal(compiled.source_reconciliation.unique_returns, 5);
  assert.equal(compiled.source_reconciliation.published_population_rows, 4);
});

test("direct verifier rejects a resealed artifact with impossible outcome totals", () => {
  const base = fixture();
  const source = compileWalmartFrozen180DayPerformanceSource(base.input);
  const body = structuredClone(source);
  delete body.snapshot_id;
  delete body.body_sha256;
  body.rows[0].units_returned = 5;
  const bodySha = walmartPerformanceCanonicalSha256(body);
  const impossible = {
    ...body,
    snapshot_id: `walmart-shadow-performance-${bodySha.slice(0, 16)}`,
    body_sha256: bodySha,
  };
  assert.throws(() => verifyWalmartFrozen180DayPerformanceSource(impossible), /outcome units exceed/);
});

test("one-shot end+1ms is impossible, while sequential baseline plus tail preserves exact 180 days", () => {
  const staleOneShot = ordersBodyForInterval(
    "SellerFulfilled",
    1,
    START,
    END,
    TAIL_CAPTURED,
  );
  assert.throws(
    () => sealWalmartRawOrdersPages(staleOneShot),
    /partition start outside Walmart's 180-day Orders horizon/,
  );

  const source = compileWalmartFrozen180DayPerformanceSource(fixture().input);
  assert.equal(source.sales_window.starts_at, START);
  assert.equal(source.sales_window.ends_at, END);
  assert.equal(source.source_reconciliation.order_partitions, 6);
  assert.equal(source.source_reconciliation.order_partition_ids.length, 6);
});

test("partition coverage rejects missing tails, touching boundaries, and gaps", () => {
  const base = fixture();
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    orders: base.input.orders.filter((source) => !(
      source.request.ship_node_type === "SellerFulfilled"
      && source.request.partition_ends_at_exclusive === END
    )),
  }), /baseline and post-cutoff tail|missing the post-cutoff tail/);

  const touchingTail = sealWalmartRawOrdersPages(ordersBodyForInterval(
    "WFSFulfilled",
    1,
    BASELINE_END,
    END,
    TAIL_CAPTURED,
  ));
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    orders: [
      ...base.input.orders.filter((source) => !(
        source.request.ship_node_type === "WFSFulfilled"
        && source.request.partition_ends_at_exclusive === END
      )),
      touchingTail,
    ],
  }), /overlap prior coverage by at least 1ms/);

  const gapBaselineEnd = "2026-06-29T23:59:59.990Z";
  const gapTailStart = "2026-06-29T23:59:59.991Z";
  const gapSources = [
    sealWalmartRawOrdersPages(ordersBodyForInterval(
      "WFSFulfilled", 1, START, gapBaselineEnd, gapBaselineEnd,
    )),
    sealWalmartRawOrdersPages(ordersBodyForInterval(
      "WFSFulfilled", 1, gapTailStart, END, TAIL_CAPTURED,
    )),
  ];
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    orders: [
      ...base.input.orders.filter((source) => source.request.ship_node_type !== "WFSFulfilled"),
      ...gapSources,
    ],
  }), /overlap prior coverage by at least 1ms/);
});

test("three or more canonical Orders partitions are supported", () => {
  const base = fixture();
  const firstEnd = "2026-03-01T00:00:00.000Z";
  const secondStart = "2026-02-28T23:59:59.999Z";
  const secondEnd = "2026-05-01T00:00:00.000Z";
  const thirdStart = "2026-04-30T23:59:59.999Z";
  const partitions = [
    sealWalmartRawOrdersPages(ordersBodyForInterval(
      "WFSFulfilled", 1, START, firstEnd, firstEnd, [], "wfs-three-1",
    )),
    sealWalmartRawOrdersPages(ordersBodyForInterval(
      "WFSFulfilled", 1, secondStart, secondEnd, secondEnd, [], "wfs-three-2",
    )),
    sealWalmartRawOrdersPages(ordersBodyForInterval(
      "WFSFulfilled", 1, thirdStart, END, TAIL_CAPTURED, [], "wfs-three-3",
    )),
  ];
  const source = compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    orders: [
      ...base.input.orders.filter((candidate) => (
        candidate.request.ship_node_type !== "WFSFulfilled"
      )),
      ...partitions,
    ],
  });
  assert.equal(source.source_reconciliation.order_partitions, 7);
});

test("same-scope overlaps deduplicate only canonical-identical orders", () => {
  const base = fixture();
  const baseline = ordersBody();
  const duplicateOrder = decodedPage(baseline, 1).list.elements.order[0];
  const overlapStart = "2026-06-29T23:59:59.000Z";
  const identicalTail = sealWalmartRawOrdersPages(ordersBodyForInterval(
    "SellerFulfilled", 1, overlapStart, END, TAIL_CAPTURED, [duplicateOrder], "identical-tail",
  ));
  const withDuplicate = compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    orders: [
      ...base.input.orders.filter((source) => !(
        source.request.ship_node_type === "SellerFulfilled"
        && source.request.partition_ends_at_exclusive === END
      )),
      identicalTail,
    ],
  });
  assert.equal(withDuplicate.source_reconciliation.overlapping_orders_deduplicated, 1);
  assert.equal(withDuplicate.source_reconciliation.unique_orders, 2);

  const conflict = structuredClone(duplicateOrder);
  conflict.orderLines.orderLine[0].charges.charge[0].chargeAmount.amount = "99.99";
  const conflictingTail = sealWalmartRawOrdersPages(ordersBodyForInterval(
    "SellerFulfilled", 1, overlapStart, END, TAIL_CAPTURED, [conflict], "conflicting-tail",
  ));
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    orders: [
      ...base.input.orders.filter((source) => !(
        source.request.ship_node_type === "SellerFulfilled"
        && source.request.partition_ends_at_exclusive === END
      )),
      conflictingTail,
    ],
  }), /conflicts with same-scope overlapping purchaseOrderId/);
});

test("partition records outside their interval and the 10,000 cap fail closed", () => {
  const base = fixture();
  const outside = order("PO-OUTSIDE-TAIL", "2026-05-01T00:00:00.000Z", [orderLine({
    lineNumber: 1,
    sku: "SKU-A",
    quantity: 1,
    amount: "1.00",
    statuses: [["Delivered", 1]],
  })]);
  const outsideTail = sealWalmartRawOrdersPages(ordersBodyForInterval(
    "WFSFulfilled", 1, TAIL_START, END, TAIL_CAPTURED, [outside], "outside-tail",
  ));
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    orders: [
      ...base.input.orders.filter((source) => !(
        source.request.ship_node_type === "WFSFulfilled"
        && source.request.partition_ends_at_exclusive === END
      )),
      outsideTail,
    ],
  }), /outside its exact open partition interval/);

  const cappedBody = structuredClone(emptyOrdersBody("WFSFulfilled", 1, "tail"));
  const cappedResponse = decodedPage(cappedBody, 0);
  cappedResponse.list.meta.totalCount = 10_000;
  const capped = sealWalmartRawOrdersPages(replacePageResponse(cappedBody, 0, cappedResponse));
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    orders: replaceOrderScope(base.input, capped),
  }), /ambiguous 10,000-order cap/);
});

test("deep JSON payloads fail by budget rather than RangeError", () => {
  let nested = { leaf: true };
  for (let index = 0; index < 5_000; index += 1) nested = { nested };
  const correlation = "9".repeat(64);
  assert.throws(() => walmartRawPageFromBytes(
    "orders",
    0,
    null,
    "x=y",
    Buffer.from(JSON.stringify(nested), "utf8"),
    {
      requested_at: END,
      completed_at: END,
      request_correlation_id_sha256: correlation,
      response_correlation_id_sha256: correlation,
    },
  ), (error) => {
    assert(!(error instanceof RangeError));
    assert.match(error.message, /JSON depth budget/);
    return true;
  });
});

test("Returns lifecycle and MLMQ nested quantities are conservatively validated", () => {
  const base = fixture();
  const garbageBody = structuredClone(returnsBody());
  const garbageResponse = decodedPage(garbageBody, 0);
  garbageResponse.returnOrders[0].returnOrderLines[0].status = "GARBAGE";
  const garbage = sealWalmartRawReturnsPages(replacePageResponse(garbageBody, 0, garbageResponse));
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    returns: replaceReturnScope(base.input, garbage),
  }), /status must be INITIATED, DELIVERED, or COMPLETED/);

  for (const field of ["currentTrackingStatuses", "refundChannels"]) {
    const body = structuredClone(returnsBody());
    const response = decodedPage(body, 0);
    const line = response.returnOrders[0].returnOrderLines[0];
    line[field] = field === "currentTrackingStatuses"
      ? [{ status: "DELIVERED", quantity: { unitOfMeasure: "EACH", measurementValue: 3 } }]
      : [{ refundChannel: "ORIGINAL_TENDER", quantity: { unitOfMeasure: "EACH", measurementValue: 3 } }];
    const invalid = sealWalmartRawReturnsPages(replacePageResponse(body, 0, response));
    assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
      ...base.input,
      returns: replaceReturnScope(base.input, invalid),
    }), /cannot exceed the return-line quantity/);
  }

  const duplicatesBody = structuredClone(returnsBody());
  const duplicatesResponse = decodedPage(duplicatesBody, 0);
  duplicatesResponse.returnOrders[0].returnOrderLines[0].currentTrackingStatuses = [
    { status: "INITIATED", quantity: { unitOfMeasure: "EACH", measurementValue: 2 } },
    { status: "DELIVERED", quantity: { unitOfMeasure: "EACH", measurementValue: 2 } },
  ];
  duplicatesResponse.returnOrders[0].returnOrderLines[0].refundChannels = [
    { refundChannel: "ORIGINAL_TENDER", quantity: { unitOfMeasure: "EACH", measurementValue: 2 } },
  ];
  const duplicates = sealWalmartRawReturnsPages(
    replacePageResponse(duplicatesBody, 0, duplicatesResponse),
  );
  const compiled = compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    returns: replaceReturnScope(base.input, duplicates),
  });
  assert.equal(compiled.rows[0].units_returned, 1);
  assert.equal(compiled.rows[0].units_refunded, 1);
});

test("known in-window PO line mismatch fails; replacement and unknown POs reconcile separately", () => {
  const base = fixture();
  const mismatchBody = structuredClone(returnsBody());
  const mismatchResponse = decodedPage(mismatchBody, 0);
  mismatchResponse.returnOrders[0].returnOrderLines[0].purchaseOrderLineNumber = 99;
  const mismatch = sealWalmartRawReturnsPages(replacePageResponse(
    mismatchBody,
    0,
    mismatchResponse,
  ));
  assert.throws(() => compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    returns: replaceReturnScope(base.input, mismatch),
  }), /does not match a known in-window purchase order line/);

  const replacementOrder = order("PO-REPLACEMENT", "2026-05-01T00:00:00.000Z", [orderLine({
    lineNumber: 1,
    sku: "SKU-A",
    quantity: 1,
    amount: "1.00",
    statuses: [["Delivered", 1]],
  })], "REPLACEMENT");
  const replacementOrders = sealWalmartRawOrdersPages(
    ordersBodyWithRecords("WFSFulfilled", 1, [replacementOrder]),
  );
  const outcomeBody = structuredClone(returnsBody());
  const outcomeResponse = decodedPage(outcomeBody, 0);
  outcomeResponse.returnOrders.push(returnOrder({
    id: "R-REPLACEMENT-PO",
    date: "2026-07-05T00:00:00.000Z",
    type: "PREORDER",
    lines: [returnLine({
      returnOrderLineNumber: 2,
      purchaseOrderId: "PO-REPLACEMENT",
      purchaseOrderLineNumber: 1,
      sku: "SKU-A",
      quantity: 1,
    })],
  }));
  outcomeResponse.meta.totalCount = 5;
  const replacementOutcome = sealWalmartRawReturnsPages(
    replacePageResponse(outcomeBody, 0, outcomeResponse),
  );
  const compiled = compileWalmartFrozen180DayPerformanceSource({
    ...base.input,
    orders: replaceOrderScope(base.input, replacementOrders),
    returns: replaceReturnScope(base.input, replacementOutcome),
  });
  assert.equal(compiled.source_reconciliation.outcome_units_replacement_purchase_order, 1);
  assert.equal(
    compiled.source_reconciliation.outcome_units_unknown_or_pre_window_purchase_order,
    1,
  );
});

test("detached verifier enforces zero-sale gross invariant and fixed calibration NO-GO", () => {
  const source = compileWalmartFrozen180DayPerformanceSource(fixture().input);
  assert.deepEqual(source.assurance, WALMART_PERFORMANCE_ASSURANCE);
  const impossibleGross = resealPerformance(source, (body) => {
    body.rows.find((row) => row.sku === "ZERO").gross_sales_cents = 1;
  });
  assert.throws(
    () => verifyWalmartFrozen180DayPerformanceSource(impossibleGross),
    /gross_sales_cents must be zero when units_sold is zero/,
  );

  const callerUnlocked = resealPerformance(source, (body) => {
    body.assurance.gross_sales_operationally_usable = true;
    body.assurance.operational_ready = true;
  });
  assert.throws(
    () => verifyWalmartFrozen180DayPerformanceSource(callerUnlocked),
    /assurance does not match the frozen compiler semantics/,
  );
  assert.throws(() => verifyWalmartFrozen180DayPerformanceOperationalReadinessAgainstCaptures(
    source,
    {
      trusted_accounts: [],
      published_item_captures: [],
      orders: [],
      returns: [],
    },
  ), /trusted account registry must be a non-empty exact store universe/);
});
