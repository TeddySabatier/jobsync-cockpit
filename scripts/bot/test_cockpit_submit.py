"""Tests for cockpit_submit.py against a stub MCP server (standard library only).

The stub mimics the real server where it matters: add_job dedupes by link and then
by company + title (allowDuplicate skips both), answers in several wordings,
reports rate limits as plain text, every upload gets its own file id, a submit
supersedes the job's open package and closes its change request, a reused key for
another job is a CONFLICT, and it can redirect, hang or answer garbage.

Run from this folder:  python -m unittest -v test_cockpit_submit
"""
import base64
import contextlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

import cockpit_submit as cs

TOKEN = "jsync_TESTTOKEN_do_not_print_1234567890"
PDF = b"%PDF-1.4\n% synthetic cv\n%%EOF\n"
KEY_RE = re.compile(r"^[A-Za-z0-9._:-]{1,100}$")
JOB = "00000000-0000-4000-8000-%012d"
LINK = "https://example.com/job/1"


class Stub:
    def __init__(self):
        self.calls = []  # (tool name, arguments)
        self.auth = []
        self.keys = {}  # idempotency key -> (jobId, packageId)
        self.job_urls = {}
        self.job_names = {}
        self.job_links = {}  # job id -> link
        self.packages = {}  # job id -> [{"id", "version", "status"}], oldest first
        self.next_id = 1
        self.files = 0
        self.http_status = 200
        self.redirect_to = None
        self.delay = 0
        self.raw_body = None
        self.fail = {}  # tool -> isError text
        self.inject_on_fail = None
        self.fail_once = {}  # tool -> isError text, for the NEXT call only
        self.plain = {}  # tool -> plain-text answer (rate limit, scope, "Error: ...")
        self.change_requests = []
        self.tools = [
            "add_job", "find_job", "get_job", "attach_file", "submit_application_package",
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
                if stub.delay:
                    time.sleep(stub.delay)
                if stub.redirect_to:
                    self.send_response(302)
                    self.send_header("Location", stub.redirect_to)
                    self.end_headers()
                    return
                if stub.http_status != 200:
                    self.send_response(stub.http_status)
                    self.end_headers()
                    return
                if stub.raw_body is not None:
                    payload = stub.raw_body.encode()
                else:
                    if request["method"] == "tools/list":
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

    def new_id(self):
        n = self.next_id
        self.next_id += 1
        return JOB % n

    def names(self, tool):
        return [c[0] for c in self.calls if c[0] == tool]

    def seed_job(self, link=LINK, status=None, version=1):
        """A job that already exists (optionally with a package in `status`)."""
        job_id = self.new_id()
        self.job_urls[link] = job_id
        self.job_links[job_id] = link
        self.packages[job_id] = []
        if status:
            self.packages[job_id].append({"id": "seeded-pkg-%s" % status, "version": version, "status": status})
        return job_id

    def invalid_input(self, name, arguments):
        """The server's input checks that a bot bug could hit (limits, PDF magic, key pattern)."""
        if name == "attach_file":
            content = arguments.get("contentBase64", "")
            if len(content) > cs.MAX_BASE64_CHARS:
                return "contentBase64 is too long"
            if not base64.b64decode(content)[:5] == b"%PDF-":
                return "The file is not a PDF"
        if name == "submit_application_package":
            if not KEY_RE.match(arguments.get("idempotencyKey", "")):
                return "idempotencyKey has an invalid format"
            if len(arguments.get("emailSubject", "")) > cs.MAX_SUBJECT or not arguments.get("emailSubject"):
                return "emailSubject must be 1 to 300 characters"
            for field in ("emailBody", "letterMd"):
                if len(arguments.get(field) or "") > cs.MAX_TEXT:
                    return field + " is too long"
            if arguments.get("fitGrade") not in ("A", "B"):
                return "fitGrade must be A or B"
        return None

    def tool(self, name, arguments):
        if name in self.plain:
            return {"content": [{"type": "text", "text": self.plain[name]}]}
        if name in self.fail:
            return {"isError": True, "content": [{"type": "text", "text": self.fail[name]}]}
        if name in self.fail_once:
            if self.inject_on_fail:
                self.inject_on_fail(arguments)  # something else happens to the job meanwhile
            return {"isError": True, "content": [{"type": "text", "text": self.fail_once.pop(name)}]}
        invalid = self.invalid_input(name, arguments)
        if invalid:
            return {"isError": True, "content": [{"type": "text", "text": "MCP error -32602: Input validation error: " + invalid}]}
        if name == "find_job":
            found = self.job_urls.get(arguments["jobUrl"])
            text = ('Found existing job "Role" at "Co" (id: %s, status: draft, description: full).' % found
                    if found else "No saved job matches that URL — call add_job to create it.")
        elif name == "get_job":
            job = arguments["jobId"]
            text = json.dumps({"id": job, "jobUrl": self.job_links.get(job),
                               "packages": list(reversed(self.packages.get(job, [])))})
        elif name == "add_job":
            company, title, link = arguments["company"], arguments["jobTitle"], arguments.get("jobUrl")
            found = None
            if not arguments.get("allowDuplicate"):  # the real flag skips both dedupe tiers
                found = self.job_urls.get(link) if link else None
                found = found or self.job_names.get(company + "|" + title)
            if found and arguments.get("upsert"):
                text = "Job %s updated. Fields changed: description." % found
            elif found:
                text = 'Duplicate detected — existing job "%s" at "%s" (id: %s). Call update_job.' % (title, company, found)
            else:
                found = self.new_id()
                self.job_names.setdefault(company + "|" + title, found)
                self.packages[found] = []
                if link:
                    self.job_urls[link] = found
                    self.job_links[found] = link
                text = "Created %s; Created %s. Job created (id: %s). Done." % (company, title, found)
        elif name == "attach_file":
            self.files += 1
            text = json.dumps({"fileId": "file-%d" % self.files, "fileName": arguments["fileName"], "sizeBytes": 10})
        elif name == "submit_application_package":
            key, job = arguments["idempotencyKey"], arguments["jobId"]
            if key in self.keys and self.keys[key][0] != job:
                return {"isError": True, "content": [{"type": "text", "text": "CONFLICT: That key belongs to another job."}]}
            again = key in self.keys
            superseded = []
            if not again:
                package_id = "pkg-%d" % (len(self.keys) + 1)
                self.keys[key] = (job, package_id)
                packages = self.packages.setdefault(job, [])
                for p in packages:
                    if p["status"] in ("pending", "approved", "changes_requested"):
                        p["status"] = "superseded"
                        superseded.append(p["id"])
                packages.append({"id": package_id, "version": len(packages) + 1, "status": "pending",
                                 "idempotencyKey": key, "emailSubject": arguments["emailSubject"],
                                 "emailBody": arguments["emailBody"], "letterMd": arguments.get("letterMd"),
                                 "fitGrade": arguments["fitGrade"]})
                # An answered change request is closed: it no longer shows up in the list.
                self.change_requests = [c for c in self.change_requests if c.get("jobId") != job]
            version = next(p["version"] for p in self.packages[job] if p["id"] == self.keys[key][1])
            text = json.dumps({"packageId": self.keys[key][1], "version": version, "status": "pending",
                               "supersededIds": superseded, "idempotent": again})
        elif name == "list_jobs":
            text = json.dumps({"total": 0, "jobs": []})
        elif name == "list_change_requests":
            text = json.dumps(self.change_requests[: arguments.get("limit", 50)])
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
    def make_folder(self, name="2026-11-09_acme_backend-engineer", **overrides):
        folder = Path(tempfile.mkdtemp()) / name
        folder.mkdir()
        self.addCleanup(lambda: shutil.rmtree(folder.parent, ignore_errors=True))
        files = {
            "letter.md": "Dear team,\n\nI would like to apply.\n",
            "posting.md": "Posting text, long enough to be a description.",
            "cv.json": json.dumps({"name": "Jane Doe"}),
        }
        files.update(overrides)
        for fname, content in files.items():
            if content is not None:
                (folder / fname).write_text(content, encoding="utf-8")
        (folder / "Jane_Doe_CV_Acme.pdf").write_bytes(PDF)
        return folder


class HelperTests(unittest.TestCase):
    def test_key_identifies_a_posting_not_a_day_or_a_folder(self):
        key = cs.idempotency_key("Société Générale", "Développeur (H/F)", "https://x.example/1")
        self.assertRegex(key, KEY_RE)
        self.assertEqual(key, cs.idempotency_key("Société Générale", "Développeur (H/F)", "https://x.example/1"))

    def test_same_company_and_role_with_another_link_is_another_key(self):
        self.assertNotEqual(cs.idempotency_key("Acme", "Dev", "https://x.example/geneva"),
                            cs.idempotency_key("Acme", "Dev", "https://x.example/paris"))

    def test_keys_stay_valid_and_short(self):
        key = cs.idempotency_key("A" * 300, "B" * 300, "https://x.example/" + "y" * 300, "pkg-" + "z" * 80, "d" * 64)
        self.assertRegex(key, KEY_RE)
        self.assertRegex(cs.idempotency_key("世界", "世界", ""), KEY_RE)
        self.assertEqual(cs.idempotency_key("", "", "", "pkg-1"), cs.idempotency_key("x", "y", "z", "pkg-1"))
        self.assertNotEqual(cs.idempotency_key("", "", "", "pkg-1"), cs.idempotency_key("", "", "", "pkg-2"))

    def test_slug_never_empty(self):
        self.assertEqual(cs.slug("!!!", 10), "x")

    def test_build_body_apply_via_link(self):
        body = cs.build_body("Dear team", "", "https://example.com/job")
        self.assertEqual(body.splitlines()[0], "Apply via: https://example.com/job")
        self.assertEqual(cs.build_body("Dear team\n", "hr@example.com", "https://example.com/job"), "Dear team")
        text = "Apply via: https://example.com/job\n\nDear team"
        self.assertEqual(cs.build_body(text, "", "https://example.com/job"), text)

    def test_parse_job_id_in_every_wording_the_server_uses(self):
        job = JOB % 7
        for text in (
            "Created Acme; Created Role. Job created (id: %s). Done." % job,
            'Duplicate detected — existing job "QA" at "Acme" (id: %s). To enrich it, call update_job' % job,
            "Job %s updated. Fields changed: companyId, jobTitleId, jobUrl, description." % job,
            'Found existing job "QA" at "Acme" (id: %s, status: draft).' % job,
        ):
            self.assertEqual(cs.parse_job_id(text), job, text)
        with self.assertRaises(cs.CockpitError):
            cs.parse_job_id("no id here")

    def test_parse_job_id_prefers_the_id_label_over_other_uuids(self):
        job, other = JOB % 7, JOB % 8
        self.assertEqual(cs.parse_job_id('Duplicate of %s. Existing job (id: %s).' % (other, job)), job)

    def test_plain_text_failures_get_their_own_codes(self):
        with self.assertRaises(cs.CockpitError) as raised:
            cs.parse_job_id("Rate limit exceeded. Try again in 12s.")
        self.assertEqual(raised.exception.code, "RATE_LIMITED")
        with self.assertRaises(cs.CockpitError) as raised:
            cs.parse_job_id("Insufficient scope. Required: jobs:write")
        self.assertEqual(raised.exception.code, "UNAUTHORIZED_SCOPE")

    def test_validate_package_refuses_what_the_server_would_refuse(self):
        ok = dict(subject="Application", recipient="hr@example.com", body="Hello", letter="Hello", fit="A")
        cs.validate_package(**ok)
        for bad in (
            dict(subject="two\nlines"), dict(subject=""), dict(subject="x" * 301),
            dict(recipient="not-an-address"), dict(recipient="a@example.com,b@example.com"),
            dict(recipient="prénom@example.com"), dict(recipient="a..b@example.com"), dict(recipient="a@b.c"),
            dict(body="   "), dict(body="x" * 20001), dict(fit="C"),
            dict(cv_json={"x": "y" * 200_001}), dict(fit_analysis={"x": "y" * 20_001}),
        ):
            with self.assertRaises(cs.CockpitError, msg=str(bad)[:60]) as raised:
                cs.validate_package(**dict(ok, **bad))
            self.assertEqual(raised.exception.code, "VALIDATION")

    def test_lengths_count_utf16_units_like_the_server(self):
        ok = dict(recipient="", body="Hello", letter="Hello", fit="A")
        cs.validate_package(subject="\U0001F600" * 150, **ok)  # 150 emoji = 300 units: allowed
        with self.assertRaises(cs.CockpitError):
            cs.validate_package(subject="\U0001F600" * 151, **ok)  # 302 units: refused

    def test_safe_pdf_name(self):
        self.assertEqual(cs.safe_pdf_name("CV.pdf"), "CV.pdf")
        long_name = cs.safe_pdf_name("a" * 300 + ".pdf")
        self.assertLessEqual(len(long_name), 120)
        self.assertTrue(long_name.endswith(".pdf"))

    def test_endpoint_rules(self):
        cs.check_endpoint("http://localhost:3737/api/mcp")
        cs.check_endpoint("http://127.0.0.1:3737/api/mcp")
        cs.check_endpoint("https://cockpit.example.com/api/mcp")
        with self.assertRaises(cs.CockpitError) as raised:
            cs.check_endpoint("http://cockpit.example.com/api/mcp")
        self.assertEqual(raised.exception.code, "INSECURE_URL")
        with mock.patch.dict(os.environ, {"COCKPIT_ALLOW_HTTP": "1"}):
            cs.check_endpoint("http://100.64.0.1:3737/api/mcp")
        with self.assertRaises(cs.CockpitError):
            cs.check_endpoint("ftp://x")


class ProxyTests(unittest.TestCase):
    def proxies(self, url):
        env = {"HTTP_PROXY": "http://proxy.example:8080", "http_proxy": "http://proxy.example:8080",
               "HTTPS_PROXY": "http://proxy.example:8080", "https_proxy": "http://proxy.example:8080"}
        with mock.patch.dict(os.environ, env):
            opener = cs._opener(url)
        return [h.proxies for h in opener.handlers if isinstance(h, urllib.request.ProxyHandler)]

    def test_the_default_endpoint_is_the_ipv4_loopback_address(self):
        # "localhost" costs ~20 s per request on Windows (IPv6 tried first).
        self.assertEqual(cs.DEFAULT_URL, "http://127.0.0.1:3737/api/mcp")
        cs.check_endpoint(cs.DEFAULT_URL)

    def test_a_system_proxy_never_sees_a_token_meant_for_localhost(self):
        # An empty ProxyHandler replaces urllib's default one and registers nothing,
        # so "no active proxy handler at all" is the correct outcome for loopback.
        for url in ("http://localhost:3737/api/mcp", "http://127.0.0.1:3737/api/mcp"):
            self.assertEqual(self.proxies(url), [], url)

    def test_other_hosts_keep_the_normal_proxy_settings(self):
        (found,) = self.proxies("https://cockpit.example.com/api/mcp")
        self.assertIn("https", found)


class TokenTests(unittest.TestCase):
    def load(self, raw):
        path = Path(tempfile.mkdtemp()) / "t.txt"
        self.addCleanup(lambda: shutil.rmtree(path.parent, ignore_errors=True))
        path.write_bytes(raw)
        with mock.patch.dict(os.environ, {"COCKPIT_TOKEN": "", "COCKPIT_TOKEN_FILE": str(path)}):
            return cs.load_token()

    def test_plain_bom_and_utf16_files(self):
        self.assertEqual(self.load((TOKEN + "\r\n").encode()), TOKEN)
        self.assertEqual(self.load(b"\xef\xbb\xbf" + TOKEN.encode()), TOKEN)
        self.assertEqual(self.load(("﻿" + TOKEN + "\r\n").encode("utf-16")), TOKEN)

    def test_garbage_and_empty_are_refused(self):
        with self.assertRaises(cs.CockpitError):
            self.load(b"")
        with self.assertRaises(cs.CockpitError) as raised:
            self.load(b"jsync_abc def\nsecond line")
        self.assertEqual(raised.exception.code, "NO_TOKEN")


class CommandTests(FolderMixin, unittest.TestCase):
    def setUp(self):
        self.stub = Stub()
        self.addCleanup(self.stub.close)

    def args(self, folder, *extra, company="Acme", role="Backend Engineer", link=LINK, subject="Application - Backend Engineer - Jane Doe", fit="A"):
        base = ["--endpoint", self.stub.url, "submit", "--folder", str(folder),
                "--company", company, "--role", role, "--subject", subject,
                "--fit", fit, "--track", "Fintech", "--location", "Geneva",
                "--reasons", "stack overlap; location"]
        if link:
            base += ["--url", link]
        return base + list(extra)

    # ---- the happy paths

    def test_submit_creates_the_job_uploads_and_submits(self):
        folder = self.make_folder()
        code, result, _ = run(self.args(folder))
        self.assertEqual(code, 0, result)
        self.assertTrue(result["applyViaLink"])
        self.assertEqual([c[0] for c in self.stub.calls], ["find_job", "add_job", "attach_file", "submit_application_package"])

        job = self.stub.calls[1][1]
        self.assertEqual((job["company"], job["jobTitle"], job["jobUrl"]), ("Acme", "Backend Engineer", LINK))
        self.assertTrue(job["allowDuplicate"])  # a new link is a new posting
        self.assertNotIn("upsert", job)

        attach = self.stub.calls[2][1]
        self.assertEqual(attach["fileName"], "Jane_Doe_CV_Acme.pdf")
        self.assertEqual(base64.b64decode(attach["contentBase64"]), PDF)

        package = self.stub.calls[3][1]
        self.assertEqual(package["emailTo"], "")
        self.assertEqual(package["emailBody"].splitlines()[0], "Apply via: " + LINK)
        self.assertEqual(package["fitAnalysis"], {"verdict": "A", "track": "Fintech", "location": "Geneva",
                                                  "reasons": ["stack overlap", "location"]})
        self.assertEqual(package["cvFileId"], "file-1")
        self.assertEqual(package["sourceFolder"], folder.name)
        self.assertRegex(package["idempotencyKey"], KEY_RE)
        self.assertEqual(set(self.stub.auth), {"Bearer " + TOKEN})

    def test_a_job_that_exists_without_a_package_is_reused(self):
        job_id = self.stub.seed_job()
        code, result, _ = run(self.args(self.make_folder()))
        self.assertEqual(code, 0, result)
        self.assertEqual(result["jobId"], job_id)
        self.assertEqual([c[0] for c in self.stub.calls], ["find_job", "get_job", "attach_file", "submit_application_package"])

    def test_two_postings_with_the_same_company_and_title_stay_two_applications(self):
        first = run(self.args(self.make_folder(), link="https://example.com/job/geneva"))[1]
        second = run(self.args(self.make_folder(), link="https://example.com/job/paris"))[1]
        self.assertTrue(first["ok"] and second["ok"])
        self.assertNotEqual(first["jobId"], second["jobId"])
        self.assertNotEqual(first["packageId"], second["packageId"])
        self.assertEqual(len(self.stub.names("add_job")), 2)

    def test_with_a_recipient_there_is_no_apply_via_line(self):
        code, result, _ = run(self.args(self.make_folder(), "--to", "hr@example.com"))
        self.assertEqual(code, 0)
        self.assertFalse(result["applyViaLink"])
        package = self.stub.calls[-1][1]
        self.assertEqual(package["emailTo"], "hr@example.com")
        self.assertNotIn("Apply via", package["emailBody"])

    def test_meta_file_carries_the_values_and_options_override_it(self):
        folder = self.make_folder()
        meta = folder / "meta.json"
        meta.write_text(json.dumps({
            "company": 'Evil" Co $(rm -rf /) `x`', "role": "Dev", "subject": "Application - Dev - Jane Doe",
            "fit": "B", "url": "https://example.com/job/9", "to": "hr@example.com", "track": "AI",
        }), encoding="utf-8")
        code, _, _ = run(["--endpoint", self.stub.url, "submit", "--folder", str(folder), "--meta", str(meta), "--fit", "A"])
        self.assertEqual(code, 0)
        job = [c for c in self.stub.calls if c[0] == "add_job"][0][1]
        self.assertEqual(job["company"], 'Evil" Co $(rm -rf /) `x`')  # travels as data, never through a shell
        package = self.stub.calls[-1][1]
        self.assertEqual((package["fitGrade"], package["emailTo"]), ("A", "hr@example.com"))

    def test_missing_required_values_are_named(self):
        code, result, _ = run(["--endpoint", self.stub.url, "submit", "--folder", str(self.make_folder())])
        self.assertEqual((code, result["error"]), (1, "VALIDATION"))
        self.assertIn("company", result["message"])

    # ---- a job that already has a package must never be replaced by accident

    def test_finding_the_same_posting_again_never_replaces_the_package_under_review(self):
        first = run(self.args(self.make_folder(name="2026-11-09_acme_backend")))[1]
        self.assertTrue(first["ok"])
        # next day: a new dated folder (so no marker), the same posting, a regenerated letter
        regenerated = self.make_folder(name="2026-11-10_acme_backend", **{"letter.md": "A freshly written letter.\n"})
        code, result, _ = run(self.args(regenerated))
        self.assertEqual((code, result["error"]), (1, "ALREADY_SUBMITTED"))
        self.assertEqual(result["packageId"], first["packageId"])
        self.assertEqual(self.stub.files, 1)  # nothing uploaded the second time
        self.assertEqual(len(self.stub.names("submit_application_package")), 1)

    def test_the_status_of_the_existing_package_picks_the_code(self):
        for status, code in (("sent", "ALREADY_SENT"), ("rejected", "JOB_REJECTED"),
                             ("approved", "ALREADY_SUBMITTED"), ("pending", "ALREADY_SUBMITTED")):
            stub = Stub()
            self.addCleanup(stub.close)
            stub.seed_job(status=status)
            argv = self.args(self.make_folder())
            argv[1] = stub.url  # ["--endpoint", <url>, "submit", ...]
            result = run(argv)[1]
            self.assertEqual(result["error"], code, status)
            self.assertEqual(result["status"], status)

    def test_a_package_waiting_for_changes_points_at_the_revision_flow(self):
        self.stub.seed_job(status="changes_requested")
        result = run(self.args(self.make_folder()))[1]
        self.assertEqual(result["error"], "ALREADY_SUBMITTED")
        self.assertIn("--revision seeded-pkg-changes_requested", result["message"])

    def test_a_superseded_old_package_does_not_block(self):
        self.stub.seed_job(status="superseded")
        self.assertTrue(run(self.args(self.make_folder()))[1]["ok"])

    def test_resubmit_is_the_explicit_way_past_the_guard(self):
        self.stub.seed_job(status="pending")
        code, result, _ = run(self.args(self.make_folder(), "--resubmit"))
        self.assertEqual(code, 0, result)
        self.assertNotIn("get_job", [c[0] for c in self.stub.calls])

    def test_an_unexpected_find_job_answer_never_creates_a_duplicate_job(self):
        self.stub.plain["find_job"] = "Error: database unavailable"
        code, result, _ = run(self.args(self.make_folder()))
        self.assertEqual((code, result["error"]), (1, "TOOL_ERROR"))
        self.assertEqual(self.stub.names("add_job"), [])
        self.assertEqual(self.stub.files, 0)

    def test_without_a_link_a_duplicate_is_reused_unchanged_and_guarded(self):
        first = run(self.args(self.make_folder(name="2026-11-09_acme_a"), link=""))[1]
        self.assertTrue(first["ok"])
        add_job = [c for c in self.stub.calls if c[0] == "add_job"][0][1]
        self.assertNotIn("upsert", add_job)  # never overwrites another posting's fields
        self.assertNotIn("allowDuplicate", add_job)
        self.assertEqual(self.stub.names("find_job"), [])
        second = run(self.args(self.make_folder(name="2026-11-10_acme_a", **{"letter.md": "Another letter.\n"}), link=""))[1]
        self.assertEqual(second["error"], "ALREADY_SUBMITTED")

    # ---- re-runs

    def test_an_identical_rerun_returns_the_same_package_without_new_requests(self):
        folder = self.make_folder()
        first = run(self.args(folder))[1]
        calls_after_first = len(self.stub.calls)
        second = run(self.args(folder))[1]
        self.assertFalse(first["idempotent"])
        self.assertTrue(second["idempotent"] and second["cached"])
        self.assertEqual(first["packageId"], second["packageId"])
        self.assertEqual(len(self.stub.calls), calls_after_first)
        self.assertEqual(self.stub.files, 1)

    def test_corrected_content_is_never_silently_ignored(self):
        folder = self.make_folder()
        run(self.args(folder))
        (folder / "letter.md").write_text("A corrected letter.\n", encoding="utf-8")
        code, result, _ = run(self.args(folder))
        self.assertEqual((code, result["error"]), (1, "CONTENT_CHANGED"))
        self.assertIn("--resubmit", result["message"])
        self.assertEqual(len(self.stub.names("submit_application_package")), 1)

    def test_a_changed_grade_or_track_counts_as_changed_content(self):
        folder = self.make_folder()
        run(self.args(folder))
        self.assertEqual(run(self.args(folder, fit="B"))[1]["error"], "CONTENT_CHANGED")
        argv = self.args(folder)
        argv[argv.index("Fintech")] = "AI"
        self.assertEqual(run(argv)[1]["error"], "CONTENT_CHANGED")

    def test_resubmit_sends_the_corrected_content_under_a_new_key_once(self):
        folder = self.make_folder()
        run(self.args(folder))
        (folder / "letter.md").write_text("A corrected letter.\n", encoding="utf-8")
        code, result, _ = run(self.args(folder, "--resubmit"))
        self.assertEqual(code, 0, result)
        keys = [c[1]["idempotencyKey"] for c in self.stub.calls if c[0] == "submit_application_package"]
        self.assertEqual(len(set(keys)), 2)
        again = run(self.args(folder, "--resubmit"))[1]
        self.assertTrue(again["cached"])  # the same correction twice is a no-op

    def test_a_lost_or_corrupt_marker_recognises_its_own_package_and_adds_no_second_one(self):
        folder = self.make_folder()
        first = run(self.args(folder))[1]
        (folder / ".cockpit-submitted.json").write_text("not json", encoding="utf-8")  # e.g. a crash before the marker
        again = run(self.args(folder))[1]
        self.assertTrue(again["ok"] and again["idempotent"] and again["recovered"])
        self.assertEqual(again["packageId"], first["packageId"])
        self.assertEqual(self.stub.files, 1)  # no second upload
        self.assertEqual(len(self.stub.names("submit_application_package")), 1)
        self.assertTrue((folder / ".cockpit-submitted.json").is_file())  # the marker is rebuilt

    def test_the_same_posting_with_identical_content_is_only_a_harmless_replay(self):
        first = run(self.args(self.make_folder(name="2026-11-09_acme_backend")))[1]
        again = run(self.args(self.make_folder(name="2026-11-10_acme_backend")))[1]
        self.assertTrue(again["ok"] and again["recovered"])
        self.assertEqual(again["packageId"], first["packageId"])
        self.assertEqual(self.stub.files, 1)

    def test_a_package_with_the_same_key_but_different_content_is_never_called_a_success(self):
        folder = self.make_folder()
        run(self.args(folder))
        (folder / ".cockpit-submitted.json").unlink()  # marker lost AND the letter was regenerated
        (folder / "letter.md").write_text("Regenerated.\n", encoding="utf-8")
        self.assertEqual(run(self.args(folder))[1]["error"], "ALREADY_SUBMITTED")

    def test_resubmit_from_a_fresh_folder_really_creates_a_new_version(self):
        first = run(self.args(self.make_folder(name="2026-11-09_acme_backend")))[1]
        corrected = self.make_folder(name="2026-11-10_acme_backend", **{"letter.md": "A corrected letter.\n"})
        code, result, _ = run(self.args(corrected, "--resubmit"))
        self.assertEqual(code, 0, result)
        self.assertFalse(result["idempotent"])  # the server did NOT just replay the old package
        self.assertNotEqual(result["packageId"], first["packageId"])
        self.assertEqual(result["supersededIds"], [first["packageId"]])
        self.assertEqual(self.stub.files, 2)

    def test_a_failed_submit_leaves_no_marker(self):
        self.stub.fail["submit_application_package"] = "ALREADY_SENT: already sent"
        folder = self.make_folder()
        run(self.args(folder))
        self.assertFalse((folder / ".cockpit-submitted.json").exists())

    # ---- answering a change request

    def change_request(self, **overrides):
        job_id = self.stub.seed_job(link="https://example.com/job/rev", status="changes_requested")
        item = {
            "packageId": "pkg-9", "jobId": job_id, "company": "Acme", "jobTitle": "Backend Engineer",
            "version": 1, "changeRequest": "shorten the letter", "emailTo": "hr@example.com",
            "emailSubject": "Owner edited subject", "emailBody": "Owner edited body",
            "fitAnalysis": json.dumps({"verdict": "B", "track": "AI", "location": "Lausanne", "extra": {"keep": "me"}}),
            "sourceFolder": "2026-11-09_acme_backend-engineer",
        }
        item.update(overrides)
        self.stub.change_requests = [item]
        return job_id

    def revise(self, folder, *extra):
        return run(["--endpoint", self.stub.url, "submit", "--folder", str(folder), "--revision", "pkg-9", *extra])

    def test_revision_reuses_the_job_and_keeps_what_the_owner_set(self):
        job_id = self.change_request()
        code, result, _ = self.revise(self.make_folder())
        self.assertEqual(code, 0, result)
        self.assertEqual([c[0] for c in self.stub.calls], ["list_change_requests", "attach_file", "submit_application_package"])
        package = self.stub.calls[-1][1]
        self.assertEqual(package["jobId"], job_id)  # no add_job, no duplicate job
        self.assertEqual(package["emailTo"], "hr@example.com")
        self.assertEqual(package["emailSubject"], "Owner edited subject")
        self.assertEqual(package["fitGrade"], "B")
        self.assertEqual(package["idempotencyKey"], "scout-rev-pkg-9")
        self.assertEqual(package["fitAnalysis"]["track"], "AI")
        self.assertEqual(package["fitAnalysis"]["extra"], {"keep": "me"})  # nothing the owner stored is dropped

    def test_revision_options_override_the_package_values(self):
        self.change_request()
        self.revise(self.make_folder(), "--subject", "A new subject", "--fit", "A", "--to", "")
        package = self.stub.calls[-1][1]
        self.assertEqual((package["emailSubject"], package["fitGrade"], package["emailTo"]), ("A new subject", "A", ""))

    def test_revision_keeps_the_apply_via_line_of_the_previous_body(self):
        self.change_request(emailTo="", emailBody="Apply via: https://example.com/job/rev\n\nOld body")
        self.revise(self.make_folder())
        self.assertEqual(self.stub.calls[-1][1]["emailBody"].splitlines()[0], "Apply via: https://example.com/job/rev")

    def test_revision_finds_the_link_in_the_job_when_the_recipient_was_cleared(self):
        self.change_request(emailTo="", emailBody="Owner removed the link line")
        self.revise(self.make_folder())
        self.assertEqual(self.stub.calls[-1][1]["emailBody"].splitlines()[0], "Apply via: https://example.com/job/rev")
        self.assertIn("get_job", [c[0] for c in self.stub.calls])

    def test_revision_of_an_unknown_request_is_a_clear_error(self):
        code, result, _ = run(["--endpoint", self.stub.url, "submit", "--folder", str(self.make_folder()), "--revision", "pkg-404"])
        self.assertEqual((code, result["error"]), (1, "NOT_FOUND"))
        self.assertEqual(self.stub.files, 0)

    def test_retrying_an_answered_revision_is_a_cached_no_op_not_an_error(self):
        self.change_request()
        folder = self.make_folder()
        self.revise(folder)
        self.assertEqual(self.stub.change_requests, [])  # the server closed it, as the real one does
        calls = len(self.stub.calls)
        again = self.revise(folder)[1]
        self.assertTrue(again["ok"] and again["cached"])
        self.assertEqual(len(self.stub.calls), calls)  # no list_change_requests, no upload

    # ---- nothing is uploaded when the package would be refused

    def test_bad_fields_are_refused_before_any_upload(self):
        folder = self.make_folder()
        for extra in (["--to", "nobody"], ["--to", "prénom@example.com"], ["--subject", "two\nlines"]):
            code, result, _ = run(self.args(folder, *extra))
            self.assertEqual((code, result["error"]), (1, "VALIDATION"), extra)
        big = self.make_folder(**{"cv.json": json.dumps({"x": "y" * 200_001})})
        self.assertEqual(run(self.args(big))[1]["error"], "VALIDATION")
        self.assertEqual(self.stub.calls, [])
        self.assertEqual(self.stub.files, 0)

    def test_missing_files_fail_before_any_request(self):
        for fname in ("letter.md", "cv.json"):
            folder = self.make_folder(**{fname: None})
            code, result, _ = run(self.args(folder))
            self.assertEqual((code, result["error"]), (1, "FILE_NOT_FOUND"), fname)
        folder = self.make_folder()
        (folder / "Jane_Doe_CV_Acme.pdf").unlink()
        self.assertEqual(run(self.args(folder))[1]["error"], "FILE_NOT_FOUND")
        self.assertEqual(self.stub.calls, [])

    def test_cv_json_must_be_an_object(self):
        for content in ("not json", "[1, 2]"):
            code, result, _ = run(self.args(self.make_folder(**{"cv.json": content})))
            self.assertEqual((code, result["error"]), (1, "VALIDATION"), content)

    def test_files_with_a_byte_order_mark_are_read(self):
        folder = self.make_folder()
        (folder / "cv.json").write_bytes(b"\xef\xbb\xbf" + json.dumps({"name": "Jane Doe"}).encode())
        self.assertEqual(run(self.args(folder))[0], 0)

    def test_too_large_pdf_is_refused_locally(self):
        with mock.patch.object(cs, "MAX_PDF_BYTES", 5):
            code, result, _ = run(self.args(self.make_folder()))
        self.assertEqual((code, result["error"]), (1, "TOO_LARGE"))
        self.assertEqual(self.stub.calls, [])

    def test_the_cv_is_chosen_carefully_when_there_are_several_pdfs(self):
        folder = self.make_folder()
        (folder / "posting-saved.pdf").write_bytes(b"%PDF-1.4 other")
        self.assertEqual(run(self.args(folder))[0], 0)  # exactly one name contains "cv"
        self.assertEqual(self.stub.calls[-2][1]["fileName"], "Jane_Doe_CV_Acme.pdf")
        other = self.make_folder()
        (other / "second.pdf").write_bytes(b"%PDF-1.4 other")
        (other / "Jane_Doe_CV_Acme.pdf").rename(other / "first.pdf")
        code, result, _ = run(self.args(other, link="https://example.com/job/other"))
        self.assertEqual((code, result["error"]), (1, "AMBIGUOUS_PDF"))

    # ---- errors always come back as one JSON line

    def test_server_error_codes_pass_through(self):
        self.stub.fail["submit_application_package"] = "ALREADY_SENT: An application was already sent for this job."
        code, result, _ = run(self.args(self.make_folder()))
        self.assertEqual((code, result["ok"], result["error"]), (1, False, "ALREADY_SENT"))
        self.assertIn("already sent", result["message"])

    def test_sdk_validation_text_becomes_validation(self):
        self.stub.fail["add_job"] = "MCP error -32602: Input validation error: Invalid arguments for tool add_job: Invalid input at jobUrl"
        code, result, _ = run(self.args(self.make_folder()))
        self.assertEqual((code, result["error"]), (1, "VALIDATION"))
        self.assertIn("jobUrl", result["message"])

    def test_plain_text_rate_limit_and_scope_from_add_job(self):
        self.stub.plain["add_job"] = "Rate limit exceeded. Try again in 30s."
        self.assertEqual(run(self.args(self.make_folder()))[1]["error"], "RATE_LIMITED")
        self.stub.plain["add_job"] = "Insufficient scope. Required: jobs:write"
        self.assertEqual(run(self.args(self.make_folder(), link="https://example.com/job/2"))[1]["error"], "UNAUTHORIZED_SCOPE")

    def test_unauthorized_unreachable_and_timeout(self):
        self.stub.http_status = 401
        self.assertEqual(run(self.args(self.make_folder()))[1]["error"], "UNAUTHORIZED")
        self.assertEqual(run(["--endpoint", "http://127.0.0.1:9/api/mcp", "check"])[1]["error"], "UNREACHABLE")
        self.stub.http_status = 200
        self.stub.delay = 2
        with mock.patch.object(cs, "TIMEOUT_SECONDS", 1):
            self.assertEqual(run(["--endpoint", self.stub.url, "check"])[1]["error"], "TIMEOUT")

    def test_a_redirect_is_not_followed_and_the_token_goes_nowhere(self):
        elsewhere = Stub()
        self.addCleanup(elsewhere.close)
        self.stub.redirect_to = elsewhere.url
        code, result, raw = run(["--endpoint", self.stub.url, "check"])
        self.assertEqual((code, result["error"]), (1, "REDIRECTED"))
        self.assertEqual(elsewhere.auth, [])
        self.assertNotIn(TOKEN, raw)

    def test_garbage_answers_still_produce_one_json_line(self):
        self.stub.raw_body = "<html>login</html>"
        self.assertEqual(run(["--endpoint", self.stub.url, "check"])[1]["error"], "BAD_RESPONSE")
        self.stub.raw_body = None
        self.stub.tool = lambda name, arguments: {"content": [{"type": "text", "text": "oops"}]}
        code, result, _ = run(self.args(self.make_folder()))
        self.assertEqual((code, result["ok"]), (1, False))
        self.assertIn(result["error"], ("INTERNAL", "BAD_RESPONSE", "TOOL_ERROR"))

    def test_a_wrong_command_line_is_json_with_exit_code_2(self):
        out = io.StringIO()
        with mock.patch.dict(os.environ, {"COCKPIT_TOKEN": TOKEN}), contextlib.redirect_stdout(out):
            with self.assertRaises(SystemExit) as raised:
                cs.main(["submit"])
        self.assertEqual(raised.exception.code, 2)
        self.assertEqual(json.loads(out.getvalue())["error"], "USAGE")

    def test_plain_http_to_another_host_is_refused_before_any_request(self):
        code, result, _ = run(["--endpoint", "http://cockpit.example.com/api/mcp", "check"])
        self.assertEqual((code, result["error"]), (1, "INSECURE_URL"))

    # ---- token and output hygiene

    def test_no_token(self):
        out = io.StringIO()
        with mock.patch.dict(os.environ, {"COCKPIT_TOKEN": "", "COCKPIT_TOKEN_FILE": "/nonexistent/token.txt"}), \
                contextlib.redirect_stdout(out):
            code = cs.main(["--endpoint", self.stub.url, "check"])
        self.assertEqual((code, json.loads(out.getvalue())["error"]), (1, "NO_TOKEN"))

    def test_token_file_is_used_and_the_token_is_never_printed(self):
        token_file = Path(tempfile.mkdtemp()) / "cockpit_token.txt"
        self.addCleanup(lambda: shutil.rmtree(token_file.parent, ignore_errors=True))
        token_file.write_text(TOKEN + "\n", encoding="utf-8")
        out = io.StringIO()
        with mock.patch.dict(os.environ, {"COCKPIT_TOKEN": "", "COCKPIT_TOKEN_FILE": str(token_file)}), \
                contextlib.redirect_stdout(out):
            code = cs.main(["--endpoint", self.stub.url, "check"])
        self.assertEqual(code, 0)
        self.assertEqual(set(self.stub.auth), {"Bearer " + TOKEN})
        self.assertNotIn(TOKEN, out.getvalue())

    def test_the_token_is_redacted_even_from_unexpected_errors(self):
        with mock.patch.object(cs, "cmd_check", side_effect=RuntimeError("boom " + TOKEN)):
            _, result, raw = run(["--endpoint", self.stub.url, "check"])
        self.assertEqual(result["error"], "INTERNAL")
        self.assertNotIn(TOKEN, raw)

    def test_output_is_ascii_even_with_accents_and_symbols(self):
        # Success: accented values go to the server and the output stays ASCII.
        _, result, raw = run(self.args(self.make_folder(), company="Société Générale", role="Développeur — Back-end ✓"))
        raw.encode("ascii")
        self.assertTrue(result["ok"])
        # Failure: a server message with accents and symbols must come out as \\u escapes,
        # because a legacy Windows code page would crash on printing them.
        self.stub.fail["submit_application_package"] = "VALIDATION: Le sujet est invalide é — ✓"
        _, error, raw = run(self.args(self.make_folder(), link="https://example.com/job/accents"))
        raw.encode("ascii")  # raises on a raw accented character
        self.assertIn("é", error["message"])  # decoded back by any JSON reader

    # ---- the other commands

    def test_check_ok_and_missing_tools(self):
        code, result, _ = run(["--endpoint", self.stub.url, "check"])
        self.assertEqual(code, 0)
        self.assertIn("submit_application_package", result["tools"])
        self.stub.tools = ["add_job"]
        self.assertEqual(run(["--endpoint", self.stub.url, "check"])[1]["error"], "MISSING_TOOLS")

    def test_changes_and_done(self):
        self.change_request()
        code, result, _ = run(["--endpoint", self.stub.url, "changes"])
        self.assertEqual((code, result["changeRequests"][0]["packageId"]), (0, "pkg-9"))
        code, result, _ = run(["--endpoint", self.stub.url, "done", "--package", "pkg-9", "--response", "Shortened."])
        self.assertEqual((code, result["status"]), (0, "pending"))
        self.assertEqual(self.stub.calls[-1], ("mark_change_request_done", {"packageId": "pkg-9", "response": "Shortened."}))



class ReviewFindingTests(FolderMixin, unittest.TestCase):
    """Issue 61: hand-over script review."""

    def setUp(self):
        self.stub = Stub()
        self.addCleanup(self.stub.close)

    def submit_args(self, folder, *extra):
        return ["--endpoint", self.stub.url, "submit", "--folder", str(folder),
                "--company", "Acme", "--role", "Backend Engineer", "--subject", "Application",
                "--fit", "A", "--url", LINK, *extra]

    def open_request(self, **overrides):
        job_id = self.stub.seed_job(link="https://example.com/job/rev", status="changes_requested")
        item = {"packageId": "pkg-9", "jobId": job_id, "company": "Acme", "jobTitle": "Engineer",
                "version": 1, "changeRequest": "shorten", "emailTo": "hr@example.com",
                "emailSubject": "S", "emailBody": "B", "letterMd": "L" * 5000,
                "cvJson": {"name": "x" * 5000}, "fitAnalysis": "{}", "sourceFolder": "folder-1"}
        item.update(overrides)
        self.stub.change_requests = [item]

    # 1. the token and the marker must never be committable
    def test_token_folder_and_marker_are_git_ignored(self):
        root = Path(cs.__file__).resolve().parents[2]
        if not (root / ".gitignore").is_file() or shutil.which("git") is None:
            self.skipTest("not inside a git checkout")
        for path in ("scripts/bot/secrets/cockpit_token.txt", "applications/x/.cockpit-submitted.json",
                     "applications/x/.cockpit-submitted.json.tmp"):
            done = subprocess.run(["git", "check-ignore", "-q", path], cwd=str(root))
            self.assertEqual(done.returncode, 0, path)

    # 2. changes prints a summary by default
    def test_changes_is_a_summary_unless_full(self):
        self.open_request()
        code, result, raw = run(["--endpoint", self.stub.url, "changes"])
        (item,) = result["changeRequests"]
        self.assertEqual(item["packageId"], "pkg-9")
        self.assertEqual(item["changeRequest"], "shorten")
        for heavy in ("cvJson", "letterMd", "emailBody", "fitAnalysis"):
            self.assertNotIn(heavy, item)
        self.assertLess(len(raw), 1000)
        full = run(["--endpoint", self.stub.url, "changes", "--full"])[1]["changeRequests"][0]
        self.assertEqual(len(full["letterMd"]), 5000)
        one = run(["--endpoint", self.stub.url, "changes", "--package", "pkg-9"])[1]["changeRequests"][0]
        self.assertIn("cvJson", one)
        missing = run(["--endpoint", self.stub.url, "changes", "--package", "nope"])
        self.assertEqual((missing[0], missing[1]["error"]), (1, "NOT_FOUND"))

    # 3. the fit grade comes from the package column
    def test_revision_takes_the_fit_from_the_package_grade(self):
        self.open_request(fitGrade="B", fitAnalysis="{}")  # no verdict key in the analysis
        code, result, _ = run(["--endpoint", self.stub.url, "submit", "--folder", str(self.make_folder()),
                               "--revision", "pkg-9"])
        self.assertEqual(code, 0, result)
        self.assertEqual(self.stub.calls[-1][1]["fitGrade"], "B")

    # 4. one bounded retry on CONFLICT
    def test_a_conflict_is_replayed_once(self):
        self.stub.fail_once["submit_application_package"] = "CONFLICT: busy"
        code, result, _ = run(self.submit_args(self.make_folder()))
        self.assertEqual(code, 0, result)
        self.assertEqual(len(self.stub.names("submit_application_package")), 2)

    def test_a_second_conflict_is_reported_not_retried_again(self):
        self.stub.fail["submit_application_package"] = "CONFLICT: That key belongs to another job."
        code, result, _ = run(self.submit_args(self.make_folder()))
        self.assertEqual((code, result["error"]), (1, "CONFLICT"))
        self.assertEqual(len(self.stub.names("submit_application_package")), 2)

    def test_other_errors_are_not_retried(self):
        self.stub.fail["submit_application_package"] = "INVALID_STATE: locked"
        code, result, _ = run(self.submit_args(self.make_folder()))
        self.assertEqual((code, result["error"]), (1, "INVALID_STATE"))
        self.assertEqual(len(self.stub.names("submit_application_package")), 1)

    # 8. --help keeps the one-JSON-line promise
    def test_help_is_one_json_line(self):
        for argv in (["--help"], ["submit", "--help"]):
            out = io.StringIO()
            with contextlib.redirect_stdout(out), self.assertRaises(SystemExit) as raised:
                cs.main(argv)
            self.assertEqual(raised.exception.code, 0)
            lines = out.getvalue().strip().splitlines()
            self.assertEqual(len(lines), 1)
            self.assertTrue(json.loads(lines[0])["ok"])

    # 9. a lone surrogate is a count, not an INTERNAL crash
    def test_lone_surrogate_in_cv_json(self):
        self.assertEqual(cs.u16len("a" + chr(0xD800)), 2)
        folder = self.make_folder(**{"cv.json": '{"name": "a\\ud800"}'})
        code, result, _ = run(self.submit_args(folder))
        self.assertEqual(code, 0, result)

    # 10. not a PDF: refused before any upload
    def test_a_file_that_is_not_a_pdf_is_refused_locally(self):
        folder = self.make_folder()
        (folder / "Jane_Doe_CV_Acme.pdf").write_bytes(b"<html>login page</html>")
        code, result, _ = run(self.submit_args(folder))
        self.assertEqual((code, result["error"]), (1, "VALIDATION"))
        self.assertIn("PDF", result["message"])
        self.assertEqual(self.stub.calls, [])

    # 13. the marker is written atomically
    def test_a_failed_marker_write_leaves_the_old_marker_intact(self):
        folder = self.make_folder()
        cs.write_marker(folder, "key-a", "d1", {"packageId": "p1"})
        with mock.patch("cockpit_submit.os.replace", side_effect=OSError("disk")):
            cs.write_marker(folder, "key-b", "d2", {"packageId": "p2"})
        self.assertEqual(cs.read_marker(folder, "key-a")["digest"], "d1")
        self.assertIsNone(cs.read_marker(folder, "key-b"))
        self.assertEqual(sorted(p.name for p in folder.glob(".cockpit*")), [".cockpit-submitted.json"])

    # 14. a full list says so
    def test_revision_not_found_in_a_full_list_says_the_list_was_full(self):
        self.stub.change_requests = [{"packageId": "other-%d" % i, "jobId": JOB % 1} for i in range(cs.MAX_CHANGE_REQUESTS)]
        code, result, _ = run(["--endpoint", self.stub.url, "submit", "--folder", str(self.make_folder()),
                               "--revision", "pkg-404"])
        self.assertEqual((code, result["error"]), (1, "NOT_FOUND"))
        self.assertIn("full", result["message"])
        self.assertNotIn("already answered", result["message"])
        self.assertEqual(self.stub.calls[0][1]["limit"], cs.MAX_CHANGE_REQUESTS)

    # stub fidelity: the stub now enforces what the server enforces
    def test_the_stub_rejects_what_the_server_rejects(self):
        junk = base64.b64encode(b"not a pdf").decode()
        reply = self.stub.tool("attach_file", {"fileName": "a.pdf", "mimeType": "application/pdf", "contentBase64": junk})
        self.assertTrue(reply["isError"])
        reply = self.stub.tool("submit_application_package", {
            "jobId": JOB % 1, "idempotencyKey": "bad key!", "emailSubject": "s", "emailBody": "b", "fitGrade": "A"})
        self.assertTrue(reply["isError"])


class ReviewHardeningTests(FolderMixin, unittest.TestCase):
    """Independent tester for PR 67: the same fixes, checked against the stub's STATE, not call counts."""

    def setUp(self):
        self.stub = Stub()
        self.addCleanup(self.stub.close)

    def submit_args(self, folder, *extra):
        return ["--endpoint", self.stub.url, "submit", "--folder", str(folder),
                "--company", "Acme", "--role", "Backend Engineer", "--subject", "Application",
                "--fit", "A", "--url", LINK, *extra]

    def real_packages(self):
        return [p for packages in self.stub.packages.values() for p in packages]

    def open_request(self, **overrides):
        job_id = self.stub.seed_job(link="https://example.com/job/rev2", status="changes_requested")
        item = {"packageId": "pkg-9", "jobId": job_id, "company": "Acme", "jobTitle": "Engineer",
                "version": 1, "changeRequest": "shorten", "emailTo": "hr@example.com",
                "emailSubject": "S", "emailBody": "SENTINEL_BODY", "letterMd": "SENTINEL_LETTER",
                "cvJson": {"name": "SENTINEL_CV"}, "fitAnalysis": "{}", "sourceFolder": "folder-1",
                "unexpectedKey": "SENTINEL_EXTRA"}
        item.update(overrides)
        self.stub.change_requests = [item]
        return job_id

    # CONFLICT: replay is idempotent in the stub's state
    def test_conflict_replay_creates_one_package_and_one_key(self):
        self.stub.fail_once["submit_application_package"] = "CONFLICT: busy"
        folder = self.make_folder()
        code, result, _ = run(self.submit_args(folder))
        self.assertEqual(code, 0, result)
        submits = [a for n, a in self.stub.calls if n == "submit_application_package"]
        self.assertEqual(len(submits), 2)
        self.assertEqual(submits[0]["idempotencyKey"], submits[1]["idempotencyKey"])
        self.assertEqual(len(self.stub.keys), 1)
        self.assertEqual(len(self.real_packages()), 1)
        self.assertEqual(self.real_packages()[0]["id"], result["packageId"])
        for field in ("jobId", "emailBody", "letterMd", "emailSubject", "fitGrade", "cvJson"):
            self.assertEqual(submits[0][field], submits[1][field], field)
        self.assertEqual(len(self.stub.names("add_job")), 1)

    def test_conflict_after_the_server_already_stored_the_package(self):
        """The first submit reaches the server, the answer is a CONFLICT: the replay must reuse it."""
        real = self.stub.tool
        state = {"done": False}

        def lose_first_answer(name, arguments):
            reply = real(name, arguments)
            if name == "submit_application_package" and not state["done"]:
                state["done"] = True
                return {"isError": True, "content": [{"type": "text", "text": "CONFLICT: send in progress"}]}
            return reply

        self.stub.tool = lose_first_answer
        folder = self.make_folder()
        code, result, _ = run(self.submit_args(folder))
        self.assertEqual(code, 0, result)
        self.assertTrue(result["idempotent"])
        self.assertEqual(len(self.real_packages()), 1)
        self.assertEqual(result["packageId"], self.real_packages()[0]["id"])

    def test_two_conflicts_leave_nothing_behind_and_no_marker(self):
        self.stub.fail["submit_application_package"] = "CONFLICT: busy"
        folder = self.make_folder()
        code, result, _ = run(self.submit_args(folder))
        self.assertEqual((code, result["error"]), (1, "CONFLICT"))
        self.assertEqual(len(self.stub.names("submit_application_package")), 2)
        self.assertEqual(self.real_packages(), [])
        self.assertEqual(self.stub.keys, {})
        self.assertFalse((folder / cs.MARKER_NAME).exists())

    # changes summary: no letter, CV or email content, no token, whitelist only
    def test_changes_summary_never_prints_content_or_token(self):
        self.open_request()
        for argv in (["changes"], ["changes", "--limit", "5"]):
            code, result, raw = run(["--endpoint", self.stub.url] + argv)
            self.assertEqual(code, 0)
            for secret in ("SENTINEL_BODY", "SENTINEL_LETTER", "SENTINEL_CV", "SENTINEL_EXTRA", TOKEN):
                self.assertNotIn(secret, raw)
            self.assertEqual(len(raw.strip().splitlines()), 1)
        full = run(["--endpoint", self.stub.url, "changes", "--full"])[2]
        self.assertIn("SENTINEL_LETTER", full)
        self.assertNotIn(TOKEN, full)
        one = run(["--endpoint", self.stub.url, "changes", "--package", "pkg-9"])[2]
        self.assertIn("SENTINEL_CV", one)
        self.assertNotIn(TOKEN, one)

    def test_changes_summary_survives_items_with_missing_keys(self):
        self.stub.change_requests = [{"packageId": "p-1"}]
        code, result, _ = run(["--endpoint", self.stub.url, "changes"])
        self.assertEqual((code, result["changeRequests"]), (0, [{"packageId": "p-1"}]))

    # --help in a real process: exit 0, one JSON line, nothing on stderr
    def test_help_in_a_real_process(self):
        env = {k: v for k, v in os.environ.items() if k != "COCKPIT_TOKEN"}
        for argv in (["--help"], ["submit", "--help"], ["changes", "-h"]):
            done = subprocess.run([sys.executable, cs.__file__] + argv, capture_output=True, text=True,
                                  env=env, cwd=tempfile.gettempdir(), timeout=60)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(len(done.stdout.strip().splitlines()), 1)
            self.assertTrue(json.loads(done.stdout)["ok"])
            self.assertEqual(done.stderr, "")

    # --revision: the package grade wins over a stale verdict in the analysis, an explicit --fit wins over both
    def test_revision_grade_beats_the_analysis_verdict(self):
        self.open_request(fitGrade="B", fitAnalysis=json.dumps({"verdict": "A"}))
        code, result, _ = run(["--endpoint", self.stub.url, "submit", "--folder", str(self.make_folder()),
                               "--revision", "pkg-9"])
        self.assertEqual(code, 0, result)
        self.assertEqual(self.stub.calls[-1][1]["fitGrade"], "B")

    def test_revision_falls_back_to_the_verdict_and_explicit_fit_wins(self):
        self.open_request(fitGrade=None, fitAnalysis=json.dumps({"verdict": "B"}))
        code, result, _ = run(["--endpoint", self.stub.url, "submit", "--folder", str(self.make_folder()),
                               "--revision", "pkg-9"])
        self.assertEqual(code, 0, result)
        self.assertEqual(self.stub.calls[-1][1]["fitGrade"], "B")
        self.open_request(packageId="pkg-10", fitGrade="B")
        code, result, _ = run(["--endpoint", self.stub.url, "submit", "--folder", str(self.make_folder()),
                               "--revision", "pkg-10", "--fit", "A"])
        self.assertEqual(code, 0, result)
        self.assertEqual(self.stub.calls[-1][1]["fitGrade"], "A")

    # PDF magic: refused before ANY network call, also when answering a change request
    def test_non_pdf_is_refused_before_any_call_on_a_revision_too(self):
        self.open_request(fitGrade="A")
        folder = self.make_folder()
        (folder / "Jane_Doe_CV_Acme.pdf").write_bytes(b"")
        code, result, _ = run(["--endpoint", self.stub.url, "submit", "--folder", str(folder), "--revision", "pkg-9"])
        self.assertEqual((code, result["error"]), (1, "VALIDATION"))
        self.assertEqual(self.stub.calls, [])
        self.assertEqual(self.stub.files, 0)

    # marker: a write that dies half way leaves neither a temp file nor a damaged marker
    def test_a_marker_write_that_dies_midway_leaves_no_temp_file(self):
        folder = self.make_folder()
        cs.write_marker(folder, "key-a", "d1", {"packageId": "p1"})
        real = Path.write_text

        def half(self_path, text, *a, **kw):
            real(self_path, text[: len(text) // 2], *a, **kw)
            raise OSError("disk full")

        with mock.patch.object(Path, "write_text", half):
            cs.write_marker(folder, "key-b", "d2", {"packageId": "p2"})
        self.assertEqual(sorted(p.name for p in folder.glob(".cockpit*")), [cs.MARKER_NAME])
        self.assertEqual(cs.read_marker(folder, "key-a")["digest"], "d1")

    def test_a_marker_is_replaced_when_one_already_exists(self):
        folder = self.make_folder()
        for n in range(3):
            cs.write_marker(folder, "key-%d" % n, "d%d" % n, {"packageId": "p%d" % n})
        self.assertEqual(cs.read_marker(folder, "key-2")["digest"], "d2")
        self.assertEqual(cs.read_marker(folder, "key-0")["digest"], "d0")
        self.assertEqual(sorted(p.name for p in folder.glob(".cockpit*")), [cs.MARKER_NAME])

    # the script must carry no invisible character: the BOM strip is written as an escape
    def test_source_has_no_invisible_bom_literal(self):
        text = Path(cs.__file__).read_text(encoding="utf-8")
        self.assertNotIn(chr(0xFEFF), text)

if __name__ == "__main__":
    unittest.main()


class ReviewRound2Tests(FolderMixin, unittest.TestCase):
    def setUp(self):
        self.stub = Stub()
        self.addCleanup(self.stub.close)

    def submit_args(self, folder, *extra):
        return ["--endpoint", self.stub.url, "submit", "--folder", str(folder),
                "--company", "Acme", "--role", "Backend Engineer", "--subject", "Application",
                "--fit", "A", "--url", LINK, *extra]

    # S1
    def test_a_replay_never_supersedes_a_package_a_concurrent_run_wrote(self):
        def other_run(arguments):
            self.stub.packages[arguments["jobId"]].append(
                {"id": "other-pkg", "version": 1, "status": "pending", "idempotencyKey": "other-key",
                 "emailSubject": "x", "emailBody": "y", "letterMd": "z", "fitGrade": "A"})
        self.stub.inject_on_fail = other_run
        self.stub.fail_once["submit_application_package"] = "CONFLICT: busy"
        code, result, _ = run(self.submit_args(self.make_folder()))
        self.assertEqual((code, result["error"]), (1, "ALREADY_SUBMITTED"))
        self.assertEqual(len(self.stub.names("submit_application_package")), 1)
        (job,) = self.stub.packages.values()
        self.assertEqual([p["status"] for p in job], ["pending"])

    def test_a_conflict_after_the_submit_really_landed_is_recovered_not_replayed(self):
        folder = self.make_folder()
        holder = {}

        def landed(arguments):
            self.stub.packages[arguments["jobId"]].append(
                {"id": "pkg-mine", "version": 1, "status": "pending", "idempotencyKey": arguments["idempotencyKey"],
                 "emailSubject": arguments["emailSubject"], "emailBody": arguments["emailBody"],
                 "letterMd": arguments["letterMd"], "fitGrade": arguments["fitGrade"]})
        self.stub.inject_on_fail = landed
        self.stub.fail_once["submit_application_package"] = "CONFLICT: busy"
        code, result, _ = run(self.submit_args(folder))
        self.assertEqual(code, 0, result)
        self.assertEqual((result["packageId"], result["recovered"]), ("pkg-mine", True))
        self.assertEqual(len(self.stub.names("submit_application_package")), 1)

    def test_a_replay_reuses_the_uploaded_file(self):
        self.stub.fail_once["submit_application_package"] = "CONFLICT: busy"
        code, result, _ = run(self.submit_args(self.make_folder()))
        self.assertEqual(code, 0, result)
        self.assertEqual(len(self.stub.names("attach_file")), 1)
        submits = [a for n, a in self.stub.calls if n == "submit_application_package"]
        self.assertEqual(len(submits), 2)
        self.assertEqual(submits[0]["cvFileId"], submits[1]["cvFileId"])

    # S2
    def requests(self, n):
        self.stub.change_requests = [
            {"packageId": "pkg-%d" % i, "jobId": JOB % i, "company": "C", "jobTitle": "T", "version": 1,
             "changeRequest": "x", "sourceFolder": None} for i in range(n)]

    def test_changes_flags_a_full_list(self):
        self.requests(3)
        full = run(["--endpoint", self.stub.url, "changes", "--limit", "3"])[1]
        self.assertEqual((full["count"], full["truncated"]), (3, True))
        part = run(["--endpoint", self.stub.url, "changes", "--limit", "5"])[1]
        self.assertEqual(part["count"], 3)
        self.assertNotIn("truncated", part)

    def test_changes_package_looks_beyond_the_default_limit(self):
        self.requests(25)
        code, result, _ = run(["--endpoint", self.stub.url, "changes", "--package", "pkg-24"])
        self.assertEqual(code, 0, result)
        self.assertEqual(result["changeRequests"][0]["packageId"], "pkg-24")
        self.assertEqual(self.stub.calls[-1][1]["limit"], cs.MAX_CHANGE_REQUESTS)

    # N1
    def test_a_lone_surrogate_in_the_key_inputs(self):
        key = cs.idempotency_key("A" + chr(0xD800), "Dev", "https://x.example/1")
        self.assertRegex(key, KEY_RE)

    # N4
    def test_the_marker_replace_is_retried_once(self):
        folder = self.make_folder()
        real = os.replace
        calls = []

        def flaky(src, dst):
            calls.append(1)
            if len(calls) == 1:
                raise PermissionError("held by another process")
            real(src, dst)
        with mock.patch("cockpit_submit.os.replace", side_effect=flaky), mock.patch("cockpit_submit.time.sleep") as slept:
            cs.write_marker(folder, "k", "d", {"packageId": "p"})
        self.assertEqual(len(calls), 2)
        slept.assert_called_once_with(0.2)
        self.assertEqual(cs.read_marker(folder, "k")["digest"], "d")
