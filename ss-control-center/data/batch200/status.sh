#!/bin/bash
cd "/Users/vladimirkuznetsov/SS Command Center/ss-control-center"
S=data/batch200/auto-state.json
DONE=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$S','utf8')).done.length)" 2>/dev/null || echo 0)
FAIL=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$S','utf8')).failed.length)" 2>/dev/null || echo 0)
if pgrep -f "_b2_auto" >/dev/null; then ALIVE="работает"; COLOR="#1E6B4A"; else ALIVE="ОСТАНОВЛЕН"; COLOR="#B3261E"; fi
PCT=$(( DONE * 100 / 200 ))
EVENTS=$(tail -14 data/batch200/auto-loop.log 2>/dev/null | sed 's/&/\&amp;/g;s/</\&lt;/g' | tail -r)
cat > "$HOME/Desktop/Листинги-статус.html" << HTML
<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=30>
<title>Листинги — \$DONE из 200</title>
<style>
body{font:16px/1.5 system-ui,-apple-system,sans-serif;margin:0;background:#F6F6F3;color:#17191D}
.w{max-width:760px;margin:0 auto;padding:40px 24px}
h1{font:600 26px/1.2 Georgia,serif;margin:0 0 4px}
.t{color:#6B7168;font-size:13px;margin:0 0 24px}
.big{font-size:64px;font-weight:600;line-height:1;font-variant-numeric:tabular-nums}
.big span{font-size:24px;color:#6B7168;font-weight:400}
.bar{height:14px;background:#E3E4DF;border-radius:7px;overflow:hidden;margin:18px 0 8px}
.bar i{display:block;height:100%;background:#1E6B4A;width:${PCT}%}
.row{display:flex;gap:28px;margin:20px 0 26px;font-size:14px}
.row b{display:block;font-size:22px;font-variant-numeric:tabular-nums}
.st{color:$COLOR;font-weight:600}
pre{background:#fff;border:1px solid #E3E4DF;border-radius:10px;padding:14px;font-size:12px;
    overflow-x:auto;white-space:pre-wrap;color:#3A3F44;margin:0}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#6B7168;margin:26px 0 8px}
@media(prefers-color-scheme:dark){body{background:#15171B;color:#EBEDF0}pre{background:#1D2025;border-color:#2C3138;color:#C9CDD2}.bar{background:#2C3138}}
</style>
<div class=w>
<h1>Создание 200 листингов</h1>
<p class=t>Страница сама обновляется каждые 30 секунд · $(date '+%H:%M:%S')</p>
<div class=big>$DONE <span>из 200</span></div>
<div class=bar><i></i></div>
<div class=row>
  <div>Опубликовано<b>$DONE</b></div>
  <div>Осталось<b>\$(( 200 - DONE ))</b></div>
  <div>Не удалось<b>$FAIL</b></div>
  <div>Конвейер<b class=st>$ALIVE</b></div>
</div>
<h2>Последние события</h2>
<pre>$EVENTS</pre>
</div>
HTML
