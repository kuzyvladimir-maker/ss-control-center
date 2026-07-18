#!/usr/bin/env python3
"""Offline tests for cdp_browser high-level primitives."""

import contextlib
import hashlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).with_name("cdp_browser.py")
SPEC = importlib.util.spec_from_file_location("cdp_browser", MODULE_PATH)
cdp_browser = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cdp_browser)


class FakeEvaluateClient:
    def __init__(self, observations):
        self.observations = list(observations)
        self.expressions = []

    def evaluate(self, expression):
        self.expressions.append(expression)
        return self.observations.pop(0)


class FakeDomClient:
    def __init__(self, node_name="INPUT", attributes=None):
        self.node_name = node_name
        self.attributes = attributes or ["type", "file"]
        self.calls = []

    def cmd(self, method, params=None):
        self.calls.append((method, params))
        if method == "DOM.getDocument":
            return {"root": {"nodeId": 10}}
        if method == "DOM.querySelector":
            return {"nodeId": 20}
        if method == "DOM.describeNode":
            return {
                "node": {
                    "nodeName": self.node_name,
                    "attributes": self.attributes,
                }
            }
        return {}


class FakeDownloadClient:
    def __init__(
        self,
        directory,
        guid="1234-abcd",
        frame_id="selected-frame",
        restore_fails=False,
    ):
        self.directory = Path(directory)
        self.guid = guid
        self.frame_id = frame_id
        self.restore_fails = restore_fails
        self.commands = []
        self.evaluations = []

    def cmd(self, method, params=None):
        self.commands.append((method, params))
        if (
            self.restore_fails
            and method == "Browser.setDownloadBehavior"
            and params.get("behavior") == "default"
        ):
            raise RuntimeError("restore refused")
        return {}

    def evaluate(self, expression):
        self.evaluations.append(expression)
        return {"clicked": True}

    def wait_event(self, method, timeout, predicate=None):
        if method == "Browser.downloadWillBegin":
            return {
                "method": method,
                "params": {
                    "guid": self.guid,
                    "frameId": self.frame_id,
                    "suggestedFilename": "inventory.txt",
                },
            }
        if method == "Browser.downloadProgress":
            event = {
                "method": method,
                "params": {"guid": self.guid, "state": "completed"},
            }
            if predicate is not None:
                self.assert_predicate(predicate, event)
            (self.directory / self.guid).write_bytes(b"download evidence")
            return event
        raise AssertionError(f"unexpected event method {method}")

    @staticmethod
    def assert_predicate(predicate, event):
        if not predicate(event):
            raise AssertionError("download predicate rejected matching GUID")


class FakeClickClient:
    def __init__(self):
        self.expressions = []

    def evaluate(self, expression):
        self.expressions.append(expression)
        return {"clicked": True}


class FakeFrameClient:
    def __init__(self, url="https://selling.channelmax.net/products"):
        self.url = url

    def cmd(self, method, params=None):
        if method == "Page.getFrameTree":
            return {
                "frameTree": {
                    "frame": {"id": "selected-frame", "url": self.url}
                }
            }
        raise AssertionError(f"unexpected method {method}")


class TabSelectionTests(unittest.TestCase):
    def setUp(self):
        self.pages = [
            {
                "id": "tab-one",
                "url": "https://selling.channelmax.net/products",
                "title": "ChannelMAX Products",
                "webSocketDebuggerUrl": "ws://one",
            },
            {
                "id": "tab-two",
                "url": "https://selling.channelmax.net/settings",
                "title": "ChannelMAX Settings",
                "webSocketDebuggerUrl": "ws://two",
            },
        ]

    def test_tab_match_must_exist(self):
        with mock.patch.object(cdp_browser, "list_pages", return_value=self.pages):
            with self.assertRaises(cdp_browser.CliError) as raised:
                cdp_browser.pick_target("not-present")
        self.assertEqual(raised.exception.code, "TAB_NOT_FOUND")

    def test_tab_match_must_be_unique(self):
        with mock.patch.object(cdp_browser, "list_pages", return_value=self.pages):
            with self.assertRaises(cdp_browser.CliError) as raised:
                cdp_browser.pick_target("channelmax")
        self.assertEqual(raised.exception.code, "TAB_AMBIGUOUS")

    def test_exact_target_id_selects_one_tab(self):
        with mock.patch.object(cdp_browser, "list_pages", return_value=self.pages):
            selected = cdp_browser.pick_target("tab-two")
        self.assertEqual(selected["id"], "tab-two")

    def test_every_existing_tab_command_requires_tab(self):
        for command in sorted(cdp_browser.TAB_COMMANDS):
            with self.subTest(command=command):
                with self.assertRaises(cdp_browser.CliError) as raised:
                    cdp_browser._run([command])
                self.assertEqual(raised.exception.code, "TAB_REQUIRED")


