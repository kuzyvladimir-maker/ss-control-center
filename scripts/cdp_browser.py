#!/usr/bin/env python3
"""Small, structured CDP CLI for Vladimir's local Chrome on port 9222.

The original low-level commands remain available.  The higher-level commands
below are intended for local workers that need deterministic evidence and
fail-closed handling around UI waits, file inputs, downloads, and screenshots.

Usage:
  python3 scripts/cdp_browser.py ping
  python3 scripts/cdp_browser.py tabs
  python3 scripts/cdp_browser.py new_tab "https://URL" --expected-host HOST
  python3 scripts/cdp_browser.py navigate "https://URL" --tab UNIQUE_MATCH --expected-host HOST
  python3 scripts/cdp_browser.py wait 4
  python3 scripts/cdp_browser.py wait_for "#selector" --tab UNIQUE_MATCH [--state visible] [--timeout 30] [--poll 0.25]
  python3 scripts/cdp_browser.py get_text --tab UNIQUE_MATCH
  python3 scripts/cdp_browser.py evaluate "JS expression" --tab UNIQUE_MATCH --expected-host HOST
  python3 scripts/cdp_browser.py screenshot --tab UNIQUE_MATCH [--output-dir /ABS/DIR]
  python3 scripts/cdp_browser.py upload_file "input[type=file]" /ABS/FILE --allowed-root /ABS/DIR --expected-sha256 HEX --tab UNIQUE_MATCH --expected-host HOST
  python3 scripts/cdp_browser.py capture_download /ABS/DIR --tab UNIQUE_MATCH --expected-host HOST [--click-selector "#export"] [--timeout 120]
  python3 scripts/cdp_browser.py fill "#sel" "text" --tab UNIQUE_MATCH --expected-host HOST
  python3 scripts/cdp_browser.py click_sel "#sel" --tab UNIQUE_MATCH --expected-host HOST
  python3 scripts/cdp_browser.py click 640 400 --tab UNIQUE_MATCH --expected-host HOST
  python3 scripts/cdp_browser.py key Enter --tab UNIQUE_MATCH --expected-host HOST
  python3 scripts/cdp_browser.py scroll down 500 --tab UNIQUE_MATCH --expected-host HOST

Every command that operates on an existing page requires ``--tab``.  Its
case-insensitive URL/title/id match must identify exactly one page.  Commands
that can mutate a page (plus arbitrary ``evaluate``) also require an exact
``--expected-host`` and refuse non-HTTPS or different current pages.

Every invocation prints exactly one JSON object.  Failures also return a
non-zero process status, with a stable ``error.code`` suitable for a worker.
"""

import base64
import hashlib
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

import websocket  # websocket-client


PORT = int(os.environ.get("CDP_PORT", "9222"))
BASE = f"http://localhost:{PORT}"
WAIT_STATES = {"attached", "visible", "hidden", "detached", "enabled"}
SAFE_DOWNLOAD_GUID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
SHA256_HEX = re.compile(r"[a-fA-F0-9]{64}\Z")
TAB_COMMANDS = {
    "navigate",
    "get_text",
    "evaluate",
    "wait_for",
    "screenshot",
    "upload_file",
    "capture_download",
    "fill",
    "click_sel",
    "click",
    "key",
    "scroll",
}
HOST_GUARDED_COMMANDS = {
    "navigate",
    "evaluate",
    "upload_file",
    "capture_download",
    "fill",
    "click_sel",
    "click",
    "key",
    "scroll",
}


class CliError(Exception):
    """Expected, structured CLI failure."""

    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


def _http(path, method="GET"):
    req = urllib.request.Request(BASE + path, method=method)
    with urllib.request.urlopen(req, timeout=8) as response:
        return response.read().decode("utf-8", "replace")


def list_pages():
    data = json.loads(_http("/json"))
    return [
        target
        for target in data
        if target.get("type") == "page" and target.get("webSocketDebuggerUrl")
    ]


