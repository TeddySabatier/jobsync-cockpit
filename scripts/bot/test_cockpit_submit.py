"""Tests for cockpit_submit.py against a stub MCP server (standard library only).

Run from this folder:  python -m unittest -v test_cockpit_submit
"""
import base64
import contextlib
import io
import json
import os
import re
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

import cockpit_submit as cs

TOKEN = "jsync_TESTTOKEN_do_not_print_1234567890"
PDF = b"%PDF-1.4\n% synthetic cv\n%%EOF\n"
KEY_RE = re.compile(r"^[A-Za-z0-9._:-]{1,100}$")


class Stub:
    """A tiny MCP endpoint that records requests and can be told to fail."""

    def __init__(self):
        self.calls = []  # (tool name, arguments)
        self.auth = []
        self.keys = set()
        self.jobs = set()
        self.http_status = 200
        self.fail = {}  # tool name -> "CODE: message"
        self.tools = [
            "add_job", "attach_file", "submit_application_package",
            "list_jobs", "list_change_requests", "mark_change_request_done",
        ]
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                request = json.loads(self.rfile.read(length))
                stub.auth.append(self.headers.get("Authorization"))
                if stub.http_status != 200:
                    self.send_response(stub.http_status)
                    self.end_headers()
                    return
                method = request["method"]
                if method == "tools/list":
                    result = {"tools": [{"name": n} for n in stub.tools]}
                else:
                    name = request["params"]["name"]
                    arguments = request["params"]["arguments"]
                    stub.calls.append((name, arguments))
                    result = stub.tool(name, arguments)
                payload = json.dumps({"jsonrpc": "2.0", "id": 1, "result": result}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:%d/api/mcp" % self.server.server_port
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def tool(self, name, arguments):
        if name in self.fail:
            return {"isError": True, "content": [{"type": "text", "text": self.fail[name]}]}
        if name == "add_job":
            # The real server words this three ways: created, upsert on an existing job, duplicate.
            seen = arguments["company"] + "|" + arguments["jobTitle"]
            first = seen not in self.jobs
            self.jobs.add(seen)
            if first:
                text = "Created Acme; Created Role. Job created (id: 11111111-2222-3333-4444-555555555555). Done."
            else:
                text = "Job 11111111-2222-3333-4444-555555555555 updated. Fields changed: jobUrl, description."
        elif name == "attach_file":
            text = json.dumps({"fileId": "file-1", "fileName": "x.pdf", "sizeBytes": 10})
        elif name == "submit_application_package":
            key = arguments["idempotencyKey"]
            again = key in self.keys
            self.keys.add(key)
            text = json.dumps({"packageId": "pkg-1", "version": 1, "status": "pending",
                               "supersededIds": [], "idempotent": again})
        elif name == "list_jobs":
            text = json.dumps({"total": 0, "jobs": []})
        elif name == "list_change_requests":
            text = json.dumps([{"packageId": "pkg-9", "changeRequest": "shorten the letter"}])
        elif name == "mark_change_request_done":
            text = json.dumps({"packageId": arguments["packageId"], "status": "pending"})
        else:
            text = "{}"
        return {"content": [{"type": "text", "text": text}]}


def run(argv, env=None):
    """Run main() and return (exit code, parsed JSON line, raw stdout)."""
    out = io.StringIO()
    base = {"COCKPIT_TOKEN": TOKEN}
    base.update(env or {})
    with mock.patch.dict(os.environ, base), contextlib.redirect_stdout(out):
        code = cs.main(argv)
    raw = out.getvalue()
    return code, json.loads(raw.strip().splitlines()[-1]), raw


class FolderMixin:
    def make_folder(self, **overrides):
        folder = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(folder, ignore_errors=True))
        files = {
            "letter.md": "Dear team,\n\nI would like to apply.\n",
            "posting.md": "Posting text, long enough to be a description.",
            "cv.json": json.dumps({"name": "Jane Doe"}),
        }
        files.update(overrides)
        for name, content in files.items():
            if content is not None:
                (folder / name).write_text(content, encoding="utf-8")
        (folder / "Jane_Doe_CV_Acme.pdf").write_bytes(PDF)
        return folder


