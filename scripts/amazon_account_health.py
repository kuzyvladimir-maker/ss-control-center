#!/usr/bin/env python3
"""Read Amazon Account Health / Policy Compliance programmatically.

WHY THIS EXISTS
---------------
The official Amazon SP-API has NO public endpoint for Account Health Rating
(AHR) or the listing Policy Compliance table. The two endpoints our own code
stubs out —
    GET /sellingpartnerinsights/2024-09-10/accountHealth
    GET /sellingpartnerinsights/2024-09-10/policyCompliance
sit behind the "Selling Partner Insights" role, which is NOT granted on any of
our stores (see src/lib/amazon-sp-api/account-health-rating.ts and
policy-compliance.ts — both hard-return empty). So the only way to read this
data is the SAME private JSON endpoint the Seller Central web page itself calls
when you open:
    sellercentral.amazon.com/performance/account/health/product-policies

HOW WE READ IT (robust, no fragile cookie-copying)
--------------------------------------------------
Instead of copying cookies + the anti-csrftoken-a2z token out of the browser by
hand (they expire in minutes and break constantly), we drive a `fetch()` from
*inside* the already-authenticated Chrome tab over the Chrome DevTools Protocol
(CDP) — the same bridge scripts/cdp_browser.py uses (Chrome with
--remote-debugging-port, default :9222; over the SSH tunnel this reaches the
Salutem session box).

That gives us two things for free:
  1. Cookies attach automatically — the fetch is same-origin from within the
     logged-in sellercentral.amazon.com document.
  2. The private endpoint URL, method, body AND its anti-csrftoken-a2z header
     are DISCOVERED by sniffing the real requests the page makes (CDP Network
     domain) — we never hardcode a guessed URL. The discovered endpoint is
     cached so later runs hit it directly and only re-discover on 403/empty.

READ-ONLY. This never writes/edits a listing. It only GETs the health data.

USAGE
-----
  # one-time / whenever the session was re-logged-in:
  python3 scripts/amazon_account_health.py check              # is SC logged in?
  python3 scripts/amazon_account_health.py discover           # dump candidate endpoints
  python3 scripts/amazon_account_health.py get salutem        # the real thing
  python3 scripts/amazon_account_health.py get salutem --json # machine output
  python3 scripts/amazon_account_health.py get salutem --raw  # + raw payload

Env:
  CDP_PORT   CDP port of the target Chrome (default 9222)

Requires: pip install websocket-client
"""

import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter

import websocket  # websocket-client

PORT = int(os.environ.get("CDP_PORT", "9222"))
BASE = f"http://localhost:{PORT}"

HEALTH_PAGE = (
    "https://sellercentral.amazon.com/performance/account/health/product-policies"
)

# Where we remember the discovered endpoint per channel so we don't have to
# re-sniff the whole page every run. Lives in $HOME, never committed.
STATE_DIR = os.path.expanduser("~/.ss-cc")
STATE_FILE = os.path.join(STATE_DIR, "amazon_health_endpoints.json")

# channel -> the Amazon account it maps to. US merchant tokens per CLAUDE.md.
# The Seller Central session must be switched to this account for the numbers
# to be that account's; we read the page's account context and WARN on mismatch
# rather than silently returning another store's health.
CHANNELS = {
    "salutem": {"merchantToken": "A3A7A0RDFUSGBS", "storeIndex": 1,
                "label": "Salutem Solutions"},
    "amzcom": {"merchantToken": "A2ON382ZMCWPCT", "storeIndex": 3,
               "label": "AMZ Commerce"},
    "retailer": {"merchantToken": "A1LCOF57VUVMI4", "storeIndex": 5,
                 "label": "Retailer Distributor"},
}


class NotLoggedIn(RuntimeError):
    """Seller Central redirected us to /ap/signin — a human must log in."""


# ── CDP plumbing ─────────────────────────────────────────────────────────────
def _http(path, method="GET"):
    req = urllib.request.Request(BASE + path, method=method)
    with urllib.request.urlopen(req, timeout=8) as r:
        return r.read().decode("utf-8", "replace")


def list_pages():
    data = json.loads(_http("/json"))
    return [t for t in data
            if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]


