import { test } from "node:test";
import assert from "node:assert/strict";
import { isVeeqoTransientError, veeqoFetch } from "../client";
import { putNotesOnce } from "../../procurement/order-state-update";

const HTML = "<!DOCTYPE html>\n<html><head><title>502 Bad Gateway</title></head><body>…</body></html>";

type Call = { url: string; method: string };
function mockFetch(handler: (c: Call, n: number) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const c = { url: String(url), method: (init?.method || "GET").toUpperCase() };
    calls.push(c);
    return handler(c, calls.length);
  }) as typeof fetch;
  return calls;
}

test("a 502 HTML page becomes a short message, not the page", async () => {
  mockFetch(() => new Response(HTML, { status: 502 }));
  await assert.rejects(
    veeqoFetch("/orders/1", { method: "PUT", body: "{}" }),
    (e: Error) => {
      assert.equal(e.message, "Veeqo API error 502: Veeqo is temporarily unavailable, try again");
      assert.equal(isVeeqoTransientError(e), true);
      return true;
    },
  );
});

test("a GET survives a 502 blip with backoff", async () => {
  const calls = mockFetch((_c, n) =>
    n === 1 ? new Response(HTML, { status: 502 }) : Response.json({ id: 1 }),
  );
  assert.deepEqual(await veeqoFetch("/orders/1"), { id: 1 });
  assert.equal(calls.length, 2);
});

const block = "[PROCUREMENT]\n55 | Pork roll | bought\n[/PROCUREMENT]";
const desired = new Map([["55", { kind: "bought" as const }]]);

test("notes PUT that failed but landed is not re-sent", async () => {
  const calls = mockFetch((c) =>
    c.method === "PUT"
      ? new Response(HTML, { status: 502 })
      : Response.json({ id: 1, employee_notes: block }),
  );
  assert.equal(await putNotesOnce("1", { employee_notes_attributes: [{ text: block }] }, desired), null);
  assert.deepEqual(calls.map((c) => c.method), ["PUT", "GET"]);
});

test("notes PUT that failed and did not land is sent again", async () => {
  const calls = mockFetch((c, n) =>
    c.method === "PUT"
      ? n === 1
        ? new Response(HTML, { status: 502 })
        : Response.json({ ok: true })
      : Response.json({ id: 1, employee_notes: "" }),
  );
  assert.deepEqual(
    await putNotesOnce("1", { employee_notes_attributes: [{ text: block }] }, desired),
    { ok: true },
  );
  assert.deepEqual(calls.map((c) => c.method), ["PUT", "GET", "PUT"]);
});

test("a non-transient PUT error is thrown at once", async () => {
  const calls = mockFetch(() => new Response('{"error":"bad"}', { status: 422 }));
  await assert.rejects(putNotesOnce("1", {}, desired), /Veeqo API error 422: \{"error":"bad"\}/);
  assert.equal(calls.length, 1);
});

test("a read-only POST (rate quote) is retried; any other POST is not", async () => {
  let calls = mockFetch((_c, n) =>
    n === 1 ? new Response(HTML, { status: 429 }) : Response.json({ quotes: [] }),
  );
  assert.deepEqual(
    await veeqoFetch("/shipping/api/v1/rates", { method: "POST", body: "{}" }, { readOnlyPost: true }),
    { quotes: [] },
  );
  assert.equal(calls.length, 2);

  calls = mockFetch(() => new Response(HTML, { status: 502 }));
  await assert.rejects(veeqoFetch("/shipping/shipments", { method: "POST", body: "{}" }), /502/);
  assert.equal(calls.length, 1);
});