class HostGuardTests(unittest.TestCase):
    TARGET = {
        "id": "tab-one",
        "url": "https://selling.channelmax.net/products",
    }

    def test_mutating_and_evaluate_commands_require_expected_host(self):
        for command in sorted(cdp_browser.HOST_GUARDED_COMMANDS):
            with self.subTest(command=command):
                with self.assertRaises(cdp_browser.CliError) as raised:
                    cdp_browser._run([command, "--tab", "tab-one"])
                self.assertEqual(raised.exception.code, "EXPECTED_HOST_REQUIRED")

    def test_selected_current_tab_must_be_exact_https_host(self):
        with self.assertRaises(cdp_browser.CliError) as raised:
            cdp_browser._verify_selected_tab(
                FakeFrameClient("https://evil.example/products"),
                self.TARGET,
                "selling.channelmax.net",
            )
        self.assertEqual(raised.exception.code, "HTTPS_HOST_MISMATCH")

        with self.assertRaises(cdp_browser.CliError) as raised:
            cdp_browser._verify_selected_tab(
                FakeFrameClient("http://selling.channelmax.net/products"),
                self.TARGET,
                "selling.channelmax.net",
            )
        self.assertEqual(raised.exception.code, "HTTPS_REQUIRED")

    def test_navigation_target_host_is_validated_before_connecting(self):
        with mock.patch.object(cdp_browser, "list_pages", return_value=[self.TARGET]):
            with self.assertRaises(cdp_browser.CliError) as raised:
                cdp_browser._run(
                    [
                        "navigate",
                        "https://evil.example/path",
                        "--tab",
                        "tab-one",
                        "--expected-host",
                        "selling.channelmax.net",
                    ]
                )
        self.assertEqual(raised.exception.code, "HTTPS_HOST_MISMATCH")

    def test_new_tab_target_must_be_expected_https_host_without_http_call(self):
        with mock.patch.object(cdp_browser, "_http") as http:
            with self.assertRaises(cdp_browser.CliError) as raised:
                cdp_browser._run(
                    [
                        "new_tab",
                        "http://selling.channelmax.net/path",
                        "--expected-host",
                        "selling.channelmax.net",
                    ]
                )
        self.assertEqual(raised.exception.code, "HTTPS_REQUIRED")
        http.assert_not_called()

    def test_expected_host_rejects_wildcards_urls_and_ports(self):
        for value in (
            "*.channelmax.net",
            "https://selling.channelmax.net",
            "selling.channelmax.net:443",
        ):
            with self.subTest(value=value):
                with self.assertRaises(cdp_browser.CliError) as raised:
                    cdp_browser._expected_host(value)
                self.assertEqual(raised.exception.code, "INVALID_EXPECTED_HOST")


class PathSafetyTests(unittest.TestCase):
    def test_upload_requires_an_absolute_regular_file(self):
        with self.assertRaises(cdp_browser.CliError) as raised:
            cdp_browser._explicit_file("relative.txt")
        self.assertEqual(raised.exception.code, "ABSOLUTE_PATH_REQUIRED")

        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(cdp_browser.CliError) as raised:
                cdp_browser._explicit_file(directory)
            self.assertEqual(raised.exception.code, "NOT_A_FILE")

    def test_output_directory_must_already_exist(self):
        missing = str(Path(tempfile.gettempdir()) / "cdp-test-missing-directory")
        with self.assertRaises(cdp_browser.CliError) as raised:
            cdp_browser._explicit_directory(missing)
        self.assertEqual(raised.exception.code, "DIRECTORY_NOT_FOUND")


