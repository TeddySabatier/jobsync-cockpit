#!/usr/bin/env python3
"""Hand application packages to the JobSync cockpit over MCP.

Python standard library only (no pip, no venv packages). Meant to be run by a
scheduled Claude task, which cannot type a 100 KB PDF as base64 itself.

Commands. Each prints ONE ASCII JSON line on stdout; exit code 0 = ok, 1 = error
(2 = wrong command line). Every failure is JSON, with the cockpit's error code.
  check                       Test the URL and the token.
  submit --folder DIR [--meta FILE] ...
                              Create or find the job, upload the CV, submit the package.
  submit --folder DIR --revision PACKAGE_ID
                              Answer a change request: new version of that package.
  changes [--limit N]         List the packages the owner asked changes for.
  done --package ID --response TEXT
                              Mark a change request handled without a new version.

Setup: the token comes from the COCKPIT_TOKEN environment variable, or from the
file named by COCKPIT_TOKEN_FILE, or from secrets/cockpit_token.txt next to this
script. It is never printed. COCKPIT_URL defaults to http://localhost:3737/api/mcp
(plain http is only accepted for localhost; anything else needs https).

Sending email is NOT possible from here (or from any MCP tool): the owner
presses Send in the cockpit.
"""
import argparse
import base64
import hashlib
import http.client
import json
import os
import re
import socket
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_URL = "http://localhost:3737/api/mcp"
TIMEOUT_SECONDS = 90
MAX_BASE64_CHARS = 7_000_000  # the server's limit for attach_file
MAX_SUBJECT = 300
MAX_TEXT = 20000  # emailBody and letterMd
MAX_FILE_NAME = 120
LOOPBACK = ("localhost", "127.0.0.1", "::1")
MARKER_NAME = ".cockpit-submitted.json"
UUID_RE = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")
EMAIL_RE = re.compile(r"^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$")
TOKEN_RE = re.compile(r"^[A-Za-z0-9_.~+/=-]+$")
META_KEYS = ("company", "role", "subject", "fit", "track", "url", "to", "location", "source", "reasons")


