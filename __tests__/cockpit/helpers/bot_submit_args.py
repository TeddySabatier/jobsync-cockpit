"""Runs the bot script's own command tests (scripts/bot/test_cockpit_submit.py,
CommandTests) and writes every `submit_application_package` argument object the
script sent to the stub server, plus every `submit_follow_up` argument object
(from FollowUpTests), as JSON, to the path in argv[1].

Used by __tests__/cockpit/botSubmitArgs.spec.ts to check those real arguments
against the strict server schema (D-018 (b)). Standard library only.
"""
import json
import os
import sys
import unittest
from pathlib import Path

BOT_DIR = Path(__file__).resolve().parents[3] / "scripts" / "bot"
sys.path.insert(0, str(BOT_DIR))

import test_cockpit_submit as t  # noqa: E402

captured = []
captured_follow_ups = []
original_tool = t.Stub.tool


def recording_tool(self, name, arguments):
    # Only what really went over HTTP (the server handler calls it), not the stub
    # self-tests' deliberately bad arguments, which call the stub directly.
    if sys._getframe(1).f_code.co_name != "do_POST":
        return original_tool(self, name, arguments)
    if name == "submit_application_package":
        captured.append(arguments)
    if name == "submit_follow_up":
        captured_follow_ups.append(arguments)
    return original_tool(self, name, arguments)


t.Stub.tool = recording_tool

suite = unittest.TestSuite(
    [
        unittest.defaultTestLoader.loadTestsFromTestCase(t.CommandTests),
        unittest.defaultTestLoader.loadTestsFromTestCase(t.FollowUpTests),
    ]
)
with open(os.devnull, "w") as sink:
    result = unittest.TextTestRunner(stream=sink, verbosity=0).run(suite)

Path(sys.argv[1]).write_text(
    json.dumps({"ok": result.wasSuccessful(), "testsRun": result.testsRun, "args": captured, "followUpArgs": captured_follow_ups}),
    encoding="utf-8",
)
