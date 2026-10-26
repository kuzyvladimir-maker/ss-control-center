#!/usr/bin/env python3
"""NAN Health (Shopify) label rates — pure server-side HTTP, no browser, no iMac.

Shopify's public Admin API has no rate-listing query, so this replays the
admin's own FetchShippingRates call (captured once; cookies + csrf live in
.secrets/nan_shopify_session.json) with each open order's destination and
weight, and posts the rates to the Command Center (/api/shipping/nan-rates).
Read-only: it never buys a label.

  nan_rates_http.py --all        every open unfulfilled NAN order
  nan_rates_http.py --pending    only orders the owner asked to refresh
  nan_rates_http.py --dry        print, don't post
"""
import copy
import datetime
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

WS = "/root/.openclaw/workspace"
SESSION = f"{WS}/.secrets/nan_shopify_session.json"
APP_ENV = f"{WS}/.secrets/shopify_nanhealth_app.env"
INGEST_ENV = f"{WS}/.secrets/nan_rates_ingest.env"
API_KEYS_ENV = f"{WS}/.secrets/api_keys_migrated.env"
CC = "https://salutemsolutions.info"
ALERT_FLAG = f"{WS}/data/nan_rates_session_expired.flag"
PACKAGE_LB = 0.5  # "Коробка для семейного набора" 12x10x6 in, 0.5 lb


def env(path):
    d = {}
    for line in open(path):
        if "=" in line and not line.startswith("#"):
            k, v = line.strip().split("=", 1)
            d[k] = v.strip().strip('"').strip("'")
    return d


def http_json(url, body=None, headers=None, method=None, timeout=40):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method or ("POST" if data else "GET"))
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.load(r)


# ── Shopify Admin API (official, app credentials): open orders ──
def admin_token(e):
    data = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "client_id": e["NANHEALTH_CLIENT_ID"],
        "client_secret": e["NANHEALTH_CLIENT_SECRET"],
    }).encode()
    with urllib.request.urlopen(urllib.request.Request(
            f"https://{e['NANHEALTH_SHOP']}/admin/oauth/access_token", data=data), timeout=30) as r:
        return json.load(r)["access_token"]


ORDERS_Q = """{orders(first:50, query:"fulfillment_status:unfulfilled status:open"){nodes{
  name legacyResourceId totalWeight
  shippingAddress{address1 address2 company city zip provinceCode countryCodeV2 latitude longitude}
  lineItems(first:30){nodes{id quantity title originalUnitPriceSet{shopMoney{amount}}}}
}}}"""


def open_orders(e):
    tok = admin_token(e)
    _, j = http_json(f"https://{e['NANHEALTH_SHOP']}/admin/api/2026-10/graphql.json", {"query": ORDERS_Q},
                     {"X-Shopify-Access-Token": tok, "Content-Type": "application/json"})
    if j.get("errors"):
        raise SystemExit(f"Admin API error: {json.dumps(j['errors'])[:300]}")
    return j["data"]["orders"]["nodes"]


# ── Shopify admin internal FetchShippingRates (captured request) ──
class SessionExpired(Exception):
    pass


def load_session():
    s = json.load(open(SESSION))
    cookie = "; ".join(f"{c['name']}={c['value']}" for c in s["cookies"] if "shopify.com" in c["domain"])
    headers = dict(s["request"]["headers"])
    headers["cookie"] = cookie
    headers["origin"] = "https://admin.shopify.com"
    return s["request"]["url"], headers, json.loads(s["request"]["body"])


def to_lb(value, unit):
    unit = (unit or "").upper()
    if unit in ("GRAMS", "G"):
        return value / 453.592
    if unit in ("KILOGRAMS", "KG"):
        return value * 2.20462
    if unit in ("OUNCES", "OZ"):
        return value / 16
    return value


def build_body(template, order, override=None):
    b = copy.deepcopy(template)
    sh = b["variables"]["shippingLabels"][0]["shipment"]
    a = order.get("shippingAddress") or {}
    sh["destination"] = {
        "address1": a.get("address1") or "", "address2": a.get("address2") or "",
        "company": a.get("company") or "", "city": a.get("city") or "", "zip": a.get("zip") or "",
        "provinceCode": a.get("provinceCode"), "countryCode": a.get("countryCodeV2"),
        "latitude": a.get("latitude"), "longitude": a.get("longitude"),
    }
    try:
        grams = float(order.get("totalWeight") or 0)  # Admin API returns it as a string
    except (TypeError, ValueError):
        grams = 0
    goods_lb = grams / 453.592 if grams else 0
    sh["package"]["weight"] = round(goods_lb + PACKAGE_LB, 2) if goods_lb else sh["package"]["weight"]
    if override:
        # The box/weight the owner set on the card's Package tile wins.
        sh["package"]["length"] = override["l"]
        sh["package"]["width"] = override["w"]
        sh["package"]["height"] = override["h"]
        sh["package"]["weight"] = override["weight_lb"]
    sh["shippingDate"] = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    tmpl_items = sh.get("customsLineItems") or []
    if (a.get("countryCodeV2") or "US") == "US":
        sh["customsLineItems"] = []
    else:
        base = tmpl_items[0] if tmpl_items else {}
        items = []
        for li in (order.get("lineItems") or {}).get("nodes") or []:
            inv = {}  # no read_products scope: HS code / origin come from the template
            w = {}
            items.append({
                **base,
                "quantity": li["quantity"],
                "description": li["title"][:80],
                "value": float(((li.get("originalUnitPriceSet") or {}).get("shopMoney") or {}).get("amount") or 0),
                "weight": {"value": round(to_lb(w.get("value") or 0, w.get("unit")), 2) or (base.get("weight") or {}).get("value", 0.4), "unit": "POUNDS"},
                "harmonizedSystemCode": inv.get("harmonizedSystemCode") or base.get("harmonizedSystemCode"),
                "countryCodeOfOrigin": inv.get("countryCodeOfOrigin") or base.get("countryCodeOfOrigin"),
                "lineItemId": li["id"],
            })
        sh["customsLineItems"] = items or tmpl_items
    return b


