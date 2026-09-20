#!/usr/bin/env python3
"""Сверка заявленного в лейбле против фактического замера перевозчика.

Зачем: Amazon списывает shipping adjustment, не раскрывая причину. Единственный
независимый свидетель — сам перевозчик: и FedEx, и UPS отдают в Track API те
вес и габариты, которые прошли через их измеритель. Положив их рядом с тем, что
мы заявили при покупке лейбла, получаем ответ, обоснован штраф или нет.

Классы (по оплачиваемому весу = max(вес, ДхШхВ/139)):
  A — перевозчик намерил не больше нашего  → штраф не на чем основан, спорить
  B — расхождение до 30%                   → спорно
  C — намерил заметно больше               → похоже, занижены наши габариты, чинить SKU
  D — намерил в 2.5+ раза больше           → машинная ошибка замера, спорить

Запуск:  SSCC_TOKEN=... python3 scripts/carrier-measure-audit.py [fedex|ups|all]
Результат: /tmp/carrier_audit.json + сводка в stderr.
"""
import base64, json, os, sys, time, urllib.error, urllib.parse, urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
DIM_DIVISOR = 139.0

def load_env(path):
    out = {}
    try:
        for line in open(path, encoding="utf-8", errors="replace"):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return out

E = load_env(os.path.join(ROOT, ".env"))

def _json(req, timeout=45):
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

