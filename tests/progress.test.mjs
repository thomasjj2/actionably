import test from "node:test";
import assert from "node:assert/strict";
import {
  wkKey, wkShift, rateOf, outcomeOf, buildRecord, weeklySeries, trend, sumWeeks, RECORD_KEYS, emptyCounts,
} from "../js/progress.mjs";

const L = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime(); // local time, so tests pass in any time zone

test("weeks run Monday to Sunday", () => {
  assert.equal(wkKey(L(2026, 10, 12)), "2026-10-12"); // Monday
  assert.equal(wkKey(L(2026, 10, 18, 23)), "2026-10-12"); // Sunday night
  assert.equal(wkKey(L(2026, 10, 19, 0)), "2026-10-19");
  assert.equal(wkShift("2026-10-12", -2), "2026-09-28");
  assert.equal(wkShift("2026-12-28", 1), "2027-01-04");
});

test("rate: partial counts half, skipped and moved are left out", () => {
  assert.equal(rateOf({ planned: 4, done: 4 }), 1);
  assert.equal(rateOf({ planned: 4, done: 2, partial: 2 }), 0.75);
  assert.equal(rateOf({ planned: 5, done: 2, skipped: 1 }), 0.5); // 2 of 4
  assert.equal(rateOf({ planned: 5, done: 2, moved: 1, skipped: 1 }), 2 / 3);
  assert.equal(rateOf({ planned: 3, skipped: 3 }), null); // nothing to measure
  assert.equal(rateOf({ planned: 0 }), null);
  assert.equal(rateOf({ planned: 2, done: 0 }), 0);
});

test("outcomes: unfinished work is only missed when the week closes", () => {
  assert.equal(outcomeOf({ done: true }, false), "done");
  assert.equal(outcomeOf({}, false), "pending");
  assert.equal(outcomeOf({}, true), "missed");
  assert.equal(outcomeOf({ out: "skipped" }, true), "skipped");
  assert.equal(outcomeOf({ out: "rescheduled" }, true), "rescheduled");
  assert.equal(outcomeOf({ out: "partial" }, false), "partial");
  assert.equal(outcomeOf({ goal: true, cur: 5, target: 5 }, false), "done");
  assert.equal(outcomeOf({ goal: true, cur: 2, target: 5 }, false), "pending");
  assert.equal(outcomeOf({ goal: true, cur: 2, target: 5 }, true), "partial");
  assert.equal(outcomeOf({ goal: true, cur: 0, target: 5 }, true), "missed");
  assert.equal(outcomeOf({ goal: true, cur: 2, target: 5, out: "skipped" }, true), "skipped");
});

test("buildRecord stores only allowed keys and trims long text", () => {
  const it = {
    id: "p3_1", t: "x".repeat(300), step: "y".repeat(300), day: "Wednesday", min: 20.4, on: "z".repeat(300),
    ev: Array.from({ length: 50 }, (_, i) => ({ o: "moved", at: i, from: "Mon", to: "Tue" })), out: "partial",
  };
  const r = buildRecord(it, { wk: 1000, sched: 5000, closing: false, now: 9000 });
  assert.equal(r.id, "1000_p3_1");
  assert.equal(r.data.outcome, "partial");
  assert.equal(r.data.title.length, 140);
  assert.equal(r.data.note.length, 140);
  assert.equal(r.data.schedDay, "Wed");
  assert.equal(r.data.events.length, 30);
  assert.equal(r.data.min, 20);
  for (const k of Object.keys(r.data)) assert.ok(RECORD_KEYS.includes(k), "unexpected key " + k);
});

test("buildRecord for a goal keeps progress and uses the completion time for done", () => {
  const g = { id: "gx1", goal: true, t: "Run 3 times", cur: 3, target: 3, day: "Fri", min: 30 };
  const r = buildRecord(g, { wk: 1, sched: 2, closing: true, now: 900, doneAt: 400 });
  assert.equal(r.data.kind, "goal");
  assert.equal(r.data.outcome, "done");
  assert.equal(r.data.outAt, 400);
  assert.equal(r.data.cur, 3);
  assert.equal(r.data.target, 3);
});

