// npm run test:channelmax-worker

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";

import {
  CHANNELMAX_MANUAL_MODEL_DISCOVERY_EXPRESSION,
  CHANNELMAX_INVENTORY_SNAPSHOT_EXPRESSION,
  CHANNELMAX_BOUND_ACCOUNT_ID,
  CHANNELMAX_SELECTED_CHANNEL_MARKER,
  CHANNELMAX_BROWSER_WORKER_OPERATIONS,
  CdpBrowserReadOnlyClient,
  ChannelMaxBrowserWorker,
  ChannelMaxBrowserWorkerError,
  validateControlPlaneBaseUrl,
  type ChannelMaxBrowserTab,
  type ReadOnlyCdp,
} from "@/lib/channelmax-agent/browser-worker";

const TOKEN = "jackie-secret-never-log-123456";
const LEASE_TOKEN = "a".repeat(64);
const SCREENSHOT_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const SCREENSHOT_SHA256 = createHash("sha256")
  .update(SCREENSHOT_BYTES)
  .digest("hex");

interface CapturedRequest {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
  rawBody?: Uint8Array;
}

function claimedJob(
  operation: "SNAPSHOT_INVENTORY" | "DISCOVER_MANUAL_MODEL" =
    "SNAPSHOT_INVENTORY",
  includeInactive = false,
  accountId: string = CHANNELMAX_BOUND_ACCOUNT_ID,
) {
  return {
    ok: true,
    claimed: true,
    lease_token: LEASE_TOKEN,
    lease_expires_at: "2026-07-18T22:02:00.000Z",
    job: {
      id: "job-read-only-001",
      operation,
      mutation: false,
      attempts: 1,
      payload: {
        account_id: accountId,
        expected_active_rows: 164,
        ...(operation === "SNAPSHOT_INVENTORY"
          ? { include_inactive: includeInactive }
          : {}),
      },
    },
    protocol: { read_only: true, external_writes_forbidden: true },
  };
}

function fetchHarness(
  claim: Record<string, unknown>,
): { fetchImpl: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (url.endsWith("/evidence")) {
      const rawBody = Uint8Array.from(init?.body as Uint8Array);
      requests.push({ url, init: init ?? {}, body: {}, rawBody });
      const headers = new Headers(init?.headers);
      const capturedAt = headers.get("x-channelmax-captured-at");
      const kind = headers.get("x-channelmax-evidence-kind");
      const mediaType = headers.get("content-type");
      return Response.json(
        {
          ok: true,
          evidence: {
            kind,
            sha256: createHash("sha256").update(rawBody).digest("hex"),
            byte_size: rawBody.byteLength,
            media_type: mediaType,
            captured_at: capturedAt,
            uri: `https://sscc.example/api/openclaw/channelmax/jobs/job-read-only-001/evidence/${kind === "SCREENSHOT" ? "screenshot-001" : "dom-001"}`,
          },
        },
        { status: 201 },
      );
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url, init: init ?? {}, body });
    if (url.endsWith("/jobs/claim")) return Response.json(claim);
    return Response.json({ ok: true });
  };
  return { fetchImpl: fetchImpl as typeof fetch, requests };
}

class FakeCdp implements ReadOnlyCdp {
  calls: Array<{ command: string; tabId?: string }> = [];

  constructor(
    private readonly tabList: ChannelMaxBrowserTab[],
    private readonly text: string,
    private readonly manualModels = [
      { id: "59021", name: "Manual min/max" },
    ],
  ) {}

  async ping(): Promise<void> {
    this.calls.push({ command: "ping" });
  }

  async tabs(): Promise<ChannelMaxBrowserTab[]> {
    this.calls.push({ command: "tabs" });
    return this.tabList;
  }

  async getText(tabId: string): Promise<string> {
    this.calls.push({ command: "get_text", tabId });
    return this.text;
  }

  async discoverManualModels(tabId: string) {
    this.calls.push({ command: "evaluate", tabId });
    return {
      selectedSiteId: "300",
      selectedSiteName: CHANNELMAX_SELECTED_CHANNEL_MARKER,
      scannedNodes: 3,
      models: this.manualModels,
    };
  }

