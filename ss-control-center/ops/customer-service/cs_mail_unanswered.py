#!/usr/bin/env python3
"""Read-only Amazon mail history plus unanswered view. No browser or mail writes."""
import argparse
import base64
import hashlib
import html
import json
import os
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path('/root/.openclaw/workspace')
ACCOUNTS = ['amazon@salutem.solutions', 'amz.commerce@salutem.solutions', 'amazon.retailerdistributor@gmail.com', 'info.siriustrading@gmail.com']
ORDER = re.compile(r'\b\d{3}-\d{7}-\d{7}\b')

def decode_body(payload):
    candidates = []
    def walk(p):
        data = p.get('body', {}).get('data')
        if data and p.get('mimeType') in ('text/plain', 'text/html'):
            text = base64.urlsafe_b64decode(data + '===').decode('utf-8', errors='replace')
            if p['mimeType'] == 'text/html':
                text = re.sub(r'<(style|script)\b[^>]*>.*?</\1>', '', text, flags=re.S | re.I)
                text = re.sub(r'<(?:br\b[^>]*|/p|/div|/tr)>', '\n', text, flags=re.I)
                text = html.unescape(re.sub(r'<[^>]+>', ' ', text))
            candidates.append((p['mimeType'], text))
        for part in p.get('parts', []): walk(part)
    walk(payload)
    return next((text for mime, text in candidates if mime == 'text/plain'), candidates[0][1] if candidates else '')

def parse_message(message, thread):
    payload = message.get('payload', {})
    headers = {h['name'].lower(): h['value'] for h in payload.get('headers', [])}
    subject, sender = headers.get('subject', ''), headers.get('from', '')
    recipient = re.match(r'Your e-mail to(?:\s+(.*))?$', subject, re.I)
    if '@marketplace.amazon.com' in sender.lower():
        role = 'buyer'
        buyer = re.sub(r'\s*<.*', '', sender).strip().strip('"')
    elif recipient and re.search(r'@(?:[\w.-]+\.)?amazon\.com\b', sender, re.I):
        role, buyer = 'seller', (recipient.group(1) or 'Unknown buyer').strip()
    else:
        return None
    full = decode_body(payload)
    orders = set(ORDER.findall(subject + '\n' + full))
    order = next(iter(orders)) if len(orders) == 1 else None
    match = re.search(r'-{3,}\s*(?:Begin\s+)?Message\s*:?\s*-{3,}(.*?)-{3,}\s*End message', full, re.S | re.I)
    text = match.group(1).strip() if match else full.strip()
    # Keep message text, never email headers, tracking pixels or opaque footer tokens.
    if not match:
        text = re.split(r'Was this email helpful\?|Copyright \d{4} Amazon|For Your Information:', text, flags=re.I)[0].strip()
    text = re.sub(r'[ \t]+', ' ', text)
    at = datetime.fromtimestamp(int(message['internalDate']) / 1000, timezone.utc).isoformat()
    return {'id': message['id'], 'thread': thread, 'date': at, 'sender': role, 'buyer': buyer,
            'subject': subject, 'order': order, 'text': text[:20000], 'truncated': len(text) > 20000,
            'bodyAvailable': bool(text)}

