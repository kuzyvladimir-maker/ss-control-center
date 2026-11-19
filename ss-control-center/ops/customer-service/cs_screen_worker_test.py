import unittest
from cs_screen_worker import parse_metrics,parse_thread
class ScreenReadTest(unittest.TestCase):
 def test_metrics_not_summed(self):
  self.assertEqual(parse_metrics('Salutem Solutions | United States','Cases requiring attention 3 Response needed 2 Reported unresolved 1'),(2,1))
 def test_unknown_not_zero(self):
  for a,t in [('Salutem Solutions | United States','Response needed'),('Other shop','Response needed 0 Reported unresolved 0')]:
   with self.assertRaises(ValueError):parse_metrics(a,t)
 def test_full_identity_and_sla(self):
  t=parse_thread('Mary © See all communication with this buyer','Order ID 113-2368331-6725010','© Due: 44 mins')
  self.assertEqual(t['buyer'],'Mary');self.assertFalse(t['overSla'])
  self.assertTrue(parse_thread('Mary © See all communication','Order ID 113-2368331-6725010','Over SLA')['overSla'])
  for order,sla in [('113-2368331-67...','Due: 4 mins'),('113-2368331-6725010','Open')]:
   with self.assertRaises(ValueError):parse_thread('Mary',order,sla)
if __name__=='__main__':unittest.main()
