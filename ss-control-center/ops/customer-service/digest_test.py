import unittest
from datetime import datetime, timezone
from digest import render

class DigestTest(unittest.TestCase):
    def test_screen_membership_wins_over_legacy_card_state(self):
        now = datetime(2026, 11, 9, 13, tzinfo=timezone.utc)
        rows = [{'storeIndex': 1, 'order': name, 'cardStatus': status} for name, status in
                [('Dee', 'SENT'), ('Scott', 'SUPERSEDED'), ('Russell', 'CLOSED')]]
        data = {'source':'seller_central_screen','state':'fresh','lastScanAt': now.isoformat(), 'stale': False, 'threads': rows}
        self.assertIn('Dee', render(data, now))
        data['threads'].append({'storeIndex': 1, 'order': 'new', 'cardStatus': 'PUBLISHED'})
        self.assertIn('new', render(data, now))
        self.assertIn('Scott', render(data, now))

    def test_stale_fail_closed(self):
        now = datetime(2026, 11, 9, 13, tzinfo=timezone.utc)
        for at, stale in [('2026-11-09T10:59:59Z', False), ('2026-11-09T13:00:00Z', True), (None, False)]:
            result = render({'source':'seller_central_screen','state':'fresh','lastScanAt': at, 'stale': stale, 'threads': [{'order':'secret'}]}, now)
            self.assertNotIn('secret', result)
            self.assertIn('не удалось проверить', result)

    def test_mail_never_enters_queue(self):
        result=render({'source':'amazon_mail','state':'fresh','stale':False,'threads':[{'order':'mail-only'}]})
        self.assertIn('Не проверено',result);self.assertNotIn('mail-only',result)

if __name__ == '__main__':
    unittest.main()