def pick_target(selector):
    """Resolve a tab selector only when it identifies exactly one page."""

    if not isinstance(selector, str) or not selector.strip():
        raise CliError("TAB_REQUIRED", "--tab requires a non-empty unique match")
    pages = list_pages()
    lowered = selector.casefold()
    matches = []
    for target in pages:
        fields = (
            str(target.get("id") or ""),
            str(target.get("url") or ""),
            str(target.get("title") or ""),
        )
        if any(lowered in field.casefold() for field in fields):
            matches.append(target)
    if not matches:
        raise CliError(
            "TAB_NOT_FOUND",
            "--tab did not match any page",
            {"tab": selector, "page_count": len(pages)},
        )
    if len(matches) != 1:
        raise CliError(
            "TAB_AMBIGUOUS",
            "--tab must match exactly one page",
            {
                "tab": selector,
                "match_count": len(matches),
                "matching_ids": [target.get("id") for target in matches],
            },
        )
    return matches[0]


class CDP:
    def __init__(self, ws_url):
        # Chrome 111+ rejects an un-allowlisted Origin header. Omitting Origin
        # avoids requiring Chrome to be relaunched with a broad allowlist.
        self.ws = websocket.create_connection(
            ws_url, timeout=60, suppress_origin=True
        )
        self._id = 0
        self._events = []

    def cmd(self, method, params=None):
        self._id += 1
        message_id = self._id
        self.ws.send(
            json.dumps(
                {"id": message_id, "method": method, "params": params or {}}
            )
        )
        while True:
            message = json.loads(self.ws.recv())
            if message.get("id") == message_id:
                if "error" in message:
                    error = message["error"]
                    raise CliError(
                        "CDP_COMMAND_FAILED",
                        error.get("message", str(error)),
                        {
                            "method": method,
                            "cdp_code": error.get("code"),
                        },
                    )
                return message.get("result", {})
            if message.get("method"):
                self._events.append(message)

    def wait_event(self, method, timeout, predicate=None):
        """Wait for one CDP event while retaining unrelated events."""

        deadline = time.monotonic() + timeout
        while True:
            for index, event in enumerate(self._events):
                if event.get("method") != method:
                    continue
                if predicate is not None and not predicate(event):
                    continue
                return self._events.pop(index)

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise CliError(
                    "CDP_EVENT_TIMEOUT",
                    f"Timed out waiting for {method}",
                    {"method": method, "timeout_seconds": timeout},
                )

            previous_timeout = self.ws.gettimeout()
            self.ws.settimeout(remaining)
            try:
                message = json.loads(self.ws.recv())
            except websocket.WebSocketTimeoutException as error:
                raise CliError(
                    "CDP_EVENT_TIMEOUT",
                    f"Timed out waiting for {method}",
                    {"method": method, "timeout_seconds": timeout},
                ) from error
            finally:
                self.ws.settimeout(previous_timeout)

            if message.get("method"):
                self._events.append(message)

    def evaluate(self, expression, await_promise=True):
        result = self.cmd(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": await_promise,
                "userGesture": True,
            },
        )
        exception = result.get("exceptionDetails")
        if exception:
            description = (
                exception.get("exception", {}).get("description")
                or exception.get("text")
                or "JavaScript evaluation failed"
            )
            raise CliError("JAVASCRIPT_ERROR", description)
        return result.get("result", {}).get("value")

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


def out(value):
    """Emit exactly one JSON value to stdout."""

    print(json.dumps(value, ensure_ascii=False, sort_keys=True))


def _success(command, **fields):
    return {"ok": True, "command": command, **fields}


def _failure(command, error):
    return {
        "ok": False,
        "command": command,
        "error": {
            "code": error.code,
            "message": error.message,
            "details": error.details,
        },
    }


def _pop_option(args, option, default=None):
    positions = [index for index, arg in enumerate(args) if arg == option]
    if len(positions) > 1:
        raise CliError("DUPLICATE_OPTION", f"{option} may be supplied only once")
    if not positions:
        return default
    index = positions[0]
    if index + 1 >= len(args) or args[index + 1].startswith("--"):
        raise CliError("MISSING_OPTION_VALUE", f"{option} requires a value")
    value = args[index + 1]
    del args[index : index + 2]
    return value


def _required_option(value, option):
    if value is None:
        raise CliError("REQUIRED_OPTION", f"{option} is required")
    return value