const rec = (sched, outcome) => ({ sched, outcome });

test("series leaves gaps for weeks with no data and never invents zeros", () => {
  const now = L(2026, 10, 14); // Wednesday
  const s = weeklySeries([rec(L(2026, 10, 6), "done"), rec(L(2026, 10, 7), "missed")], [], { now, weeks: 4 });
  assert.equal(s.length, 4);
  assert.deepEqual(s.map((w) => w.key), ["2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"]);
  assert.equal(s[0].rate, null);
  assert.equal(s[1].rate, null);
  assert.equal(s[2].rate, 0.5);
  assert.equal(s[3].rate, null);
  assert.equal(s[3].current, true);
});

test("pending in a finished week counts as missed, pending this week stays open", () => {
  const now = L(2026, 10, 14);
  const s = weeklySeries(
    [rec(L(2026, 10, 6), "pending"), rec(L(2026, 10, 6), "done"), rec(L(2026, 10, 13), "done"), rec(L(2026, 10, 15), "pending")],
    [], { now, weeks: 2 }
  );
  assert.equal(s[0].missed, 1);
  assert.equal(s[0].pending, 0);
  assert.equal(s[0].rate, 0.5);
  assert.equal(s[1].pending, 1);
  assert.equal(s[1].rate, 0.5); // 1 done of 2 planned so far
});

test("skipped and moved actions are shown but do not lower the rate", () => {
  const now = L(2026, 10, 14);
  const s = weeklySeries(
    [rec(L(2026, 10, 6), "done"), rec(L(2026, 10, 7), "skipped"), rec(L(2026, 10, 8), "rescheduled"), rec(L(2026, 10, 9), "partial")],
    [], { now, weeks: 2 }
  );
  assert.equal(s[0].skipped, 1);
  assert.equal(s[0].moved, 1);
  assert.equal(s[0].rate, 0.75); // (1 + 0.5) / 2
});

test("legacy weekly summaries fill earlier weeks and are not double counted", () => {
  const now = L(2026, 10, 14);
  const legacy = [
    { start: L(2026, 9, 29), end: L(2026, 10, 3), planned: 4, done: 3 },
    { start: L(2026, 10, 6), end: L(2026, 10, 12), planned: 5, done: 5 }, // closed after record keeping began
  ];
  const s = weeklySeries([rec(L(2026, 10, 7), "done")], legacy, { now, weeks: 3, recFrom: L(2026, 10, 5) });
  assert.deepEqual(s.map((w) => w.key), ["2026-09-28", "2026-10-05", "2026-10-12"]);
  assert.equal(s[0].source, "summary");
  assert.equal(s[0].planned, 4);
  assert.equal(s[0].missed, 1);
  assert.equal(s[0].rate, 0.75);
  assert.equal(s[1].source, "records");
  assert.equal(s[1].planned, 1); // the second legacy week closed after record keeping began, so it is ignored
  assert.equal(s[2].source, "none");
});

test("trend compares the last two finished weeks with the two before", () => {
  const mk = (rates, cur = null) =>
    rates.map((r, i) => ({ key: "k" + i, rate: r, current: false })).concat(cur === null ? [] : [{ key: "c", rate: cur, current: true }]);
  assert.equal(trend(mk([0.5, 0.5, 0.9, 0.9])).label, "improving");
  assert.equal(trend(mk([0.9, 0.9, 0.5, 0.5])).label, "declining");
  assert.equal(trend(mk([0.6, 0.7, 0.65, 0.7])).label, "steady");
  assert.equal(trend(mk([0.6, 0.7])).label, "insufficient");
  assert.equal(trend(mk([null, 0.6, 0.7, null, 0.8, 0.9], 0.1)).label, "improving"); // gaps and the current week are ignored
});

test("sumWeeks adds the counts", () => {
  const t = sumWeeks([
    Object.assign(emptyCounts(), { planned: 3, done: 2, missed: 1 }),
    Object.assign(emptyCounts(), { planned: 2, done: 1, skipped: 1 }),
  ]);
  assert.equal(t.planned, 5);
  assert.equal(t.done, 3);
  assert.equal(t.skipped, 1);
  assert.equal(t.missed, 1);
});