  async snapshotInventory(tabId: string) {
    this.calls.push({ command: "evaluate", tabId });
    const launchRows = Array.from({ length: 164 }, (_, index) => ({
      item_id: `item-${index}`,
      sku: `AA-ASAA-${index.toString(36).toUpperCase().padStart(4, "0")}`,
      asin: `B0TEST${index.toString().padStart(4, "0")}`,
      description: "Uncrustables test row",
      repricing_model_id: null,
      repricing_model_name: null,
      base_price: 10,
      unit_cost: 5,
      purchase_price: 5,
      actual_shipping_cost: 0,
      qty_in_stock: 1,
      quantity_ss: 1,
      discontinued: false,
      listing_status: "LIVE",
      repricing_status: "LIVE",
      reprice_info: {
        my_price: index < 116 ? 10 : 0,
        my_floor: 9,
        my_ceiling: 12,
        net_profit_roi: 70,
      },
    }));
    return {
      selectedSiteId: "300",
      selectedSiteName: CHANNELMAX_SELECTED_CHANNEL_MARKER,
      titleTotal: 447,
      loadedTitleRows: 447,
      launchRows,
      aggregate: {
        exact_launch_count: 164,
        positive_current_price_count: 116,
        zero_or_missing_current_price_count: 48,
      },
      queryScope: {
        active_skus_only: true,
        title_contains: "Uncrustables",
        view_type: "REPRICING",
        page: 1,
        size: 600,
      },
    };
  }

  async captureScreenshot(tabId: string) {
    this.calls.push({ command: "screenshot", tabId });
    return {
      sha256: SCREENSHOT_SHA256,
      byteSize: SCREENSHOT_BYTES.byteLength,
      capturedAt: new Date().toISOString(),
      bytes: Uint8Array.from(SCREENSHOT_BYTES),
    };
  }
}

function makeWorker(
  fetchImpl: typeof fetch,
  cdp: ReadOnlyCdp,
  logs: string[] = [],
) {
  return new ChannelMaxBrowserWorker(
    {
      controlPlaneBaseUrl: "https://sscc.example",
      jackieApiToken: TOKEN,
      workerId: "imac-channelmax-primary",
      cdpScriptPath: "/workspace/scripts/cdp_browser.py",
    },
    {
      fetchImpl,
      cdp,
      logger: {
        info: (message, fields) => logs.push(JSON.stringify({ message, fields })),
        warn: (message, fields) => logs.push(JSON.stringify({ message, fields })),
        error: (message, fields) => logs.push(JSON.stringify({ message, fields })),
      },
    },
  );
}

test("control-plane URL is HTTPS except explicit loopback development", () => {
  assert.equal(
    validateControlPlaneBaseUrl("https://sscc.example/"),
    "https://sscc.example",
  );
  assert.equal(
    validateControlPlaneBaseUrl("http://127.0.0.1:3000/", {
      allowHttpLocalhost: true,
    }),
    "http://127.0.0.1:3000",
  );
  assert.throws(
    () => validateControlPlaneBaseUrl("http://sscc.example/"),
    (error: unknown) =>
      error instanceof ChannelMaxBrowserWorkerError &&
      error.code === "INVALID_CONFIG",
  );
  assert.throws(() =>
    validateControlPlaneBaseUrl("http://localhost:3000/"),
  );
  assert.throws(() =>
    validateControlPlaneBaseUrl("https://sscc.example/path"),
  );
});

test("fixed inventory probe parses discontinued exactly and aggregates repricing status", () => {
  assert.equal(
    CHANNELMAX_INVENTORY_SNAPSHOT_EXPRESSION.includes(
      "Boolean(row.Discontinued)",
    ),
    false,
  );
  assert.ok(
    CHANNELMAX_INVENTORY_SNAPSHOT_EXPRESSION.includes(
      "row.Discontinued === 1",
    ),
  );
  assert.ok(
    CHANNELMAX_INVENTORY_SNAPSHOT_EXPRESSION.includes(
      "repricing_status_distribution",
    ),
  );
});