def _require_arity(args, minimum, maximum=None):
    maximum = minimum if maximum is None else maximum
    if not minimum <= len(args) <= maximum:
        expected = str(minimum) if minimum == maximum else f"{minimum}..{maximum}"
        raise CliError(
            "INVALID_ARGUMENTS",
            f"Expected {expected} positional argument(s), got {len(args)}",
        )


def _bounded_float(raw, name, default, minimum, maximum):
    if raw is None:
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError) as error:
        raise CliError("INVALID_NUMBER", f"{name} must be a number") from error
    if not math.isfinite(value) or value < minimum or value > maximum:
        raise CliError(
            "NUMBER_OUT_OF_RANGE",
            f"{name} must be between {minimum} and {maximum}",
        )
    return value


def _expected_host(raw_host):
    """Validate one literal DNS hostname (no URL, port, path, or wildcard)."""

    if not isinstance(raw_host, str) or not raw_host:
        raise CliError(
            "EXPECTED_HOST_REQUIRED",
            "This command requires --expected-host",
        )
    if raw_host != raw_host.strip() or any(
        marker in raw_host for marker in ("://", "/", "@", ":", "*", "?")
    ):
        raise CliError(
            "INVALID_EXPECTED_HOST",
            "--expected-host must be one literal hostname without scheme, port, path, or wildcard",
            {"expected_host": raw_host},
        )
    try:
        normalized = raw_host.encode("idna").decode("ascii").lower()
    except UnicodeError as error:
        raise CliError(
            "INVALID_EXPECTED_HOST",
            "--expected-host is not a valid hostname",
            {"expected_host": raw_host},
        ) from error
    labels = normalized.split(".")
    if (
        len(normalized) > 253
        or any(
            not label
            or len(label) > 63
            or label[0] == "-"
            or label[-1] == "-"
            or re.fullmatch(r"[a-z0-9-]+", label) is None
            for label in labels
        )
    ):
        raise CliError(
            "INVALID_EXPECTED_HOST",
            "--expected-host is not a valid hostname",
            {"expected_host": raw_host},
        )
    return normalized


def _validated_https_url(raw_url, expected_host, purpose):
    """Return a URL only when it uses HTTPS and the exact expected hostname."""

    if not isinstance(raw_url, str) or not raw_url:
        raise CliError("INVALID_URL", f"{purpose} URL must not be empty")
    try:
        parsed = urllib.parse.urlsplit(raw_url)
        port = parsed.port
    except ValueError as error:
        raise CliError(
            "INVALID_URL", f"{purpose} URL is invalid", {"url": raw_url}
        ) from error
    if parsed.scheme.lower() != "https":
        raise CliError(
            "HTTPS_REQUIRED",
            f"{purpose} URL must use HTTPS",
            {"url": raw_url},
        )
    if parsed.username is not None or parsed.password is not None:
        raise CliError(
            "URL_CREDENTIALS_FORBIDDEN",
            f"{purpose} URL must not contain credentials",
            {"url": raw_url},
        )
    if port not in (None, 443):
        raise CliError(
            "HTTPS_PORT_FORBIDDEN",
            f"{purpose} URL may use only the default HTTPS port",
            {"url": raw_url, "port": port},
        )
    try:
        actual_host = (parsed.hostname or "").encode("idna").decode("ascii").lower()
    except UnicodeError as error:
        raise CliError(
            "INVALID_URL", f"{purpose} URL hostname is invalid", {"url": raw_url}
        ) from error
    if actual_host != expected_host:
        raise CliError(
            "HTTPS_HOST_MISMATCH",
            f"{purpose} URL host does not exactly match --expected-host",
            {"expected_host": expected_host, "actual_host": actual_host},
        )
    return raw_url


def _main_frame(client):
    tree = client.cmd("Page.getFrameTree")
    frame = tree.get("frameTree", {}).get("frame", {})
    if not isinstance(frame.get("id"), str) or not frame["id"]:
        raise CliError("MAIN_FRAME_MISSING", "CDP did not return the selected tab's main frame")
    if not isinstance(frame.get("url"), str) or not frame["url"]:
        raise CliError("CURRENT_URL_MISSING", "CDP did not return the selected tab's current URL")
    return frame


