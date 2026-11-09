import unittest
from datetime import datetime, timezone
from digest import render

class DigestTest(unittest.TestCase):
    def test_answered_never_appears(self):
        now = datetime(2026, 11, 9, 13, tzinfo=timezone.utc)
        rows = [{'storeIndex': 1, 'order': name, 'cardStatus': status} for name, status in
                [('Dee', 'SENT'), ('Scott', 'SUPERSEDED'), ('Russell', 'CLOSED')]]
        data = {'lastScanAt': now.isoformat(), 'stale': False, 'threads': rows}
        self.assertEqual(render(data, now), 'NO_REPLY')
        data['threads'].append({'storeIndex': 1, 'order': 'new', 'cardStatus': 'PUBLISHED'})
        self.assertIn('new', render(data, now))
        self.assertNotIn('Scott', render(data, now))

    def test_stale_fail_closed(self):
        now = datetime(2026, 11, 9, 13, tzinfo=timezone.utc)
        for at, stale in [('2026-11-09T10:59:59Z', False), ('2026-11-09T13:00:00Z', True), (None, False)]:
            result = render({'lastScanAt': at, 'stale': stale, 'threads': [{'order':'secret'}]}, now)
            self.assertNotIn('secret', result)
            self.assertIn('не удалось проверить', result)

if __name__ == '__main__':
    unittest.main()