test("claim advertises exactly two read-only operations and never leaks the token", async () => {
  const harness = fetchHarness({ ok: true, claimed: false, job: null });
  const logs: string[] = [];
  const worker = makeWorker(
    harness.fetchImpl,
    new FakeCdp([], ""),
    logs,
  );

  assert.equal(await worker.runOnce(), "NO_JOB");
  assert.equal(harness.requests.length, 1);
  const request = harness.requests[0];
  assert.deepEqual(
    request.body.supported_operations,
    CHANNELMAX_BROWSER_WORKER_OPERATIONS,
  );
  assert.equal(request.init.headers instanceof Headers, false);
  assert.equal(
    new Headers(request.init.headers).get("authorization"),
    `Bearer ${TOKEN}`,
  );
  assert.equal(JSON.stringify(request.body).includes(TOKEN), false);
  assert.equal(request.url.includes(TOKEN), false);
  assert.equal(logs.join("\n").includes(TOKEN), false);
});

test("uses one exact ChannelMAX target id and only read-only CDP commands", async () => {
  const harness = fetchHarness(claimedJob());
  const cdp = new FakeCdp(
    [
      {
        id: "target-channelmax-001",
        title: "ChannelMAX Inventory",
        url: "https://selling.channelmax.net/inventory",
      },
      {
        id: "unrelated",
        title: "Other",
        url: "https://example.com/",
      },
    ],
    `${CHANNELMAX_SELECTED_CHANNEL_MARKER}\nInventory\nSKU\nAmazonUS\nRepricing`,
  );
  const worker = makeWorker(harness.fetchImpl, cdp);

  assert.equal(await worker.runOnce(), "COMPLETED");
  assert.deepEqual(cdp.calls, [
    { command: "ping" },
    { command: "tabs" },
    { command: "get_text", tabId: "target-channelmax-001" },
    { command: "screenshot", tabId: "target-channelmax-001" },
    { command: "evaluate", tabId: "target-channelmax-001" },
  ]);
  const commands = cdp.calls.map((call) => call.command);
  for (const forbidden of [
    "navigate",
    "click",
    "click_sel",
    "fill",
    "key",
    "scroll",
    "upload_file",
    "capture_download",
    "new_tab",
    // The sole fixed evaluate probe is allowed only for manual-model discovery.
  ]) {
    assert.equal(commands.includes(forbidden), false);
  }
  const uploads = harness.requests.filter((request) =>
    request.url.endsWith("/evidence"),
  );
  assert.equal(uploads.length, 2);
  const upload = uploads[0];
  assert.ok(upload);
  assert.deepEqual(Buffer.from(upload.rawBody ?? []), SCREENSHOT_BYTES);
  const uploadHeaders = new Headers(upload.init.headers);
  assert.equal(uploadHeaders.get("content-type"), "image/png");
  assert.equal(uploadHeaders.get("x-channelmax-lease-token"), LEASE_TOKEN);
  assert.equal(uploadHeaders.get("x-channelmax-evidence-kind"), "SCREENSHOT");
  const completion = harness.requests.find((request) =>
    request.url.endsWith("/complete"),
  );
  assert.ok(completion);
  assert.equal(completion.body.status, "SUCCEEDED");
  assert.equal((completion.body.evidence as unknown[]).length, 2);
  const result = completion.body.result as Record<string, unknown>;
  assert.equal((result.managed_evidence as unknown[]).length, 2);
});

test("fails closed when zero or multiple exact ChannelMAX tabs exist", async () => {
  for (const tabs of [
    [
      {
        id: "lookalike",
        title: "Fake",
        url: "https://selling.channelmax.net.evil.example/",
      },
    ],
    [
      {
        id: "one",
        title: "One",
        url: "https://selling.channelmax.net/a",
      },
      {
        id: "two",
        title: "Two",
        url: "https://selling.channelmax.net/b",
      },
    ],
  ]) {
    const harness = fetchHarness(claimedJob());
    const cdp = new FakeCdp(tabs, "Inventory SKU");
    const worker = makeWorker(harness.fetchImpl, cdp);
    assert.equal(await worker.runOnce(), "COMPLETED");
    assert.deepEqual(
      cdp.calls.map((call) => call.command),
      ["ping", "tabs"],
    );
    const completion = harness.requests.find((request) =>
      request.url.endsWith("/complete"),
    );
    assert.equal(completion?.body.status, "FAILED");
    assert.match(
      String(completion?.body.message),
      /CHANNELMAX_TAB_(?:NOT_FOUND|AMBIGUOUS)/,
    );
  }
});

