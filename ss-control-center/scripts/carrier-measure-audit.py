#!/usr/bin/env python3
"""Сверка: что мы заявили в лейбле против того, что перевозчик реально намерил.

Берёт строки ShippingAdjustment из SSCC, тянет по трек-номеру фактический замер
из Track API перевозчика и кладёт рядом. Нужно, чтобы отличить "мы занизили
габариты" от "перевозчик намерил чушь" — второе оспаривается.
"""
import json, os, sys, time, urllib.request, urllib.parse

ENV = os.path.join(os.path.dirname(__file__), "..", ".env")
def load_env(path):
    out = {}
    for line in open(path, encoding="utf-8", errors="replace"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line: continue
        k, v = line.split("=", 1)
        if k.strip().isupper() or k.strip().replace("_","").isalnum():
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out
E = load_env(ENV)

def post(url, data, headers, timeout=40):
    body = data if isinstance(data, bytes) else json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

def fedex_token():
    body = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "client_id": E["FEDEX_CLIENT_ID"],
        "client_secret": E["FEDEX_CLIENT_SECRET"],
    }).encode()
    d = post("https://apis.fedex.com/oauth/token", body,
             {"Content-Type": "application/x-www-form-urlencoded"})
    return d["access_token"]

def fedex_batch(token, numbers):
    """FedEx Track API берёт до 30 номеров за вызов."""
    payload = {"includeDetailedScans": False,
               "trackingInfo": [{"trackingNumberInfo": {"trackingNumber": n}} for n in numbers]}
    d = post("https://apis.fedex.com/track/v1/trackingnumbers", payload,
             {"Authorization": f"Bearer {token}", "Content-Type": "application/json",
              "X-locale": "en_US"})
    out = {}
    for c in d.get("output", {}).get("completeTrackResults", []):
        num = c.get("trackingNumber")
        for tr in c.get("trackResults", []):
            if tr.get("error"): continue
            pd = tr.get("packageDetails", {}) or {}
            wd = pd.get("weightAndDimensions", {}) or {}
            w = next((x for x in wd.get("weight", []) if x.get("unit") == "LB"), None)
            dim = next((x for x in wd.get("dimensions", []) if x.get("units") == "IN"), None)
            out[num] = {
                "weight": float(w["value"]) if w else None,
                "L": dim.get("length") if dim else None,
                "W": dim.get("width") if dim else None,
                "H": dim.get("height") if dim else None,
                "packaging": (pd.get("packagingDescription") or {}).get("type"),
                "service": (tr.get("serviceDetail") or {}).get("description"),
                "status": (tr.get("latestStatusDetail") or {}).get("description"),
            }
            break
    return out

def sscc_rows():
    token = E.get("JACKIE_API_TOKEN") or os.environ.get("SSCC_TOKEN")
    url = "https://salutemsolutions.info/api/adjustments?days=400&limit=2000"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read().decode())["adjustments"]

def main():
    rows = [r for r in sscc_rows()
            if r["adjustmentAmount"] < 0 and r.get("trackingNumber")
            and r.get("declaredDimL") and r.get("carrier") == "FEDEX"]
    rows.sort(key=lambda r: r["adjustmentDate"], reverse=True)
    print(f"строк к проверке: {len(rows)}", file=sys.stderr)
    tok = fedex_token()
    measured = {}
    nums = [r["trackingNumber"] for r in rows]
    for i in range(0, len(nums), 30):
        chunk = nums[i:i+30]
        try:
            measured.update(fedex_batch(tok, chunk))
        except Exception as e:
            print(f"  пачка {i}: {e}", file=sys.stderr)
        print(f"  {min(i+30,len(nums))}/{len(nums)} готово", file=sys.stderr)
        time.sleep(0.4)
    out = []
    for r in rows:
        m = measured.get(r["trackingNumber"])
        out.append({**{k: r.get(k) for k in
                       ("adjustmentDate","adjustmentAmount","trackingNumber","sku","amazonOrderId",
                        "declaredWeightLbs","declaredDimL","declaredDimW","declaredDimH",
                        "originalLabelCost")},
                    "measured": m})
    json.dump(out, open("/tmp/fedex_audit.json","w"))
    got = sum(1 for o in out if o["measured"])
    print(f"замеры получены: {got}/{len(out)} → /tmp/fedex_audit.json", file=sys.stderr)

if __name__ == "__main__":
    main()
