#!/usr/bin/env python3
"""Hand application packages to the JobSync cockpit over MCP.

Python standard library only (no pip, no venv packages). Meant to be run by a
scheduled Claude task, which cannot type a 100 KB PDF as base64 itself.

Commands (each prints ONE JSON line on stdout; exit code 0 = ok, 1 = error):
  check                       Test the URL and the token.
  submit  --folder DIR ...    add_job (upsert) + attach_file + submit_application_package.
  changes [--limit N]         List packages the owner asked changes for.
  done --package ID --response TEXT
                              Tell the owner a change request was handled without a new version.

Setup: the token comes from the COCKPIT_TOKEN environment variable, or from the
file named by COCKPIT_TOKEN_FILE, or from secrets/cockpit_token.txt next to this
script. The token is never printed. COCKPIT_URL defaults to
http://localhost:3737/api/mcp.

Sending email is NOT possible from here (or from any MCP tool): the owner
presses Send in the cockpit.
"""
import argparse
import base64
import hashlib
import json
import os
import re
import sys
import unicodedata
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

DEFAULT_URL = "http://localhost:3737/api/mcp"
TIMEOUT_SECONDS = 90
MAX_BASE64_CHARS = 7_000_000  # the server's limit for attach_file


class CockpitError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------- transport

def load_token():
    token = os.environ.get("COCKPIT_TOKEN", "").strip()
    if token:
        return token
    path = Path(
        os.environ.get("COCKPIT_TOKEN_FILE")
        or Path(__file__).resolve().parent / "secrets" / "cockpit_token.txt"
    )
    try:
        token = path.read_text(encoding="utf-8").strip()
    except OSError:
        token = ""
    if not token:
        raise CockpitError(
            "NO_TOKEN",
            "No token: set COCKPIT_TOKEN or put it in %s" % path,
        )
    return token


def _parse_response(raw, content_type):
    text = raw.decode("utf-8", errors="replace")
    if "text/event-stream" in (content_type or ""):
        # Fallback for servers that answer with SSE: take the last data line.
        datas = [l[5:].strip() for l in text.splitlines() if l.startswith("data:")]
        text = datas[-1] if datas else "{}"
    try:
        return json.loads(text)
    except ValueError:
        raise CockpitError("BAD_RESPONSE", "The server did not return JSON.")


def rpc(url, token, method, params):
    body = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    ).encode("utf-8")
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
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return _parse_response(response.read(), response.headers.get("Content-Type"))
    except urllib.error.HTTPError as error:
        mapping = {
            401: ("UNAUTHORIZED", "The token is missing, wrong or expired."),
            403: ("UNAUTHORIZED_SCOPE", "The token lacks a needed permission."),
            404: ("NOT_FOUND", "Endpoint not found (is COCKPIT_ENABLED on, is the URL right?)."),
            429: ("RATE_LIMITED", "Too many requests; try again later."),
        }
        code, message = mapping.get(
            error.code, ("HTTP_%d" % error.code, "The server answered HTTP %d." % error.code)
        )
        raise CockpitError(code, message)
    except urllib.error.URLError as error:
        raise CockpitError("UNREACHABLE", "Cannot reach %s: %s" % (url, error.reason))


def call(url, token, name, arguments):
    """Call one MCP tool and return its text. Raises CockpitError on any failure."""
    reply = rpc(url, token, "tools/call", {"name": name, "arguments": arguments})
    if "error" in reply:
        message = str(reply["error"].get("message", "request rejected"))
        raise CockpitError("VALIDATION", message[:300])
    result = reply.get("result", {})
    text = "".join(part.get("text", "") for part in result.get("content", []))
    if result.get("isError"):
        match = re.match(r"^([A-Z_]+): (.*)$", text, re.S)
        if match:
            raise CockpitError(match.group(1), match.group(2)[:300])
        raise CockpitError("TOOL_ERROR", text[:300])
    return text


# ------------------------------------------------------------------ helpers

def slug(text, limit):
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    cleaned = re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")
    return cleaned[:limit].strip("-") or "x"