class CDP:
    """A CDP session on ONE page target, with an event pump.

    cmd() sends a command and returns its result, buffering any CDP *events*
    (Network.*, Page.*) that arrive in the meantime into self.events so a later
    drain() can consume them. This is what lets us both call commands and
    passively record the page's network traffic on one socket.
    """

    def __init__(self, ws_url):
        self.ws = websocket.create_connection(
            ws_url, timeout=60, suppress_origin=True, max_size=None
        )
        self._id = 0
        self.events = []

    def cmd(self, method, params=None, timeout=30):
        self._id += 1
        mid = self._id
        self.ws.send(json.dumps({"id": mid, "method": method,
                                 "params": params or {}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.ws.settimeout(max(1, deadline - time.time()))
            try:
                msg = json.loads(self.ws.recv())
            except (websocket.WebSocketTimeoutException, ValueError):
                continue
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(msg["error"].get("message", str(msg["error"])))
                return msg.get("result", {})
            if "method" in msg:  # a CDP event — stash it
                self.events.append(msg)
        raise RuntimeError(f"CDP timeout waiting for {method}")

    def drain(self, seconds):
        """Passively read events for `seconds` (used while a page loads)."""
        deadline = time.time() + seconds
        while time.time() < deadline:
            self.ws.settimeout(max(0.3, deadline - time.time()))
            try:
                msg = json.loads(self.ws.recv())
            except (websocket.WebSocketTimeoutException, ValueError):
                continue
            if "method" in msg:
                self.events.append(msg)

    def evaluate(self, expr, await_promise=True, timeout=40):
        r = self.cmd("Runtime.evaluate", {
            "expression": expr, "returnByValue": True,
            "awaitPromise": await_promise, "userGesture": True,
        }, timeout=timeout)
        if r.get("exceptionDetails"):
            return {"__eval_error__": r["exceptionDetails"].get("text", "eval error")}
        return r.get("result", {}).get("value")

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


def open_or_get_tab(substr):
    """Return a CDP bound to a tab whose url/title contains substr, opening the
    health page if none exists."""
    pages = list_pages()
    for t in pages:
        if substr in (t.get("url", "") + " " + t.get("title", "")).lower():
            return CDP(t["webSocketDebuggerUrl"])
    # none yet — open one
    try:
        _http("/json/new?" + urllib.parse.quote(HEALTH_PAGE, safe=""), method="PUT")
    except Exception:
        ver = json.loads(_http("/json/version"))
        c = CDP(ver["webSocketDebuggerUrl"])
        c.cmd("Target.createTarget", {"url": HEALTH_PAGE})
        c.close()
    time.sleep(2)
    for t in list_pages():
        if "health" in (t.get("url", "")).lower() or "sellercentral" in (t.get("url", "")).lower():
            return CDP(t["webSocketDebuggerUrl"])
    # fall back to the newest page
    pages = list_pages()
    return CDP(pages[-1]["webSocketDebuggerUrl"]) if pages else None


# ── session / login ──────────────────────────────────────────────────────────
def current_url(cdp):
    return cdp.evaluate("location.href") or ""


def ensure_health_page(cdp):
    """Navigate the tab to the health page and confirm we're logged in.

    Raises NotLoggedIn if Amazon bounced us to the sign-in page.
    """
    cdp.cmd("Page.enable")
    cdp.cmd("Network.enable")
    cdp.cmd("Page.navigate", {"url": HEALTH_PAGE})
    # let the SPA boot and fire its data XHRs
    cdp.drain(9)
    url = current_url(cdp)
    if "/ap/signin" in url or "/ap/mfa" in url:
        raise NotLoggedIn(
            "Seller Central is logged out (landed on sign-in). A human must log "
            "in as the target account in the CDP Chrome, then re-run."
        )
    return url


def read_account_context(cdp):
    """Best-effort read of which merchant/marketplace the page is showing, so we
    can flag a channel mismatch. Amazon stashes these in the page's JS state and
    cookies; we sniff the obvious spots."""
    js = r"""
    (() => {
      const out = {};
      try {
        const m = document.cookie.match(/(?:^|;\s*)(?:sc-merchant-id|merchantID|merchant-id)=([^;]+)/i);
        if (m) out.merchantId = decodeURIComponent(m[1]);
      } catch (e) {}
      // Seller Central often exposes the picked account on window state.
      for (const k of ['merchantId','sellerId','encryptedMerchantId']) {
        try { if (window[k]) out[k] = String(window[k]); } catch(e){}
      }
      // the account switcher label, if rendered
      const el = document.querySelector('[data-testid="account-switcher"], .partner-switcher, #partner-switcher');
      if (el) out.switcherText = el.innerText.trim().slice(0, 80);
      return out;
    })()
    """
    return cdp.evaluate(js) or {}


# ── endpoint discovery ───────────────────────────────────────────────────────
HEALTH_MARKERS = re.compile(
    r"accounthealthrating|policycompliance|policyviolation|listingpolicy|"
    r"atrisksales|at_risk_sales|violationreason|compliancestatus|productpolic|"
    r"account.?health|ahr\b|health.?score",
    re.I,
)


def collect_network(cdp):
    """Turn the buffered CDP events into request records with response bodies.

    Returns a list of dicts: {url, method, requestHeaders, postData, status,
    mimeType, body}. We only fetch bodies for JSON-ish responses to keep it
    cheap.
    """
    reqs = {}  # requestId -> record
    for ev in cdp.events:
        m = ev.get("method")
        p = ev.get("params", {})
        rid = p.get("requestId")
        if not rid:
            continue
        if m == "Network.requestWillBeSent":
            r = p.get("request", {})
            reqs.setdefault(rid, {})
            reqs[rid].update({
                "url": r.get("url", ""),
                "method": r.get("method", "GET"),
                "requestHeaders": r.get("headers", {}),
                "postData": r.get("postData"),
            })
        elif m == "Network.responseReceived":
            resp = p.get("response", {})
            reqs.setdefault(rid, {})
            reqs[rid].update({
                "status": resp.get("status"),
                "mimeType": resp.get("mimeType", ""),
                "respHeaders": resp.get("headers", {}),
            })

    records = []
    for rid, r in reqs.items():
        mime = (r.get("mimeType") or "").lower()
        url = r.get("url", "")
        looks_json = "json" in mime or url.endswith(".json") or "/api/" in url
        if not looks_json:
            continue
        body = None
        try:
            b = cdp.cmd("Network.getResponseBody", {"requestId": rid}, timeout=8)
            body = b.get("body")
            if b.get("base64Encoded"):
                import base64
                body = base64.b64decode(body).decode("utf-8", "replace")
        except Exception:
            pass
        r["body"] = body
        records.append(r)
    return records


def score_candidate(rec):
    """How likely is this response the health/violations payload?"""
    hay = (rec.get("url", "") + " " + (rec.get("body") or "")[:5000])
    if not HEALTH_MARKERS.search(hay):
        return 0
    score = len(HEALTH_MARKERS.findall(hay))
    # bodies that actually parse as JSON and contain arrays get a boost
    body = rec.get("body") or ""
    try:
        j = json.loads(body)
        score += 2
        if _find_violation_arrays(j):
            score += 5
    except Exception:
        pass
    return score


def discover_endpoints(cdp):
    """Return candidate records sorted best-first (health-looking JSON)."""
    records = collect_network(cdp)
    scored = [(score_candidate(r), r) for r in records]
    scored = [(s, r) for s, r in scored if s > 0]
    scored.sort(key=lambda x: x[0], reverse=True)
    return [r for _, r in scored]


# ── parsing (schema-flexible: we map by fuzzy key names) ─────────────────────
def _walk(obj, path=()):
    """Yield (path, value) for every node in a nested dict/list."""
    yield path, obj
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield from _walk(v, path + (str(k),))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from _walk(v, path + (f"[{i}]",))


def _find_number_by_key(obj, key_re):
    rx = re.compile(key_re, re.I)
    for path, val in _walk(obj):
        if path and rx.search(path[-1]) and isinstance(val, (int, float)):
            return val
        if path and rx.search(path[-1]) and isinstance(val, str):
            mm = re.search(r"-?\d+(\.\d+)?", val)
            if mm:
                try:
                    return float(mm.group()) if "." in mm.group() else int(mm.group())
                except ValueError:
                    pass
    return None


def _find_string_by_key(obj, key_re):
    rx = re.compile(key_re, re.I)
    for path, val in _walk(obj):
        if path and rx.search(path[-1]) and isinstance(val, str) and val.strip():
            return val.strip()
    return None


VIOLATION_ITEM_KEYS = re.compile(r"asin|reason|violation|policy|status", re.I)


def _find_violation_arrays(obj):
    """Find arrays whose elements look like violation rows (dicts with an ASIN
    or a reason/violation-ish field)."""
    hits = []
    for path, val in _walk(obj):
        if isinstance(val, list) and val and all(isinstance(x, dict) for x in val):
            sample = val[0]
            keys = " ".join(sample.keys())
            if VIOLATION_ITEM_KEYS.search(keys) and (
                re.search(r"asin", keys, re.I) or re.search(r"reason|violation", keys, re.I)
            ):
                hits.append((path, val))
    return hits


def _map_violation(row):
    """Map one raw violation dict to our canonical fields by fuzzy key name."""
    def pick(*patterns):
        for p in patterns:
            rx = re.compile(p, re.I)
            for k, v in row.items():
                if rx.search(k) and v not in (None, ""):
                    return v
        return None
    return {
        "reason": pick(r"^reason$", r"violationreason", r"issuetype", r"policytype",
                       r"title", r"reason"),
        "asin": pick(r"^asin$", r"asin"),
        "date": pick(r"reporteddate", r"createddate", r"^date$", r"date", r"timestamp"),
        "atRiskSales": pick(r"atrisksales", r"salesatrisk", r"impactedsales",
                            r"at_risk"),
        "actionTaken": pick(r"actiontaken", r"action_taken", r"^action$",
                            r"remediation", r"action"),
        "ahrImpact": pick(r"ahrimpact", r"healthimpact", r"ahr_impact", r"impact"),
        "status": pick(r"^status$", r"^state$", r"status"),
        "_raw": row,
    }


def parse_payload(payload):
    """Flexible extraction → canonical dict. Works even though we don't hardcode
    Amazon's exact schema: AHR is pulled by fuzzy key, violations by shape."""
    ahr = _find_number_by_key(payload, r"accounthealthrating|health.?rating|ahr")
    ahr_status = _find_string_by_key(
        payload, r"ahrstatus|healthstatus|accounthealthstatus|health.?state"
    )

    arrays = _find_violation_arrays(payload)
    # prefer the largest violation-shaped array
    arrays.sort(key=lambda pv: len(pv[1]), reverse=True)
    violations = []
    if arrays:
        violations = [_map_violation(r) for r in arrays[0][1]]

    by_reason = Counter(
        (v.get("reason") or "UNKNOWN") for v in violations
    )
    return {
        "ahr": ahr,
        "ahrStatus": ahr_status,
        "policyComplianceCount": len(violations),
        "listingPolicyViolations": violations,
        "byReason": dict(by_reason),
    }


# ── endpoint cache ───────────────────────────────────────────────────────────
def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def save_endpoint(channel, rec):
    os.makedirs(STATE_DIR, exist_ok=True)
    st = load_state()
    st[channel] = {
        "url": rec.get("url"),
        "method": rec.get("method", "GET"),
        "postData": rec.get("postData"),
        # persist the csrf header key the page used, so a direct replay can
        # re-scrape a fresh value for it
        "csrfHeader": next((k for k in (rec.get("requestHeaders") or {})
                            if k.lower() == "anti-csrftoken-a2z"), "anti-csrftoken-a2z"),
    }
    with open(STATE_FILE, "w") as f:
        json.dump(st, f, indent=2)


def refetch_in_session(cdp, rec):
    """Replay the discovered request from inside the tab (fresh cookies + a
    fresh CSRF token scraped from the live page). Returns parsed JSON or None."""
    csrf_key = next((k for k in (rec.get("requestHeaders") or {})
                     if k.lower() == "anti-csrftoken-a2z"), None)
    csrf_val = (rec.get("requestHeaders") or {}).get(csrf_key) if csrf_key else None
    url = json.dumps(rec["url"])
    method = json.dumps(rec.get("method", "GET"))
    body = rec.get("postData")
    body_js = json.dumps(body) if body else "undefined"
    csrf_js = json.dumps(csrf_val) if csrf_val else "undefined"
    js = f"""
    (async () => {{
      const headers = {{'accept': 'application/json'}};
      const csrf = {csrf_js};
      if (csrf) headers['anti-csrftoken-a2z'] = csrf;
      const init = {{ method: {method}, credentials: 'include', headers }};
      const b = {body_js};
      if (b !== undefined && {json.dumps(rec.get('method','GET'))} !== 'GET') init.body = b;
      const r = await fetch({url}, init);
      const text = await r.text();
      return JSON.stringify({{ status: r.status, body: text }});
    }})()
    """
    res = cdp.evaluate(js)
    if isinstance(res, dict) and res.get("__eval_error__"):
        return {"status": -1, "error": res["__eval_error__"]}
    try:
        outer = json.loads(res)
    except Exception:
        return {"status": -1, "error": "bad eval result"}
    return outer


# ── top-level API ────────────────────────────────────────────────────────────
def get_account_health(channel="salutem"):
    """MAIN ENTRY. Returns:
      { ahr, ahrStatus, policyComplianceCount, listingPolicyViolations, byReason,
        _meta: {channel, account, endpoint, accountContext, warnings} }
    Raises NotLoggedIn if the Seller Central session is logged out.
    """
    ch = CHANNELS.get(channel)
    if not ch:
        raise ValueError(f"unknown channel {channel!r}; known: {list(CHANNELS)}")

    cdp = open_or_get_tab("sellercentral")
    if cdp is None:
        raise RuntimeError("No CDP Chrome page available (is the tunnel up?)")
    warnings = []
    try:
        ensure_health_page(cdp)  # raises NotLoggedIn if bounced to signin
        ctx = read_account_context(cdp)

        # discover from the traffic we just recorded
        candidates = discover_endpoints(cdp)
        if not candidates:
            raise RuntimeError(
                "Loaded the health page but found no violations-shaped JSON in "
                "its network traffic. Run `discover` to inspect candidates; "
                "Amazon may have changed the endpoint."
            )
        best = candidates[0]
        save_endpoint(channel, best)

        # parse straight from the captured body (freshest, already authorized)
        payload = None
        if best.get("body"):
            try:
                payload = json.loads(best["body"])
            except Exception:
                payload = None
        # if the captured body was partial, replay in-session for a clean copy
        if payload is None:
            outer = refetch_in_session(cdp, best)
            if outer and outer.get("status") == 200:
                try:
                    payload = json.loads(outer["body"])
                except Exception:
                    payload = None
        if payload is None:
            raise RuntimeError("Could not obtain a parseable JSON payload.")

        result = parse_payload(payload)
        result["_meta"] = {
            "channel": channel,
            "account": ch["label"],
            "expectedMerchant": ch["merchantToken"],
            "endpoint": best.get("url"),
            "accountContext": ctx,
            "candidatesFound": len(candidates),
            "warnings": warnings,
        }
        return result
    finally:
        cdp.close()


# ── CLI ──────────────────────────────────────────────────────────────────────
def _cli_check():
    cdp = open_or_get_tab("sellercentral")
    if cdp is None:
        print(json.dumps({"loggedIn": None, "error": "no CDP page / tunnel down"}))
        return
    try:
        cdp.cmd("Page.enable")
        cdp.cmd("Page.navigate", {"url": HEALTH_PAGE})
        cdp.drain(7)
        url = current_url(cdp)
        logged_in = "/ap/signin" not in url and "/ap/mfa" not in url
        print(json.dumps({
            "loggedIn": logged_in,
            "url": url,
            "accountContext": read_account_context(cdp) if logged_in else None,
        }, ensure_ascii=False, indent=2))
    finally:
        cdp.close()


def _cli_discover():
    cdp = open_or_get_tab("sellercentral")
    if cdp is None:
        print("no CDP page / tunnel down"); return
    try:
        try:
            ensure_health_page(cdp)
        except NotLoggedIn as e:
            print(json.dumps({"error": str(e)})); return
        cands = discover_endpoints(cdp)
        print(f"{len(cands)} candidate endpoint(s), best first:\n")
        for i, r in enumerate(cands[:12]):
            body = (r.get("body") or "")
            print(f"[{i}] score-ranked  {r.get('method')}  {r.get('status')}  "
                  f"{r.get('url')[:140]}")
            print(f"     bodyLen={len(body)}  preview={body[:160]!r}\n")
    finally:
        cdp.close()


def _cli_get(channel, as_json, show_raw):
    try:
        res = get_account_health(channel)
    except NotLoggedIn as e:
        print(json.dumps({"error": "NOT_LOGGED_IN", "detail": str(e)}, indent=2))
        sys.exit(2)
    if not show_raw:
        for v in res.get("listingPolicyViolations", []):
            v.pop("_raw", None)
    if as_json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
        return
    m = res["_meta"]
    print(f"Account: {m['account']}  ({channel})")
    print(f"Endpoint: {m['endpoint']}")
    print(f"AHR: {res['ahr']}   status: {res['ahrStatus']}")
    print(f"Policy compliance violations: {res['policyComplianceCount']}")
    if res["byReason"]:
        print("By reason:")
        for reason, n in sorted(res["byReason"].items(), key=lambda x: -x[1]):
            print(f"  {n:>3}  {reason}")
    for v in res["listingPolicyViolations"]:
        print(f"  - {v.get('reason')} | ASIN {v.get('asin')} | {v.get('date')} | "
              f"at-risk {v.get('atRiskSales')} | {v.get('actionTaken')} | "
              f"AHR {v.get('ahrImpact')} | {v.get('status')}")


def main():
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__); return
    cmd = args[0]
    if cmd == "check":
        _cli_check(); return
    if cmd == "discover":
        _cli_discover(); return
    if cmd == "get":
        channel = args[1] if len(args) > 1 and not args[1].startswith("-") else "salutem"
        _cli_get(channel, "--json" in args, "--raw" in args); return
    print(f"unknown command {cmd!r} — try check | discover | get <channel>")


if __name__ == "__main__":
    main()