def fetch_rates(url, headers, body):
    try:
        st, j = http_json(url, body, headers)
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise SessionExpired(f"HTTP {e.code}")
        raise
    if j.get("errors"):
        msg = json.dumps(j["errors"])[:300]
        if "auth" in msg.lower() or "login" in msg.lower():
            raise SessionExpired(msg)
        raise RuntimeError(msg)
    groups = (j.get("data") or {}).get("shippingRates") or []
    if not groups:
        return []
    g = groups[0]
    out = []
    for r in g.get("shippingRates") or []:
        amt = ((r.get("charge") or {}).get("total") or {}).get("amount")
        if amt is None:
            continue
        days = r.get("expectedDeliveryDays")
        out.append({
            "carrier": r.get("carrierName") or "",
            "service": r.get("serviceName") or r.get("name") or "",
            "price_usd": float(amt),
            "eta_text": f"{days} дн." if days else "",
            "cheapest": r.get("name") == g.get("lowestCostRateKey"),
            "fastest": r.get("name") == g.get("fastestRateKey"),
        })
    return out


def alert_once(text):
    if os.path.exists(ALERT_FLAG):
        return
    open(ALERT_FLAG, "w").write(datetime.datetime.now().isoformat())
    subprocess.run(["python3", f"{WS}/scripts/cj.py", "send", "ss-control-center", "135", text], timeout=30)


def main():
    dry = "--dry" in sys.argv
    # Same auth the other server scripts use for the Command Center API
    # (JACKIE_API_TOKEN bearer, accepted by the proxy on /api/*). The
    # dedicated x-nan-rates-secret is sent too once it exists in Vercel.
    keys = env(API_KEYS_ENV)
    secret_hdr = {
        "Authorization": f"Bearer {keys.get('JACKIE_API_TOKEN_SSCC') or keys['JACKIE_API_TOKEN']}",
        "Content-Type": "application/json",
    }
    if os.path.exists(INGEST_ENV):
        secret_hdr["x-nan-rates-secret"] = env(INGEST_ENV).get("NAN_RATES_INGEST_SECRET", "")
    only = None
    _, p = http_json(f"{CC}/api/shipping/nan-rates/pending", headers=secret_hdr)
    overrides = p.get("packages") or {}
    if "--pending" in sys.argv:
        only = {x["order_name"].lstrip("#") for x in p.get("pending", [])}
        if not only:
            return
    orders = [o for o in open_orders(env(APP_ENV)) if only is None or o["name"].lstrip("#") in only]
    if not orders:
        return
    url, headers, template = load_session()
    captured = datetime.datetime.now(datetime.timezone.utc).isoformat()
    payload = {"captured_at": captured, "orders": []}
    for o in orders:
        try:
            ov = overrides.get(o["name"].lstrip("#"))
            body = build_body(template, o, ov)
            rates = fetch_rates(url, headers, body)
        except SessionExpired as e:
            alert_once(
                "⚠️ Тарифы NAN: сессия админки Shopify NAN истекла "
                f"({e}). Тарифы на /shipping перестали обновляться — нужен повторный вход в админку NAN "
                "(Джеки: обновить .secrets/nan_shopify_session.json).")
            raise SystemExit("SESSION_EXPIRED")
        a = o.get("shippingAddress") or {}
        payload["orders"].append({
            "order_name": o["name"], "shopify_order_id": o["legacyResourceId"],
            "dest": {"city": a.get("city"), "state": a.get("provinceCode"), "country": a.get("countryCodeV2")},
            "package": {
                "l": body["variables"]["shippingLabels"][0]["shipment"]["package"]["length"],
                "w": body["variables"]["shippingLabels"][0]["shipment"]["package"]["width"],
                "h": body["variables"]["shippingLabels"][0]["shipment"]["package"]["height"],
                "in": True,
                "weight_lb": body["variables"]["shippingLabels"][0]["shipment"]["package"]["weight"],
            },
            "rates": rates,
        })
    if os.path.exists(ALERT_FLAG):
        os.remove(ALERT_FLAG)  # session works again
    if dry:
        print(json.dumps(payload, ensure_ascii=False)[:3000])
        return
    st, res = http_json(f"{CC}/api/shipping/nan-rates", payload, secret_hdr)
    print(datetime.datetime.now().isoformat(), "POST", st, res.get("saved"))


if __name__ == "__main__":
    main()