def _verify_selected_tab(client, target, expected_host):
    """Verify both selected target metadata and the page target's live main frame."""

    target_url = str(target.get("url") or "")
    _validated_https_url(target_url, expected_host, "Selected tab metadata")
    frame = _main_frame(client)
    _validated_https_url(frame["url"], expected_host, "Selected tab current")
    return frame


def _validated_sha256(raw_digest):
    if not isinstance(raw_digest, str) or SHA256_HEX.fullmatch(raw_digest) is None:
        raise CliError(
            "INVALID_EXPECTED_SHA256",
            "--expected-sha256 must contain exactly 64 hexadecimal characters",
        )
    return raw_digest.lower()


def _explicit_file(raw_path):
    path = Path(raw_path)
    if not path.is_absolute():
        raise CliError(
            "ABSOLUTE_PATH_REQUIRED",
            "File path must be explicit and absolute",
            {"path": raw_path},
        )
    try:
        resolved = path.resolve(strict=True)
    except FileNotFoundError as error:
        raise CliError(
            "FILE_NOT_FOUND", "Upload file does not exist", {"path": raw_path}
        ) from error
    if not resolved.is_file():
        raise CliError(
            "NOT_A_FILE", "Upload path must identify a regular file", {"path": raw_path}
        )
    return resolved


def _explicit_directory(raw_path):
    path = Path(raw_path)
    if not path.is_absolute():
        raise CliError(
            "ABSOLUTE_PATH_REQUIRED",
            "Output directory must be explicit and absolute",
            {"path": raw_path},
        )
    try:
        resolved = path.resolve(strict=True)
    except FileNotFoundError as error:
        raise CliError(
            "DIRECTORY_NOT_FOUND",
            "Output directory does not exist",
            {"path": raw_path},
        ) from error
    if not resolved.is_dir():
        raise CliError(
            "NOT_A_DIRECTORY",
            "Output path must identify a directory",
            {"path": raw_path},
        )
    return resolved


def _sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _upload_path_inside_root(raw_path, raw_root):
    root = _explicit_directory(raw_root)
    path = _explicit_file(raw_path)
    try:
        path.relative_to(root)
    except ValueError as error:
        raise CliError(
            "UPLOAD_OUTSIDE_ALLOWED_ROOT",
            "Upload file must resolve inside --allowed-root",
            {"path": str(path), "allowed_root": str(root)},
        ) from error
    return path, root


def _save_unique_bytes(directory, prefix, suffix, payload):
    directory = _explicit_directory(str(directory))
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    for _ in range(8):
        filename = f"{prefix}-{timestamp}-{uuid.uuid4().hex[:12]}{suffix}"
        path = directory / filename
        try:
            with path.open("xb") as handle:
                handle.write(payload)
            return path
        except FileExistsError:
            continue
    raise CliError("UNIQUE_PATH_FAILED", "Could not allocate a unique output path")


def _selector_probe_expression(selector, state):
    return """(() => {
      const element = document.querySelector(%s);
      const exists = !!element;
      let visible = false;
      let enabled = false;
      if (element) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        visible = !element.hidden && style.display !== 'none' &&
          style.visibility !== 'hidden' && style.visibility !== 'collapse' &&
          Number(style.opacity || '1') !== 0 && rect.width > 0 && rect.height > 0;
        enabled = visible && !element.disabled &&
          element.getAttribute('aria-disabled') !== 'true';
      }
      const state = %s;
      const matched = state === 'attached' ? exists :
        state === 'visible' ? visible :
        state === 'enabled' ? enabled :
        state === 'detached' ? !exists :
        state === 'hidden' ? !visible : false;
      return {matched, exists, visible, enabled};
    })()""" % (json.dumps(selector), json.dumps(state))


def wait_for_selector(client, selector, state="visible", timeout=30.0, poll=0.25):
    if not selector:
        raise CliError("EMPTY_SELECTOR", "Selector must not be empty")
    if state not in WAIT_STATES:
        raise CliError(
            "INVALID_WAIT_STATE",
            f"state must be one of {', '.join(sorted(WAIT_STATES))}",
        )
    started = time.monotonic()
    deadline = started + timeout
    last_observation = None
    while True:
        last_observation = client.evaluate(_selector_probe_expression(selector, state))
        if not isinstance(last_observation, dict):
            raise CliError(
                "INVALID_PROBE_RESULT", "Selector probe did not return an object"
            )
        if last_observation.get("matched"):
            return {
                "selector": selector,
                "state": state,
                "elapsed_ms": round((time.monotonic() - started) * 1000),
                "observation": last_observation,
            }
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise CliError(
                "WAIT_FOR_TIMEOUT",
                f"Timed out waiting for selector to become {state}",
                {
                    "selector": selector,
                    "state": state,
                    "timeout_seconds": timeout,
                    "last_observation": last_observation,
                },
            )
        time.sleep(min(poll, remaining))


