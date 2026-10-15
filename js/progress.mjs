// Actionably progress engine. Pure functions only: no DOM, no network, no clock unless passed in.
// Used by the browser (graph and week summaries) and covered by tests in /tests.
// Claude is never asked to compute any of these numbers.

export const OUTCOMES = ["done", "partial", "missed", "skipped", "rescheduled", "pending"];

// Keys a stored action record may contain. Keep in sync with firestore.rules.
export const RECORD_KEYS = [
  "pid", "wk", "title", "from", "kind", "sched", "schedDay", "outcome", "outAt",
  "min", "cur", "target", "events", "note", "goalId", "created",
];

const p2 = (n) => (n < 10 ? "0" : "") + n;
const fmt = (d) => d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());

// Calendar weeks run Monday to Sunday in local time. A week key is the Monday's date, YYYY-MM-DD.
export function wkKey(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return fmt(d);
}
export function wkStart(key) {
  const p = key.split("-");
  return new Date(+p[0], +p[1] - 1, +p[2]).getTime();
}
export function wkShift(key, n) {
  const p = key.split("-");
  return wkKey(new Date(+p[0], +p[1] - 1, +p[2] + 7 * n).getTime());
}

export function emptyCounts() {
  return { planned: 0, done: 0, partial: 0, skipped: 0, moved: 0, missed: 0, pending: 0 };
}

// Completion rate. Partly done counts as half. Actions skipped on purpose or moved to later are left out of
// the denominator (they are shown separately). Pending and missed actions count as not yet done.
// Returns null when nothing is left to measure, so the app shows a gap and not a fake zero.
export function rateOf(c) {
  const den = (c.planned || 0) - (c.skipped || 0) - (c.moved || 0);
  if (den <= 0) return null;
  return Math.min(1, ((c.done || 0) + 0.5 * (c.partial || 0)) / den);
}

// The outcome of one plan item. "closing" is true when the week is ending: unfinished work becomes missed.
export function outcomeOf(it, closing) {
  const full = it.goal ? (it.cur || 0) >= (it.target || 1) : !!it.done;
  if (full) return "done";
  if (it.out === "skipped") return "skipped";
  if (it.out === "rescheduled") return "rescheduled";
  if (it.out === "partial") return "partial";
  if (it.goal && (it.cur || 0) > 0 && closing) return "partial";
  return closing ? "missed" : "pending";
}

const cut = (s, n) => String(s == null ? "" : s).slice(0, n);

// Builds the stored record for a plan item. ctx: { wk, sched, closing, now, doneAt }
export function buildRecord(it, ctx) {
  const outcome = outcomeOf(it, !!ctx.closing);
  const data = {
    pid: cut(it.id, 60),
    wk: +ctx.wk || 0,
    title: cut(it.goal ? it.t : it.step || it.t, 140),
    from: it.goal ? "" : cut(it.t, 140),
    kind: it.goal ? "goal" : "action",
    sched: +ctx.sched || 0,
    schedDay: cut(it.day, 3),
    outcome,
    outAt: outcome === "done" ? +ctx.doneAt || +ctx.now || 0 : outcome === "pending" ? 0 : +ctx.now || 0,
    min: Math.max(0, Math.round(+it.min || 0)),
    events: (it.ev || []).slice(-30).map((e) => {
      const o = { o: cut(e.o, 20), at: +e.at || 0 };
      if (e.to !== undefined) o.to = cut(e.to, 20);
      if (e.from !== undefined) o.from = cut(e.from, 20);
      if (e.n !== undefined) o.n = +e.n || 0;
      return o;
    }),
    note: cut(it.on, 140),
    goalId: it.goalId ? cut(it.goalId, 60) : "",
    created: +it.rc || +ctx.now || 0,
  };
  if (it.goal) {
    data.cur = Math.max(0, +it.cur || 0);
    data.target = Math.max(1, +it.target || 1);
  }
  return { id: cut(data.wk + "_" + it.id, 100), data };
}

// Weekly series for the consistency graph, oldest first, one entry per calendar week.
// records: stored action records. legacy: weekly summaries saved before records existed
// ({start,end,planned,done,partial?,skipped?,moved?}). Legacy weeks only count if they closed before
// opts.recFrom (when record keeping began) so nothing is counted twice.
export function weeklySeries(records, legacy, opts) {
  const now = opts.now;
  const cur = wkKey(now);
  const n = opts.weeks || 12;
  const keys = [];
  for (let i = n - 1; i >= 0; i--) keys.push(wkShift(cur, -i));
  const bucket = {};
  const get = (k) => bucket[k] || (bucket[k] = Object.assign(emptyCounts(), { src: {} }));

  (records || []).forEach((r) => {
    if (!r || !r.sched) return;
    const k = wkKey(r.sched);
    const b = get(k);
    b.planned++;
    b.src.records = true;
    if (r.outcome === "done") b.done++;
    else if (r.outcome === "partial") b.partial++;
    else if (r.outcome === "skipped") b.skipped++;
    else if (r.outcome === "rescheduled") b.moved++;
    else if (r.outcome === "missed") b.missed++;
    else if (k < cur) b.missed++; // a pending action in a finished week never happened
    else b.pending++;
  });

  (legacy || []).forEach((w) => {
    if (!w || !w.start || !w.planned) return;
    if (opts.recFrom && w.end > opts.recFrom) return;
    const k = wkKey(w.start);
    const b = get(k);
    const d = w.done || 0, p = w.partial || 0, s = w.skipped || 0, m = w.moved || 0;
    b.planned += w.planned;
    b.done += d;
    b.partial += p;
    b.skipped += s;
    b.moved += m;
    b.missed += Math.max(0, w.planned - d - p - s - m);
    b.src.summary = true;
  });

  return keys.map((k) => {
    const b = bucket[k];
    const base = { key: k, start: wkStart(k), current: k === cur };
    if (!b || !b.planned) return Object.assign(base, emptyCounts(), { rate: null, source: "none" });
    const source = b.src.records && b.src.summary ? "mixed" : b.src.records ? "records" : "summary";
    return Object.assign(base, {
      planned: b.planned, done: b.done, partial: b.partial, skipped: b.skipped,
      moved: b.moved, missed: b.missed, pending: b.pending, rate: rateOf(b), source,
    });
  });
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// Compares the last two finished weeks with the two before them. A direction, not a judgement.
export function trend(series, opts) {
  const band = (opts && opts.band) || 0.1;
  const w = series.filter((s) => !s.current && s.rate !== null);
  if (w.length < 3) return { label: "insufficient", weeks: w.length };
  const recent = mean(w.slice(-2).map((s) => s.rate));
  const earlier = mean(w.slice(-4, -2).map((s) => s.rate));
  const diff = recent - earlier;
  return { label: diff > band ? "improving" : diff < -band ? "declining" : "steady", recent, earlier, weeks: w.length };
}

export function sumWeeks(series) {
  const t = emptyCounts();
  series.forEach((s) => {
    ["planned", "done", "partial", "skipped", "moved", "missed", "pending"].forEach((k) => (t[k] += s[k] || 0));
  });
  return t;
}
