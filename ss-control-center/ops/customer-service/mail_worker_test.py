import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
spec=importlib.util.spec_from_file_location('mail_worker', Path(__file__).with_name('mail-worker.py'))
worker=importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
class MailWorkerTest(unittest.TestCase):
    def test_actual_contract(self):
        def run(command, **kwargs):
            self.assertEqual(command[-2:], ['cs_mail_unanswered.py','--json'] if command[-2]=='cs_mail_unanswered.py' else [str(worker.ROOT/'scripts/cs_mail_unanswered.py'),'--json'])
            return SimpleNamespace(returncode=0,stdout='{"unanswered":[],"errors":[]}')
        result=worker.collect({},run)
        self.assertEqual(result['errors'],[])
        self.assertIn('checkedAt',result)
    def test_failures_are_not_empty_successes(self):
        for stdout,code in [('bad json',0),('{"unanswered":[]}',0),('',1)]:
            result=worker.collect({},lambda *a,**k:SimpleNamespace(returncode=code,stdout=stdout))
            self.assertEqual(len(result['errors']),len(worker.ACCOUNTS))
            self.assertEqual(result['unanswered'],[])
if __name__=='__main__': unittest.main()