def _click_selector(client, selector):
    if not selector:
        raise CliError("EMPTY_SELECTOR", "Selector must not be empty")
    result = client.evaluate(
        """(() => {
          const element = document.querySelector(%s);
          if (!element) return {clicked: false, reason: 'not_found'};
          element.click();
          return {clicked: true};
        })()""" % json.dumps(selector)
    )
    if not isinstance(result, dict) or not result.get("clicked"):
        raise CliError(
            "ELEMENT_NOT_FOUND",
            "Click selector did not match an element",
            {"selector": selector},
        )
    return result


def upload_file(client, selector, raw_path, allowed_root, expected_sha256):
    """Set one explicit local file on one explicit HTML file input."""

    if not selector:
        raise CliError("EMPTY_SELECTOR", "Selector must not be empty")
    expected_digest = _validated_sha256(expected_sha256)
    path, root = _upload_path_inside_root(raw_path, allowed_root)
    client.cmd("DOM.enable")
    document = client.cmd("DOM.getDocument", {"depth": -1, "pierce": True})
    root_id = document.get("root", {}).get("nodeId")
    if not root_id:
        raise CliError("DOM_ROOT_MISSING", "CDP did not return a document root")
    query = client.cmd("DOM.querySelector", {"nodeId": root_id, "selector": selector})
    node_id = query.get("nodeId")
    if not node_id:
        raise CliError(
            "ELEMENT_NOT_FOUND",
            "Upload selector did not match an element",
            {"selector": selector},
        )
    described = client.cmd("DOM.describeNode", {"nodeId": node_id})
    node = described.get("node", {})
    attributes = node.get("attributes", [])
    attribute_map = dict(zip(attributes[0::2], attributes[1::2]))
    if node.get("nodeName", "").upper() != "INPUT" or attribute_map.get("type", "").lower() != "file":
        raise CliError(
            "NOT_A_FILE_INPUT",
            "Upload selector must resolve directly to input[type=file]",
            {"selector": selector},
        )
    # Resolve again after the DOM work so a swapped symlink cannot silently
    # broaden the allowed path immediately before the browser reads the file.
    final_path, final_root = _upload_path_inside_root(raw_path, allowed_root)
    if final_path != path or final_root != root:
        raise CliError(
            "UPLOAD_PATH_CHANGED",
            "Upload path changed while it was being validated",
            {"initial_path": str(path), "final_path": str(final_path)},
        )
    actual_digest = _sha256_file(final_path)
    if actual_digest != expected_digest:
        raise CliError(
            "UPLOAD_SHA256_MISMATCH",
            "Upload file does not match --expected-sha256",
            {
                "path": str(final_path),
                "expected_sha256": expected_digest,
                "actual_sha256": actual_digest,
            },
        )
    client.cmd(
        "DOM.setFileInputFiles", {"files": [str(final_path)], "nodeId": node_id}
    )
    return {
        "selector": selector,
        "path": str(final_path),
        "allowed_root": str(final_root),
        "filename": final_path.name,
        "bytes": final_path.stat().st_size,
        "sha256": actual_digest,
    }