class CockpitError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------- transport

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """urllib would follow a redirect and keep the Authorization header, even to
    another host. Never follow: the answer becomes a REDIRECTED error."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _host(url):
    return (urllib.parse.urlparse(url).hostname or "").lower()


def check_endpoint(url):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise CockpitError("BAD_URL", "Not a valid http(s) URL: %s" % url)
    if parsed.scheme == "http" and _host(url) not in LOOPBACK and os.environ.get("COCKPIT_ALLOW_HTTP") != "1":
        raise CockpitError(
            "INSECURE_URL",
            "Refusing to send the token over plain http to %s. Use https "
            "(or set COCKPIT_ALLOW_HTTP=1 on a network you trust)." % _host(url),
        )


def _opener(url):
    handlers = [_NoRedirect()]
    if _host(url) in LOOPBACK:
        # A system or registry proxy must never see a token meant for localhost.
        handlers.append(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener(*handlers)


def load_token():
    token = os.environ.get("COCKPIT_TOKEN", "").strip()
    if not token:
        path = Path(
            os.environ.get("COCKPIT_TOKEN_FILE")
            or Path(__file__).resolve().parent / "secrets" / "cockpit_token.txt"
        )
        try:
            raw = path.read_bytes()
        except OSError:
            raw = b""
        # PowerShell 5.1 writes UTF-16 by default; Windows editors add a BOM.
        if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
            text = raw.decode("utf-16", errors="replace")
        else:
            text = raw.decode("utf-8-sig", errors="replace")
        token = text.strip().lstrip("﻿")
        if not token:
            raise CockpitError("NO_TOKEN", "No token: set COCKPIT_TOKEN or put it in %s" % path)
    if not TOKEN_RE.match(token):
        raise CockpitError("NO_TOKEN", "The token has unexpected characters (a copy and paste problem?).")
    return token


def _parse_response(raw, content_type):
    text = raw.decode("utf-8", errors="replace")
    if "text/event-stream" in (content_type or ""):
        datas = [l[5:].strip() for l in text.splitlines() if l.startswith("data:")]
        text = datas[-1] if datas else "{}"
    try:
        parsed = json.loads(text)
    except ValueError:
        raise CockpitError("BAD_RESPONSE", "The server did not return JSON.")
    if not isinstance(parsed, dict):
        raise CockpitError("BAD_RESPONSE", "Unexpected answer from the server.")
    return parsed


def rpc(url, token, method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
    )
    try:
        with _opener(url).open(request, timeout=TIMEOUT_SECONDS) as response:
            return _parse_response(response.read(), response.headers.get("Content-Type"))
    except urllib.error.HTTPError as error:
        if error.code in (301, 302, 303, 307, 308):
            raise CockpitError(
                "REDIRECTED",
                "The server redirected the request (wrong URL, a login page or a proxy?). "
                "Not following it, so the token stays where it is.",
            )
        mapping = {
            401: ("UNAUTHORIZED", "The token is missing, wrong or expired."),
            403: ("UNAUTHORIZED_SCOPE", "The token lacks a needed permission."),
            404: ("NOT_FOUND", "Endpoint not found (is COCKPIT_ENABLED on, is the URL right?)."),
            429: ("RATE_LIMITED", "Too many requests; try again later."),
        }
        code, message = mapping.get(error.code, ("HTTP_%d" % error.code, "The server answered HTTP %d." % error.code))
        raise CockpitError(code, message)
    except urllib.error.URLError as error:
        raise CockpitError("UNREACHABLE", "Cannot reach %s: %s" % (url, error.reason))
    except (TimeoutError, socket.timeout):
        raise CockpitError("TIMEOUT", "No answer from %s within %d seconds." % (url, TIMEOUT_SECONDS))
    except (OSError, http.client.HTTPException) as error:
        raise CockpitError("UNREACHABLE", "Connection problem with %s (%s)." % (url, type(error).__name__))


def call(url, token, name, arguments):
    """Call one MCP tool and return its text. Raises CockpitError on any failure."""
    reply = rpc(url, token, "tools/call", {"name": name, "arguments": arguments})
    if "error" in reply:
        err = reply["error"]
        message = str(err.get("message", "request rejected")) if isinstance(err, dict) else str(err)
        raise CockpitError("VALIDATION", message[:300])
    result = reply.get("result") or {}
    text = "".join(part.get("text", "") for part in result.get("content", []))
    if result.get("isError"):
        match = re.match(r"^([A-Z][A-Z_]+): (.*)$", text, re.S)
        if match:
            raise CockpitError(match.group(1), match.group(2)[:300])
        if text.startswith("MCP error -32602"):
            detail = re.sub(r"^MCP error -32602:\s*(Input validation error:)?\s*", "", text)
            raise CockpitError("VALIDATION", detail[:300])
        raise CockpitError("TOOL_ERROR", text[:300])
    return text


def plain_failure(text):
    """add_job and find_job report rate limits and missing scopes as plain text."""
    low = text.strip().lower()
    if low.startswith("rate limit exceeded"):
        raise CockpitError("RATE_LIMITED", text.strip()[:200])
    if low.startswith("insufficient scope"):
        raise CockpitError("UNAUTHORIZED_SCOPE", text.strip()[:200])


# ------------------------------------------------------------------ helpers

def slug(text, limit):
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    cleaned = re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")
    return cleaned[:limit].strip("-") or "x"


def idempotency_key(folder_name, company, role, link, revision_package="", manual_digest=""):
    """Identifies ONE posting, not one day: the application folder name plus a hash
    of company, role and link (so two postings with the same company and title but
    different links never share a key). A change request answer is keyed on the
    package it answers, so a retried answer is a no-op."""
    if revision_package:
        key = "scout-rev-" + slug(revision_package, 40)
    else:
        digest = hashlib.sha1(("%s|%s|%s" % (company, role, link)).encode("utf-8")).hexdigest()[:8]
        key = "scout-%s-%s" % (slug(folder_name, 60), digest)
    if manual_digest:
        key += "-m" + manual_digest[:8]
    return key


def parse_job_id(text):
    """add_job answers in prose and the wording differs: 'Job created (id: <id>)',
    'Duplicate detected ... (id: <id>)', and 'Job <id> updated ...' (an upsert).
    find_job says 'Found existing job ... (id: <id>, ...)'. The id is the first UUID."""
    plain_failure(text)
    match = UUID_RE.search(text)
    if not match:
        raise CockpitError("BAD_RESPONSE", "No job id in the answer: " + text[:120])
    return match.group(0)


def read_text(path, what):
    try:
        # utf-8-sig: Windows editors sometimes add a byte-order mark, which would break json.loads
        return Path(path).read_text(encoding="utf-8-sig")
    except OSError:
        raise CockpitError("FILE_NOT_FOUND", "Cannot read %s: %s" % (what, path))
    except UnicodeDecodeError:
        raise CockpitError("VALIDATION", "%s is not UTF-8 text: %s" % (what, path))


def find_pdf(folder, override):
    if override:
        candidate = Path(override)
        if not candidate.is_file():
            raise CockpitError("FILE_NOT_FOUND", "PDF not found: %s" % override)
        return candidate
    pdfs = sorted(p for p in Path(folder).glob("*.pdf") if p.is_file())
    if not pdfs:
        raise CockpitError("FILE_NOT_FOUND", "No .pdf in %s (render the CV first)." % folder)
    if len(pdfs) == 1:
        return pdfs[0]
    cvs = [p for p in pdfs if "cv" in p.name.lower()]
    if len(cvs) == 1:
        return cvs[0]
    raise CockpitError(
        "AMBIGUOUS_PDF",
        "Several PDFs in %s (%s): pass --pdf with the CV." % (folder, ", ".join(p.name for p in pdfs[:4])),
    )


def safe_pdf_name(name):
    if len(name) <= MAX_FILE_NAME:
        return name
    return name[: MAX_FILE_NAME - 4].rstrip(". ") + ".pdf"


def build_body(letter, recipient, link):
    """Same rule as the Gmail-draft pipeline: with no recipient, the first line
    tells the reader how to apply."""
    body = letter.strip()
    first_line = body.splitlines()[0] if body else ""
    if not recipient and link and link not in first_line:
        body = "Apply via: %s\n\n%s" % (link, body)
    return body


def split_reasons(text):
    return [p.strip() for p in re.split(r"[;\n]+", text or "") if p.strip()]


def validate_package(subject, recipient, body, letter, fit):
    """Everything the server would refuse, checked BEFORE any upload so a bad
    field never leaves an orphan PDF behind (the file quota counts every upload)."""
    if fit not in ("A", "B"):
        raise CockpitError("VALIDATION", "The fit must be A or B.")
    if not subject or len(subject) > MAX_SUBJECT or "\r" in subject or "\n" in subject:
        raise CockpitError("VALIDATION", "The subject must be one line of 1 to %d characters." % MAX_SUBJECT)
    if recipient and (len(recipient) > 254 or not EMAIL_RE.match(recipient)):
        raise CockpitError("VALIDATION", "The recipient is not a valid single email address.")
    if not body.strip():
        raise CockpitError("VALIDATION", "The email body is empty.")
    if len(body) > MAX_TEXT or len(letter) > MAX_TEXT:
        raise CockpitError("VALIDATION", "The letter or email body is longer than %d characters." % MAX_TEXT)


def content_digest(parts, pdf_bytes):
    h = hashlib.sha256()
    for part in parts:
        h.update(part.encode("utf-8"))
        h.update(b"\0")
    h.update(pdf_bytes)
    return h.hexdigest()


def _read_entries(folder):
    try:
        data = json.loads((Path(folder) / MARKER_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    entries = data.get("entries") if isinstance(data, dict) else None
    return entries if isinstance(entries, dict) else {}


def read_marker(folder, key):
    """What was submitted under this exact key: {"digest", "result"} or None.
    One entry per key: a corrected resubmit must not make us forget the original."""
    entry = _read_entries(folder).get(key)
    if isinstance(entry, dict) and isinstance(entry.get("result"), dict):
        return entry
    return None


def write_marker(folder, key, digest, result):
    entries = _read_entries(folder)
    entries[key] = {"digest": digest, "result": result}
    entries = dict(list(entries.items())[-20:])
    try:
        (Path(folder) / MARKER_NAME).write_text(json.dumps({"entries": entries}), encoding="utf-8")
    except OSError:
        pass  # a read-only folder only costs a repeated upload on a re-run


def load_meta(path):
    if not path:
        return {}
    try:
        data = json.loads(read_text(path, "meta file"))
    except ValueError:
        raise CockpitError("VALIDATION", "The meta file is not valid JSON: %s" % path)
    if not isinstance(data, dict):
        raise CockpitError("VALIDATION", "The meta file must be a JSON object: %s" % path)
    return {k: str(v) for k, v in data.items() if k in META_KEYS and v is not None}


def as_dict(value):
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except ValueError:
            return {}
    return {}


def _redact(text, token):
    return text.replace(token, "***") if token else text


# ----------------------------------------------------------------- commands

def cmd_check(args, url, token):
    reply = rpc(url, token, "tools/list", {})
    if "error" in reply:
        raise CockpitError("TOOL_ERROR", str(reply["error"])[:200])
    names = sorted(t["name"] for t in reply["result"]["tools"])
    needed = ["add_job", "attach_file", "submit_application_package", "list_change_requests"]
    missing = [n for n in needed if n not in names]
    if missing:
        raise CockpitError(
            "MISSING_TOOLS",
            "Missing %s: is COCKPIT_ENABLED=true and does the token have the new scopes?" % ", ".join(missing),
        )
    call(url, token, "list_jobs", {"limit": 1})  # proves jobs:read; write scopes only show on a real submit
    return {"tools": [n for n in names if n in needed]}


def _resolve_job(url, token, values, posting):
    """One job per POSTING. With a link: reuse the job saved under that link, else
    force-create a new one (company and title alone must not merge two postings).
    Without a link there is nothing better than company and title, so upsert."""
    link = values["url"]
    if link:
        found = call(url, token, "find_job", {"jobUrl": link})
        plain_failure(found)
        if "Found existing job" in found:
            return parse_job_id(found)
    job = {
        "company": values["company"],
        "jobTitle": values["role"],
        "jobDescription": posting.strip() or "N/A",
        "source": values["source"] or "Newsletter",
    }
    if link:
        job["jobUrl"] = link
        job["allowDuplicate"] = True
    else:
        job["upsert"] = True
    if values["location"]:
        job["location"] = values["location"]
    return parse_job_id(call(url, token, "add_job", job))


def cmd_submit(args, url, token):
    meta = load_meta(args.meta)
    values = {}
    for k in META_KEYS:
        v = getattr(args, k)
        values[k] = v if v is not None else meta.get(k)

    folder = Path(args.folder)
    if not folder.is_dir():
        raise CockpitError("FILE_NOT_FOUND", "Folder not found: %s" % args.folder)
    letter = read_text(args.letter_file or folder / "letter.md", "letter")
    try:
        cv_json = json.loads(read_text(args.cv_json or folder / "cv.json", "cv.json"))
    except ValueError:
        raise CockpitError("VALIDATION", "cv.json is not valid JSON.")
    if not isinstance(cv_json, dict):
        raise CockpitError("VALIDATION", "cv.json must be a JSON object.")

    revision = args.revision or ""
    item = {}
    if revision:
        # Answering a change request: the job, recipient, subject and fit come from the
        # package being answered, so nothing the owner set can be lost by omission.
        text = call(url, token, "list_change_requests", {"limit": 100})
        for candidate in json.loads(text):
            if candidate.get("packageId") == revision:
                item = candidate
        if not item:
            raise CockpitError("NOT_FOUND", "No open change request for package %s (already handled?)." % revision)
        analysis = as_dict(item.get("fitAnalysis"))
        subject = values["subject"] or item.get("emailSubject") or ""
        to = values["to"] if values["to"] is not None else (item.get("emailTo") or "")
        fit = values["fit"] or analysis.get("verdict") or ""
        track = values["track"] or analysis.get("track") or ""
        location = values["location"] or analysis.get("location") or ""
        reasons = split_reasons(values["reasons"]) or analysis.get("reasons") or []
        previous_first_line = (item.get("emailBody") or "").strip().splitlines()[:1]
        carry_link = previous_first_line[0] if previous_first_line and previous_first_line[0].startswith("Apply via:") else ""
        base = read_text(args.body_file, "body") if args.body_file else letter
        body = base.strip()
        if not to and carry_link and carry_link not in body.splitlines()[:1]:
            body = "%s\n\n%s" % (carry_link, body)
        company = role = link = ""
    else:
        missing = [k for k in ("company", "role", "subject", "fit") if not values[k]]
        if missing:
            raise CockpitError("VALIDATION", "Missing: %s (use --meta FILE or the options)." % ", ".join(missing))
        company, role, link = values["company"], values["role"], values["url"] or ""
        subject, fit, track = values["subject"], values["fit"], values["track"] or ""
        location, to = values["location"] or "", values["to"] or ""
        reasons = split_reasons(values["reasons"])
        base = read_text(args.body_file, "body") if args.body_file else letter
        body = build_body(base, to, link)

    validate_package(subject, to, body, letter, fit)
    pdf = find_pdf(folder, args.pdf)
    data = pdf.read_bytes()
    encoded = base64.b64encode(data).decode("ascii")
    if len(encoded) > MAX_BASE64_CHARS:
        raise CockpitError("TOO_LARGE", "The PDF is too large (%d bytes)." % len(data))

    digest = content_digest([letter, body, subject, to, json.dumps(cv_json, sort_keys=True)], data)
    key = idempotency_key(folder.name, company, role, link, revision)
    marker = read_marker(folder, key)
    if marker and marker.get("digest") != digest:
        if not args.resubmit:
            raise CockpitError(
                "CONTENT_CHANGED",
                "This posting was already submitted with different content. Pass --resubmit to "
                "send the corrected content as a new version (it replaces the version still waiting).",
            )
        key = idempotency_key(folder.name, company, role, link, revision, manual_digest=digest)
        marker = read_marker(folder, key)
    if marker and marker.get("digest") == digest:
        return dict(marker["result"], idempotent=True, cached=True)

    job_id = item["jobId"] if revision else _resolve_job(url, token, values, read_text(args.description_file or folder / "posting.md", "posting text"))

    attached = json.loads(
        call(url, token, "attach_file",
             {"fileName": safe_pdf_name(pdf.name), "mimeType": "application/pdf", "contentBase64": encoded})
    )

    fit_analysis = {"verdict": fit}
    if track:
        fit_analysis["track"] = track
    if location:
        fit_analysis["location"] = location
    if reasons:
        fit_analysis["reasons"] = reasons

    package = json.loads(
        call(url, token, "submit_application_package", {
            "jobId": job_id,
            "emailTo": to,
            "emailSubject": subject,
            "emailBody": body,
            "letterMd": letter,
            "fitGrade": fit,
            "fitAnalysis": fit_analysis,
            "cvJson": cv_json,
            "cvFileId": attached["fileId"],
            "sourceFolder": folder.name[:300],
            "idempotencyKey": key,
        })
    )
    result = {
        "jobId": job_id,
        "packageId": package["packageId"],
        "version": package["version"],
        "status": package["status"],
        "idempotent": package["idempotent"],
        "supersededIds": package.get("supersededIds", []),
        "applyViaLink": not to,
    }
    write_marker(folder, key, digest, result)
    return result


def cmd_changes(args, url, token):
    return {"changeRequests": json.loads(call(url, token, "list_change_requests", {"limit": args.limit}))}


def cmd_done(args, url, token):
    return json.loads(call(url, token, "mark_change_request_done",
                           {"packageId": args.package, "response": args.response}))


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        print(json.dumps({"ok": False, "error": "USAGE", "message": message}))
        sys.exit(2)


def build_parser():
    parser = _Parser(description="Hand application packages to the JobSync cockpit.")
    parser.add_argument(
        "--endpoint",
        default=os.environ.get("COCKPIT_URL", DEFAULT_URL),
        help="MCP endpoint (before the command); default $COCKPIT_URL or " + DEFAULT_URL,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("check", help="test the URL and the token")

    submit = sub.add_parser("submit", help="create or find the job, upload the CV, submit the package")
    submit.add_argument("--folder", required=True, help="application folder (letter.md, cv.json, posting.md, the PDF)")
    submit.add_argument("--meta", default="", help="JSON file with company, role, subject, fit, track, url, to, location, source, reasons")
    for name in META_KEYS:
        submit.add_argument("--" + name, default=None)
    submit.add_argument("--revision", default="", help="the packageId of the change request you are answering")
    submit.add_argument("--resubmit", action="store_true", help="send corrected content for a posting already submitted today")
    submit.add_argument("--letter-file", dest="letter_file", default="")
    submit.add_argument("--body-file", dest="body_file", default="", help="plain-text email body if different from the letter")
    submit.add_argument("--cv-json", dest="cv_json", default="")
    submit.add_argument("--description-file", dest="description_file", default="")
    submit.add_argument("--pdf", default="")

    changes = sub.add_parser("changes", help="list change requests")
    changes.add_argument("--limit", type=int, default=20)

    done = sub.add_parser("done", help="mark a change request as handled without a new version")
    done.add_argument("--package", required=True)
    done.add_argument("--response", required=True)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    handlers = {"check": cmd_check, "submit": cmd_submit, "changes": cmd_changes, "done": cmd_done}
    token = ""
    try:
        check_endpoint(args.endpoint)
        token = load_token()
        result = handlers[args.command](args, args.endpoint, token)
        # ASCII-only JSON (\u escapes): a Windows console or pipe often uses a legacy
        # code page, and printing an accented or non-Latin character would crash.
        print(json.dumps(dict(ok=True, **result)))
        return 0
    except CockpitError as error:
        print(json.dumps({"ok": False, "error": error.code, "message": _redact(error.message, token)}))
        return 1
    except Exception as error:  # last resort: the bot must always get a JSON line
        message = _redact("%s: %s" % (type(error).__name__, error), token)[:300]
        print(json.dumps({"ok": False, "error": "INTERNAL", "message": message}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
