#!/usr/bin/env python3
"""Publish cs_mail_unanswered.py evidence to the hub. No browser or buyer writes."""
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
import requests

ROOT = Path('/root/.openclaw/workspace')
ACCOUNTS = ['amazon@salutem.solutions', 'amz.commerce@salutem.solutions', 'amazon.retailerdistributor@gmail.com', 'info.siriustrading@gmail.com']

def env_file(path):
    result = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if line.startswith('export '): line = line[7:]
        if '=' in line and not line.startswith('#'):
            key, value = line.split('=', 1)
            result[key] = value.strip().strip('\"\x27')
    return result

def collect(env, run=subprocess.run):
    checked = datetime.now(timezone.utc).isoformat()
    try:
        result = run(['python3', str(ROOT / 'scripts/cs_mail_unanswered.py'), '--json', '--history-only'], env=env, capture_output=True, text=True, timeout=840)
        if result.returncode: raise ValueError('Source process failed')
        data = json.loads(result.stdout)
        if data.get('schemaVersion') != 2 or not isinstance(data.get('threads'), list) or not isinstance(data.get('unanswered'), list) or not isinstance(data.get('errors'), list): raise ValueError('Invalid source payload')
        return {**data, 'checkedAt': checked}
    except (ValueError, subprocess.TimeoutExpired, OSError):
        # Do not print stderr/environment: mail tools can include sensitive diagnostics.
        return {'checkedAt': checked, 'schemaVersion': 2, 'lookbackDays': 30, 'threads': [], 'unanswered': [], 'errors': [{'account': a, 'error': 'Mail source failed, timed out or returned invalid JSON'} for a in ACCOUNTS]}

def main():
    os.umask(0o077)
    env = {**os.environ, **env_file(ROOT / '.secrets/gog_cron.env')}
    credentials = env_file(ROOT / '.secrets/cs_scan.env')
    token = credentials.get('JACKIE_API_TOKEN') or credentials['SSCC_API_TOKEN']
    base = 'https://salutemsolutions.info/api/customer-hub/'
    headers = {'Authorization': 'Bearer '+token, 'Accept-Encoding': 'identity'}
    job_response = requests.get(base+'mail-refresh', headers=headers, timeout=60)
    job_response.raise_for_status()
    job = job_response.json()
    pending = job.get('status') in ('pending', 'running')
    if '--scheduled' in sys.argv and not pending:
        current = requests.get(base+'mail-inbox', headers=headers, timeout=60)
        current.raise_for_status()
        checked = current.json().get('checkedAt')
        if checked and (datetime.now(timezone.utc) - datetime.fromisoformat(checked.replace('Z','+00:00'))).total_seconds() < 29*60:
            print(json.dumps({'state':'not_due'})); return
    def job_status(status, error=None):
        if pending:
            reply=requests.patch(base+'mail-refresh', headers=headers, json={'id':job['id'],'status':status,'error':error},timeout=60)
            reply.raise_for_status()
    job_status('running')
    try:
        data = collect(env)
        response = requests.post(base+'mail-inbox', headers=headers, json=data, timeout=90)
        response.raise_for_status()
        saved = response.json()
        job_status('failed' if data['errors'] else 'completed', 'One or more mailboxes could not be checked' if data['errors'] else None)
    except Exception:
        job_status('failed', 'Mail check or publication failed; previous successful evidence is retained')
        raise
    proof = ROOT / 'data/customer-hub-mail'
    proof.mkdir(parents=True, exist_ok=True)
    (proof / 'last-published.json').write_text(json.dumps(data, ensure_ascii=False, indent=2))
    print(json.dumps({'state': 'partial_or_failed' if data['errors'] else 'ok', 'checkedAt': data['checkedAt'], 'lastSuccessfulCheckAt': saved['lastSuccessfulCheckAt'], 'threads': len(data.get('threads',[])), 'historyOnly': True, 'isCurrentQueue': False, 'errors': len(data['errors'])}))

if __name__ == '__main__': main()
