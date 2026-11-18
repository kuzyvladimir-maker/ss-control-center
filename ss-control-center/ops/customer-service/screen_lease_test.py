import os, pathlib, subprocess, tempfile, unittest, json
SCRIPT=str(pathlib.Path(__file__).with_name('ss_screen_lease.py'))
class LeaseTest(unittest.TestCase):
 def test_exclusive_owner_mode_and_handoff(self):
  with tempfile.TemporaryDirectory() as d:
   env={**os.environ,'SS_SCREEN_LEASE_DIR':d}
   def run(*a):return subprocess.run(['python3',SCRIPT,*a],env=env,capture_output=True)
   self.assertEqual(run('check','--owner','a').returncode,75)
   self.assertEqual(run('acquire','--owner','a','--mode','native').returncode,0)
   self.assertEqual(run('acquire','--owner','b','--mode','worker').returncode,75)
   self.assertEqual(run('check','--owner','a','--mode','worker').returncode,75)
   self.assertEqual(run('release','--owner','b').returncode,75)
   p=pathlib.Path(d)/'owner.json';x=json.loads(p.read_text());x['expiresAt']=0;p.write_text(json.dumps(x))
   self.assertEqual(run('check','--owner','a').returncode,75)
   self.assertEqual(run('acquire','--owner','b','--mode','worker').returncode,75)
   self.assertEqual(run('release','--owner','a').returncode,0)
   self.assertEqual(run('acquire','--owner','b','--mode','worker').returncode,0)
if __name__=='__main__':unittest.main()
