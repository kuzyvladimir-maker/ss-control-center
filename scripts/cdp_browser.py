#!/usr/bin/env python3
"""Minimal CDP bridge to Vladimir's live Chrome (remote debugging on :9222).

Rebuilt locally (the original lived on Jackie's box). Drives the REAL logged-in
Chrome via the DevTools Protocol so we can read pages / run fetch() from inside
his authenticated sessions (BJ's, Publix, Walmart, Amazon, ...).

Usage:
  python3 scripts/cdp_browser.py ping
  python3 scripts/cdp_browser.py tabs
  python3 scripts/cdp_browser.py new_tab "https://URL"
  python3 scripts/cdp_browser.py navigate "https://URL"     [--tab SUBSTR]
  python3 scripts/cdp_browser.py wait 4
  python3 scripts/cdp_browser.py get_text                    [--tab SUBSTR]
  python3 scripts/cdp_browser.py evaluate "JS expression"    [--tab SUBSTR]
  python3 scripts/cdp_browser.py screenshot                  [--tab SUBSTR]
  python3 scripts/cdp_browser.py fill "#sel" "text"          [--tab SUBSTR]
  python3 scripts/cdp_browser.py click_sel "#sel"            [--tab SUBSTR]
  python3 scripts/cdp_browser.py click 640 400              [--tab SUBSTR]
  python3 scripts/cdp_browser.py key Enter                   [--tab SUBSTR]
  python3 scripts/cdp_browser.py scroll down 500             [--tab SUBSTR]

--tab SUBSTR selects the tab whose url/title contains SUBSTR (else the first page).
"""
import base64
import json
import sys
import time
import urllib.request

import websocket  # websocket-client

PORT = int(__import__("os").environ.get("CDP_PORT", "9222"))
BASE = f"http://localhost:{PORT}"


def _http(path, method="GET"):
    req = urllib.request.Request(BASE + path, method=method)
    with urllib.request.urlopen(req, timeout=8) as r:
        return r.read().decode("utf-8", "replace")


def list_pages():
    data = json.loads(_http("/json"))
    return [t for t in data if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]


def pick_target(substr=None):
    pages = list_pages()
    if not pages:
        return None
    if substr:
        s = substr.lower()
        for t in pages:
            if s in (t.get("url", "") + " " + t.get("title", "")).lower():
                return t
    return pages[0]


class CDP:
    def __init__(self, ws_url):
        # Chrome 111+ rejects the WS handshake on an un-allowlisted Origin header
        # (403). Omitting Origin entirely (suppress_origin) sidesteps that without
        # needing to relaunch Chrome with --remote-allow-origins.
        self.ws = websocket.create_connection(ws_url, timeout=60, suppress_origin=True)
        self._id = 0

    def cmd(self, method, params=None):
        self._id += 1
        mid = self._id
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(msg["error"].get("message", str(msg["error"])))
                return msg.get("result", {})

    def evaluate(self, expr, await_promise=True):
        r = self.cmd("Runtime.evaluate", {
            "expression": expr, "returnByValue": True,
            "awaitPromise": await_promise, "userGesture": True,
        })
        if r.get("exceptionDetails"):
            return {"error": r["exceptionDetails"].get("text", "eval error")}
        return r.get("result", {}).get("value")

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


def out(x):
    print(x if isinstance(x, str) else json.dumps(x, ensure_ascii=False))


def main():
    args = sys.argv[1:]
    if not args:
        out("usage: see header"); return
    # optional --tab SUBSTR
    tab_sub = None
    if "--tab" in args:
        i = args.index("--tab"); tab_sub = args[i + 1]; del args[i:i + 2]
    cmd = args[0]

    if cmd == "ping":
        try:
            ver = json.loads(_http("/json/version"))
            pages = list_pages()
            out({"ok": True, "source": "Vladimir's Chrome", "port": PORT,
                 "browser": ver.get("Browser"), "pages": len(pages)})
        except Exception as e:
            out({"ok": False, "error": str(e), "port": PORT})
        return

    if cmd == "tabs":
        for t in list_pages():
            out(f"- {(t.get('title') or '')[:50]} | {(t.get('url') or '')[:80]}")
        return

    if cmd == "wait":
        time.sleep(float(args[1]) if len(args) > 1 else 3); out("ok"); return

    if cmd == "new_tab":
        url = args[1]
        try:
            _http(f"/json/new?{urllib.parse.quote(url, safe='')}", method="PUT")
        except Exception:
            # fallback: browser-level Target.createTarget
            ver = json.loads(_http("/json/version"))
            c = CDP(ver["webSocketDebuggerUrl"])
            c.cmd("Target.createTarget", {"url": url}); c.close()
        out({"ok": True, "opened": url}); return

    t = pick_target(tab_sub)
    if not t:
        out({"ok": False, "error": "No tabs found — open one with new_tab"}); return
    c = CDP(t["webSocketDebuggerUrl"])
    try:
        if cmd == "navigate":
            c.cmd("Page.enable"); c.cmd("Page.navigate", {"url": args[1]}); out({"ok": True, "navigated": args[1]})
        elif cmd == "get_text":
            out(c.evaluate("document.body ? document.body.innerText : ''"))
        elif cmd == "evaluate":
            out(c.evaluate(args[1]))
        elif cmd == "screenshot":
            r = c.cmd("Page.captureScreenshot", {"format": "png"})
            path = "/tmp/jackie_screenshot.png"
            open(path, "wb").write(base64.b64decode(r["data"]))
            out({"ok": True, "path": path})
        elif cmd == "fill":
            sel, txt = args[1], args[2]
            js = ("(()=>{const e=document.querySelector(%s);if(!e)return'no element';"
                  "e.focus();e.value=%s;e.dispatchEvent(new Event('input',{bubbles:true}));"
                  "e.dispatchEvent(new Event('change',{bubbles:true}));return'ok';})()"
                  % (json.dumps(sel), json.dumps(txt)))
            out(c.evaluate(js))
        elif cmd == "click_sel":
            js = ("(()=>{const e=document.querySelector(%s);if(!e)return'no element';"
                  "e.click();return'ok';})()" % json.dumps(args[1]))
            out(c.evaluate(js))
        elif cmd == "click":
            x, y = float(args[1]), float(args[2])
            for typ in ("mousePressed", "mouseReleased"):
                c.cmd("Input.dispatchMouseEvent", {"type": typ, "x": x, "y": y, "button": "left", "clickCount": 1})
            out({"ok": True, "clicked": [x, y]})
        elif cmd == "key":
            k = args[1]
            keymap = {"Enter": {"key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13},
                      "Tab": {"key": "Tab", "code": "Tab", "windowsVirtualKeyCode": 9},
                      "Escape": {"key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27}}
            p = keymap.get(k, {"key": k, "code": k})
            c.cmd("Input.dispatchKeyEvent", {"type": "keyDown", **p})
            c.cmd("Input.dispatchKeyEvent", {"type": "keyUp", **p})
            out({"ok": True, "key": k})
        elif cmd == "scroll":
            direction = args[1] if len(args) > 1 else "down"
            amt = int(args[2]) if len(args) > 2 else 500
            dy = amt if direction == "down" else -amt
            out(c.evaluate(f"window.scrollBy(0,{dy});'ok'"))
        else:
            out({"ok": False, "error": f"unknown command {cmd}"})
    finally:
        c.close()


if __name__ == "__main__":
    import urllib.parse  # noqa (used in new_tab)
    main()
