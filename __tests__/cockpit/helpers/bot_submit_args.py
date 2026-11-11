"""Runs the bot script's own command tests (scripts/bot/test_cockpit_submit.py,
CommandTests) and writes every `submit_application_package` argument object the
script sent to the stub server, as a JSON list, to the path in argv[1].

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
original_tool = t.Stub.tool


def recording_tool(self, name, arguments):
    if name == "submit_application_package":
        captured.append(arguments)
    return original_tool(self, name, arguments)


t.Stub.tool = recording_tool

suite = unittest.defaultTestLoader.loadTestsFromTestCase(t.CommandTests)
with open(os.devnull, "w") as sink:
    result = unittest.TextTestRunner(stream=sink, verbosity=0).run(suite)

Path(sys.argv[1]).write_text(
    json.dumps({"ok": result.wasSuccessful(), "testsRun": result.testsRun, "args": captured}),
    encoding="utf-8",
)