class HelperTests(unittest.TestCase):
    def test_idempotency_key_is_valid_and_stable(self):
        key = cs.idempotency_key("Société Générale & Fils", "Développeur Back-end (H/F)", "2026-11-09")
        self.assertRegex(key, KEY_RE)
        self.assertEqual(key, cs.idempotency_key("Société Générale & Fils", "Développeur Back-end (H/F)", "2026-11-09"))
        self.assertTrue(key.startswith("scout-2026-11-09-"))

    def test_revision_and_day_change_the_key(self):
        base = cs.idempotency_key("Acme", "Dev", "2026-11-09")
        self.assertNotEqual(base, cs.idempotency_key("Acme", "Dev", "2026-11-09", "pkg-1"))
        self.assertNotEqual(base, cs.idempotency_key("Acme", "Dev", "2026-11-10"))
        self.assertRegex(cs.idempotency_key("A" * 300, "B" * 300, "2026-11-09", "pkg-1"), KEY_RE)

    def test_slug_never_empty(self):
        self.assertEqual(cs.slug("!!!", 10), "x")

    def test_build_body_apply_via_link(self):
        body = cs.build_body("Dear team", "", "https://example.com/job")
        self.assertEqual(body.splitlines()[0], "Apply via: https://example.com/job")
        self.assertTrue(body.endswith("Dear team"))

    def test_build_body_with_recipient_is_untouched(self):
        self.assertEqual(cs.build_body("Dear team\n", "hr@example.com", "https://example.com/job"), "Dear team")

    def test_build_body_does_not_duplicate_the_link(self):
        text = "Apply via: https://example.com/job\n\nDear team"
        self.assertEqual(cs.build_body(text, "", "https://example.com/job"), text)

    def test_parse_job_id_in_every_wording_the_server_uses(self):
        job = "11111111-2222-3333-4444-555555555555"
        for text in (
            "Created Acme; Created Role. Job created (id: %s). Done." % job,
            'Duplicate detected — existing job "QA" at "Acme" (id: %s). To enrich it, call update_job' % job,
            "Job %s updated. Fields changed: companyId, jobTitleId, jobUrl, description." % job,
        ):
            self.assertEqual(cs.parse_job_id(text), job, text)
        with self.assertRaises(cs.CockpitError):
            cs.parse_job_id("no id here")