test("active-only snapshot refuses include_inactive=true before touching Chrome", async () => {
  const harness = fetchHarness(claimedJob("SNAPSHOT_INVENTORY", true));
  const cdp = new FakeCdp([], "");
  await makeWorker(harness.fetchImpl, cdp).runOnce();
  assert.deepEqual(cdp.calls, []);
  const completion = harness.requests.find((request) =>
    request.url.endsWith("/complete"),
  );
  assert.equal(completion?.body.status, "FAILED");
  assert.match(String(completion?.body.message), /UNSUPPORTED_SNAPSHOT_SCOPE/);
});

test("snapshot fails when exact launch rows differ from expected_active_rows", async () => {
  const claim = claimedJob();
  claim.job.payload.expected_active_rows = 163;
  const harness = fetchHarness(claim);
  const cdp = new FakeCdp(
    [
      {
        id: "count-mismatch-tab",
        title: "ChannelMAX Inventory",
        url: "https://selling.channelmax.net/inventory",
      },
    ],
    `${CHANNELMAX_SELECTED_CHANNEL_MARKER}\nInventory SKU Repricing`,
  );
  await makeWorker(harness.fetchImpl, cdp).runOnce();
  const completion = harness.requests.find((request) =>
    request.url.endsWith("/complete"),
  );
  assert.equal(completion?.body.status, "FAILED");
  assert.match(String(completion?.body.message), /ACTIVE_ROW_COUNT_MISMATCH/);
  assert.equal((completion?.body.evidence as unknown[]).length, 1);
});

test("worker refuses a job for any account_id outside its exact binding", async () => {
  const harness = fetchHarness(
    claimedJob("SNAPSHOT_INVENTORY", false, "channelmax:other-account"),
  );
  const cdp = new FakeCdp([], "");
  await makeWorker(harness.fetchImpl, cdp).runOnce();
  assert.deepEqual(cdp.calls, []);
  const completion = harness.requests.find((request) =>
    request.url.endsWith("/complete"),
  );
  assert.equal(completion?.body.status, "FAILED");
  assert.match(String(completion?.body.message), /CHANNELMAX_ACCOUNT_ID_MISMATCH/);
});

test("worker refuses a page without the exact visible selected-channel marker", async () => {
  const harness = fetchHarness(claimedJob());
  const cdp = new FakeCdp(
    [
      {
        id: "wrong-account-tab",
        title: "ChannelMAX Inventory",
        url: "https://selling.channelmax.net/inventory",
      },
    ],
    "AmznUS [Some Other Seller]\nInventory SKU Repricing",
  );
  await makeWorker(harness.fetchImpl, cdp).runOnce();
  assert.deepEqual(
    cdp.calls.map((call) => call.command),
    ["ping", "tabs", "get_text"],
  );
  const completion = harness.requests.find((request) =>
    request.url.endsWith("/complete"),
  );
  assert.equal(completion?.body.status, "FAILED");
  assert.match(
    String(completion?.body.message),
    /CHANNELMAX_SELECTED_ACCOUNT_MISMATCH/,
  );
  assert.deepEqual(completion?.body.evidence, []);
});