class WaitForTests(unittest.TestCase):
    def test_wait_for_returns_only_after_requested_state_matches(self):
        client = FakeEvaluateClient(
            [
                {"matched": False, "exists": True, "visible": False, "enabled": False},
                {"matched": True, "exists": True, "visible": True, "enabled": True},
            ]
        )
        result = cdp_browser.wait_for_selector(
            client, "#upload", state="enabled", timeout=1.0, poll=0.01
        )
        self.assertEqual(result["selector"], "#upload")
        self.assertEqual(result["state"], "enabled")
        self.assertTrue(result["observation"]["matched"])
        self.assertEqual(len(client.expressions), 2)

    def test_wait_for_rejects_unknown_state_before_evaluating(self):
        client = FakeEvaluateClient([])
        with self.assertRaises(cdp_browser.CliError) as raised:
            cdp_browser.wait_for_selector(client, "#x", state="maybe")
        self.assertEqual(raised.exception.code, "INVALID_WAIT_STATE")
        self.assertEqual(client.expressions, [])


class UploadTests(unittest.TestCase):
    def test_upload_sets_one_explicit_file_on_exact_file_input(self):
        client = FakeDomClient()
        with tempfile.TemporaryDirectory() as directory:
            upload_path = Path(directory) / "assignment.txt"
            payload = b"sku\tmodel\n"
            upload_path.write_bytes(payload)
            digest = hashlib.sha256(payload).hexdigest()
            result = cdp_browser.upload_file(
                client,
                "input#assignment",
                str(upload_path),
                directory,
                digest,
            )

        self.assertEqual(result["selector"], "input#assignment")
        self.assertEqual(result["sha256"], digest)
        set_file_calls = [call for call in client.calls if call[0] == "DOM.setFileInputFiles"]
        self.assertEqual(len(set_file_calls), 1)
        self.assertEqual(set_file_calls[0][1]["nodeId"], 20)
        self.assertEqual(set_file_calls[0][1]["files"], [result["path"]])

    def test_upload_rejects_selector_that_is_not_a_file_input(self):
        client = FakeDomClient(node_name="BUTTON", attributes=["type", "button"])
        with tempfile.TemporaryDirectory() as directory:
            upload_path = Path(directory) / "assignment.txt"
            upload_path.write_text("x")
            digest = hashlib.sha256(b"x").hexdigest()
            with self.assertRaises(cdp_browser.CliError) as raised:
                cdp_browser.upload_file(
                    client, "#wrong", str(upload_path), directory, digest
                )
        self.assertEqual(raised.exception.code, "NOT_A_FILE_INPUT")
        self.assertFalse(
            any(method == "DOM.setFileInputFiles" for method, _ in client.calls)
        )

    def test_upload_rejects_file_resolving_outside_allowed_root(self):
        client = FakeDomClient()
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            allowed = base / "allowed"
            allowed.mkdir()
            outside = base / "outside.txt"
            outside.write_bytes(b"outside")
            digest = hashlib.sha256(b"outside").hexdigest()
            with self.assertRaises(cdp_browser.CliError) as raised:
                cdp_browser.upload_file(
                    client, "#upload", str(outside), str(allowed), digest
                )
        self.assertEqual(raised.exception.code, "UPLOAD_OUTSIDE_ALLOWED_ROOT")
        self.assertEqual(client.calls, [])

    def test_upload_rejects_digest_mismatch_before_setting_input(self):
        client = FakeDomClient()
        with tempfile.TemporaryDirectory() as directory:
            upload_path = Path(directory) / "assignment.txt"
            upload_path.write_bytes(b"actual")
            wrong_digest = hashlib.sha256(b"different").hexdigest()
            with self.assertRaises(cdp_browser.CliError) as raised:
                cdp_browser.upload_file(
                    client,
                    "#upload",
                    str(upload_path),
                    directory,
                    wrong_digest,
                )
        self.assertEqual(raised.exception.code, "UPLOAD_SHA256_MISMATCH")
        self.assertFalse(
            any(method == "DOM.setFileInputFiles" for method, _ in client.calls)
        )


