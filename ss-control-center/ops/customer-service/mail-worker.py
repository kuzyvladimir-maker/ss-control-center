#!/usr/bin/env python3
"""Publish cs_mail_unanswered.py evidence to the hub. No browser or buyer writes."""
import json
import os
import subprocess
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
        result = run(['python3', str(ROOT / 'scripts/cs_mail_unanswered.py'), '--json'], env=env, capture_output=True, text=True, timeout=840)
        if result.returncode: raise ValueError('Source process failed')
        data = json.loads(result.stdout)
        if not isinstance(data.get('unanswered'), list) or not isinstance(data.get('errors'), list): raise ValueError('Invalid source payload')
        return {**data, 'checkedAt': checked}
    except (ValueError, subprocess.TimeoutExpired, OSError):
        # Do not print stderr/environment: mail tools can include sensitive diagnostics.
        return {'checkedAt': checked, 'unanswered': [], 'errors': [{'account': a, 'error': 'Mail source failed, timed out or returned invalid JSON'} for a in ACCOUNTS]}

def main():
    os.umask(0o077)
    env = {**os.environ, **env_file(ROOT / '.secrets/gog_cron.env')}
    credentials = env_file(ROOT / '.secrets/cs_scan.env')
    token = credentials.get('JACKIE_API_TOKEN') or credentials['SSCC_API_TOKEN']
    data = collect(env)
    response = requests.post('https://salutemsolutions.info/api/customer-hub/mail-inbox', headers={'Authorization': 'Bearer '+token}, json=data, timeout=90)
    response.raise_for_status()
    saved = response.json()
    proof = ROOT / 'data/customer-hub-mail'
    proof.mkdir(parents=True, exist_ok=True)
    (proof / 'last-published.json').write_text(json.dumps(data, ensure_ascii=False, indent=2))
    print(json.dumps({'state': 'partial_or_failed' if data['errors'] else 'ok', 'checkedAt': data['checkedAt'], 'lastSuccessfulCheckAt': saved['lastSuccessfulCheckAt'], 'unanswered': len(data['unanswered']), 'errors': len(data['errors'])}))

if __name__ == '__main__': main()
