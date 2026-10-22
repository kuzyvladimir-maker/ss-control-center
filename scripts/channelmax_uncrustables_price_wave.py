#!/usr/bin/env python3
"""Apply canonical Uncrustables min/max bounds through the signed-in ChannelMAX tab.

The script is read-only unless --apply, the deterministic confirmation token,
and the matching environment arm are all present.  It captures an exclusive
prewrite rollback artifact, uses compare-and-set checks before every small
wave, preserves repricing-model fields by never sending them, and verifies
every persisted row through ChannelMAX's independent inventoryitemsite read.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import cdp_browser


SITE_ID = 300
SELLER_ID = "A3A7A0RDFUSGBS"
EXPECTED_HOST = "selling.channelmax.net"
EXPECTED_ACCOUNT = "AmznUS [Salutem Solutions]"
EXPECTED_COHORT = 164
TAB_ID = "00530F7E77F996D7C982F5385192E0B0"
ENV_ARM = "BF_UNCRUSTABLES_CHANNELMAX_APPLY"
IDENTITY_HOLDS = {
    "SZ-ASPI-JFAT": "AMAZON_8541_PRODUCT_IDENTITY_BLOCKER",
    "TY-AST2-JE9P": "AMAZON_8541_PRODUCT_IDENTITY_BLOCKER",
    "VN-AS1A-D572": "CHANNELMAX_ASIN_IDENTITY_MISMATCH",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def stable_bytes(value: object) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def write_exclusive_json(path: Path, value: object) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    with path.open("x", encoding="utf-8") as handle:
        handle.write(body)
    digest = sha256_bytes(body.encode("utf-8"))
    with Path(str(path) + ".sha256").open("x", encoding="ascii") as handle:
        handle.write(f"{digest}  {path.name}\n")
    return digest


def number_or_none(value: object) -> float | None:
    if value is None or str(value).strip() == "":
        return None
    number = float(value)
    if not (number == number and abs(number) != float("inf")):
        raise ValueError(f"Non-finite numeric value: {value!r}")
    return round(number, 2)


def same_number(left: object, right: object) -> bool:
    a = number_or_none(left)
    b = number_or_none(right)
    return a == b


def load_targets(path: Path) -> list[dict[str, object]]:
    with path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    if len(rows) != EXPECTED_COHORT:
        raise ValueError(f"Expected {EXPECTED_COHORT} price rows, got {len(rows)}")
    result: list[dict[str, object]] = []
    seen_skus: set[str] = set()
    seen_ordinals: set[int] = set()
    for raw in rows:
        sku = (raw.get("sku") or "").strip()
        asin = (raw.get("asin") or "").strip()
        ordinal = int(raw.get("ordinal") or 0)
        minimum = number_or_none(raw.get("target_minimum"))
        maximum = number_or_none(raw.get("target_maximum"))
        if (
            not sku
            or not asin
            or ordinal < 1
            or ordinal > EXPECTED_COHORT
            or minimum is None
            or maximum is None
            or minimum >= maximum
            or sku in seen_skus
            or ordinal in seen_ordinals
        ):
            raise ValueError(f"Invalid or duplicate canonical row: {raw!r}")
        seen_skus.add(sku)
        seen_ordinals.add(ordinal)
        result.append(
            {
                "ordinal": ordinal,
                "sku": sku,
                "asin": asin,
                "target_minimum": minimum,
                "target_maximum": maximum,
            }
        )
    return sorted(result, key=lambda row: int(row["ordinal"]))


def assert_exact_tab() -> tuple[dict[str, object], cdp_browser.CDP]:
    target = cdp_browser.pick_target(TAB_ID)
    parsed = urlparse(str(target.get("url") or ""))
    if parsed.scheme != "https" or parsed.hostname != EXPECTED_HOST:
        raise RuntimeError(f"Refusing unexpected ChannelMAX tab: {target.get('url')}")
    client = cdp_browser.CDP(str(target["webSocketDebuggerUrl"]))
    return target, client


def read_live(client: cdp_browser.CDP, targets: list[dict[str, object]]) -> dict:
    target_map = {
        str(row["sku"]): {
            "ordinal": row["ordinal"],
            "asin": row["asin"],
            "minimum": row["target_minimum"],
            "maximum": row["target_maximum"],
            "identity_hold": str(row["sku"]) in IDENTITY_HOLDS,
        }
        for row in targets
    }
    expression = r"""(async()=>{
      const targets=__TARGETS__;
      const container=document.querySelector('#inventoryContainer');
      const angularApi=window.angular;
      if(!container||!angularApi) throw new Error('CHANNELMAX_ANGULAR_UNAVAILABLE');
      const scope=angularApi.element(container).scope();
      const channel=(scope.userChannels||[]).find(x=>x&&x.selected);
      if(!channel) throw new Error('SELECTED_CHANNEL_UNAVAILABLE');
      if(String(channel.SiteID)!=='300'||String(channel.SellerID)!=='A3A7A0RDFUSGBS')
        throw new Error('CHANNELMAX_ACCOUNT_BINDING_MISMATCH');
      const WebAPI=angularApi.element(document.body).injector().get('WebAPI');
      const query={
        siteId:channel.SiteID,sellerId:channel.SellerID,viewType:'REPRICING',
        pagination:{page:1,size:600},filter:null,
        filterCode:[
          {mode:'1',code:'ActiveSKUs',siteid:channel.SiteID,value:''},
          {mode:'4',code:'srchTITLE',siteid:channel.SiteID,value:'Uncrustables'}
        ],
        sorting:null,filterRanges:[],filterMultiple:[],filterPriceView:[],filterAttributes:[]
      };
      const listed=(await WebAPI.postMessage('inventorylist',query)).data;
      if(!listed||listed.isValid!==true) throw new Error('INVENTORYLIST_INVALID');
      const launch=(listed.data.rows||[]).filter(row=>targets[row.SKU]);
      if(launch.length!==164) throw new Error('ACTIVE_COHORT_COUNT_'+launch.length);
      const ids=launch.map(row=>row.ItemID);
      const persisted=(await WebAPI.postMessage('inventoryitemsite',{
        iids:ids,sellerId:channel.SellerID
      })).data;
      if(!persisted||persisted.isValid!==true) throw new Error('INVENTORYITEMSITE_INVALID');
      const siteRows=(persisted.data.rows||[]).filter(row=>String(row.SiteID)==='300');
      const byId=new Map(siteRows.map(row=>[Number(row.ItemID),row]));
      if(byId.size!==164) throw new Error('PERSISTED_COHORT_COUNT_'+byId.size);
      const rows=launch.map(row=>{
        const expected=targets[row.SKU];
        const value=byId.get(Number(row.ItemID));
        if(!expected||!value||(!expected.identity_hold&&String(row.ASIN)!==String(expected.asin)))
          throw new Error('SKU_ASIN_BINDING_MISMATCH_'+String(row.SKU));
        return {
          ordinal:expected.ordinal,item_id:Number(row.ItemID),sku:String(row.SKU),
          asin:String(row.ASIN),canonical_asin:String(expected.asin),
          identity_mismatch:String(row.ASIN)!==String(expected.asin),
          repricing_model_id:row.RepricingModelID==null?null:String(row.RepricingModelID),
          repricing_model_name:row.RepricingModelName==null?null:String(row.RepricingModelName),
          current_minimum:value.UnitCost==null?null:Number(value.UnitCost),
          current_maximum:value.BasePrice==null?null:Number(value.BasePrice),
          current_price:value.Price==null?null:Number(value.Price),
          last_updated_by:value.LastUpdatedBy==null?null:String(value.LastUpdatedBy),
          target_minimum:Number(expected.minimum),target_maximum:Number(expected.maximum)
        };
      }).sort((a,b)=>a.ordinal-b.ordinal);
      return {
        captured_at:new Date().toISOString(),selected_site_id:String(channel.SiteID),
        selected_site_name:String(channel.SiteName||''),seller_id:String(channel.SellerID),
        title_total:Number(listed.data.totalItems),rows
      };
    })()""".replace(
        "__TARGETS__", json.dumps(target_map, ensure_ascii=False, separators=(",", ":"))
    )
    value = client.evaluate(expression)
    if not isinstance(value, dict) or not isinstance(value.get("rows"), list):
        raise RuntimeError("ChannelMAX live read returned an invalid document")
    if (
        value.get("selected_site_id") != str(SITE_ID)
        or value.get("selected_site_name") != EXPECTED_ACCOUNT
        or value.get("seller_id") != SELLER_ID
        or len(value["rows"]) != EXPECTED_COHORT
    ):
        raise RuntimeError(f"ChannelMAX binding or cohort mismatch: {value!r}")
    return value


def apply_wave(client: cdp_browser.CDP, rows: list[dict[str, object]]) -> dict:
    expression = r"""(async()=>{
      const rows=__ROWS__;
      const angularApi=window.angular;
      const scope=angularApi.element(document.querySelector('#inventoryContainer')).scope();
      const channel=(scope.userChannels||[]).find(x=>x&&x.selected);
      if(!channel||String(channel.SiteID)!=='300'||String(channel.SellerID)!=='A3A7A0RDFUSGBS')
        throw new Error('CHANNELMAX_ACCOUNT_BINDING_MISMATCH');
      const WebAPI=angularApi.element(document.body).injector().get('WebAPI');
      const before=(await WebAPI.postMessage('inventoryitemsite',{
        iids:rows.map(row=>row.item_id),sellerId:channel.SellerID
      })).data;
      if(!before||before.isValid!==true) throw new Error('CAS_READ_INVALID');
      const current=new Map((before.data.rows||[])
        .filter(row=>String(row.SiteID)==='300')
        .map(row=>[Number(row.ItemID),row]));
      const norm=value=>value==null||String(value).trim()===''?null:Number(value);
      for(const row of rows){
        const found=current.get(Number(row.item_id));
        if(!found||norm(found.UnitCost)!==norm(row.expected_minimum)||
          norm(found.BasePrice)!==norm(row.expected_maximum))
          throw new Error('CAS_MISMATCH_'+row.sku);
      }
      const data=rows.map(row=>({id:Number(row.item_id),data:{
        min:Number(row.target_minimum),max:Number(row.target_maximum),
        minDirty:true,maxDirty:true,minField:'UnitCost',maxField:'BasePrice'
      }}));
      const written=(await WebAPI.postMessage('setitmsitevalues',{
        mode:'inline',data,siteid:300
      })).data;
      if(!written||written.isValid!==true||!Array.isArray(written.data))
        throw new Error('WRITE_RESPONSE_INVALID');
      const byWritten=new Map(written.data.map(row=>[Number(row.itemid),row]));
      for(const row of rows){
        const result=byWritten.get(Number(row.item_id));
        if(!result||result.isValid!==true) throw new Error('WRITE_REJECTED_'+row.sku);
      }
      const after=(await WebAPI.postMessage('inventoryitemsite',{
        iids:rows.map(row=>row.item_id),sellerId:channel.SellerID
      })).data;
      if(!after||after.isValid!==true) throw new Error('READBACK_INVALID');
      const persisted=new Map((after.data.rows||[])
        .filter(row=>String(row.SiteID)==='300')
        .map(row=>[Number(row.ItemID),row]));
      return {confirmed_at:new Date().toISOString(),rows:rows.map(row=>{
        const value=persisted.get(Number(row.item_id));
        if(!value||Number(value.UnitCost)!==Number(row.target_minimum)||
          Number(value.BasePrice)!==Number(row.target_maximum))
          throw new Error('READBACK_MISMATCH_'+row.sku);
        return {item_id:Number(row.item_id),sku:row.sku,asin:row.asin,
          minimum_price:Number(value.UnitCost),maximum_price:Number(value.BasePrice),
          price:value.Price==null?null:Number(value.Price),
          last_updated_by:value.LastUpdatedBy==null?null:String(value.LastUpdatedBy),
          write:'SUCCESS'};
      })};
    })()""".replace(
        "__ROWS__", json.dumps(rows, ensure_ascii=False, separators=(",", ":"))
    )
    value = client.evaluate(expression)
    if not isinstance(value, dict) or len(value.get("rows") or []) != len(rows):
        raise RuntimeError(f"Invalid ChannelMAX wave result: {value!r}")
    return value


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--matrix",
        default=(
            "ss-control-center/data/audits/"
            "uncrustables-price-action-matrix-20260719-v1/"
            "uncrustables-price-action-matrix-20260719-v1.csv"
        ),
    )
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm")
    parser.add_argument("--wave-size", type=int, default=12)
    parser.add_argument("--output-dir")
    return parser.parse_args()


def main() -> int:
    options = parse_args()
    if options.wave_size < 1 or options.wave_size > 25:
        raise ValueError("--wave-size must be between 1 and 25")
    matrix_path = Path(options.matrix).resolve()
    targets = load_targets(matrix_path)
    matrix_sha256 = sha256_file(matrix_path)
    policy = {
        "site_id": SITE_ID,
        "seller_id": SELLER_ID,
        "matrix_sha256": matrix_sha256,
        "identity_holds": IDENTITY_HOLDS,
        "targets": targets,
    }
    policy_sha256 = sha256_bytes(stable_bytes(policy))
    token = f"APPLY-CHANNELMAX-UC-{policy_sha256[:16].upper()}"
    target, client = assert_exact_tab()
    try:
        live = read_live(client, targets)
        live_by_sku = {str(row["sku"]): row for row in live["rows"]}
        mismatches = [
            row
            for row in live["rows"]
            if not same_number(row["current_minimum"], row["target_minimum"])
            or not same_number(row["current_maximum"], row["target_maximum"])
        ]
        held = [row for row in mismatches if str(row["sku"]) in IDENTITY_HOLDS]
        candidates = [row for row in mismatches if str(row["sku"]) not in IDENTITY_HOLDS]
        summary = {
            "mode": "APPLY" if options.apply else "DRY_RUN_NO_EXTERNAL_WRITES",
            "captured_at": live["captured_at"],
            "matrix": str(matrix_path),
            "matrix_sha256": matrix_sha256,
            "policy_sha256": policy_sha256,
            "confirmation_token": token,
            "cohort_rows": len(live["rows"]),
            "already_canonical_rows": EXPECTED_COHORT - len(mismatches),
            "mismatch_rows": len(mismatches),
            "identity_hold_rows": len(held),
            "candidate_rows": len(candidates),
            "identity_holds": [
                {"sku": row["sku"], "asin": row["asin"], "reason": IDENTITY_HOLDS[str(row["sku"])]}
                for row in held
            ],
        }
        if not options.apply:
            print(json.dumps(summary, ensure_ascii=False, sort_keys=True, indent=2))
            return 0
        if options.confirm != token or os.environ.get(ENV_ARM) != token:
            raise RuntimeError(
                f"Apply refused. Pass --confirm={token} and set {ENV_ARM} to the same value."
            )
        run_stamp = utc_now().replace("-", "").replace(":", "").replace(".", "")
        output_dir = (
            Path(options.output_dir).resolve()
            if options.output_dir
            else Path("ss-control-center/data/repairs/rollback").resolve()
            / f"channelmax-canonical-164-{run_stamp}-{policy_sha256[:12]}"
        )
        prewrite = {
            "schema_version": "channelmax-uncrustables-canonical-prewrite/v1",
            "captured_at": live["captured_at"],
            "mutation_status": "READY_FOR_APPLY",
            "account": {
                "host": EXPECTED_HOST,
                "tab_id": target.get("id"),
                "site_id": SITE_ID,
                "site_name": EXPECTED_ACCOUNT,
                "seller_id": SELLER_ID,
            },
            "source": {
                "matrix": str(matrix_path),
                "matrix_sha256": matrix_sha256,
                "policy_sha256": policy_sha256,
            },
            "summary": summary,
            "rollback_rows": candidates,
            "identity_holds": summary["identity_holds"],
            "guardrails": {
                "compare_and_set_before_every_wave": True,
                "independent_readback_after_every_wave": True,
                "repricing_model_payload_fields": 0,
                "amazon_mutations": 0,
            },
        }
        prewrite_path = output_dir / "prewrite.json"
        prewrite_sha256 = write_exclusive_json(prewrite_path, prewrite)
        waves: list[dict[str, object]] = []
        completed: list[dict[str, object]] = []
        for start in range(0, len(candidates), options.wave_size):
            selected = candidates[start : start + options.wave_size]
            payload = [
                {
                    "item_id": row["item_id"],
                    "sku": row["sku"],
                    "asin": row["asin"],
                    "expected_minimum": row["current_minimum"],
                    "expected_maximum": row["current_maximum"],
                    "target_minimum": row["target_minimum"],
                    "target_maximum": row["target_maximum"],
                }
                for row in selected
            ]
            result = apply_wave(client, payload)
            waves.append(
                {
                    "wave": len(waves) + 1,
                    "confirmed_at": result["confirmed_at"],
                    "rows": result["rows"],
                }
            )
            completed.extend(result["rows"])
        final_live = read_live(client, targets)
        final_by_sku = {str(row["sku"]): row for row in final_live["rows"]}
        failures = []
        for original in candidates:
            current = final_by_sku[str(original["sku"])]
            if not same_number(current["current_minimum"], original["target_minimum"]) or not same_number(
                current["current_maximum"], original["target_maximum"]
            ):
                failures.append(current)
        model_changes = []
        for sku, before in live_by_sku.items():
            after = final_by_sku[sku]
            if before["repricing_model_id"] != after["repricing_model_id"] or before[
                "repricing_model_name"
            ] != after["repricing_model_name"]:
                model_changes.append({"sku": sku, "before": before, "after": after})
        if failures or model_changes or len(completed) != len(candidates):
            raise RuntimeError(
                f"Final verification failed: failures={len(failures)} model_changes={len(model_changes)} completed={len(completed)}"
            )
        postwrite = {
            "schema_version": "channelmax-uncrustables-canonical-postwrite/v1",
            "confirmed_at": final_live["captured_at"],
            "prewrite": {
                "path": str(prewrite_path),
                "sha256": prewrite_sha256,
            },
            "source": prewrite["source"],
            "summary": {
                "cohort_rows": EXPECTED_COHORT,
                "updated_rows": len(completed),
                "already_canonical_before": summary["already_canonical_rows"],
                "identity_hold_rows": len(held),
                "final_candidate_mismatches": len(failures),
                "repricing_model_changes": len(model_changes),
                "wave_count": len(waves),
                "amazon_mutations": 0,
                "result": "PASS",
            },
            "waves": waves,
            "identity_holds": summary["identity_holds"],
        }
        postwrite_path = output_dir / "postwrite.json"
        postwrite_sha256 = write_exclusive_json(postwrite_path, postwrite)
        print(
            json.dumps(
                {
                    "mode": "APPLY_CONFIRMED",
                    "result": "PASS",
                    "updated_rows": len(completed),
                    "identity_hold_rows": len(held),
                    "wave_count": len(waves),
                    "prewrite": str(prewrite_path),
                    "prewrite_sha256": prewrite_sha256,
                    "postwrite": str(postwrite_path),
                    "postwrite_sha256": postwrite_sha256,
                    "amazon_mutations": 0,
                },
                ensure_ascii=False,
                sort_keys=True,
                indent=2,
            )
        )
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"result": "FAILED", "error": str(error)}, ensure_ascii=False))
        raise
