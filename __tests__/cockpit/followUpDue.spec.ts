// @vitest-environment node
import {
  computeFollowUpDue,
  isFollowUpDue,
  resolveTimezone,
  snoozeUntil,
  stepProgress,
  startOfCivilDay,
  type DueInput,
  type FollowUpDue,
} from "@/lib/cockpit/followUpDue";

// D-030 / plan 3.1: the pure due calculation. The clock is frozen with fake
// timers; every case passes `new Date()` as `now`, so the tests read like the
// owner's calendar.

const d = (iso: string) => new Date(iso);
const at = (iso: string) => {
  vi.setSystemTime(d(iso));
  return new Date();
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// Monday 2026-03-02 10:00 UTC: sent application. +7 days = Monday 2026-03-09.
const SENT = d("2026-03-02T10:00:00Z");

function base(over: Partial<DueInput> = {}): DueInput {
  return {
    now: new Date(),
    jobStatus: "applied",
    application: { sentAt: SENT, emailTo: "hr@example.com" },
    sentFollowUps: [],
    state: null,
    ...over,
  };
}

const state = (over: Partial<NonNullable<DueInput["state"]>> = {}) => ({
  outcome: null,
  stopped: false,
  skippedThrough: 0,
  skippedAt: null,
  snoozedUntil: null,
  ...over,
});

function due(over: Partial<DueInput> = {}): FollowUpDue {
  return computeFollowUpDue(base(over));
}

function step(r: FollowUpDue) {
  if (!r.eligible) throw new Error(`not eligible: ${r.reason}`);
  return r;
}

describe("eligibility", () => {
  it("is not eligible without a sent application", () => {
    at("2026-03-20T10:00:00Z");
    expect(due({ application: null })).toEqual({ eligible: false, reason: "no_sent_application" });
    expect(due({ application: { sentAt: null, emailTo: "a@b.c" } })).toEqual({
      eligible: false,
      reason: "no_sent_application",
    });
  });

  it.each([null, "", "   "])("apply-via-link (emailTo %j) is excluded", (emailTo) => {
    at("2026-03-20T10:00:00Z");
    expect(due({ application: { sentAt: SENT, emailTo } })).toEqual({
      eligible: false,
      reason: "no_recipient",
    });
  });

  it.each([null, "draft", "new", "interview", "offer", "rejected", "archived", "expired"])(
    "needs the job status applied (status %j is refused)",
    (jobStatus) => {
      at("2026-03-20T10:00:00Z");
      expect(due({ jobStatus })).toEqual({ eligible: false, reason: "job_not_applied" });
    },
  );

  it.each(["replied", "interview", "rejected", "closed"])("outcome %s stops suggestions", (outcome) => {
    at("2026-03-20T10:00:00Z");
    expect(due({ state: state({ outcome }) })).toEqual({ eligible: false, reason: "outcome" });
  });

  it("a stopped job is not suggested", () => {
    at("2026-03-20T10:00:00Z");
    expect(due({ state: state({ stopped: true }) })).toEqual({ eligible: false, reason: "stopped" });
  });

  it("a state row with no outcome and not stopped changes nothing", () => {
    at("2026-03-09T00:00:00Z");
    expect(step(due({ state: state() })).status).toBe("due");
  });

  it("the job status check wins over the state, the state over the steps", () => {
    at("2026-03-20T10:00:00Z");
    expect(due({ jobStatus: "rejected", state: state({ outcome: "replied" }) })).toMatchObject({
      reason: "job_not_applied",
    });
    expect(due({ state: state({ outcome: "replied", stopped: true }) })).toMatchObject({
      reason: "outcome",
    });
  });

  it("re-arms when the job goes back to applied (state kept, status checked live)", () => {
    at("2026-03-12T10:00:00Z");
    expect(due({ jobStatus: "interview" }).eligible).toBe(false);
    expect(step(due({ jobStatus: "applied" })).status).toBe("due");
  });
});

describe("step 1: sentAt + 7 days", () => {
  it("is scheduled until the due day starts, then due (UTC, a Monday)", () => {
    const before = step(due({ now: at("2026-03-08T23:59:59.999Z") }));
    expect(before.status).toBe("scheduled");
    expect(before.step).toBe(1);
    expect(before.dueAt.toISOString()).toBe("2026-03-09T00:00:00.000Z");
    expect(before.anchor.toISOString()).toBe(SENT.toISOString());

    expect(step(due({ now: at("2026-03-09T00:00:00.000Z") })).status).toBe("due");
    expect(step(due({ now: at("2026-03-09T10:00:00.000Z") })).status).toBe("due");
  });

  it("counts calendar days: not due at exactly 7x24h when that falls before the due day starts", () => {
    // Sent late in the evening: 7 days later at the same time is the same day.
    const sent = d("2026-03-02T23:59:00Z");
    const r = step(due({ application: { sentAt: sent, emailTo: "a@b.c" }, now: at("2026-03-09T00:00:00Z") }));
    expect(r.dueAt.toISOString()).toBe("2026-03-09T00:00:00.000Z");
    expect(r.status).toBe("due");
  });

  it("uses package sentAt, nothing else (the application anchor is the only input)", () => {
    const other = d("2026-02-01T10:00:00Z");
    const r = step(due({ application: { sentAt: other, emailTo: "a@b.c" }, now: at("2026-02-10T10:00:00Z") }));
    expect(r.dueAt.toISOString()).toBe("2026-02-09T00:00:00.000Z");
  });
});

describe("weekday rule: Saturday and Sunday move to the next Monday", () => {
  it.each([
    ["Mon sent -> Mon due", "2026-03-02T10:00:00Z", "2026-03-09T00:00:00.000Z"],
    ["Wed sent -> Wed due", "2026-03-04T10:00:00Z", "2026-03-11T00:00:00.000Z"],
    ["Fri sent -> Fri due", "2026-03-06T10:00:00Z", "2026-03-13T00:00:00.000Z"],
    ["Sat sent -> Sat due -> Monday", "2026-03-07T10:00:00Z", "2026-03-16T00:00:00.000Z"],
    ["Sun sent -> Sun due -> Monday", "2026-03-08T10:00:00Z", "2026-03-16T00:00:00.000Z"],
  ])("%s", (_name, sent, expected) => {
    const r = step(
      due({ application: { sentAt: d(sent), emailTo: "a@b.c" }, now: at("2026-03-01T00:00:00Z") }),
    );
    expect(r.dueAt.toISOString()).toBe(expected);
  });

  it("a weekend due day is not due on Saturday or Sunday, due on Monday", () => {
    const app = { sentAt: d("2026-03-07T10:00:00Z"), emailTo: "a@b.c" };
    expect(step(due({ application: app, now: at("2026-03-14T12:00:00Z") })).status).toBe("scheduled");
    expect(step(due({ application: app, now: at("2026-03-15T12:00:00Z") })).status).toBe("scheduled");
    expect(step(due({ application: app, now: at("2026-03-16T00:00:00Z") })).status).toBe("due");
  });

  it("the window counts from the moved due day", () => {
    const app = { sentAt: d("2026-03-07T10:00:00Z"), emailTo: "a@b.c" };
    const r = step(due({ application: app, now: at("2026-03-16T00:00:00Z") }));
    expect(r.windowEnd.toISOString()).toBe("2026-04-15T00:00:00.000Z"); // Mon 03-16 + 30 days
  });
});

describe("timezone (COCKPIT_TIMEZONE)", () => {
  it("defaults to UTC; blank and unknown names fall back to UTC", () => {
    expect(resolveTimezone(undefined)).toBe("UTC");
    expect(resolveTimezone("")).toBe("UTC");
    expect(resolveTimezone("   ")).toBe("UTC");
    expect(resolveTimezone("Not/AZone")).toBe("UTC");
    expect(resolveTimezone("Europe/Paris")).toBe("Europe/Paris");
    const now = at("2026-03-09T00:00:00Z");
    expect(step(due({ now, timezone: "Not/AZone" })).dueAt.toISOString()).toBe(
      step(due({ now })).dueAt.toISOString(),
    );
  });

  it("the due day starts at local midnight (Paris, CET +1)", () => {
    // 2026-03-02 23:30Z is already Tuesday 03-03 in Paris; +7 = Tuesday 03-10.
    const app = { sentAt: d("2026-03-02T23:30:00Z"), emailTo: "a@b.c" };
    const r = step(due({ application: app, timezone: "Europe/Paris", now: at("2026-03-09T22:59:00Z") }));
    expect(r.dueAt.toISOString()).toBe("2026-03-09T23:00:00.000Z");
    expect(r.status).toBe("scheduled");
    expect(step(due({ application: app, timezone: "Europe/Paris", now: at("2026-03-09T23:00:00Z") })).status).toBe(
      "due",
    );
    // The same instant in UTC is a different day: due on 03-09 (Monday), a day earlier.
    expect(step(due({ application: app, now: at("2026-03-09T00:00:00Z") })).dueAt.toISOString()).toBe(
      "2026-03-09T00:00:00.000Z",
    );
  });

  it("crosses a DST change (Paris, 2026-03-29): the due day still starts at local midnight", () => {
    // Monday 03-23 12:00Z (CET) + 7 = Monday 03-30, which is CEST (+2).
    const app = { sentAt: d("2026-03-23T12:00:00Z"), emailTo: "a@b.c" };
    const r = step(due({ application: app, timezone: "Europe/Paris", now: at("2026-03-01T00:00:00Z") }));
    expect(r.dueAt.toISOString()).toBe("2026-03-29T22:00:00.000Z");
  });

  it("a day that is a weekend in the zone but a weekday in UTC follows the zone", () => {
    // 2026-03-06 20:00Z = Friday in UTC, Saturday 03-07 09:00 in Auckland (NZDT +13).
    const app = { sentAt: d("2026-03-06T20:00:00Z"), emailTo: "a@b.c" };
    const utc = step(due({ application: app, now: at("2026-03-01T00:00:00Z") }));
    expect(utc.dueAt.toISOString()).toBe("2026-03-13T00:00:00.000Z"); // Friday
    const nz = step(due({ application: app, timezone: "Pacific/Auckland", now: at("2026-03-01T00:00:00Z") }));
    // Local Saturday 03-14 moves to Monday 03-16 00:00 NZDT = 03-15 11:00Z.
    expect(nz.dueAt.toISOString()).toBe("2026-03-15T11:00:00.000Z");
  });

  it("works west of UTC and across its DST change (Los Angeles)", () => {
    // 2026-03-03 03:00Z is Monday 03-02 19:00 PST (-8); +7 = Monday 03-09 local,
    // after the US change on 03-08, so midnight is PDT (-7).
    const app = { sentAt: d("2026-03-03T03:00:00Z"), emailTo: "a@b.c" };
    const r = step(due({ application: app, timezone: "America/Los_Angeles", now: at("2026-03-01T00:00:00Z") }));
    expect(r.dueAt.toISOString()).toBe("2026-03-09T07:00:00.000Z");
  });

  it("startOfCivilDay is the local midnight", () => {
    expect(new Date(startOfCivilDay("UTC", { y: 2026, m: 3, d: 9 })).toISOString()).toBe("2026-03-09T00:00:00.000Z");
    expect(new Date(startOfCivilDay("Europe/Paris", { y: 2026, m: 7, d: 1 })).toISOString()).toBe(
      "2026-06-30T22:00:00.000Z",
    );
    expect(new Date(startOfCivilDay("Pacific/Auckland", { y: 2026, m: 7, d: 1 })).toISOString()).toBe(
      "2026-06-30T12:00:00.000Z",
    );
  });
});

describe("window (COCKPIT_FOLLOWUP_WINDOW_DAYS, default 30)", () => {
  // Step 1 due Monday 2026-03-09; window end Wednesday 2026-04-08 00:00Z.
  it("is still due on the last instant of the window, expired one millisecond later", () => {
    expect(step(due({ now: at("2026-04-08T00:00:00.000Z") })).status).toBe("due");
    expect(step(due({ now: at("2026-04-08T00:00:00.001Z") })).status).toBe("expired");
    expect(step(due()).windowEnd.toISOString()).toBe("2026-04-08T00:00:00.000Z");
  });

  it("an old application is expired, so enabling V1 does not flood the queue", () => {
    expect(step(due({ now: at("2026-09-01T10:00:00Z") })).status).toBe("expired");
  });

  it("honours a custom window", () => {
    expect(step(due({ windowDays: 10, now: at("2026-03-19T00:00:00Z") })).status).toBe("due");
    expect(step(due({ windowDays: 10, now: at("2026-03-19T00:00:01Z") })).status).toBe("expired");
  });

  it.each([undefined, -1, NaN, Infinity])("a bad window (%s) falls back to 30", (windowDays) => {
    expect(step(due({ windowDays: windowDays as number, now: at("2026-03-12T00:00:00Z") })).windowEnd.toISOString()).toBe(
      "2026-04-08T00:00:00.000Z",
    );
  });

  it("a window of 0 is due only at the start of the due day", () => {
    expect(step(due({ windowDays: 0, now: at("2026-03-09T00:00:00.000Z") })).status).toBe("due");
    expect(step(due({ windowDays: 0, now: at("2026-03-09T00:00:00.001Z") })).status).toBe("expired");
  });

  it("scheduled is checked before expired (a future due day is never expired)", () => {
    expect(step(due({ now: at("2026-03-02T11:00:00Z") })).status).toBe("scheduled");
  });
});

describe("step 2: follow-up 1 sentAt + 14 days", () => {
  const FU1 = d("2026-03-10T15:00:00Z"); // Tuesday; step 2 due Tuesday 2026-03-24

  it("counts from the sent follow-up, not from the application", () => {
    const r = step(due({ sentFollowUps: [{ sentAt: FU1 }], now: at("2026-03-23T23:59:59Z") }));
    expect(r.step).toBe(2);
    expect(r.anchor.toISOString()).toBe(FU1.toISOString());
    expect(r.dueAt.toISOString()).toBe("2026-03-24T00:00:00.000Z");
    expect(r.status).toBe("scheduled");
    expect(step(due({ sentFollowUps: [{ sentAt: FU1 }], now: at("2026-03-24T00:00:00Z") })).status).toBe("due");
  });

  it("applies the weekday rule", () => {
    // FU1 Sat 2026-03-14 + 14 = Sat 03-28 -> Monday 03-30.
    const r = step(due({ sentFollowUps: [{ sentAt: d("2026-03-14T10:00:00Z") }], now: at("2026-03-14T11:00:00Z") }));
    expect(r.dueAt.toISOString()).toBe("2026-03-30T00:00:00.000Z");
  });

  it("has its own window", () => {
    const sent = [{ sentAt: FU1 }];
    expect(step(due({ sentFollowUps: sent, now: at("2026-04-23T00:00:00Z") })).status).toBe("due");
    expect(step(due({ sentFollowUps: sent, now: at("2026-04-23T00:00:01Z") })).status).toBe("expired");
  });

  it("step 2 is not eligible while step 1 is still open (sentCount 0 is step 1)", () => {
    expect(step(due({ now: at("2026-03-24T10:00:00Z") })).step).toBe(1);
  });

  it("nothing is suggested after two sent follow-ups", () => {
    at("2026-04-30T10:00:00Z");
    expect(
      due({ sentFollowUps: [{ sentAt: FU1 }, { sentAt: d("2026-03-24T10:00:00Z") }] }),
    ).toEqual({ eligible: false, reason: "complete" });
  });

  it("a follow-up marked sent through the recovery panel counts like any sent one", () => {
    // Same input shape: it is a package with status sent and a sentAt.
    expect(step(due({ sentFollowUps: [{ sentAt: FU1 }], now: at("2026-03-24T00:00:00Z") })).step).toBe(2);
  });

  it("a sent follow-up without a sentAt still counts, and step 2 falls back to the application date", () => {
    const r = step(due({ sentFollowUps: [{ sentAt: null }], now: at("2026-03-20T00:00:00Z") }));
    expect(r.step).toBe(2);
    expect(r.anchor.toISOString()).toBe(SENT.toISOString());
  });

  it("uses the latest follow-up date when the sent ones are not in order", () => {
    const sent = [{ sentAt: d("2026-03-12T10:00:00Z") }, { sentAt: d("2026-03-10T10:00:00Z") }];
    at("2026-04-30T10:00:00Z");
    expect(due({ sentFollowUps: sent })).toMatchObject({ reason: "complete" });
  });
});

describe("skipping a step", () => {
  const SKIP = d("2026-03-09T12:00:00Z"); // Monday

  it("skipping step 1 makes step 2 due 14 days after the skip date", () => {
    const r = step(
      due({ state: state({ skippedThrough: 1, skippedAt: SKIP }), now: at("2026-03-22T00:00:00Z") }),
    );
    expect(r.step).toBe(2);
    expect(r.anchor.toISOString()).toBe(SKIP.toISOString());
    expect(r.dueAt.toISOString()).toBe("2026-03-23T00:00:00.000Z");
    expect(r.status).toBe("scheduled");
    expect(step(due({ state: state({ skippedThrough: 1, skippedAt: SKIP }), now: at("2026-03-23T00:00:00Z") })).status).toBe(
      "due",
    );
  });

  it("skip 1 then send = both steps done", () => {
    const sentAfterSkip = [{ sentAt: d("2026-03-25T10:00:00Z") }];
    expect(
      due({ state: state({ skippedThrough: 1, skippedAt: SKIP }), sentFollowUps: sentAfterSkip, now: at("2026-04-01T00:00:00Z") }),
    ).toEqual({ eligible: false, reason: "complete" });
  });

  it("send 1 then skip 2 = both steps done", () => {
    expect(
      due({
        state: state({ skippedThrough: 2, skippedAt: d("2026-03-25T10:00:00Z") }),
        sentFollowUps: [{ sentAt: d("2026-03-10T10:00:00Z") }],
        now: at("2026-04-01T00:00:00Z"),
      }),
    ).toEqual({ eligible: false, reason: "complete" });
  });

  it("skip 1 then skip 2 = both steps done", () => {
    expect(
      due({ state: state({ skippedThrough: 2, skippedAt: d("2026-03-25T10:00:00Z") }), now: at("2026-04-01T00:00:00Z") }),
    ).toEqual({ eligible: false, reason: "complete" });
  });

  it("a skip marker that predates the sent follow-up and says step 1 means that send was step 2", () => {
    // Skipped step 1 at 03-09, the follow-up was sent 03-25 (it was step 2).
    expect(
      stepProgress([{ sentAt: d("2026-03-25T10:00:00Z") }], { skippedThrough: 1, skippedAt: SKIP }),
    ).toMatchObject({ consumed: 2, step: null });
  });

  it("an inconsistent marker (skip 1 recorded after follow-up 1 was sent) is ignored", () => {
    expect(
      stepProgress([{ sentAt: d("2026-03-10T10:00:00Z") }], {
        skippedThrough: 1,
        skippedAt: d("2026-03-11T10:00:00Z"),
      }),
    ).toMatchObject({ consumed: 1, step: 2 });
  });

  it("a skip marker without a date anchors step 2 on the application and counts the step", () => {
    const r = step(due({ state: state({ skippedThrough: 1, skippedAt: null }), now: at("2026-03-20T00:00:00Z") }));
    expect(r.step).toBe(2);
    expect(r.anchor.toISOString()).toBe(SENT.toISOString());
  });

  it.each([-3, NaN, 0])("skippedThrough %s means nothing skipped", (n) => {
    expect(stepProgress([], { skippedThrough: n, skippedAt: SKIP })).toMatchObject({ consumed: 0, step: 1 });
  });

  it("skippedThrough above 2 is clamped to 2", () => {
    expect(stepProgress([], { skippedThrough: 9, skippedAt: SKIP })).toMatchObject({ consumed: 2, step: null });
  });

  it("step 2 skipped after step 1 was sent anchors nothing (complete)", () => {
    at("2026-04-01T00:00:00Z");
    expect(
      due({ state: state({ skippedThrough: 2, skippedAt: d("2026-03-25T00:00:00Z") }), sentFollowUps: [{ sentAt: d("2026-03-10T00:00:00Z") }] }),
    ).toMatchObject({ eligible: false });
  });
});

describe("snooze", () => {
  // Step 1 due Monday 2026-03-09.
  it("a future snooze hides a due step, a past or present one does not", () => {
    const now = at("2026-03-10T12:00:00Z");
    expect(step(due({ now, state: state({ snoozedUntil: d("2026-03-13T12:00:00Z") }) })).status).toBe("snoozed");
    expect(step(due({ now, state: state({ snoozedUntil: d("2026-03-10T12:00:00Z") }) })).status).toBe("due");
    expect(step(due({ now, state: state({ snoozedUntil: d("2026-03-10T11:59:59Z") }) })).status).toBe("due");
    expect(step(due({ now, state: state({ snoozedUntil: d("2026-03-10T12:00:00.001Z") }) })).status).toBe("snoozed");
  });

  it("reports the snooze date, also when the step is not snoozed any more", () => {
    const until = d("2026-03-13T12:00:00Z");
    expect(step(due({ now: at("2026-03-10T12:00:00Z"), state: state({ snoozedUntil: until }) })).snoozedUntil).toEqual(until);
  });

  it("a snooze does not make a future step due or an expired one reappear", () => {
    const until = d("2026-12-31T00:00:00Z");
    expect(step(due({ now: at("2026-03-05T00:00:00Z"), state: state({ snoozedUntil: until }) })).status).toBe("scheduled");
    expect(step(due({ now: at("2026-09-05T00:00:00Z"), state: state({ snoozedUntil: d("2026-09-01T00:00:00Z") }) })).status).toBe(
      "expired",
    );
  });

  it("snoozeUntil adds 3 or 7 whole days to now", () => {
    expect(snoozeUntil(d("2026-03-10T12:00:00Z"), 3).toISOString()).toBe("2026-03-13T12:00:00.000Z");
    expect(snoozeUntil(d("2026-03-10T12:00:00Z"), 7).toISOString()).toBe("2026-03-17T12:00:00.000Z");
  });
});

describe("isFollowUpDue", () => {
  it("is true only for a due step", () => {
    expect(isFollowUpDue(due({ now: at("2026-03-09T00:00:00Z") }))).toBe(true);
    expect(isFollowUpDue(due({ now: at("2026-03-08T00:00:00Z") }))).toBe(false);
    expect(isFollowUpDue(due({ now: at("2026-05-08T00:00:00Z") }))).toBe(false);
    expect(isFollowUpDue(due({ jobStatus: "rejected" }))).toBe(false);
    expect(
      isFollowUpDue(due({ now: at("2026-03-10T00:00:00Z"), state: state({ snoozedUntil: d("2026-03-20T00:00:00Z") }) })),
    ).toBe(false);
  });
});

describe("the calculation does not read the real clock or mutate its input", () => {
  it("gives the same answer however the clock moves, for a fixed `now`", () => {
    const input = base({ now: d("2026-03-12T00:00:00Z") });
    const a = computeFollowUpDue(input);
    vi.setSystemTime(d("2030-01-01T00:00:00Z"));
    expect(computeFollowUpDue(input)).toEqual(a);
  });

  it("does not change the arrays it is given", () => {
    const sent = [{ sentAt: d("2026-03-12T10:00:00Z") }, { sentAt: d("2026-03-10T10:00:00Z") }];
    const copy = JSON.stringify(sent);
    computeFollowUpDue(base({ sentFollowUps: sent, now: d("2026-04-30T00:00:00Z") }));
    expect(JSON.stringify(sent)).toBe(copy);
  });
});