class EvidenceTests(unittest.TestCase):
    def test_unique_evidence_paths_never_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            first = cdp_browser._save_unique_bytes(
                Path(directory), "screenshot", ".png", b"first"
            )
            second = cdp_browser._save_unique_bytes(
                Path(directory), "screenshot", ".png", b"second"
            )
            self.assertNotEqual(first, second)
            self.assertEqual(first.read_bytes(), b"first")
            self.assertEqual(second.read_bytes(), b"second")

    def test_download_is_captured_by_guid_in_explicit_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            client = FakeDownloadClient(directory)
            trigger_client = FakeClickClient()
            result = cdp_browser.capture_download(
                client,
                directory,
                expected_frame_id="selected-frame",
                timeout=1.0,
                click_selector="#export",
                trigger_client=trigger_client,
            )
            captured = Path(result["path"])
            self.assertEqual(captured.parent, Path(directory).resolve())
            self.assertEqual(captured.name, client.guid)
            self.assertEqual(captured.read_bytes(), b"download evidence")
            self.assertEqual(
                result["sha256"], hashlib.sha256(b"download evidence").hexdigest()
            )
            self.assertEqual(result["suggested_filename"], "inventory.txt")
            self.assertEqual(result["trigger_selector"], "#export")
            self.assertEqual(client.evaluations, [])
            self.assertEqual(len(trigger_client.expressions), 1)
            self.assertEqual(
                client.commands[0],
                (
                    "Browser.setDownloadBehavior",
                    {
                        "behavior": "allowAndName",
                        "downloadPath": str(Path(directory).resolve()),
                        "eventsEnabled": True,
                    },
                ),
            )
            self.assertEqual(
                client.commands[-1],
                (
                    "Browser.setDownloadBehavior",
                    {"behavior": "default", "eventsEnabled": False},
                ),
            )

    def test_download_rejects_unsafe_browser_guid(self):
        with tempfile.TemporaryDirectory() as directory:
            client = FakeDownloadClient(directory, guid="../escape")
            with self.assertRaises(cdp_browser.CliError) as raised:
                cdp_browser.capture_download(
                    client,
                    directory,
                    expected_frame_id="selected-frame",
                    timeout=1.0,
                )
        self.assertEqual(raised.exception.code, "UNSAFE_DOWNLOAD_GUID")
        self.assertEqual(client.commands[-1][1]["behavior"], "default")

    def test_download_from_unrelated_frame_is_rejected_and_restored(self):
        with tempfile.TemporaryDirectory() as directory:
            client = FakeDownloadClient(directory, frame_id="other-frame")
            with self.assertRaises(cdp_browser.CliError) as raised:
                cdp_browser.capture_download(
                    client,
                    directory,
                    expected_frame_id="selected-frame",
                    timeout=1.0,
                )
        self.assertEqual(raised.exception.code, "UNRELATED_DOWNLOAD")
        self.assertEqual(client.commands[-1][1]["behavior"], "default")

    def test_restore_failure_is_reported_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            client = FakeDownloadClient(directory, restore_fails=True)
            with self.assertRaises(cdp_browser.CliError) as raised:
                cdp_browser.capture_download(
                    client,
                    directory,
                    expected_frame_id="selected-frame",
                    timeout=1.0,
                )
        self.assertEqual(
            raised.exception.code, "DOWNLOAD_BEHAVIOR_RESTORE_FAILED"
        )
        self.assertIn("restore_error", raised.exception.details)


class StructuredOutputTests(unittest.TestCase):
    def test_usage_error_is_one_structured_json_object(self):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            status = cdp_browser.main([])
        payload = json.loads(stdout.getvalue())
        self.assertEqual(status, 2)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["code"], "USAGE")
        self.assertEqual(len(stdout.getvalue().strip().splitlines()), 1)


if __name__ == "__main__":
    unittest.main()