def capture_download(
    client,
    raw_directory,
    *,
    expected_frame_id,
    timeout=120.0,
    click_selector=None,
    trigger_client=None,
):
    """Capture the next completed download under its CDP-generated GUID.

    ``client`` should be attached to Chrome's browser target so Browser-domain
    events are delivered reliably.  ``trigger_client`` may be a page target
    used for the optional controlled click; it defaults to ``client`` for
    callers and tests that already provide a combined CDP session.
    """

    if not isinstance(expected_frame_id, str) or not expected_frame_id:
        raise CliError(
            "EXPECTED_FRAME_REQUIRED",
            "Download capture must be bound to the selected tab's main frame",
        )
    directory = _explicit_directory(raw_directory)
    operation_error = None
    result = None
    started = time.monotonic()
    try:
        client.cmd(
            "Browser.setDownloadBehavior",
            {
                "behavior": "allowAndName",
                "downloadPath": str(directory),
                "eventsEnabled": True,
            },
        )
        if click_selector is not None:
            _click_selector(trigger_client or client, click_selector)

        # Do not filter out another tab's first download and then silently wait
        # for ours.  The browser-wide interception itself is evidence of an
        # unsafe concurrent action, so reject it immediately.
        begin = client.wait_event("Browser.downloadWillBegin", timeout)
        begin_params = begin.get("params", {})
        actual_frame_id = begin_params.get("frameId")
        if actual_frame_id != expected_frame_id:
            raise CliError(
                "UNRELATED_DOWNLOAD",
                "The intercepted download did not originate from the selected tab's main frame",
                {
                    "expected_frame_id": expected_frame_id,
                    "actual_frame_id": actual_frame_id,
                },
            )
        guid = begin_params.get("guid")
        if not isinstance(guid, str) or not SAFE_DOWNLOAD_GUID.fullmatch(guid):
            raise CliError(
                "UNSAFE_DOWNLOAD_GUID",
                "CDP returned an unsafe download identifier",
            )
        suggested_filename = begin_params.get("suggestedFilename")

        while True:
            remaining = timeout - (time.monotonic() - started)
            if remaining <= 0:
                raise CliError(
                    "DOWNLOAD_TIMEOUT",
                    "Timed out waiting for download completion",
                    {"guid": guid, "timeout_seconds": timeout},
                )
            progress = client.wait_event(
                "Browser.downloadProgress",
                remaining,
                predicate=lambda event: event.get("params", {}).get("guid") == guid,
            ).get("params", {})
            state = progress.get("state")
            if state == "canceled":
                raise CliError(
                    "DOWNLOAD_CANCELED",
                    "Browser reported that the download was canceled",
                    {"guid": guid},
                )
            if state != "completed":
                continue

            path = directory / guid
            if not path.is_file():
                raise CliError(
                    "DOWNLOAD_FILE_MISSING",
                    "Browser reported completion but the GUID-named file is missing",
                    {"guid": guid, "directory": str(directory)},
                )
            result = {
                "directory": str(directory),
                "path": str(path),
                "guid": guid,
                "frame_id": actual_frame_id,
                "suggested_filename": suggested_filename,
                "bytes": path.stat().st_size,
                "sha256": _sha256_file(path),
                "elapsed_ms": round((time.monotonic() - started) * 1000),
                "trigger_selector": click_selector,
            }
            break
    except Exception as error:  # restored below before the original error escapes
        operation_error = error
    finally:
        try:
            client.cmd(
                "Browser.setDownloadBehavior",
                {"behavior": "default", "eventsEnabled": False},
            )
        except Exception as restore_error:
            details = {
                "restore_error": str(restore_error),
                "restore_error_type": type(restore_error).__name__,
            }
            if operation_error is not None:
                details["operation_error"] = str(operation_error)
                details["operation_error_type"] = type(operation_error).__name__
                if isinstance(operation_error, CliError):
                    details["operation_error_code"] = operation_error.code
            raise CliError(
                "DOWNLOAD_BEHAVIOR_RESTORE_FAILED",
                "Could not restore browser-wide download behavior; browser state is unsafe",
                details,
            ) from restore_error

    if operation_error is not None:
        raise operation_error
    return result