class CommandTests(FolderMixin, unittest.TestCase):
    def setUp(self):
        self.stub = Stub()
        self.addCleanup(self.stub.close)

    def submit_args(self, folder, *extra):
        return [
            "--endpoint", self.stub.url, "submit", "--folder", str(folder),
            "--company", "Acme", "--role", "Backend Engineer",
            "--subject", "Application - Backend Engineer - Jane Doe",
            "--fit", "A", "--track", "Fintech", "--url", "https://example.com/job",
            "--location", "Geneva", "--reasons", "stack overlap; location",
            "--date", "2026-11-09", *extra,
        ]

    def test_submit_happy_path_apply_via_link(self):
        folder = self.make_folder()
        code, result, _ = run(self.submit_args(folder))
        self.assertEqual(code, 0, result)
        self.assertTrue(result["ok"])
        self.assertEqual(result["packageId"], "pkg-1")
        self.assertTrue(result["applyViaLink"])
        self.assertEqual([c[0] for c in self.stub.calls], ["add_job", "attach_file", "submit_application_package"])

        job = self.stub.calls[0][1]
        self.assertEqual((job["company"], job["jobTitle"], job["upsert"]), ("Acme", "Backend Engineer", True))
        self.assertEqual(job["jobUrl"], "https://example.com/job")

        attach = self.stub.calls[1][1]
        self.assertEqual(attach["fileName"], "Jane_Doe_CV_Acme.pdf")
        self.assertEqual(base64.b64decode(attach["contentBase64"]), PDF)

        package = self.stub.calls[2][1]
        self.assertEqual(package["emailTo"], "")
        self.assertEqual(package["emailBody"].splitlines()[0], "Apply via: https://example.com/job")
        self.assertEqual(package["fitGrade"], "A")
        self.assertEqual(package["fitAnalysis"], {
            "verdict": "A", "track": "Fintech", "location": "Geneva",
            "reasons": ["stack overlap", "location"],
        })
        self.assertEqual(package["cvJson"], {"name": "Jane Doe"})
        self.assertEqual(package["cvFileId"], "file-1")
        self.assertEqual(package["sourceFolder"], folder.name)
        self.assertRegex(package["idempotencyKey"], KEY_RE)
        self.assertEqual(set(self.stub.auth), {"Bearer " + TOKEN})

    def test_submit_with_recipient_has_no_apply_via_line(self):
        folder = self.make_folder()
        code, result, _ = run(self.submit_args(folder, "--to", "hr@example.com"))
        self.assertEqual(code, 0)
        self.assertFalse(result["applyViaLink"])
        package = self.stub.calls[2][1]
        self.assertEqual(package["emailTo"], "hr@example.com")
        self.assertNotIn("Apply via", package["emailBody"])

    def test_replay_returns_the_same_package_without_uploading_again(self):
        folder = self.make_folder()
        first = run(self.submit_args(folder))[1]
        calls_after_first = len(self.stub.calls)
        second = run(self.submit_args(folder))[1]
        self.assertFalse(first["idempotent"])
        self.assertTrue(second["idempotent"])
        self.assertEqual(first["packageId"], second["packageId"])
        self.assertEqual(len(self.stub.calls), calls_after_first)  # no second upload
        self.assertTrue((folder / ".cockpit-submitted.json").is_file())

    def test_a_deleted_or_corrupt_marker_just_submits_again(self):
        folder = self.make_folder()
        run(self.submit_args(folder))
        (folder / ".cockpit-submitted.json").write_text("not json", encoding="utf-8")
        again = run(self.submit_args(folder))[1]
        self.assertTrue(again["ok"])
        self.assertEqual(len([c for c in self.stub.calls if c[0] == "attach_file"]), 2)
        self.assertTrue(again["idempotent"])  # the server still recognises the key

    def test_a_failed_submit_leaves_no_marker(self):
        self.stub.fail["submit_application_package"] = "ALREADY_SENT: already sent"
        folder = self.make_folder()
        run(self.submit_args(folder))
        self.assertFalse((folder / ".cockpit-submitted.json").exists())

    def test_resubmit_for_a_change_request_uses_a_new_key(self):
        folder = self.make_folder()
        run(self.submit_args(folder))
        run(self.submit_args(folder, "--revision", "pkg-1"))
        keys = [c[1]["idempotencyKey"] for c in self.stub.calls if c[0] == "submit_application_package"]
        self.assertEqual(len(set(keys)), 2)

    def test_missing_pdf_fails_before_any_request(self):
        folder = self.make_folder()
        (folder / "Jane_Doe_CV_Acme.pdf").unlink()
        code, result, _ = run(self.submit_args(folder))
        self.assertEqual((code, result["ok"], result["error"]), (1, False, "FILE_NOT_FOUND"))
        self.assertEqual(self.stub.calls, [])

    def test_files_with_a_byte_order_mark_are_read(self):
        folder = self.make_folder()
        (folder / "cv.json").write_bytes(b"\xef\xbb\xbf" + json.dumps({"name": "Jane Doe"}).encode())
        code, result, _ = run(self.submit_args(folder))
        self.assertEqual(code, 0, result)

    def test_missing_letter_fails(self):
        folder = self.make_folder(**{"letter.md": None})
        code, result, _ = run(self.submit_args(folder))
        self.assertEqual((code, result["error"]), (1, "FILE_NOT_FOUND"))

    def test_cv_json_must_be_an_object(self):
        for content in ("not json", "[1, 2]"):
            folder = self.make_folder(**{"cv.json": content})
            code, result, _ = run(self.submit_args(folder))
            self.assertEqual((code, result["error"]), (1, "VALIDATION"), content)

    def test_too_large_pdf_is_refused_locally(self):
        folder = self.make_folder()
        with mock.patch.object(cs, "MAX_BASE64_CHARS", 10):
            code, result, _ = run(self.submit_args(folder))
        self.assertEqual((code, result["error"]), (1, "TOO_LARGE"))
        self.assertEqual(self.stub.calls, [])

    def test_server_error_code_is_passed_through(self):
        self.stub.fail["submit_application_package"] = "ALREADY_SENT: An application was already sent for this job."
        folder = self.make_folder()
        code, result, _ = run(self.submit_args(folder))
        self.assertEqual((code, result["ok"], result["error"]), (1, False, "ALREADY_SENT"))
        self.assertIn("already sent", result["message"])

    def test_unauthorized(self):
        self.stub.http_status = 401
        code, result, _ = run(self.submit_args(self.make_folder()))
        self.assertEqual((code, result["error"]), (1, "UNAUTHORIZED"))

    def test_unreachable(self):
        code, result, _ = run(["--endpoint", "http://127.0.0.1:9/api/mcp", "check"])
        self.assertEqual((code, result["error"]), (1, "UNREACHABLE"))

    def test_no_token(self):
        out = io.StringIO()
        with mock.patch.dict(os.environ, {"COCKPIT_TOKEN": "", "COCKPIT_TOKEN_FILE": "/nonexistent/token.txt"}), \
                contextlib.redirect_stdout(out):
            code = cs.main(["--endpoint", self.stub.url, "check"])
        result = json.loads(out.getvalue())
        self.assertEqual((code, result["error"]), (1, "NO_TOKEN"))

    def test_token_file_is_used_and_never_printed(self):
        token_file = Path(tempfile.mkdtemp()) / "cockpit_token.txt"
        token_file.write_text(TOKEN + "\n", encoding="utf-8")
        out = io.StringIO()
        with mock.patch.dict(os.environ, {"COCKPIT_TOKEN": "", "COCKPIT_TOKEN_FILE": str(token_file)}), \
                contextlib.redirect_stdout(out):
            code = cs.main(["--endpoint", self.stub.url, "check"])
        self.assertEqual(code, 0)
        self.assertEqual(set(self.stub.auth), {"Bearer " + TOKEN})
        self.assertNotIn(TOKEN, out.getvalue())

    def test_token_never_appears_in_error_output(self):
        self.stub.http_status = 401
        _, _, raw = run(self.submit_args(self.make_folder()))
        self.assertNotIn(TOKEN, raw)

    def test_check_ok(self):
        code, result, _ = run(["--endpoint", self.stub.url, "check"])
        self.assertEqual(code, 0)
        self.assertIn("submit_application_package", result["tools"])

    def test_check_reports_missing_tools(self):
        self.stub.tools = ["add_job"]
        code, result, _ = run(["--endpoint", self.stub.url, "check"])
        self.assertEqual((code, result["error"]), (1, "MISSING_TOOLS"))

    def test_changes_and_done(self):
        code, result, _ = run(["--endpoint", self.stub.url, "changes"])
        self.assertEqual(code, 0)
        self.assertEqual(result["changeRequests"][0]["packageId"], "pkg-9")
        code, result, _ = run(["--endpoint", self.stub.url, "done", "--package", "pkg-9", "--response", "Shortened."])
        self.assertEqual((code, result["status"]), (0, "pending"))
        self.assertEqual(self.stub.calls[-1], ("mark_change_request_done", {"packageId": "pkg-9", "response": "Shortened."}))


if __name__ == "__main__":
    unittest.main()
