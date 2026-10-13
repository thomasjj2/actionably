// Actionably: one Netlify function, two jobs: "extract" a save, "plan" the week.
// Env vars: ANTHROPIC_API_KEY (required), ANTHROPIC_MODEL (optional),
// FIREBASE_API_KEY (the web apiKey; when set, every request must carry a signed-in user's token),
// FIREBASE_SERVICE_ACCOUNT_JSON (service account for this Firebase project; enables the daily token cap),
// DAILY_TOKEN_LIMIT (optional, tokens per user per day, default 100000, 0 turns the cap off),
// UNLIMITED_EMAILS (optional, comma separated emails that skip the hourly and daily limits)
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

export const config = { path: "/api/ai" };

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

const EXTRACT = `You extract the useful content from a saved social media post.
Input: screenshots and/or caption text. Several images may be slides of one post.
Return ONLY JSON, no markdown:
{"category":"cook|train|buy|learn|try|mindset","title":"max 8 words",
"summary":"one sentence","steps_or_items":["ingredients, exercises, steps, or product names"],
"time_needed":"minutes as a number","effort":"easy|medium|hard","theme":"one or two words",
"suggested_action":"one concrete next step using only what the post shows",
"missing_info":"anything cut off or unclear, or null"}
Rules: only include what the post actually shows. Never invent quantities, steps, or details.
If it looks like one slide of a longer carousel, say so in missing_info.`;

const PLAN = `You build a weekly plan for Actionably, an app that turns saved posts into actions.
Input JSON: {size, hours, picks:[{id,category,title,steps_or_items,time_needed,missing_info,source_link}]}
Return ONLY JSON, no markdown:
{"plan":[{"day":"Mon|Tue|Wed|Thu|Fri|Sat|Sun","ref":<pick id>,"next_step":"string","est_minutes":number,"why_now":"string"}]}
Rules: at most "size" items; total minutes at most hours*60; spread across the week with easy items first;
next_step is one concrete action using only what the pick contains, never invent details;
if missing_info is not null, the first step is to check the original post;
friendly, short, no guilt.`;


const GOALS = `You propose weekly goals for a user of Actionably, an app that turns saved posts into actions.
Input JSON: {profile:{focus_areas,hours_per_week,style:"daily"|"weekly"}, themes:[{theme,save_count}], recent_saves:[{title,theme,suggested_action}], history:[{goal_title,target,completed}]}
Return ONLY JSON, no markdown:
{"goals":[{"title":"max 8 words","metric":"what is counted","target":number,"deadline":"Mon|Tue|Wed|Thu|Fri|Sat|Sun","est_minutes":number,"based_on":"theme or focus area","why":"one sentence tied to the user's saves"}],"question":null}
Rules: propose 1 to 3 goals; ground each in a named theme or focus area; every goal is measurable (number, unit, deadline);
total est_minutes must not exceed hours_per_week*60; if history shows under 50% completion make goals smaller than before, over 80% you may raise slightly;
never invent facts or numbers the user did not provide; style "daily" means the target can be split across days, "weekly" means one batch before the deadline;
if there is too little data (fewer than 3 saves and no focus area) return goals as [] and ask one clarifying question in "question"; friendly, short, no guilt.`;

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });


const hits = new Map(); // best-effort per-user limit, resets when the function instance restarts
const LIMIT_PER_HOUR = 40;
const DAILY_TOKEN_LIMIT = parseInt(process.env.DAILY_TOKEN_LIMIT || "100000", 10);
const UNLIMITED = (process.env.UNLIMITED_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

let _db;
function db() {
  if (_db !== undefined) return _db;
  _db = null;
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) { console.warn("FIREBASE_SERVICE_ACCOUNT_JSON missing, daily token cap is off"); return _db; }
    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(raw)) });
    _db = getFirestore();
  } catch (e) {
    console.error("Firebase admin init failed:", e.message);
  }
  return _db;
}

const dayKey = () => new Date().toISOString().slice(0, 10); // UTC day

async function usedToday(uid) {
  const d = db();
  if (!d) return 0;
  try {
    const snap = await d.collection("aiUsage").doc(uid + "_" + dayKey()).get();
    return snap.exists ? snap.data().tokens || 0 : 0;
  } catch (e) {
    console.error("usage read failed:", e.message);
    return 0;
  }
}

async function addUsage(uid, tokens) {
  const d = db();
  if (!d || !tokens) return;
  try {
    await d.collection("aiUsage").doc(uid + "_" + dayKey()).set(
      { uid, day: dayKey(), tokens: FieldValue.increment(tokens), requests: FieldValue.increment(1) },
      { merge: true }
    );
  } catch (e) {
    console.error("usage write failed:", e.message);
  }
}

