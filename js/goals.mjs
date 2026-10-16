// Actionably goal setup: input checks and proposal validation. Pure functions, no network.
// The server uses these to check what a user sends and what the AI returns before anything is shown or saved.
// The AI proposes; this code decides what is acceptable.

export const GOAL_TYPES = ["skill", "concept", "communication", "consistency", "fitness", "project"];
export const LEVELS = ["new", "some", "returning"];

const clean = (s, n) =>
  String(s == null ? "" : s)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);

// What the user sends when setting up a goal.
export function validateGoalInput(b, now = Date.now()) {
  const errors = {};
  b = b || {};
  const type = String(b.type || "");
  if (!GOAL_TYPES.includes(type)) errors.type = "Pick a goal type.";
  const what = clean(b.what, 300);
  if (what.length < 3) errors.what = "Tell us what you want to do, in a few words.";
  const level = String(b.level || "");
  if (!LEVELS.includes(level)) errors.level = "Choose where you are starting from.";
  let hours = Number(b.hours);
  if (!(hours >= 0.5 && hours <= 20)) errors.hours = "Choose between half an hour and 20 hours a week.";
  else hours = Math.round(hours * 2) / 2;
  let by = "";
  if (b.by) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(b.by));
    const t = m ? new Date(+m[1], +m[2] - 1, +m[3], 12).getTime() : NaN;
    if (!m || !(t >= now - 864e5) || t > now + 400 * 864e5) errors.by = "Pick a date within the next year, or leave it blank.";
    else by = String(b.by);
  }
  const answer = clean(b.answer, 600);
  const saves = (Array.isArray(b.saves) ? b.saves : [])
    .slice(0, 5)
    .map((s) => ({ title: clean(s && s.title, 100), summary: clean(s && s.summary, 200) }))
    .filter((s) => s.title);
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { type, what, level, hours_per_week: hours, by, answer, saves } };
}

// The shape the AI must return (used for structured outputs). Code validates it again below.
export const GOAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "question", "title", "finished_looks_like", "assumptions", "actions"],
  properties: {
    status: { type: "string", enum: ["plan", "question", "decline"] },
    question: { type: "string" },
    title: { type: "string" },
    finished_looks_like: { type: "string" },
    assumptions: { type: "array", items: { type: "string" } },
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["step", "minutes", "detail"],
        properties: { step: { type: "string" }, minutes: { type: "integer" }, detail: { type: "string" } },
      },
    },
  },
};

// Checks what the AI returned. ctx: { hours } is the user's weekly time.
export function validateGoalProposal(p, ctx) {
  const errors = [];
  if (!p || typeof p !== "object") return { ok: false, errors: ["The reply was not an object."] };
  const status = String(p.status || "");
  if (!["plan", "question", "decline"].includes(status)) return { ok: false, errors: ["status must be plan, question or decline."] };
  const question = clean(p.question, 240);

  if (status !== "plan") {
    if (question.length < 5) return { ok: false, errors: ["A question or decline message is required."] };
    return { ok: true, value: { status, question, title: "", finished_looks_like: "", assumptions: [], actions: [] } };
  }

  const title = clean(p.title, 80);
  if (title.length < 3) errors.push("title is missing.");
  const finished = clean(p.finished_looks_like, 200);
  if (finished.length < 3) errors.push("finished_looks_like is missing.");
  const assumptions = (Array.isArray(p.assumptions) ? p.assumptions : []).slice(0, 3).map((a) => clean(a, 140)).filter(Boolean);

  let actions = (Array.isArray(p.actions) ? p.actions : []).slice(0, 6).map((a) => {
    const m = Math.round(Number(a && a.minutes));
    return { step: clean(a && a.step, 140), minutes: m, detail: clean(a && a.detail, 200) };
  });
  if (actions.length < 3) errors.push("Between 3 and 6 actions are required.");
  actions.forEach((a, i) => {
    if (a.step.length < 5) errors.push("Action " + (i + 1) + " needs a clear step.");
    if (!(a.minutes >= 5 && a.minutes <= 90)) errors.push("Action " + (i + 1) + " minutes must be between 5 and 90.");
  });

  const budget = Math.floor(((ctx && ctx.hours) || 3) * 60);
  let total = actions.reduce((x, a) => x + (a.minutes || 0), 0);
  while (total > budget && actions.length > 3) total -= actions.pop().minutes || 0; // drop the last actions first
  if (total > budget) errors.push("Total minutes exceed the weekly time of " + budget + ".");

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { status, question: "", title, finished_looks_like: finished, assumptions, actions } };
}