# ---------------------------------------------------------------- FedEx
def fedex_token():
    body = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "client_id": E["FEDEX_CLIENT_ID"],
        "client_secret": E["FEDEX_CLIENT_SECRET"],
    }).encode()
    return _json(urllib.request.Request(
        "https://apis.fedex.com/oauth/token", data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"}))["access_token"]

def fedex_batch(token, numbers):
    """FedEx Track API принимает до 30 номеров за вызов."""
    payload = {"includeDetailedScans": False,
               "trackingInfo": [{"trackingNumberInfo": {"trackingNumber": n}} for n in numbers]}
    d = _json(urllib.request.Request(
        "https://apis.fedex.com/track/v1/trackingnumbers",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": "application/json", "X-locale": "en_US"}))
    out = {}
    for c in d.get("output", {}).get("completeTrackResults", []):
        for tr in c.get("trackResults", []):
            if tr.get("error"):
                continue
            pd = tr.get("packageDetails") or {}
            wd = pd.get("weightAndDimensions") or {}
            w = next((x for x in wd.get("weight", []) if x.get("unit") == "LB"), None)
            dim = next((x for x in wd.get("dimensions", []) if x.get("units") == "IN"), None)
            if not (w or dim):
                continue
            out[c.get("trackingNumber")] = {
                "weight": float(w["value"]) if w else None,
                "L": dim.get("length") if dim else None,
                "W": dim.get("width") if dim else None,
                "H": dim.get("height") if dim else None,
                "service": (tr.get("serviceDetail") or {}).get("description"),
            }
            break
    return out

# ------------------------------------------------------------------ UPS
def ups_token():
    auth = base64.b64encode(
        f"{E['UPS_CLIENT_ID']}:{E['UPS_CLIENT_SECRET']}".encode()).decode()
    body = urllib.parse.urlencode({"grant_type": "client_credentials"}).encode()
    return _json(urllib.request.Request(
        "https://onlinetools.ups.com/security/v1/oauth/token", data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded",
                 "Authorization": f"Basic {auth}"}))["access_token"]

def ups_one(token, number):
    """UPS отдаёт по одному номеру за вызов."""
    req = urllib.request.Request(
        f"https://onlinetools.ups.com/api/track/v1/details/{urllib.parse.quote(number)}",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json",
                 "transId": "sscc-audit", "transactionSrc": "sscc"})
    d = _json(req)
    pkg = (((d.get("trackResponse") or {}).get("shipment") or [{}])[0]
           .get("package") or [{}])[0]
    w = pkg.get("weight") or {}
    dim = pkg.get("dimension") or {}
    if not dim and not w:
        return None
    f = lambda v: float(v) if v not in (None, "") else None
    return {"weight": f(w.get("weight")),
            "L": f(dim.get("length")), "W": f(dim.get("width")), "H": f(dim.get("height")),
            "service": (pkg.get("service") or {}).get("description")}

# ----------------------------------------------------------------- SSCC
def sscc_rows():
    token = os.environ.get("SSCC_TOKEN") or E.get("JACKIE_API_TOKEN")
    req = urllib.request.Request(
        "https://salutemsolutions.info/api/adjustments?days=400&limit=2000",
        headers={"Authorization": f"Bearer {token}"})
    return _json(req, timeout=120)["adjustments"]

# ------------------------------------------------------------- классы
def billable(L, W, H, weight):
    dim = (L * W * H) / DIM_DIVISOR if None not in (L, W, H) else 0.0
    return max(weight or 0.0, dim)

def classify(row, measured):
    declared = billable(row.get("declaredDimL"), row.get("declaredDimW"),
                        row.get("declaredDimH"), row.get("declaredWeightLbs"))
    actual = billable(measured.get("L"), measured.get("W"),
                      measured.get("H"), measured.get("weight"))
    if not declared:
        return None, declared, actual
    r = actual / declared
    return ("A" if r <= 1.05 else "B" if r <= 1.3 else "C" if r <= 2.5 else "D",
            declared, actual)

def main():
    which = (sys.argv[1] if len(sys.argv) > 1 else "all").lower()
    rows = [r for r in sscc_rows()
            if r["adjustmentAmount"] < 0 and r.get("trackingNumber")
            and r.get("declaredDimL")
            and r.get("carrier") in (("FEDEX", "UPS") if which == "all" else (which.upper(),))]
    rows.sort(key=lambda r: r["adjustmentDate"], reverse=True)
    print(f"строк к проверке: {len(rows)}", file=sys.stderr)

    measured = {}
    fx = [r["trackingNumber"] for r in rows if r["carrier"] == "FEDEX"]
    if fx:
        tok = fedex_token()
        for i in range(0, len(fx), 30):
            try:
                measured.update(fedex_batch(tok, fx[i:i + 30]))
            except Exception as e:
                print(f"  FedEx пачка {i}: {e}", file=sys.stderr)
            time.sleep(0.4)
        print(f"  FedEx: {sum(1 for n in fx if n in measured)}/{len(fx)}", file=sys.stderr)

    up = [r["trackingNumber"] for r in rows if r["carrier"] == "UPS"]
    if up:
        tok = ups_token()
        for n, num in enumerate(up, 1):
            try:
                m = ups_one(tok, num)
                if m:
                    measured[num] = m
            except Exception:
                pass
            if n % 40 == 0:
                print(f"  UPS {n}/{len(up)}", file=sys.stderr)
            time.sleep(0.25)
        print(f"  UPS: {sum(1 for n in up if n in measured)}/{len(up)}", file=sys.stderr)

    out = []
    for r in rows:
        m = measured.get(r["trackingNumber"])
        cls, db, ab = classify(r, m) if m else (None, None, None)
        out.append({k: r.get(k) for k in
                    ("adjustmentDate", "adjustmentAmount", "carrier", "trackingNumber",
                     "sku", "amazonOrderId", "declaredWeightLbs", "declaredDimL",
                     "declaredDimW", "declaredDimH", "originalLabelCost")}
                   | {"measured": m, "class": cls,
                      "billableDeclared": round(db, 1) if db else None,
                      "billableMeasured": round(ab, 1) if ab else None})
    json.dump(out, open("/tmp/carrier_audit.json", "w"))

    import collections
    cnt, amt = collections.Counter(), collections.defaultdict(float)
    for o in out:
        k = o["class"] or "нет замера"
        cnt[k] += 1
        amt[k] += o["adjustmentAmount"]
    print("\nкласс   шт     сумма", file=sys.stderr)
    for k in sorted(cnt):
        print(f"  {k:12} {cnt[k]:4}  {amt[k]:9.2f}", file=sys.stderr)
    print("→ /tmp/carrier_audit.json", file=sys.stderr)

if __name__ == "__main__":
    main()