async function verify(req) {
  const m = (req.headers.get("authorization") || "").match(/^Bearer (.+)$/);
  if (!m) return null;
  const r = await fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + process.env.FIREBASE_API_KEY,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken: m[1] }) }
  );
  if (!r.ok) return null;
  const d = await r.json();
  const u = d.users && d.users[0];
  return u ? { uid: u.localId, email: String(u.email || "").toLowerCase(), verified: !!u.emailVerified } : null;
}

function limited(uid) {
  const now = Date.now();
  const arr = (hits.get(uid) || []).filter((t) => now - t < 3600000);
  if (arr.length >= LIMIT_PER_HOUR) return true;
  arr.push(now);
  hits.set(uid, arr);
  return false;
}

async function claude(system, content, meter) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1200, system, messages: [{ role: "user", content }] }),
  });
  if (!r.ok) throw new Error("claude " + r.status);
  const d = await r.json();
  if (meter && d.usage) meter.tokens += (d.usage.input_tokens || 0) + (d.usage.output_tokens || 0);
  const txt = (d.content || []).map((b) => b.text || "").join("");
  return JSON.parse(txt.replace(/```json|```/g, "").trim());
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!process.env.ANTHROPIC_API_KEY) return json({ error: "Missing ANTHROPIC_API_KEY" }, 500);
  let user = null, exempt = false;
  const meter = { tokens: 0 };
  if (process.env.FIREBASE_API_KEY) {
    user = await verify(req);
    if (!user) return json({ error: "Sign in required" }, 401);
    exempt = user.verified && UNLIMITED.includes(user.email);
    if (!exempt) {
      if (limited(user.uid)) return json({ error: "Hourly limit reached" }, 429);
      if (DAILY_TOKEN_LIMIT > 0 && (await usedToday(user.uid)) >= DAILY_TOKEN_LIMIT)
        return json({ error: "Daily limit reached", code: "daily_limit" }, 429);
    }
  }
  let b;
  try { b = await req.json(); } catch { return json({ error: "Bad JSON" }, 400); }
  try {
    if (b.mode === "extract") {
      const imgs = (b.images || []).slice(0, 4).filter((x) => typeof x === "string");
      if (!imgs.length && !String(b.text || "").trim()) return json({ error: "Nothing to extract" }, 400);
      const content = imgs.map((data) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } }));
      content.push({ type: "text", text: "Caption/text: " + String(b.text || "").slice(0, 4000) });
      return json(await claude(EXTRACT, content, meter));
    }
    if (b.mode === "plan") {
      const picks = (b.picks || []).slice(0, 6);
      const size = Math.min(6, Math.max(2, +b.size || 4));
      const hours = Math.min(20, Math.max(0.5, +b.hours || 3));
      const out = await claude(PLAN, JSON.stringify({ size, hours, picks }), meter);
      const ids = new Set(picks.map((p) => String(p.id)));
      const plan = (out.plan || []).filter((p) => ids.has(String(p.ref))).slice(0, size);
      const mins = plan.reduce((a, p) => a + (+p.est_minutes || 0), 0);
      if (!plan.length || mins > hours * 60) return json({ error: "Plan failed checks" }, 502);
      return json({ plan });
    }
    if (b.mode === "goals") {
      const pf = b.profile || {};
      const hours = Math.min(20, Math.max(0.5, +pf.hours || 3));
      const input = {
        profile: { focus_areas: (pf.focus || []).slice(0, 2), hours_per_week: hours, style: pf.style === "daily" ? "daily" : "weekly" },
        themes: (b.themes || []).slice(0, 8),
        recent_saves: (b.recent_saves || []).slice(0, 10),
        history: (b.history || []).slice(-20),
      };
      const out = await claude(GOALS, JSON.stringify(input), meter);
      let total = 0;
      const goals = (Array.isArray(out.goals) ? out.goals : [])
        .filter((g) => g && g.title && +g.target > 0)
        .slice(0, 3)
        .filter((g) => ((total += +g.est_minutes || 0), total <= hours * 60));
      if (!goals.length && !out.question) return json({ error: "No goals" }, 502);
      return json({ goals, question: goals.length ? null : String(out.question || "") });
    }
    return json({ error: "Unknown mode" }, 400);
  } catch (e) {
    return json({ error: "AI request failed" }, 502);
  } finally {
    if (user && !exempt) await addUsage(user.uid, meter.tokens);
  }
};
