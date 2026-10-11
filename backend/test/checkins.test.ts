import assert from "node:assert/strict";
import { test } from "node:test";
import { startLocalServer } from "../scripts/local-server.js";
import { flagCheckIn, followUpSummary } from "../src/routes/checkins.js";
import type { CheckIn } from "../src/docstore/types.js";

const headers = { "Content-Type": "application/json", "x-provider-key": "local-test-key" };
const post = (body: unknown, h: Record<string, string> = headers): RequestInit => ({ method: "POST", headers: h, body: JSON.stringify(body) });
const patient = { "Content-Type": "application/json" };

const base = (over: Partial<CheckIn> = {}): Omit<CheckIn, "flags"> => ({
  at: "2026-10-05T12:00:00.000Z", day: 5, by: "patient", language: "en", meds: "all", urgentSigns: [], callDoctorSigns: [], ...over,
});
const earlier = (at: string, weightLb: number, day: number): CheckIn => ({ ...base({ at, weightLb, day }), flags: [] });

test("the flag rules: warning signs, missed medicines, weight gain by day and by week, teach-back", () => {
  assert.deepEqual(flagCheckIn(base(), []), []);
  assert.deepEqual(flagCheckIn(base({ urgentSigns: ["Chest pain"] }), []).map((f) => [f.level, f.code]), [["urgent", "warning_sign"]]);
  assert.deepEqual(flagCheckIn(base({ callDoctorSigns: ["Fever"], meds: "some" }), []).map((f) => f.code), ["call_doctor_sign", "missed_some_meds"]);
  assert.deepEqual(flagCheckIn(base({ meds: "none" }), []).map((f) => f.code), ["missed_all_meds"]);
  // 2 lb since yesterday flags; 1.5 lb does not.
  assert.deepEqual(flagCheckIn(base({ weightLb: 182 }), [earlier("2026-10-04T12:00:00.000Z", 180, 4)]).map((f) => f.code), ["weight_gain_day"]);
  assert.deepEqual(flagCheckIn(base({ weightLb: 181.5 }), [earlier("2026-10-04T12:00:00.000Z", 180, 4)]), []);
  // A slow climb: 5 lb over the week's lowest, never 2 lb in a day.
  const week = [earlier("2026-09-29T12:00:00.000Z", 178, 0), earlier("2026-10-01T12:00:00.000Z", 179.5, 2), earlier("2026-10-03T12:00:00.000Z", 181, 4), earlier("2026-10-04T12:00:00.000Z", 181.5, 5)];
  assert.deepEqual(flagCheckIn(base({ weightLb: 183 }), week).map((f) => f.code), ["weight_gain_week"]);
  // Weights older than a week do not count.
  assert.deepEqual(flagCheckIn(base({ weightLb: 183 }), [earlier("2026-09-20T12:00:00.000Z", 170, 1)]), []);
  assert.deepEqual(flagCheckIn(base({ teachBack: { medicine: "Furosemide", correct: false } }), []).map((f) => f.code), ["teach_back_missed"]);
  assert.deepEqual(flagCheckIn(base({ teachBack: { medicine: "Furosemide", correct: true } }), []), []);
});

test("the follow-up summary counts days, flags a gap of two days, and ranks the day's worst level", () => {
  const createdAt = "2026-10-01T09:00:00.000Z";
  assert.equal(followUpSummary({ createdAt }, new Date("2026-10-02T09:00:00.000Z")).level, "ok");
  const gap = followUpSummary({ createdAt }, new Date("2026-10-03T10:00:00.000Z"));
  assert.equal(gap.day, 3); assert.deepEqual(gap.flags.map((f) => f.code), ["no_checkin"]);
  const checkins: CheckIn[] = [
    { ...base({ at: "2026-10-01T10:00:00.000Z", day: 1, weightLb: 180 }), flags: [] },
    { ...base({ at: "2026-10-02T10:00:00.000Z", day: 2, weightLb: 183 }), flags: [{ level: "attention", code: "weight_gain_day", text: "" }] },
  ];
  const s = followUpSummary({ createdAt, checkins }, new Date("2026-10-02T12:00:00.000Z"));
  assert.equal(s.daysCheckedIn, 2); assert.equal(s.checkedInToday, true); assert.equal(s.weightChangeLb, 3); assert.equal(s.level, "attention");
  assert.deepEqual(s.timeline, [{ day: 1, level: "ok" }, { day: 2, level: "attention" }]);
  assert.equal(followUpSummary({ createdAt, checkins }, new Date("2040-01-01T00:00:00.000Z")).day, 30);
});

test("patients check in on their link, the dashboard sees the flags, and the purge deletes the check-ins", async () => {
  const h = await startLocalServer(0);
  try {
    const accepted = await (await fetch(h.origin + "/api/ingest", post({ patientID: "7", DOB: "2000-01-01", type: "text", data: "Synthetic notes for a check-in" }))).json();
    await h.ctx.queue.onIdle();
    const token = accepted.sumId as string;

    // The patient endpoints take the link id; a bad one is refused, an unknown one is 404.
    assert.equal((await fetch(h.origin + "/api/checkin", post({ token: "nope", meds: "all" }, patient))).status, 400);
    assert.equal((await fetch(h.origin + "/api/checkin", post({ token, meds: "maybe" }, patient))).status, 400);

    const first = await fetch(h.origin + "/api/checkin", post({ token, meds: "all", weightLb: 180 }, patient));
    assert.equal(first.status, 201);
    assert.deepEqual((await first.json()).checkin.flags, []);

    h.ctx.clock.advanceDays(1);
    const second = await (await fetch(h.origin + "/api/checkin", post({ token, by: "caregiver", meds: "some", weightLb: 183, urgentSigns: ["Chest pain or pressure"], teachBack: { medicine: "Furosemide", correct: false } }, patient))).json();
    assert.deepEqual(second.checkin.flags.map((f: { code: string }) => f.code), ["warning_sign", "missed_some_meds", "weight_gain_day", "teach_back_missed"]);
    assert.equal(second.followUp.level, "urgent"); assert.equal(second.followUp.day, 2); assert.equal(second.followUp.daysCheckedIn, 2);

    const mine = await (await fetch(h.origin + "/api/checkins?sum_id=" + token)).json();
    assert.equal(mine.checkins.length, 2); assert.equal(mine.followUp.checkedInToday, true);

    // The dashboard list needs the provider key.
    assert.equal((await fetch(h.origin + "/api/followups")).status, 401);
    const board = await (await fetch(h.origin + "/api/followups", { headers })).json();
    const row = board.followups.find((f: { sumId: string }) => f.sumId === token);
    assert.equal(row.patientID, "7"); assert.equal(row.level, "urgent"); assert.equal(row.weightChangeLb, 3); assert.match(row.link, /\/s\//);

    // The audit log keeps rule codes, never answers.
    const audit = JSON.stringify(await h.ctx.audit.listForLink(token));
    assert.match(audit, /checkin.recorded/);
    assert.doesNotMatch(audit, /Chest pain|183/);

    // Day 31: the link is gone and so are the check-ins.
    h.ctx.clock.advanceDays(30);
    assert.equal((await fetch(h.origin + "/api/checkin", post({ token, meds: "all" }, patient))).status, 410);
    await h.ctx.purge();
    assert.equal(await h.ctx.summaries.get(token), null);
    assert.ok(!(await (await fetch(h.origin + "/api/followups", { headers })).json()).followups.some((f: { sumId: string }) => f.sumId === token));
  } finally { await h.close(); }
});
