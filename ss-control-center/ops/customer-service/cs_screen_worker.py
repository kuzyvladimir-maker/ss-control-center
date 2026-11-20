#!/usr/bin/env python3
"""Read-only SS screen collector. No DOM/CDP, buyer text entry, or send controls.
A bounded visible list is supported; overflow/uncertainty fails closed.
"""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
from zoneinfo import ZoneInfo

ROOT = Path('/root/.openclaw/workspace')
SCRIPTS = ROOT / 'scripts'
STATE = ROOT / 'data/customer-hub-screen/worker'
OWNER = 'cs-screen-worker'
URL = 'https://sellercentral.amazon.com/messaging/inbox?fi=responseNeeded'


def run(args, **kw):
    return subprocess.run([str(a) for a in args], capture_output=True, text=True, timeout=kw.pop('timeout',40), check=True, **kw).stdout


def hands(*args):
    return run([SCRIPTS/'ss_hands.sh', *args], env={**os.environ, 'SS_SCREEN_OWNER': OWNER})


def stamp():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def env_file(path):
    return {k.strip(): v.strip().strip('\"\x27') for line in Path(path).read_text().splitlines()
            if '=' in line and not line.lstrip().startswith('#') for k,v in [line.split('=',1)]}


def session_free():
    import winrm
    e=env_file(ROOT/'.secrets/ss_vps.env')
    s=winrm.Session('http://'+e['SS_VPS_TAILSCALE_IP']+':5985/wsman',
                    auth=(e['SS_VPS_USER'],e['SS_VPS_PASS']),transport='ntlm', message_encryption='always', operation_timeout_sec=15,read_timeout_sec=20)
    r=s.run_cmd('quser')
    text=r.std_out.decode(errors='replace')
    if r.status_code or 'USERNAME' not in text or re.search(r'\bActive\b',text,re.I):
        raise ValueError('Windows session active or quser unavailable; no takeover')
    return text


def ocr(path, box, psm=6):
    from PIL import Image
    im=Image.open(path); im=im.crop(box); im=im.resize((im.width*3,im.height*3))
    tmp=path.with_name(path.stem+'-crop.png');im.save(tmp)
    text=run(['tesseract',tmp,'stdout','--psm',str(psm)])
    tmp.unlink()
    return text


def parse_metrics(account, text):
    if 'Salutem Solutions' not in account or 'United States' not in account:
        raise ValueError('Account identity unreadable')
    needed=re.search(r'Response needed\s+(\d+)\b',text)
    unresolved=re.search(r'Reported unresolved\s+(\d+)\b',text)
    if not needed or not unresolved:
        raise ValueError('Independent queue metrics unreadable')
    return int(needed[1]),int(unresolved[1])


def parse_sla(text):
    if re.search(r'\bOver\s+SLA\b',text,re.I): return True
    if re.search(r'\bDue\s*:\s*\d+\s*(?:mins?|minutes?|hrs?|hours?|days?)\b',text,re.I): return False
    return None


def parse_thread(buyer, order, sla, alternate_sla=''):
    name=buyer.split('See all communication')[0].strip()
    name=re.sub(r'[^\w .\-\u0080-\uffff]+$','',name).strip()
    name=re.sub(r'\s+[©®Oo]$','',name).strip()
    orders=re.findall(r'\b\d{3}-\d{7}-\d{7}\b',order)
    if len(set(orders))!=1 or not name or len(name)>80: raise ValueError('Thread identity unreadable')
    readings=[v for v in [parse_sla(sla),parse_sla(alternate_sla)] if v is not None]
    overdue=readings[0] if readings and all(v==readings[0] for v in readings) else None
    return {'order':orders[0],'buyer':name,'deadline':None,'overSla':overdue}


def aggregate_sla(threads, expected):
    if len(threads)!=expected or any(t['overSla'] is None for t in threads): return None
    return sum(t['overSla'] for t in threads)


