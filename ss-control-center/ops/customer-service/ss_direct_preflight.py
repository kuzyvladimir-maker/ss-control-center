#!/usr/bin/env python3
"""Read-only check for the owner-approved OpenClaw -> tailnet -> SS route.

Does not log in, change routing, open RDP, or emit credentials/auth URLs.
SS_VPS_IP remains the administrative WinRM address, never an RDP fallback.
"""
import ipaddress
import json
from pathlib import Path
import subprocess
import sys

EXPECTED_HOST = 'CLOUD-NN0V1SRSP'
EXPECTED_TAILNET = 'tail3cb362.ts.net'


def validate_route(status, address):
    if not address:
        raise ValueError('SS_VPS_TAILSCALE_IP is not bound; authorize the existing SS Tailscale client and verify its peer identity first')
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        raise ValueError('Invalid SS tailnet address') from None
    if ip.version != 4 or ip not in ipaddress.ip_network('100.64.0.0/10'):
        raise ValueError('SS RDP requires a Tailscale IPv4 address; public-IP fallback is forbidden')
    if status.get('BackendState') != 'Running':
        raise ValueError('OpenClaw Tailscale is not Running')
    if (status.get('CurrentTailnet') or {}).get('MagicDNSSuffix') != EXPECTED_TAILNET:
        raise ValueError('OpenClaw is not in the expected tailnet')
    peers = [p for p in (status.get('Peer') or {}).values() if address in (p.get('TailscaleIPs') or [])]
    if len(peers) != 1:
        raise ValueError('SS tailnet peer is missing or ambiguous')
    peer = peers[0]
    if peer.get('HostName', '').casefold() != EXPECTED_HOST.casefold():
        raise ValueError('Tailnet address belongs to a different host')
    if not peer.get('Online'):
        raise ValueError('SS tailnet peer is offline')
    return {'ready': True, 'host': EXPECTED_HOST, 'address': address, 'transportOnly': True}


def read_env(path):
    values = {}
    for line in Path(path).read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def main():
    env = read_env('/root/.openclaw/workspace/.secrets/ss_vps.env')
    address = env.get('SS_VPS_TAILSCALE_IP', '')
    # Missing binding must fail before any transport startup.
    if not address:
        validate_route({}, address)
    result = subprocess.run(['tailscale', 'status', '--json'], capture_output=True, text=True, timeout=15, check=True)
    print(json.dumps(validate_route(json.loads(result.stdout), address)))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError):
        # Do not expose CLI stderr, which can contain a login URL.
        error = sys.exc_info()[1]
        reason = str(error) if isinstance(error, ValueError) else 'Tailscale preflight unavailable'
        print(json.dumps({'ready': False, 'reason': reason}), file=sys.stderr)
        sys.exit(75)
