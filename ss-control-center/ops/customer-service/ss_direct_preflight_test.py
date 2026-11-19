import unittest
from ss_direct_preflight import validate_route

class DirectRouteTest(unittest.TestCase):
    def status(self, **peer):
        return {'BackendState': 'Running', 'CurrentTailnet': {'MagicDNSSuffix': 'tail3cb362.ts.net'},
                'Peer': {'ss': {'HostName': 'CLOUD-NN0V1SRSP', 'DNSName': 'salutem-vps.tail3cb362.ts.net.', 'ID': 'nEmuiKoDzu11CNTRL', 'TailscaleIPs': ['100.100.1.2'], 'Online': True, **peer}}}

    def test_no_public_fallback_or_missing_binding(self):
        for address in ['', '209.208.63.54', '192.168.1.2', 'localhost']:
            with self.subTest(address=address), self.assertRaises(ValueError):
                validate_route(self.status(), address)

    def test_account_peer_and_availability_required(self):
        cases = [self.status(Online=False), self.status(DNSName='another-account'), self.status(ID='wrong-node'), self.status(TailscaleIPs=[]),
                 {**self.status(), 'BackendState': 'NeedsLogin'},
                 {**self.status(), 'CurrentTailnet': {'MagicDNSSuffix': 'other.ts.net'}}]
        for status in cases:
            with self.subTest(status=status), self.assertRaises(ValueError):
                validate_route(status, '100.100.1.2')

    def test_verified_peer_only_establishes_transport_not_queue(self):
        self.assertEqual(validate_route(self.status(), '100.100.1.2'),
                         {'ready': True, 'host': 'CLOUD-NN0V1SRSP', 'tailnetName':'salutem-vps.tail3cb362.ts.net', 'address': '100.100.1.2', 'transportOnly': True})

if __name__ == '__main__': unittest.main()