def collect(folder):
    # Navigation only. A fixed browser address cannot execute a buyer action.
    hands('key','ctrl+l');hands('type',URL);hands('key','Return')
    time.sleep(12)
    hands('click','1020','265');hands('key','ctrl+Home');time.sleep(2)
    shot=folder/'queue.png';hands('shot',shot)
    account=ocr(shot,(190,120,380,160));metric_text=ocr(shot,(15,315,245,405))
    count,unresolved=parse_metrics(account,metric_text)
    # In this pinned 1366x768 layout only 3 complete rows fit. Never publish a partial list.
    if count>3: raise ValueError('Visible queue capacity exceeded; full-list screen reader required')
    threads=[];errors=[];readings=[]
    if count==0:
        empty=ocr(shot,(135,415,1100,720))
        if not re.search(r'(no messages|no conversations|all caught up)',empty,re.I):
            raise ValueError('Zero queue not corroborated by empty-list screen')
    else:
        # Read actual date-line positions from screen OCR, not fixed guesses about row heights.
        from PIL import Image
        im=Image.open(shot).crop((135,450,360,728));im.resize((675,834)).save(folder/'list.png')
        tsv=run(['tesseract',folder/'list.png','stdout','--psm','6','tsv'])
        import csv,io
        rows=list(csv.DictReader(io.StringIO(tsv),delimiter='\t'))
        ys=sorted({450+int(r['top'])//3 for r in rows if re.fullmatch(r'20\d\d',r.get('text',''))})
        if len(ys)!=count: raise ValueError('Visible thread count does not match Response needed')
        for i,y in enumerate(ys):
            hands('click','240',str(y+25));time.sleep(3)
            p=folder/f'thread-{i}.png';hands('shot',p)
            # Header/order panel coordinates remain stable; Amazon text length changes order Y.
            bottom=min(ys[i+1]-2 if i+1<len(ys) else 728,y+100)
            try:
                raw={'row':i,'buyer':ocr(p,(368,420,650,450)),'order':ocr(p,(1110,545,1330,625)),
                     'slaHeader':ocr(p,(1000,450,1100,478)), 'slaList':ocr(p,(140,y+20,355,bottom))}
                readings.append(raw)
                thread=parse_thread(raw['buyer'],raw['order'],raw['slaHeader'],raw['slaList'])
                if any(t['order']==thread['order'] for t in threads): raise ValueError('Duplicate screen thread identity')
                threads.append(thread)
                if thread['overSla'] is None: errors.append({'row':i,'field':'sla','reason':'SLA unreadable or conflicting badges'})
            except (ValueError,subprocess.SubprocessError,OSError) as error:
                errors.append({'row':i,'field':'identity','reason':str(error) if isinstance(error,ValueError) else 'Thread OCR '+type(error).__name__})
    (folder/'thread-readings.json').write_text(json.dumps(readings,ensure_ascii=False,indent=2))
    # Re-read metrics after traversal to reject a queue changing mid-scan.
    hands('key','ctrl+r');time.sleep(10)
    final=folder/'queue-confirm.png';hands('shot',final)
    again=parse_metrics(ocr(final,(190,120,380,160)),ocr(final,(15,315,245,405)))
    if again!=(count,unresolved): raise ValueError('Queue changed during read; retry next cycle')
    payload={'source':'seller_central_screen','method':'screen_read','storeIndex':1,'account':'Salutem Solutions',
             'observedAt':stamp(),'evidenceRef':str(folder),'collector':'cs-screen-worker',
             'metrics':{'unread':None,'responseNeeded':count,'overSla':aggregate_sla(threads,count),'reportedUnresolved':unresolved},'threads':threads,'threadErrors':errors}
    (folder/'snapshot.json').write_text(json.dumps(payload,indent=2));return payload


def post(payload, endpoint="screen-inbox"):
    import requests
    e=env_file(ROOT/'.secrets/cs_scan.env'); token=e.get('JACKIE_API_TOKEN') or e['SSCC_API_TOKEN']
    r=requests.post('https://salutemsolutions.info/api/customer-hub/'+endpoint,headers={'Authorization':'Bearer '+token},json=payload,timeout=60)
    if r.status_code!=200: raise ValueError('Hub snapshot API rejected publication HTTP '+str(r.status_code))
    data=r.json()
    if endpoint=='screen-inbox' and payload.get('state')!='unknown' and (data.get('state')!='fresh' or data.get('lastScanAt')!=payload['observedAt']): raise ValueError('Hub did not confirm current snapshot')
    return data


def notify_once(key,text,seconds=None):
    import fcntl
    ledger=STATE/'notifications.json'
    def read(): return json.loads(ledger.read_text()) if ledger.exists() else {}
    def save(x):
        tmp=ledger.with_suffix('.tmp');tmp.write_text(json.dumps(x));tmp.replace(ledger)
    with (STATE/'notifications.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        old=read();prior=old.get(key)
        if prior and (seconds is None or time.time()-prior['at']<seconds): return
        # Reserve before external send; ambiguous delivery must be inspected, never replayed.
        old[key]={'at':time.time(),'status':'pending'};save(old)
        with (STATE/'notification-attempts.jsonl').open('a') as audit: audit.write(json.dumps({'key':key,'at':stamp(),'state':'pending'})+'\n')
    result=run(['openclaw','message','send','--channel','telegram','--target','-1003924739153','--thread-id','42','--message',text,'--json'],timeout=120)
    receipt=json.loads(result)
    if not receipt.get('messageId'): raise ValueError('Telegram delivery receipt missing; notification remains pending')
    with (STATE/'notifications.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        old=read();old[key]['status']='sent';old[key]['receipt']=receipt;save(old)
        with (STATE/'notification-attempts.jsonl').open('a') as audit: audit.write(json.dumps({'key':key,'at':stamp(),'state':'sent','messageId':receipt['messageId']})+'\n')
    return receipt['messageId']


def notify_failure(reason,folder):
    key='failure:'+hashlib.sha256(reason.encode()).hexdigest()
    try:
        message_id=notify_once(key,'Проверка не выполнилась: '+reason,7200)
        result={'state':'sent' if message_id else 'throttled_or_pending','messageId':message_id,'reason':reason}
    except Exception as error:
        result={'state':'unconfirmed','reason':reason,'error':type(error).__name__}
        print(json.dumps({'notification':result}),flush=True)
    (folder/'notification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))


def arrival_keys(orders, previous):
    """A re-opened thread gets a new episode, while repeat reads do not re-publish."""
    result={k:{**v,'active':k in orders} for k,v in previous.items()}
    keys={}
    for order in orders:
        old=previous.get(order,{})
        episode=old.get('episode',0)+(0 if old.get('active') else 1)
        result[order]={'episode':episode,'active':True}
        keys[order]='arrival:'+order+((':'+str(episode)) if episode>1 else '')
    return keys,result


def mark_published(card_id,message_id):
    import requests
    e=env_file(ROOT/'.secrets/cs_scan.env');token=e.get('JACKIE_API_TOKEN') or e['SSCC_API_TOKEN']
    r=requests.post('https://salutemsolutions.info/api/mcp',headers={'Authorization':'Bearer '+token},json={'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'cs_card_published','arguments':{'card_id':card_id,'telegram_message_id':str(message_id)}}},timeout=60)
    if r.status_code!=200:raise ValueError('Card publication receipt could not be saved')
    x=r.json()
    if x.get('error') or x.get('result',{}).get('isError'):raise ValueError('Card publication receipt rejected')

def main():
    os.umask(0o077);STATE.mkdir(parents=True,exist_ok=True)
    folder=STATE/dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ');folder.mkdir()
    acquired=False; started=False; phase='lease'
    try:
        run(['python3',SCRIPTS/'ss_screen_lease.py','acquire','--owner',OWNER,'--mode','worker','--seconds','900']);acquired=True
        phase='direct preflight'
        preflight=run(['python3',SCRIPTS/'ss_direct_preflight.py']);(folder/'preflight.json').write_text(preflight)
        if subprocess.run(['systemctl','is-active','--quiet','ss-hands-rdp.service']).returncode==0:
            raise ValueError('Existing RDP transport has no cycle ownership; explicit handoff required')
        phase='Windows session ownership'
        (folder/'quser.txt').write_text(session_free())
        phase='RDP startup'
        hands('up');started=True;time.sleep(5)
        phase='screen read'
        payload=collect(folder);phase='snapshot publication';api=post(payload);(folder/'api.json').write_text(json.dumps(api,indent=2))
        phase='owner card publication'
        if payload.get('threadErrors'): notify_failure('screen read: '+ '; '.join(sorted({e['reason'] for e in payload['threadErrors']})),folder)
        episodes=STATE/'episodes.json'
        previous=json.loads(episodes.read_text()) if episodes.exists() else {}
        visible=[t['order'] for t in payload['threads']]
        if any(e['field']=='identity' for e in payload.get('threadErrors',[])): visible+= [k for k,v in previous.items() if v.get('active') and k not in visible]
        keys,updated=arrival_keys(visible,previous)
        tmp=episodes.with_suffix('.tmp');tmp.write_text(json.dumps(updated));tmp.replace(episodes)
        for t in payload['threads']:
            key=keys[t['order']]
            ledger=STATE/'notifications.json'
            known=json.loads(ledger.read_text()) if ledger.exists() else {}
            if key not in known:
                card=post({'requestId':key,'order':t['order'],'buyer':t['buyer'],
                    'observedAt':payload['observedAt'],'evidenceRef':payload['evidenceRef'],
                    'clientText':'Новое обращение в Response needed; текст требует полного чтения.',
                    'facts':[{'what':'Покупатель','value':t['buyer']},{'what':'Over SLA','value':'Не проверено' if t['overSla'] is None else 'Да' if t['overSla'] else 'Нет'}],
                    'decisionRu':'Прочитать полную ветку и подготовить ответ для одобрения.',
                    'missing':['Текст обращения, факты заказа и доставки ещё не разобраны.']},'screen-review')
                (folder/('card-'+t['order']+'.json')).write_text(json.dumps(card,ensure_ascii=False))
                message_id=notify_once(key,card['textRu'])
                if message_id: mark_published(card['cardId'],message_id)
        state='partial' if payload.get('threadErrors') else 'ok'
        (folder/'result.json').write_text(json.dumps({'state':state,'at':stamp(),'observedAt':payload['observedAt']}))
        print(json.dumps({'state':state,'evidence':str(folder),'observedAt':payload['observedAt']}))
    except Exception as error:
        reason=phase+': '+(str(error) if isinstance(error,ValueError) else type(error).__name__)
        failure={'source':'seller_central_screen','storeIndex':1,'state':'unknown','observedAt':stamp(),'reason':reason}
        (folder/'failure.json').write_text(json.dumps(failure))
        try: (folder/'api-failure.json').write_text(json.dumps(post(failure)))
        except Exception: reason+='; failure publication unavailable'
        notify_failure(reason,folder)
        print(json.dumps({'state':'unknown','reason':reason,'evidence':str(folder)}))
        return 1
    finally:
        if acquired:
            if started: hands('down')
            # A failed startup can leave a live transport: preserve lease for explicit recovery.
            active=subprocess.run(['systemctl','is-active','--quiet','ss-hands-rdp.service']).returncode==0
            if not active: run(['python3',SCRIPTS/'ss_screen_lease.py','release','--owner',OWNER])
    return 0
if __name__=='__main__': raise SystemExit(main())
