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

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rdp_identity_probe  # noqa: E402

# Two different names describe the same machine (verified 2026-11-19 with
# rdp_identity_probe.py on both the tailnet and the public address):
#   * Tailscale device name / MagicDNS: salutem-vps (stable node ID below)
#   * Windows computer name (NTLM/RDP):  CLOUD-NN0V1SRSP
# Both are required; the RDP cert is pinned to the same fingerprint xfreerdp uses.
EXPECTED_HOST = 'CLOUD-NN0V1SRSP'
EXPECTED_TAILNET = 'tail3cb362.ts.net'
EXPECTED_TS_DNSNAME = 'salutem-vps.tail3cb362.ts.net.'
EXPECTED_TS_NODE_ID = 'nEmuiKoDzu11CNTRL'
EXPECTED_RDP_CERT_SHA256 = 'FFEDD80E08EE13D0AB30AF4A969E4B768F1163853532D3B47B027E59D6A6C1BF'


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
    if (peer.get('DNSName', '').casefold() != EXPECTED_TS_DNSNAME.casefold()
            or peer.get('ID') != EXPECTED_TS_NODE_ID):
        raise ValueError('Tailnet address belongs to a different host')
    if not peer.get('Online'):
        raise ValueError('SS tailnet peer is offline')
    return {'ready': True, 'host': EXPECTED_HOST, 'tailnetName': EXPECTED_TS_DNSNAME.rstrip('.'), 'address': address, 'transportOnly': True}


def validate_windows_identity(address):
    try:
        ident = rdp_identity_probe.probe(address, 3389, timeout=10)
    except Exception:
        raise ValueError('SS RDP identity probe failed over tailnet') from None
    if ident.get('certSha256') != EXPECTED_RDP_CERT_SHA256:
        raise ValueError('SS RDP certificate does not match the pinned fingerprint')
    if (ident.get('DnsComputerName') or ident.get('NbComputerName') or '').casefold() != EXPECTED_HOST.casefold():
        raise ValueError('SS RDP computer name does not match ' + EXPECTED_HOST)


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
    route = validate_route(json.loads(result.stdout), address)
    validate_windows_identity(address)
    route['windowsIdentityVerified'] = True
    print(json.dumps(route))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError):
        # Do not expose CLI stderr, which can contain a login URL.
        error = sys.exc_info()[1]
        reason = str(error) if isinstance(error, ValueError) else 'Tailscale preflight unavailable'
        print(json.dumps({'ready': False, 'reason': reason}), file=sys.stderr)
        sys.exit(75)