test("login, 2FA, and CAPTCHA stop before any page interaction", async () => {
  for (const visibleText of [
    "Sign in with your email address and password",
    "Enter your two-factor verification code",
    "Complete CAPTCHA to verify you are human",
  ]) {
    const harness = fetchHarness(claimedJob("DISCOVER_MANUAL_MODEL"));
    const cdp = new FakeCdp(
      [
        {
          id: "auth-tab",
          title: "ChannelMAX",
          url: "https://selling.channelmax.net/login",
        },
      ],
      visibleText,
    );
    const worker = makeWorker(harness.fetchImpl, cdp);
    await worker.runOnce();

    assert.deepEqual(
      cdp.calls.map((call) => call.command),
      ["ping", "tabs", "get_text", "screenshot"],
    );
    const authEvent = harness.requests.find(
      (request) =>
        request.url.endsWith("/event") && request.body.type === "AUTH_REQUIRED",
    );
    assert.ok(authEvent);
    const completion = harness.requests.find((request) =>
      request.url.endsWith("/complete"),
    );
    assert.equal(completion?.body.status, "FAILED");
    assert.match(
      String(completion?.body.message),
      /(?:LOGIN|TWO_FACTOR|CAPTCHA)_REQUIRED/,
    );
    assert.equal((completion?.body.evidence as unknown[]).length, 1);
  }
});

test("manual discovery requires ID 59021 with the exact Manual min/max model", async () => {
  const harness = fetchHarness(claimedJob("DISCOVER_MANUAL_MODEL"));
  const cdp = new FakeCdp(
    [
      {
        id: "wrong-manual-tab",
        title: "Repricing Models",
        url: "https://selling.channelmax.net/repricing-models",
      },
    ],
    `${CHANNELMAX_SELECTED_CHANNEL_MARKER}\nRepricing Model Manual`,
    [{ id: "59021", name: "Manual" }],
  );
  await makeWorker(harness.fetchImpl, cdp).runOnce();
  const completion = harness.requests.find((request) =>
    request.url.endsWith("/complete"),
  );
  assert.equal(completion?.body.status, "FAILED");
  assert.match(String(completion?.body.message), /MANUAL_MODEL_NOT_FOUND/);
  assert.equal((completion?.body.evidence as unknown[]).length, 1);
});

test("heartbeat, events, and one terminal completion are emitted without job replay", async () => {
  const harness = fetchHarness(claimedJob("DISCOVER_MANUAL_MODEL"));
  const cdp = new FakeCdp(
    [
      {
        id: "manual-tab",
        title: "Repricing Models",
        url: "https://selling.channelmax.net/repricing-models",
      },
    ],
    `${CHANNELMAX_SELECTED_CHANNEL_MARKER}\nRepricing Model\nManual min/max floor and ceiling\nRules 44(a) and 44(b)`,
  );
  const worker = makeWorker(harness.fetchImpl, cdp);
  await worker.runOnce();

  assert.ok(
    harness.requests.filter((request) => request.url.endsWith("/heartbeat"))
      .length >= 2,
  );
  assert.deepEqual(
    harness.requests
      .filter((request) => request.url.endsWith("/heartbeat"))
      .map((request) => request.body.phase),
    [
      "starting",
      "browser_connected",
      "tab_selected",
      "visible_text_read",
      "screenshot_captured",
      "screenshot_stored",
      "read_only_probe_complete",
      "json_evidence_ready",
      "evidence_stored",
    ],
  );
  assert.ok(
    harness.requests.some((request) => request.url.endsWith("/event")),
  );
  assert.equal(
    harness.requests.filter((request) => request.url.endsWith("/complete"))
      .length,
    1,
  );
  assert.equal(
    harness.requests.filter((request) => request.url.endsWith("/jobs/claim"))
      .length,
    1,
  );
  assert.equal(JSON.stringify(harness.requests).includes(TOKEN), true);
  const serializedWithoutHeaders = JSON.stringify(
    harness.requests.map((request) => ({ url: request.url, body: request.body })),
  );
  assert.equal(serializedWithoutHeaders.includes(TOKEN), false);
  assert.deepEqual(
    cdp.calls.map((call) => call.command),
    ["ping", "tabs", "get_text", "screenshot", "evaluate"],
  );
  assert.ok(CHANNELMAX_MANUAL_MODEL_DISCOVERY_EXPRESSION.includes("openQRM"));
});

