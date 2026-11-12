// @vitest-environment node
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  SubmitApplicationPackageObject,
  SubmitApplicationPackageSchema,
  SubmitFollowUpObject,
  SubmitFollowUpSchema,
} from "@/lib/cockpit/schemas";

// The submit schema is strict (D-018 (b)): an unknown key is refused. This runs
// the repo's own bot script (scripts/bot/cockpit_submit.py) through its command
// tests against the stub server, collects every submit_application_package
// argument object it really sent, and checks each one against the strict
// server schema. A key the script adds later without a schema change fails here.
const hasPython =
  spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasPython)("bot script vs the strict submit schema", () => {
  let captured: {
    ok: boolean;
    testsRun: number;
    args: Record<string, unknown>[];
    followUpArgs: Record<string, unknown>[];
  };

  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-bot-args-"));
    const out = path.join(dir, "args.json");
    try {
      const run = spawnSync(
        "python3",
        ["-I", path.join(__dirname, "helpers", "bot_submit_args.py"), out],
        { encoding: "utf8", timeout: 120_000 },
      );
      if (run.status !== 0) throw new Error(`driver failed: ${run.stderr}`);
      captured = JSON.parse(fs.readFileSync(out, "utf8"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 150_000);

  it("the bot's own command tests pass and submit at least once", () => {
    expect(captured.ok).toBe(true);
    expect(captured.args.length).toBeGreaterThan(0);
  });

  it("every key the bot sends is a schema key", () => {
    const allowed = Object.keys(SubmitApplicationPackageObject.shape);
    const sent = [...new Set(captured.args.flatMap((a) => Object.keys(a)))];
    expect(sent.filter((k) => !allowed.includes(k))).toEqual([]);
  });

  it("every argument object the bot sent passes the strict schema", () => {
    const failures = captured.args.flatMap((a, i) => {
      const r = SubmitApplicationPackageSchema.safeParse(a);
      return r.success ? [] : [{ i, issues: r.error.issues }];
    });
    expect(failures).toEqual([]);
  });

  // D-033: the follow-up command against the strict submit_follow_up schema.
  it("the follow-up commands submit at least once, with only schema keys, and pass the strict schema", () => {
    expect(captured.followUpArgs.length).toBeGreaterThan(0);
    const allowed = Object.keys(SubmitFollowUpObject.shape);
    const sent = [...new Set(captured.followUpArgs.flatMap((a) => Object.keys(a)))];
    expect(sent.filter((k) => !allowed.includes(k))).toEqual([]);
    const failures = captured.followUpArgs.flatMap((a, i) => {
      const r = SubmitFollowUpSchema.safeParse(a);
      return r.success ? [] : [{ i, issues: r.error.issues }];
    });
    expect(failures).toEqual([]);
  });
});
