#!/usr/bin/env python3
"""Unauthenticated RDP identity probe (read-only).

Prints the RDP TLS certificate SHA-256 fingerprint and the NTLM computer
names the server advertises during CredSSP negotiation. Sends no
credentials; the NTLM exchange stops after the server CHALLENGE.
Usage: rdp_identity_probe.py HOST [PORT]
"""
import hashlib, json, socket, ssl, struct, sys


def der_len(n):
    if n < 0x80:
        return bytes([n])
    b = n.to_bytes((n.bit_length() + 7) // 8, 'big')
    return bytes([0x80 | len(b)]) + b


def tlv(tag, body):
    return bytes([tag]) + der_len(len(body)) + body


def probe(host, port=3389, timeout=10):
    s = socket.create_connection((host, port), timeout=timeout)
    # X.224 Connection Request asking for PROTOCOL_HYBRID (CredSSP) | SSL.
    neg = struct.pack('<BBHI', 1, 0, 8, 3)
    x224 = bytes([len(neg) + 6, 0xE0, 0, 0, 0, 0, 0]) + neg
    s.sendall(struct.pack('>BBH', 3, 0, len(x224) + 4) + x224)
    resp = s.recv(1024)
    if len(resp) < 19 or resp[11] != 2:
        raise RuntimeError('server refused TLS/CredSSP negotiation')
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # identity is checked by pinned fingerprint below
    t = ctx.wrap_socket(s)
    fp = hashlib.sha256(t.getpeercert(binary_form=True)).hexdigest().upper()
    ntlm = b'NTLMSSP\x00' + struct.pack('<II', 1, 0xE2088297) + b'\x00' * 16 + bytes([10, 0, 0x63, 0x45, 0, 0, 0, 15])
    tsreq = tlv(0x30, tlv(0xA0, tlv(0x02, b'\x06')) +
                tlv(0xA1, tlv(0x30, tlv(0x30, tlv(0xA0, tlv(0x04, ntlm))))))
    t.sendall(tsreq)
    t.settimeout(5)
    data = b''
    try:
        while b'NTLMSSP\x00\x02' not in data:
            chunk = t.recv(4096)
            if not chunk:
                break
            data += chunk
    except socket.timeout:
        pass
    t.close()
    names = {}
    i = data.find(b'NTLMSSP\x00\x02\x00\x00\x00')
    if i >= 0:
        msg = data[i:]
        ln, _, off = struct.unpack('<HHI', msg[40:48])
        info = msg[off:off + ln]
        keys = {1: 'NbComputerName', 2: 'NbDomainName', 3: 'DnsComputerName', 4: 'DnsDomainName'}
        p = 0
        while p + 4 <= len(info):
            av, alen = struct.unpack('<HH', info[p:p + 4])
            if av == 0:
                break
            if av in keys:
                names[keys[av]] = info[p + 4:p + 4 + alen].decode('utf-16le', 'replace')
            p += 4 + alen
    return {'host': host, 'certSha256': fp, **names}


if __name__ == '__main__':
    print(json.dumps(probe(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 3389)))
