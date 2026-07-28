import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const toolSourceUrl = new URL("../tools/channelmax.ts", import.meta.url);
const barrelSourceUrl = new URL("../tools/index.ts", import.meta.url);
const source = await readFile(toolSourceUrl, "utf8");
const barrel = await readFile(barrelSourceUrl, "utf8");

const expectedTools = [
  "channelmax_capabilities",
  "channelmax_job_create",
  "channelmax_job_get",
  "channelmax_job_cancel",
  "channelmax_job_reconcile",
];

test("ChannelMAX Jackie surface exposes only the intended durable tools", () => {
  const actual = [...source.matchAll(/name: "(channelmax_[a-z_]+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(actual, expectedTools);
  assert.match(barrel, /import \{ tools as channelMax \} from "\.\/channelmax";/);
  assert.match(barrel, /\.\.\.channelMax,/);
});

test("ChannelMAX Jackie surface cannot grant mutation approval", () => {
  assert.doesNotMatch(source, /channelmax_job_approve/i);
  assert.doesNotMatch(source, /approveChannelMaxAgentJob/);
  assert.doesNotMatch(source, /parseApproveChannelMaxAgentJob/);
  assert.doesNotMatch(source, /owner_approval\s*:/);
  assert.match(source, /PENDING_APPROVAL/);
});

test("Jackie MCP exposes no ChannelMAX worker execution primitives", () => {
  for (const forbidden of [
    "channelmax_job_claim",
    "channelmax_job_event",
    "channelmax_job_heartbeat",
    "channelmax_job_complete",
    "claimChannelMaxAgentJob",
    "appendChannelMaxAgentEvent",
    "heartbeatChannelMaxAgentJob",
    "completeChannelMaxAgentJob",
  ]) {
    assert.equal(source.includes(forbidden), false, `unexpected ${forbidden}`);
  }
});

test("ChannelMAX Jackie surface has no arbitrary browser-command primitive", () => {
  for (const forbiddenField of [
    "browser_command",
    "javascript",
    "navigate_url",
    "selector",
  ]) {
    assert.equal(
      source.includes(`${forbiddenField}:`),
      false,
      `unexpected arbitrary browser field: ${forbiddenField}`,
    );
  }
});

test("reconciliation is derived from an ambiguous job, not freely created", () => {
  assert.match(
    source,
    /!createOperationEnum\.includes\(input\.operation\)/,
  );
  assert.match(source, /createChannelMaxReconciliationJob/);
  assert.match(source, /parseCreateChannelMaxReconciliation/);
});