def _run(argv):
    args = list(argv)
    if not args:
        raise CliError("USAGE", "usage: see module header")

    if args[0].startswith("--"):
        raise CliError("MISSING_COMMAND", "The command must be the first argument")
    command = args.pop(0)
    if command not in TAB_COMMANDS | {"ping", "tabs", "wait", "new_tab"}:
        raise CliError("UNKNOWN_COMMAND", f"Unknown command: {command}")

    tab_selector = _pop_option(args, "--tab")
    raw_expected_host = _pop_option(args, "--expected-host")
    if command in TAB_COMMANDS:
        if tab_selector is None:
            raise CliError(
                "TAB_REQUIRED",
                f"{command} requires an explicit --tab unique match",
            )
    elif tab_selector is not None:
        raise CliError(
            "TAB_OPTION_NOT_ALLOWED",
            f"{command} does not select an existing tab",
        )

    expected_host = None
    if command in HOST_GUARDED_COMMANDS or command == "new_tab":
        expected_host = _expected_host(raw_expected_host)
    elif raw_expected_host is not None:
        # Read-only tab commands may opt in to the same host assertion.
        if command not in TAB_COMMANDS:
            raise CliError(
                "EXPECTED_HOST_OPTION_NOT_ALLOWED",
                f"{command} does not operate on a tab",
            )
        expected_host = _expected_host(raw_expected_host)

    if command == "ping":
        _require_arity(args, 0)
        try:
            version = json.loads(_http("/json/version"))
            pages = list_pages()
        except Exception as error:
            raise CliError(
                "CDP_UNAVAILABLE",
                str(error),
                {"port": PORT},
            ) from error
        return _success(
            command,
            source="Vladimir's Chrome",
            port=PORT,
            browser=version.get("Browser"),
            pages=len(pages),
        )

    if command == "tabs":
        _require_arity(args, 0)
        tabs = [
            {
                "id": target.get("id"),
                "title": target.get("title") or "",
                "url": target.get("url") or "",
            }
            for target in list_pages()
        ]
        return _success(command, tabs=tabs, count=len(tabs))

    if command == "wait":
        _require_arity(args, 0, 1)
        seconds = _bounded_float(
            args[0] if args else None, "seconds", 3.0, 0.0, 900.0
        )
        time.sleep(seconds)
        return _success(command, seconds=seconds)

    if command == "new_tab":
        _require_arity(args, 1)
        url = _validated_https_url(args[0], expected_host, "New tab target")
        try:
            _http(f"/json/new?{urllib.parse.quote(url, safe='')}", method="PUT")
        except Exception:
            # Browser-level fallback for Chrome versions without /json/new.
            version = json.loads(_http("/json/version"))
            client = CDP(version["webSocketDebuggerUrl"])
            try:
                client.cmd("Target.createTarget", {"url": url})
            finally:
                client.close()
        return _success(command, opened=url)

    target = pick_target(tab_selector)
    if command == "navigate":
        _require_arity(args, 1)
        _validated_https_url(args[0], expected_host, "Navigation target")
    client = CDP(target["webSocketDebuggerUrl"])
    try:
        selected_frame = None
        if expected_host is not None:
            selected_frame = _verify_selected_tab(client, target, expected_host)

        if command == "navigate":
            client.cmd("Page.enable")
            client.cmd("Page.navigate", {"url": args[0]})
            return _success(
                command,
                navigated=args[0],
                tab_id=target.get("id"),
                expected_host=expected_host,
            )

        if command == "get_text":
            _require_arity(args, 0)
            text = client.evaluate("document.body ? document.body.innerText : ''")
            return _success(command, text=text)

        if command == "evaluate":
            _require_arity(args, 1)
            return _success(command, value=client.evaluate(args[0]))

        if command == "wait_for":
            state = _pop_option(args, "--state", "visible")
            timeout = _bounded_float(
                _pop_option(args, "--timeout"), "timeout", 30.0, 0.01, 900.0
            )
            poll = _bounded_float(
                _pop_option(args, "--poll"), "poll", 0.25, 0.01, 5.0
            )
            _require_arity(args, 1)
            result = wait_for_selector(client, args[0], state, timeout, poll)
            return _success(command, **result)

        if command == "screenshot":
            output_directory = _pop_option(args, "--output-dir", "/tmp")
            _require_arity(args, 0)
            directory = _explicit_directory(output_directory)
            result = client.cmd("Page.captureScreenshot", {"format": "png"})
            payload = base64.b64decode(result["data"], validate=True)
            path = _save_unique_bytes(
                directory, "jackie_screenshot", ".png", payload
            )
            return _success(
                command,
                path=str(path),
                bytes=len(payload),
                sha256=hashlib.sha256(payload).hexdigest(),
            )

        if command == "upload_file":
            allowed_root = _required_option(
                _pop_option(args, "--allowed-root"), "--allowed-root"
            )
            expected_sha256 = _required_option(
                _pop_option(args, "--expected-sha256"), "--expected-sha256"
            )
            _require_arity(args, 2)
            return _success(
                command,
                **upload_file(
                    client,
                    args[0],
                    args[1],
                    allowed_root,
                    expected_sha256,
                ),
            )

        if command == "capture_download":
            click_selector = _pop_option(args, "--click-selector")
            timeout = _bounded_float(
                _pop_option(args, "--timeout"), "timeout", 120.0, 0.01, 900.0
            )
            _require_arity(args, 1)
            version = json.loads(_http("/json/version"))
            browser_client = CDP(version["webSocketDebuggerUrl"])
            try:
                result = capture_download(
                    browser_client,
                    args[0],
                    expected_frame_id=selected_frame["id"],
                    timeout=timeout,
                    click_selector=click_selector,
                    trigger_client=client,
                )
            finally:
                browser_client.close()
            return _success(command, **result)

        if command == "fill":
            _require_arity(args, 2)
            selector, text = args
            result = client.evaluate(
                """(() => {
                  const element = document.querySelector(%s);
                  if (!element) return {filled: false, reason: 'not_found'};
                  element.focus();
                  element.value = %s;
                  element.dispatchEvent(new Event('input', {bubbles: true}));
                  element.dispatchEvent(new Event('change', {bubbles: true}));
                  return {filled: true};
                })()""" % (json.dumps(selector), json.dumps(text))
            )
            if not isinstance(result, dict) or not result.get("filled"):
                raise CliError(
                    "ELEMENT_NOT_FOUND",
                    "Fill selector did not match an element",
                    {"selector": selector},
                )
            return _success(command, selector=selector, filled=True)

        if command == "click_sel":
            _require_arity(args, 1)
            _click_selector(client, args[0])
            return _success(command, selector=args[0], clicked=True)

        if command == "click":
            _require_arity(args, 2)
            try:
                x, y = float(args[0]), float(args[1])
            except ValueError as error:
                raise CliError("INVALID_COORDINATES", "click coordinates must be numeric") from error
            if not math.isfinite(x) or not math.isfinite(y):
                raise CliError("INVALID_COORDINATES", "click coordinates must be finite")
            for event_type in ("mousePressed", "mouseReleased"):
                client.cmd(
                    "Input.dispatchMouseEvent",
                    {
                        "type": event_type,
                        "x": x,
                        "y": y,
                        "button": "left",
                        "clickCount": 1,
                    },
                )
            return _success(command, clicked=[x, y])

        if command == "key":
            _require_arity(args, 1)
            key = args[0]
            keymap = {
                "Enter": {"key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13},
                "Tab": {"key": "Tab", "code": "Tab", "windowsVirtualKeyCode": 9},
                "Escape": {"key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27},
            }
            params = keymap.get(key, {"key": key, "code": key})
            client.cmd("Input.dispatchKeyEvent", {"type": "keyDown", **params})
            client.cmd("Input.dispatchKeyEvent", {"type": "keyUp", **params})
            return _success(command, key=key)

        if command == "scroll":
            _require_arity(args, 0, 2)
            direction = args[0] if args else "down"
            if direction not in {"up", "down"}:
                raise CliError("INVALID_DIRECTION", "scroll direction must be up or down")
            try:
                amount = int(args[1]) if len(args) > 1 else 500
            except ValueError as error:
                raise CliError("INVALID_NUMBER", "scroll amount must be an integer") from error
            delta_y = amount if direction == "down" else -amount
            client.evaluate(f"window.scrollBy(0,{delta_y}); true")
            return _success(command, direction=direction, amount=amount)

        raise CliError("UNKNOWN_COMMAND", f"Unknown command: {command}")
    finally:
        client.close()


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    command = argv[0] if argv and not argv[0].startswith("--") else None
    try:
        result = _run(argv)
    except CliError as error:
        out(_failure(command, error))
        return 2
    except Exception as error:
        structured = CliError(
            "UNEXPECTED_ERROR",
            str(error),
            {"type": type(error).__name__},
        )
        out(_failure(command, structured))
        return 1
    out(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
