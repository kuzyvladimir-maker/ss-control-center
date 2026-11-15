import base64
import importlib.util
from pathlib import Path
import unittest
s=importlib.util.spec_from_file_location('source',Path(__file__).with_name('cs_mail_unanswered.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
ORDER='112-0621311-3138660'
def msg(role='buyer',order=ORDER,date='2026-11-14T14:00:00+00:00',thread='abcd0011',id='one'):
    return dict(id=id,thread=thread,date=date,sender=role,buyer='Buyer',subject='Question',order=order,text='Message text')
class HistoryTest(unittest.TestCase):
    def test_exact_order_association_not_buyer_name(self):
        rows=m.build_threads('account',[msg(),msg('seller',order='111-1111111-1111111',id='two')],set())
        self.assertEqual(len(rows),2);self.assertEqual(next(r for r in rows if r['order']==ORDER)['status'],'awaiting_reply')
    def test_reply_and_followup_preserve_history(self):
        messages=[msg(),msg('seller',date='2026-11-14T15:00:00+00:00',thread='abcd0022',id='two')]
        row=m.build_threads('account',messages,set())[0]
        self.assertEqual(row['status'],'sent');self.assertEqual(len(row['messages']),2)
        messages.append(msg(date='2026-11-14T16:00:00+00:00',thread='abcd0033',id='three'))
        self.assertEqual(m.build_threads('account',messages,{'abcd0011'})[0]['status'],'awaiting_reply')
        self.assertEqual(m.build_threads('account',messages,{'abcd0033'})[0]['status'],'resolved')
    def test_old_missing_reply_is_review_not_new_queue(self):
        row=m.build_threads('account',[msg()],set(),'2026-11-15T00:00:00+00:00')[0]
        self.assertEqual(row['status'],'needs_review');self.assertEqual(row['lastSender'],'buyer')
    def test_html_reply_and_plain_buyer_order_and_body(self):
        for mime,body in [('text/html',f'<style>hide me</style>Order ID: {ORDER}<br>--- Begin message ---<p>Hello buyer</p>--- End message --- tracking-token'),('text/plain',f'# {ORDER}\n--- Message: ---\nActual customer words\n--- End message ---')]:
            payload={'mimeType':mime,'body':{'data':base64.urlsafe_b64encode(body.encode()).decode()},'headers':[{'name':'From','value':'Amazon <donotreply@amazon.com>' if mime=='text/html' else 'Buyer <abc@marketplace.amazon.com>'},{'name':'Subject','value':'Your e-mail to Buyer' if mime=='text/html' else 'Question'}]}
            parsed=m.parse_message({'id':'one','internalDate':'1794668859000','payload':payload},'abcd0011')
            self.assertEqual(parsed['order'],ORDER);self.assertNotIn('hide me',parsed['text']);self.assertNotIn('tracking-token',parsed['text']);self.assertNotIn('End message',parsed['text'])
    def test_missing_order_never_joins_different_threads_by_name(self):
        rows=m.build_threads('a',[msg(order=None),msg('seller',order=None,thread='abcd0022',id='two')],set())
        self.assertEqual(len(rows),2)
if __name__=='__main__':unittest.main()