test("subprocess wrapper passes no application secret and uses only fixed read-only commands", async () => {
  const invocations: Array<{
    file: string;
    args: readonly string[];
    options: { env: NodeJS.ProcessEnv };
  }> = [];
  const priorToken = process.env.JACKIE_API_TOKEN;
  process.env.JACKIE_API_TOKEN = TOKEN;
  try {
    const execFileImpl = (
      file: string,
      args: readonly string[],
      options: { env: NodeJS.ProcessEnv },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      invocations.push({ file, args, options });
      const command = args[1];
      if (command === "ping") {
        callback(null, JSON.stringify({ ok: true, command: "ping" }), "");
      } else if (command === "tabs") {
        callback(
          null,
          JSON.stringify({
            ok: true,
            command: "tabs",
            tabs: [
              {
                id: "exact-target",
                title: "ChannelMAX",
                url: "https://selling.channelmax.net/models",
              },
            ],
          }),
          "",
        );
      } else if (command === "get_text") {
        callback(
          null,
          JSON.stringify({ ok: true, command: "get_text", text: "Manual" }),
          "",
        );
      } else if (command === "evaluate") {
        if (args[2] === CHANNELMAX_MANUAL_MODEL_DISCOVERY_EXPRESSION) {
          callback(
            null,
            JSON.stringify({
              ok: true,
              command: "evaluate",
              value: {
                selected_site_id: "300",
                selected_site_name: CHANNELMAX_SELECTED_CHANNEL_MARKER,
                scanned_nodes: 1,
                models: [{ id: "59021", name: "Manual min/max" }],
              },
            }),
            "",
          );
        } else if (args[2] === CHANNELMAX_INVENTORY_SNAPSHOT_EXPRESSION) {
          callback(
            null,
            JSON.stringify({
              ok: true,
              command: "evaluate",
              value: {
                selected_site_id: "300",
                selected_site_name: CHANNELMAX_SELECTED_CHANNEL_MARKER,
                title_total: 2,
                loaded_title_rows: 2,
                launch_rows: [
                  {
                    item_id: "item-1",
                    sku: "AA-ASAA-0001",
                    asin: "B0TEST0001",
                    description: "Uncrustables one",
                    repricing_model_id: null,
                    repricing_model_name: null,
                    base_price: 10,
                    unit_cost: 5,
                    purchase_price: 5,
                    actual_shipping_cost: 0,
                    qty_in_stock: 1,
                    quantity_ss: 1,
                    discontinued: false,
                    listing_status: "",
                    repricing_status: "LIVE",
                    reprice_info: {
                      my_price: 10,
                      my_floor: 9,
                      my_ceiling: 12,
                      net_profit_roi: 70,
                    },
                  },
                  {
                    item_id: "item-2",
                    sku: "BB-ASBB-0002",
                    asin: "B0TEST0002",
                    description: "Uncrustables two",
                    repricing_model_id: "59021",
                    repricing_model_name: "Manual min/max",
                    base_price: 10,
                    unit_cost: 5,
                    purchase_price: 5,
                    actual_shipping_cost: 0,
                    qty_in_stock: 1,
                    quantity_ss: 1,
                    discontinued: false,
                    listing_status: "",
                    repricing_status: "LIVE",
                    reprice_info: {
                      my_price: 0,
                      my_floor: 9,
                      my_ceiling: 12,
                      net_profit_roi: 70,
                    },
                  },
                ],
                // Deliberately false: the host must recompute this.
                aggregate: { exact_launch_count: 999 },
                query_scope: { sellerId: "must-not-be-trusted" },
              },
            }),
            "",
          );
        } else {
          callback(new Error("unapproved evaluate expression"), "", "");
        }
      } else if (command === "screenshot") {
        const outputIndex = args.indexOf("--output-dir");
        const outputPath = `${args[outputIndex + 1]}/capture.png`;
        void writeFile(outputPath, SCREENSHOT_BYTES).then(() => {
          callback(
            null,
            JSON.stringify({
              ok: true,
              command: "screenshot",
              path: outputPath,
              bytes: SCREENSHOT_BYTES.byteLength,
              sha256: SCREENSHOT_SHA256,
            }),
            "",
          );
        });
      } else {
        callback(new Error(`forbidden command: ${command}`), "", "");
      }
    };
    const client = new CdpBrowserReadOnlyClient({
      pythonExecutable: "/usr/bin/python3",
      scriptPath: "/workspace/scripts/cdp_browser.py",
      cdpPort: 9222,
      timeoutMs: 1_000,
      execFileImpl: execFileImpl as never,
    });

    await client.ping();
    assert.equal((await client.tabs())[0]?.id, "exact-target");
    assert.equal(await client.getText("exact-target"), "Manual");
    assert.deepEqual(await client.discoverManualModels("exact-target"), {
      selectedSiteId: "300",
      selectedSiteName: CHANNELMAX_SELECTED_CHANNEL_MARKER,
      scannedNodes: 1,
      models: [{ id: "59021", name: "Manual min/max" }],
    });
    const inventory = await client.snapshotInventory("exact-target");
    assert.deepEqual(inventory.aggregate, {
      exact_launch_count: 2,
      positive_current_price_count: 1,
      zero_or_missing_current_price_count: 1,
      model_distribution: [
        { id: null, name: null, count: 1 },
        { id: "59021", name: "Manual min/max", count: 1 },
      ],
      repricing_status_distribution: [{ status: "LIVE", count: 2 }],
    });
    assert.equal(JSON.stringify(inventory).includes("must-not-be-trusted"), false);
    const screenshot = await client.captureScreenshot("exact-target");
    assert.equal(screenshot.sha256, SCREENSHOT_SHA256);

    assert.deepEqual(
      invocations.map((invocation) => invocation.args[1]),
      ["ping", "tabs", "get_text", "evaluate", "evaluate", "screenshot"],
    );
    for (const invocation of invocations) {
      assert.equal(invocation.args.includes(TOKEN), false);
      assert.equal(JSON.stringify(invocation.options.env).includes(TOKEN), false);
      assert.equal(invocation.options.env.JACKIE_API_TOKEN, undefined);
    }
    const evaluateInvocation = invocations.find(
      (invocation) =>
        invocation.args[1] === "evaluate" &&
        invocation.args[2] === CHANNELMAX_MANUAL_MODEL_DISCOVERY_EXPRESSION,
    );
    assert.equal(
      evaluateInvocation?.args[2],
      CHANNELMAX_MANUAL_MODEL_DISCOVERY_EXPRESSION,
    );
    assert.deepEqual(evaluateInvocation?.args.slice(3), [
      "--tab",
      "exact-target",
      "--expected-host",
      "selling.channelmax.net",
    ]);
    const snapshotInvocation = invocations.find(
      (invocation) =>
        invocation.args[1] === "evaluate" &&
        invocation.args[2] === CHANNELMAX_INVENTORY_SNAPSHOT_EXPRESSION,
    );
    assert.ok(snapshotInvocation);
  } finally {
    if (priorToken === undefined) delete process.env.JACKIE_API_TOKEN;
    else process.env.JACKIE_API_TOKEN = priorToken;
  }
});