def idempotency_key(company, role, day, revision=""):
    """Stable per (day, company, role): replaying a run never duplicates a package.
    A different `revision` (for example a change request id) gives a new key."""
    key = "scout-%s-%s-%s" % (day, slug(company, 30), slug(role, 40))
    if revision:
        key += "-r" + hashlib.sha1(revision.encode("utf-8")).hexdigest()[:8]
    return key


UUID_RE = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")


def parse_job_id(text):
    """add_job answers in prose and the wording differs: 'Job created (id: <id>)',
    'Duplicate detected ... (id: <id>)', and 'Job <id> updated. Fields changed ...'
    (an upsert on an existing job). The job id is the first UUID in every case."""
    match = UUID_RE.search(text)
    if not match:
        raise CockpitError("BAD_RESPONSE", "add_job did not return a job id: " + text[:120])
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
    pdfs = sorted(Path(folder).glob("*.pdf"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not pdfs:
        raise CockpitError("FILE_NOT_FOUND", "No .pdf in %s (render the CV first)." % folder)
    return pdfs[0]


def build_body(letter, recipient, link):
    """Same rule as the Gmail-draft pipeline: with no recipient, the first line
    tells the reader how to apply."""
    body = letter.strip()
    first_line = body.splitlines()[0] if body else ""
    if not recipient and link and link not in first_line:
        body = "Apply via: %s\n\n%s" % (link, body)
    return body


MARKER_NAME = ".cockpit-submitted.json"


def read_marker(folder, key):
    """The result of a previous submit with this exact key, or None. Delete the
    file in the application folder to force a fresh submit."""
    try:
        data = json.loads((Path(folder) / MARKER_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if isinstance(data, dict) and data.get("key") == key and isinstance(data.get("result"), dict):
        return data["result"]
    return None


def write_marker(folder, key, result):
    try:
        (Path(folder) / MARKER_NAME).write_text(
            json.dumps({"key": key, "result": result}, ensure_ascii=False), encoding="utf-8"
        )
    except OSError:
        pass  # a read-only folder only costs a repeated upload on a re-run


def split_reasons(text):
    parts = re.split(r"[;\n]+", text or "")
    return [p.strip() for p in parts if p.strip()]


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
            "Missing %s: is COCKPIT_ENABLED=true and does the token have the new scopes?"
            % ", ".join(missing),
        )
    call(url, token, "list_jobs", {"limit": 1})  # needs the jobs:read scope
    return {"tools": [n for n in names if n in needed]}


def cmd_submit(args, url, token):
    folder = Path(args.folder)
    if not folder.is_dir():
        raise CockpitError("FILE_NOT_FOUND", "Folder not found: %s" % args.folder)
    letter = read_text(args.letter_file or folder / "letter.md", "letter")
    posting = read_text(args.description_file or folder / "posting.md", "posting text")
    try:
        cv_json = json.loads(read_text(args.cv_json or folder / "cv.json", "cv.json"))
    except ValueError:
        raise CockpitError("VALIDATION", "cv.json is not valid JSON.")
    if not isinstance(cv_json, dict):
        raise CockpitError("VALIDATION", "cv.json must be a JSON object.")
    pdf = find_pdf(folder, args.pdf)
    data = pdf.read_bytes()
    encoded = base64.b64encode(data).decode("ascii")
    if len(encoded) > MAX_BASE64_CHARS:
        raise CockpitError("TOO_LARGE", "The PDF is too large (%d bytes)." % len(data))

    day = args.date or date.today().isoformat()
    key = idempotency_key(args.company, args.role, day, args.revision or "")

    # An identical re-run (for example the bot retrying a failed run) must not
    # upload the PDF again: the server would only answer "already have it".
    cached = read_marker(folder, key)
    if cached:
        return dict(cached, idempotent=True, cached=True)

    job_arguments = {
        "company": args.company,
        "jobTitle": args.role,
        "jobDescription": posting.strip() or "N/A",
        "source": args.source,
        "upsert": True,
    }
    if args.url:
        job_arguments["jobUrl"] = args.url
    if args.location:
        job_arguments["location"] = args.location
    job_id = parse_job_id(call(url, token, "add_job", job_arguments))

    attached = json.loads(
        call(
            url,
            token,
            "attach_file",
            {"fileName": pdf.name, "mimeType": "application/pdf", "contentBase64": encoded},
        )
    )

    fit_analysis = {"verdict": args.fit}
    if args.track:
        fit_analysis["track"] = args.track
    if args.location:
        fit_analysis["location"] = args.location
    reasons = split_reasons(args.reasons)
    if reasons:
        fit_analysis["reasons"] = reasons

    package = json.loads(
        call(
            url,
            token,
            "submit_application_package",
            {
                "jobId": job_id,
                "emailTo": args.to or "",
                "emailSubject": args.subject,
                "emailBody": build_body(
                    read_text(args.body_file, "body") if args.body_file else letter,
                    args.to,
                    args.url,
                ),
                "letterMd": letter,
                "fitGrade": args.fit,
                "fitAnalysis": fit_analysis,
                "cvJson": cv_json,
                "cvFileId": attached["fileId"],
                "sourceFolder": folder.name[:300],
                "idempotencyKey": key,
            },
        )
    )
    result = {
        "jobId": job_id,
        "packageId": package["packageId"],
        "version": package["version"],
        "status": package["status"],
        "idempotent": package["idempotent"],
        "supersededIds": package.get("supersededIds", []),
        "applyViaLink": not args.to,
    }
    write_marker(folder, key, result)
    return result


def cmd_changes(args, url, token):
    text = call(url, token, "list_change_requests", {"limit": args.limit})
    return {"changeRequests": json.loads(text)}


def cmd_done(args, url, token):
    text = call(
        url,
        token,
        "mark_change_request_done",
        {"packageId": args.package, "response": args.response},
    )
    return json.loads(text)


def build_parser():
    parser = argparse.ArgumentParser(description="Hand application packages to the JobSync cockpit.")
    parser.add_argument(
        "--endpoint",
        default=os.environ.get("COCKPIT_URL", DEFAULT_URL),
        help="MCP endpoint (before the command); default $COCKPIT_URL or " + DEFAULT_URL,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("check", help="test the URL and the token")

    submit = sub.add_parser("submit", help="create the job, upload the CV, submit the package")
    submit.add_argument("--folder", required=True, help="application folder (letter.md, cv.json, posting.md, the PDF)")
    submit.add_argument("--company", required=True)
    submit.add_argument("--role", required=True)
    submit.add_argument("--subject", required=True, help="email subject, same as the old draft subject")
    submit.add_argument("--fit", required=True, choices=["A", "B"])
    submit.add_argument("--track", default="", help="Energy, Fintech, AI, Startup or Consulting")
    submit.add_argument("--url", dest="url", default="", help="link to the posting")
    submit.add_argument("--to", default="", help="recruiter address; empty means apply via link")
    submit.add_argument("--location", default="")
    submit.add_argument("--source", default="Newsletter")
    submit.add_argument("--reasons", default="", help="why it fits; separate with ';'")
    submit.add_argument("--letter-file", dest="letter_file", default="")
    submit.add_argument("--body-file", dest="body_file", default="", help="plain-text email body if different from the letter")
    submit.add_argument("--cv-json", dest="cv_json", default="")
    submit.add_argument("--description-file", dest="description_file", default="")
    submit.add_argument("--pdf", default="")
    submit.add_argument("--date", default="", help="YYYY-MM-DD, defaults to today")
    submit.add_argument("--revision", default="", help="use the change request package id when resubmitting")

    changes = sub.add_parser("changes", help="list change requests")
    changes.add_argument("--limit", type=int, default=20)

    done = sub.add_parser("done", help="mark a change request as handled without a new version")
    done.add_argument("--package", required=True)
    done.add_argument("--response", required=True)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    handlers = {"check": cmd_check, "submit": cmd_submit, "changes": cmd_changes, "done": cmd_done}
    try:
        token = load_token()
        result = handlers[args.command](args, args.endpoint, token)
        # ASCII-only JSON (\u escapes): a Windows console or pipe often uses a legacy
        # code page, and printing an accented or non-Latin character would crash.
        print(json.dumps(dict(ok=True, **result)))
        return 0
    except CockpitError as error:
        print(json.dumps({"ok": False, "error": error.code, "message": error.message}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
