// Actionably: private app stats for the owner. GET /api/stats
// Only a signed in account whose verified email is listed in ADMIN_EMAILS can read this.
// It returns totals and counts only. It never reads or returns anything a user wrote.
// Env vars: FIREBASE_API_KEY, FIREBASE_SERVICE_ACCOUNT_JSON, ADMIN_EMAILS (comma separated)
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { GOAL_TYPES } from "../../js/goals.mjs";

export const config = { path: "/api/stats" };

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const emails = (name) => (process.env[name] || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

function db() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(raw)) });
    return getFirestore();
  } catch (e) {
    console.error("Firebase admin init failed:", e.message);
    return null;
  }
}

async function verify(req) {
  const m = (req.headers.get("authorization") || "").match(/^Bearer (.+)$/);
  if (!m || !process.env.FIREBASE_API_KEY) return null;
  const r = await fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + process.env.FIREBASE_API_KEY,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken: m[1] }) }
  );
  if (!r.ok) return null;
  const d = await r.json();
  const u = d.users && d.users[0];
  return u ? { uid: u.localId, email: String(u.email || "").toLowerCase(), verified: !!u.emailVerified } : null;
}

const MODES = ["extract", "goal_setup", "plan", "goals"];
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

export default async (req) => {
  if (req.method !== "GET") return json({ error: "GET only" }, 405);
  const user = await verify(req);
  if (!user) return json({ error: "Sign in required" }, 401);
  if (!(user.verified && emails("ADMIN_EMAILS").includes(user.email))) return json({ error: "Not allowed" }, 403);
  const d = db();
  if (!d) return json({ error: "Stats are not available right now" }, 503);

  try {
    const now = Date.now();
    const since = dayOf(now - 13 * 864e5);
    const [apps, goalSnap, entSnap, useSnap] = await Promise.all([
      d.collection("actionablyApp").count().get(),
      d.collectionGroup("goals").select("type", "created", "status").get(),
      d.collection("entitlements").get(),
      d.collection("aiUsage").where("day", ">=", since).get(),
    ]);

    // goals: counts by type and by day, never their text
    const byType = {};
    GOAL_TYPES.forEach((t) => (byType[t] = 0));
    const perDay = {};
    const withGoal = new Set();
    let active = 0;
    goalSnap.docs.forEach((g) => {
      const x = g.data();
      byType[GOAL_TYPES.includes(x.type) ? x.type : "other"] = (byType[GOAL_TYPES.includes(x.type) ? x.type : "other"] || 0) + 1;
      if (x.status === "active") active++;
      const uid = String(g.ref.path).split("/")[1];
      if (uid) withGoal.add(uid);
      if (x.created && x.created >= now - 13 * 864e5) perDay[dayOf(x.created)] = (perDay[dayOf(x.created)] || 0) + 1;
    });

    // paid and starter weeks
    let pro = 0, starterUsed = 0;
    entSnap.docs.forEach((e) => {
      const x = e.data();
      if (x.tier === "pro") pro++;
      if (x.starterUsed) starterUsed++;
    });

    // AI use per day (only accounts that are not exempt from limits are counted)
    const days = {};
    const modeTotals = {};
    MODES.forEach((m) => (modeTotals[m] = 0));
    useSnap.docs.forEach((u) => {
      const x = u.data();
      if (!x.day) return;
      const row = days[x.day] || (days[x.day] = { day: x.day, users: new Set(), requests: 0, tokens: 0, modes: {} });
      row.users.add(x.uid);
      row.requests += x.requests || 0;
      row.tokens += x.tokens || 0;
      MODES.forEach((m) => {
        const n = x["m_" + m] || 0;
        row.modes[m] = (row.modes[m] || 0) + n;
        modeTotals[m] += n;
      });
    });
    const aiDays = Object.values(days)
      .sort((a, b) => (a.day < b.day ? 1 : -1))
      .map((r) => ({ day: r.day, users: r.users.size, requests: r.requests, tokens: r.tokens, modes: r.modes }));

    return json({
      generatedAt: now,
      timezone: "UTC",
      accounts: apps.data().count,
      goals: { total: goalSnap.size, active, usersWithGoal: withGoal.size, byType, perDay },
      entitlements: { pro, starterUsed },
      ai: { days: aiDays, modeTotals },
    });
  } catch (e) {
    console.error("stats failed:", e.message);
    return json({ error: "Could not load stats" }, 500);
  }
};