test("manual discovery host-validates exact selected ChannelMAX site identity", async () => {
  for (const selected of [
    { id: "999", name: CHANNELMAX_SELECTED_CHANNEL_MARKER },
    { id: "300", name: "AmznUS [Another Seller]" },
    { id: "300", name: `${CHANNELMAX_SELECTED_CHANNEL_MARKER} ` },
  ]) {
    const execFileImpl = (
      _file: string,
      _args: readonly string[],
      _options: { env: NodeJS.ProcessEnv },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      callback(
        null,
        JSON.stringify({
          ok: true,
          command: "evaluate",
          value: {
            selected_site_id: selected.id,
            selected_site_name: selected.name,
            scanned_nodes: 1,
            models: [{ id: "59021", name: "Manual min/max" }],
          },
        }),
        "",
      );
    };
    const client = new CdpBrowserReadOnlyClient({
      pythonExecutable: "/usr/bin/python3",
      scriptPath: "/workspace/scripts/cdp_browser.py",
      cdpPort: 9222,
      timeoutMs: 1_000,
      execFileImpl: execFileImpl as never,
    });

    await assert.rejects(
      client.discoverManualModels("exact-target"),
      (error: unknown) =>
        error instanceof ChannelMaxBrowserWorkerError &&
        error.code === "CHANNELMAX_SELECTED_ACCOUNT_MISMATCH",
    );
  }
});
