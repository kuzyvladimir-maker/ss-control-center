// Phase 3 — assert the tool registry actually contains every tool we
// expect and that each one has a sane shape (no duplicate names, every
// schema is type=object, every write tool exposes dry_run somewhere).
//
//   npx tsx --test src/lib/jackie-mcp/__tests__/tool-catalogue.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { ensureRegistered, } from "../tools";
import { listTools } from "../registry";

ensureRegistered();
const ALL = listTools();

test("at least 20 tools registered", () => {
  assert.ok(ALL.length >= 20, `expected ≥20 tools, got ${ALL.length}`);
});

test("no duplicate tool names", () => {
  const seen = new Set<string>();
  for (const t of ALL) {
    assert.equal(seen.has(t.name), false, `duplicate: ${t.name}`);
    seen.add(t.name);
  }
});

test("every tool has type=object input schema", () => {
  for (const t of ALL) {
    assert.equal(t.input_schema.type, "object", `${t.name} schema not object`);
    assert.ok(
      typeof t.input_schema.properties === "object" && t.input_schema.properties !== null,
      `${t.name} schema missing properties`,
    );
  }
});

test("every write tool offers dry_run support", () => {
  // Some write tools intentionally don't (account_health_refresh — a
  // poll cycle that's already idempotent; alert_acknowledge has dry_run;
  // …). Assert by allowlist of names that *should* have dry_run.
  const mustHaveDryRun = [
    "listings_update",
    "message_respond",
    "feedback_mark_removal_requested",
    "alert_acknowledge",
    "alert_resolve",
    "draft_publish",
    "walmart_return_refund",
  ];
  for (const name of mustHaveDryRun) {
    const t = ALL.find((x) => x.name === name);
    assert.ok(t, `tool ${name} not registered`);
    const props = t!.input_schema.properties as Record<string, unknown>;
    assert.ok(
      props.dry_run !== undefined || props.apply !== undefined,
      `${name} should have a dry_run or apply flag (safety gate)`,
    );
  }
});

test("every write tool is flagged write=true; every read tool is write=false", () => {
  const writeNames = new Set([
    "listings_update",
    "message_respond",
    "feedback_mark_removal_requested",
    "account_health_refresh",
    "alert_acknowledge",
    "alert_resolve",
    "draft_validate",
    "draft_publish",
    "walmart_return_refund",
  ]);
  for (const t of ALL) {
    if (writeNames.has(t.name)) {
      assert.equal(t.write, true, `${t.name} should be write=true`);
    } else {
      assert.equal(t.write, false, `${t.name} should be write=false`);
    }
  }
});

test("required tool names present", () => {
  const required = [
    "listings_search",
    "listings_get",
    "listings_update",
    "amazon_orders_list",
    "amazon_order_get",
    "walmart_orders_list",
    "walmart_order_get",
    "messages_list",
    "message_get",
    "message_respond",
    "atoz_claims_list",
    "atoz_claim_analyze",
    "feedback_list",
    "feedback_mark_removal_requested",
    "account_health_get",
    "account_health_refresh",
    "account_alerts_list",
    "critical_alerts_list",
    "alert_acknowledge",
    "alert_resolve",
    "drafts_list",
    "draft_get",
    "draft_validate",
    "draft_publish",
    "sku_poll_status",
    "walmart_returns_list",
    "walmart_return_refund",
  ];
  for (const name of required) {
    assert.ok(ALL.some((t) => t.name === name), `missing tool: ${name}`);
  }
});
