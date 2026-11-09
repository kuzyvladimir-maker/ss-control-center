#!/usr/bin/env python3
"""Record an already-sent VPS reply without MCP or connector-forge."""
import argparse
import base64
import json
import os
from pathlib import Path
import requests
from cs_inbox_scan import ROOT, env_file

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--order', required=True)
    parser.add_argument('--sent-at', required=True, help='ISO time with timezone')
    parser.add_argument('--screenshot', required=True, type=Path)
    args = parser.parse_args()
    env = {**env_file(ROOT / '.secrets/cs_scan.env'), **os.environ}
    token = env.get('JACKIE_API_TOKEN') or env['SSCC_API_TOKEN']
    response = requests.post('https://salutemsolutions.info/api/customer-hub/manual-close',
        headers={'Authorization': 'Bearer ' + token}, timeout=60,
        json={'storeIndex': 1, 'orderId': args.order, 'sentAt': args.sent_at,
              'screenshot': {'name': args.screenshot.name,
                             'base64': base64.b64encode(args.screenshot.read_bytes()).decode()}})
    response.raise_for_status()
    print(json.dumps(response.json(), ensure_ascii=False))
