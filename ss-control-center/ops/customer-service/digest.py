#!/usr/bin/env python3
"""Only fresh, actionable inbox rows may enter the owner digest."""
import os
from datetime import datetime, timezone

def render(data, now=None):
    now = now or datetime.now(timezone.utc)
    if data.get('source') != 'seller_central_screen' or data.get('state') != 'fresh':
        return 'Не проверено: нет свежего экранного снимка Seller Central. Почта не является очередью.'
    try:
        observed = datetime.fromisoformat(data['lastScanAt'].replace('Z', '+00:00'))
        age = (now - observed).total_seconds()
    except (KeyError, ValueError, TypeError, AttributeError):
        return 'Инбокс Customer Service не удалось проверить; список ожидающих решений не сформирован.'
    if data.get('stale') is not False or not 0 <= age < 3600:
        return 'Инбокс Customer Service не удалось проверить; список ожидающих решений не сформирован.'
    rows = [r for r in data.get('threads', []) if r.get('storeIndex') == 1 and
            not r.get('stale')]
    if not rows:
        return 'NO_REPLY'
    lines = ['Response needed — подтверждено экраном Seller Central']
    for row in rows:
        lines.append(f"{row.get('buyer') or 'Покупатель'} — {row['order']} — срок: {row.get('deadline') or 'не установлен'} — {row.get('telegramLink') or 'карточка ещё не опубликована'}")
    lines.append('Ответь «отправляй» / «не так» / «доработать + комментарий» под нужной карточкой.')
    return '\n'.join(lines)

def main():
    import requests
    from cs_mail_publish import ROOT, env_file
    env = {**env_file(ROOT / '.secrets/cs_scan.env'), **os.environ}
    token = env.get('JACKIE_API_TOKEN') or env['SSCC_API_TOKEN']
    try:
        response = requests.get('https://salutemsolutions.info/api/customer-hub/open-threads',
            headers={'Authorization': 'Bearer ' + token}, timeout=60)
        response.raise_for_status()
        print(render(response.json()))
    except (requests.RequestException, ValueError):
        print('Инбокс Customer Service не удалось проверить; список ожидающих решений не сформирован.')

if __name__ == '__main__':
    main()
