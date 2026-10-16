import test from "node:test";
import assert from "node:assert/strict";
import { GOAL_TYPES, validateGoalInput, validateGoalProposal, GOAL_SCHEMA } from "../js/goals.mjs";

const NOW = new Date(2026, 9, 15, 12).getTime();
const good = { type: "skill", what: "learn to play guitar", level: "new", hours: 3, by: "2026-12-20" };

test("valid input is cleaned and normalised", () => {
  const r = validateGoalInput(Object.assign({}, good, { what: "  learn   guitar\u0000\n basics ", hours: 2.74, saves: [{ title: "Chords", summary: "x" }, { title: "" }] }), NOW);
  assert.ok(r.ok);
  assert.equal(r.value.what, "learn guitar basics");
  assert.equal(r.value.hours_per_week, 2.5);
  assert.deepEqual(r.value.saves, [{ title: "Chords", summary: "x" }]);
  assert.equal(r.value.by, "2026-12-20");
});

test("input rules: type, text, level, hours, date", () => {
  assert.equal(validateGoalInput(Object.assign({}, good, { type: "weight loss" }), NOW).errors.type !== undefined, true);
  assert.equal(validateGoalInput(Object.assign({}, good, { what: "ab" }), NOW).errors.what !== undefined, true);
  assert.equal(validateGoalInput(Object.assign({}, good, { level: "expert" }), NOW).errors.level !== undefined, true);
  assert.equal(validateGoalInput(Object.assign({}, good, { hours: 0 }), NOW).errors.hours !== undefined, true);
  assert.equal(validateGoalInput(Object.assign({}, good, { hours: 25 }), NOW).errors.hours !== undefined, true);
  assert.equal(validateGoalInput(Object.assign({}, good, { by: "2020-01-01" }), NOW).errors.by !== undefined, true);
  assert.equal(validateGoalInput(Object.assign({}, good, { by: "2028-01-01" }), NOW).errors.by !== undefined, true);
  assert.equal(validateGoalInput(Object.assign({}, good, { by: "next month" }), NOW).errors.by !== undefined, true);
  assert.ok(validateGoalInput(Object.assign({}, good, { by: "" }), NOW).ok); // date is optional
  assert.equal(validateGoalInput(null, NOW).ok, false);
});

test("long text is cut, saves are capped at 5", () => {
  const r = validateGoalInput(Object.assign({}, good, { what: "x".repeat(900), saves: Array.from({ length: 9 }, (_, i) => ({ title: "t" + i, summary: "s" })) }), NOW);
  assert.equal(r.value.what.length, 300);
  assert.equal(r.value.saves.length, 5);
});

const act = (m = 20) => ({ step: "Practice three basic chords", minutes: m, detail: "Slowly, with a metronome." });
const plan = (o = {}) =>
  Object.assign({ status: "plan", question: "", title: "Learn guitar basics", finished_looks_like: "I can play one simple song.", assumptions: ["You own a guitar"], actions: [act(), act(), act(), act()] }, o);

test("a good plan passes and is cleaned", () => {
  const r = validateGoalProposal(plan({ title: "  Learn\u0001 guitar  " }), { hours: 3 });
  assert.ok(r.ok);
  assert.equal(r.value.title, "Learn guitar");
  assert.equal(r.value.actions.length, 4);
});

test("a question or a decline needs a message and carries no actions", () => {
  const q = validateGoalProposal({ status: "question", question: "What would finishing look like for you?", actions: [act()] }, { hours: 3 });
  assert.ok(q.ok);
  assert.equal(q.value.actions.length, 0);
  assert.equal(validateGoalProposal({ status: "question", question: "" }, { hours: 3 }).ok, false);
  assert.ok(validateGoalProposal({ status: "decline", question: "That is outside what this app can plan. A qualified professional can help." }, { hours: 3 }).ok);
});

test("plan rules: 3 to 6 actions, 5 to 90 minutes, clear steps", () => {
  assert.equal(validateGoalProposal(plan({ actions: [act(), act()] }), { hours: 3 }).ok, false);
  assert.equal(validateGoalProposal(plan({ actions: [act(4), act(), act()] }), { hours: 3 }).ok, false);
  assert.equal(validateGoalProposal(plan({ actions: [act(120), act(), act()] }), { hours: 3 }).ok, false);
  assert.equal(validateGoalProposal(plan({ actions: [{ step: "Go", minutes: 20, detail: "" }, act(), act()] }), { hours: 3 }).ok, false);
  assert.equal(validateGoalProposal(plan({ title: "" }), { hours: 3 }).ok, false);
  assert.equal(validateGoalProposal(plan({ status: "maybe" }), { hours: 3 }).ok, false);
  assert.equal(validateGoalProposal(null, { hours: 3 }).ok, false);
  const six = validateGoalProposal(plan({ actions: Array.from({ length: 9 }, () => act(10)) }), { hours: 3 });
  assert.equal(six.value.actions.length, 6); // never more than 6
});

test("minutes as numbers in strings are accepted and rounded", () => {
  const r = validateGoalProposal(plan({ actions: [act("20"), act(15.4), act(30)] }), { hours: 3 });
  assert.ok(r.ok);
  assert.deepEqual(r.value.actions.map((a) => a.minutes), [20, 15, 30]);
});

test("the weekly time budget is enforced by trimming the last actions", () => {
  // 1 hour = 60 minutes; 4 actions of 20 = 80, so the last one is dropped
  const r = validateGoalProposal(plan({ actions: [act(20), act(20), act(20), act(20)] }), { hours: 1 });
  assert.ok(r.ok);
  assert.equal(r.value.actions.length, 3);
  // cannot trim below 3 actions: 3 x 30 = 90 > 60 fails
  const f = validateGoalProposal(plan({ actions: [act(30), act(30), act(30)] }), { hours: 1 });
  assert.equal(f.ok, false);
  assert.match(f.errors.join(" "), /exceed/);
});

test("assumptions are capped and the schema forbids extra fields", () => {
  const r = validateGoalProposal(plan({ assumptions: ["a", "b", "c", "d", ""] }), { hours: 3 });
  assert.equal(r.value.assumptions.length, 3);
  assert.equal(GOAL_SCHEMA.additionalProperties, false);
  assert.equal(GOAL_SCHEMA.properties.actions.items.additionalProperties, false);
  assert.equal(GOAL_TYPES.length, 6);
});