def build_threads(account, messages, ignored, active_since=None):
    groups = {}
    seen = set()
    for m in messages:
        if m['id'] in seen: continue
        seen.add(m['id'])
        # Exact order association only. A same-name customer on a different order cannot close a case.
        key = m['order'] or 'thread:' + m['thread']
        groups.setdefault(key, []).append(m)
    rows = []
    for key, conversation in groups.items():
        conversation.sort(key=lambda m: (m['date'], m['sender'] == 'buyer', m['id']))
        buyers = [m for m in conversation if m['sender'] == 'buyer']
        buyer = buyers[-1] if buyers else conversation[-1]
        last = conversation[-1]
        ignored_latest = bool(buyers and buyer['thread'] in ignored)
        status = 'sent' if last['sender'] == 'seller' else 'resolved' if ignored_latest else 'needs_review' if active_since and last['date'] < active_since else 'awaiting_reply'
        rows.append({'account': account, 'buyer': buyer['buyer'], 'thread': buyer['thread'],
                     'threadIds': sorted(set(m['thread'] for m in conversation)), 'subject': buyer['subject'],
                     'order': buyer['order'], 'date': last['date'][:16].replace('T', ' '),
                     'lastMessageAt': last['date'], 'lastSender': last['sender'], 'status': status,
                     'statusReason': 'seller_reply_in_mail' if status == 'sent' else 'ignore_list' if ignored_latest else 'no_reply_found_in_older_mail' if status == 'needs_review' else 'buyer_last',
                     'messages': conversation})
    return sorted(rows, key=lambda row: row['lastMessageAt'], reverse=True)

def gog(account, *args):
    run = subprocess.run(['gog', 'gmail', *args, '--json', '--no-input'],
                         env={**os.environ, 'GOG_ACCOUNT': account}, capture_output=True, text=True, timeout=120)
    if run.returncode: raise RuntimeError('gog mail read failed (check account credentials/environment)')
    return json.loads(run.stdout)

def collect_account(account, days):
    summaries = gog(account, 'search', f'(from:marketplace.amazon.com OR (subject:"Your e-mail to" from:amazon.com)) newer_than:{days}d', '--all', '--timezone', 'UTC')
    if not isinstance(summaries.get('threads'), list) or summaries.get('nextPageToken'):
        raise RuntimeError('Incomplete mail search pagination')
    cache = ROOT / 'data/customer-hub-mail/thread-cache'
    cache.mkdir(parents=True, exist_ok=True)
    def read(summary):
        # Search date/messageCount invalidates cache when Gmail thread gains a message.
        key = hashlib.sha256(json.dumps(['parser-v3', account, summary['id'], summary.get('date'), summary.get('messageCount')]).encode()).hexdigest()
        path = cache / (key + '.json')
        if path.exists(): return json.loads(path.read_text())
        raw = gog(account, 'thread', 'get', summary['id'])
        messages = raw.get('thread', {}).get('messages')
        if not isinstance(messages, list) or not messages: raise RuntimeError('Incomplete mail thread')
        parsed = [p for m in messages if (p := parse_message(m, summary['id']))]
        # Cache parsed text only, not raw email headers or access-bearing footer links.
        path.write_text(json.dumps(parsed, ensure_ascii=False))
        return parsed
    with ThreadPoolExecutor(max_workers=4) as pool:
        return [m for thread in pool.map(read, summaries['threads']) for m in thread]

def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--days', type=int, default=30)
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()
    if not 1 <= args.days <= 30: parser.error('days must be 1..30')
    ignore = ROOT / 'memory/cs_mail_ignore.txt'
    ignored = {line.split()[0] for line in ignore.read_text().splitlines() if line.strip() and not line.lstrip().startswith('#')} if ignore.exists() else set()
    rows, errors = [], []
    active_since = (datetime.now(timezone.utc) - timedelta(days=min(7, args.days))).isoformat()
    for account in ACCOUNTS:
        try: rows.extend(build_threads(account, collect_account(account, args.days), ignored, active_since))
        except Exception as exc: errors.append({'account': account, 'error': str(exc)[:200]})
    rows.sort(key=lambda row: row['lastMessageAt'], reverse=True)
    result = {'schemaVersion': 2, 'lookbackDays': args.days, 'timezone': 'UTC', 'activeWindowDays': min(7, args.days), 'threads': rows,
              'unanswered': [r for r in rows if r['status'] == 'awaiting_reply'], 'errors': errors}
    print(json.dumps(result, ensure_ascii=False, indent=1) if args.json else '\n'.join(f"{r['date']} | {r['buyer']} | {r['order']} | {r['status']}" for r in rows))
if __name__ == '__main__': main()
