#!/usr/bin/env python3
"""Exclusive Salutem screen ownership. No browser access, credentials or sends."""
import argparse, contextlib, fcntl, json, os, pathlib, re, time
ROOT = pathlib.Path(os.environ.get('SS_SCREEN_LEASE_DIR', '/run/ss-screen'))
@contextlib.contextmanager
def locked():
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (ROOT/'lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield

def read():
    try: return json.loads((ROOT/'owner.json').read_text())
    except FileNotFoundError: return None

def save(value):
    tmp=ROOT/'owner.tmp'; tmp.write_text(json.dumps(value)); tmp.replace(ROOT/'owner.json')

def guard(owner, mode=None):
    x=read()
    if not x or x['owner']!=owner or x['expiresAt']<=time.time() or (mode and x['mode']!=mode):
        raise ValueError('SS screen lease required; no automatic takeover. Inspect ss_screen_lease.py status.')
    return x

def main():
    p=argparse.ArgumentParser();p.add_argument('action',choices=['acquire','release','check','status']);p.add_argument('--owner',default=os.environ.get('SS_SCREEN_OWNER',''));p.add_argument('--mode',choices=['native','worker']);p.add_argument('--seconds',type=int,default=14400);a=p.parse_args()
    with locked():
        if a.action=='status': print(json.dumps(read()));return
        if not re.fullmatch(r'[a-zA-Z0-9_.:-]{1,100}',a.owner):raise ValueError('Explicit owner ID required')
        if a.action=='acquire':
            x=read()
            if x and x['owner']!=a.owner:raise ValueError('Screen already owned by '+x['owner']+'; handoff required even after expiry')
            if a.mode is None or not 60<=a.seconds<=14400:raise ValueError('Mode and 60..14400 second lease required')
            if x and x['mode']!=a.mode:raise ValueError('Release before changing session mode')
            x={'owner':a.owner,'mode':a.mode,'acquiredAt':x['acquiredAt'] if x else time.time(),'expiresAt':time.time()+a.seconds};save(x);print(json.dumps(x))
        elif a.action=='check': guard(a.owner,a.mode)
        else:
            x=read()
            if not x or x['owner']!=a.owner:raise ValueError('Only the current owner may release')
            (ROOT/'owner.json').unlink();print('released')
if __name__=='__main__':
    try: main()
    except (ValueError,OSError) as e: print(str(e),file=__import__('sys').stderr);raise SystemExit(75)
