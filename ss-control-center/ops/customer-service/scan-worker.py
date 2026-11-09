#!/usr/bin/env python3
"""Read-only store-1 VPS scan worker. No buyer SEND capability is called."""
import json, os, sys, time
from pathlib import Path
import requests
import winrm

ROOT = Path('/root/.openclaw/workspace')
def env_file(path):
    out = {}
    for line in Path(path).read_text().splitlines():
        if '=' in line and not line.startswith('#'):
            key, value = line.split('=', 1)
            out[key] = value.strip().strip('\"\x27')
    return out

def main():
    env = {**env_file(ROOT / '.secrets/cs_scan.env'), **os.environ}
    vps = env_file(ROOT / '.secrets/ss_vps.env')
    token = env.get('JACKIE_API_TOKEN') or env['SSCC_API_TOKEN']
    def mcp(name, args):
        r = requests.post('https://salutemsolutions.info/api/mcp', headers={'Authorization': 'Bearer '+token, 'Content-Type':'application/json', 'Accept':'application/json, text/event-stream'}, json={'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':name,'arguments':args}}, timeout=240)
        r.raise_for_status()
        data = r.json()
        if data.get('error'): raise RuntimeError(str(data['error']))
        result=data['result']
        if result.get('isError'): raise RuntimeError(str(result['content']))
        return result.get('structuredContent') or json.loads(result['content'][0]['text'])
    tasks = mcp('cs_tasks_list', {'store_index':1, 'kind':'INBOX_SCAN'})
    if not tasks:
        mcp('cs_inbox_status', {'reconcile':True})
        tasks = mcp('cs_tasks_list', {'store_index':1, 'kind':'INBOX_SCAN'})
    if not tasks:
        print(json.dumps({'state':'not_due'})); return
    task=tasks[0]
    if task['status']=='QUEUED': mcp('cs_task_claim', {'task_id':task['id'],'vps':'salutem-vps-cs-scan'})
    elif task.get('claimedBy')!='salutem-vps-cs-scan': raise RuntimeError('Scan claimed by another executor')
    session=winrm.Session('http://'+vps['SS_VPS_IP']+':5985/wsman',auth=(vps['SS_VPS_USER'],vps['SS_VPS_PASS']),transport='ntlm')
    ps="""
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
# Recover a stopped scanner task; never restart the Telegram listener or Chrome.
if ((Get-ScheduledTask -TaskName SalutemCsScanBridge).State -ne 'Running') {
  Start-ScheduledTask -TaskName SalutemCsScanBridge
  Start-Sleep -Seconds 2
}
$expr=[IO.File]::ReadAllText('C:\\ProgramData\\SalutemCsScan\\scan.js')
$b=@{id=20;method='Runtime.evaluate';params=@{expression=$expr;returnByValue=$true;awaitPromise=$true}} | ConvertTo-Json -Compress -Depth 10
(Invoke-WebRequest -UseBasicParsing -Method POST -ContentType application/json -Body $b http://127.0.0.1:9230/ -TimeoutSec 125).Content
"""
    try:
        r=session.run_ps(ps)
        if r.status_code: raise RuntimeError('VPS scan transport failed: '+r.std_err.decode(errors='replace')[:500])
        wire=json.loads(r.std_out.decode('utf-8-sig').strip())
        if wire.get('error') or wire.get('result',{}).get('exceptionDetails'): raise RuntimeError('Browser scan failed: '+str(wire)[:800])
        snapshot=json.loads(wire['result']['result']['value'])
        if snapshot.get('complete') is not True or snapshot.get('storeIndex')!=1: raise RuntimeError('Incomplete snapshot')
        proof=ROOT/'data/customer-hub-scans'; proof.mkdir(parents=True,exist_ok=True)
        (proof/(task['id']+'.json')).write_text(json.dumps(snapshot,ensure_ascii=False,indent=2))
    except Exception as exc:
        mcp('cs_task_complete', {'task_id':task['id'],'outcome':'FAILED','error':str(exc)[:800]})
        raise
    # Outside the exception handler: an uncertain completion is never overwritten as FAILED.
    mcp('cs_task_complete', {'task_id':task['id'],'outcome':'DONE','result':snapshot})
    # Explicitly reconcile even if the MCP after() callback did not finish.
    mcp('cs_inbox_status', {'reconcile':True})
    print(json.dumps({'state':'DONE','taskId':task['id'],'scannedAt':snapshot['scannedAt'],'responseNeeded':len(snapshot['items']),'resolved':len(snapshot['resolved'])}))
if __name__=='__main__': main()
