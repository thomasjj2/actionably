// Actionably: removes the data that browsers are not allowed to delete themselves.
// POST /api/account  { "action": "purge" }
// Deletes everything under growth/{uid} (action records and anything added later) and the
// per-day AI usage counts for that user. The browser then deletes the main data document and the account.
// Env vars: FIREBASE_API_KEY (to verify the sign in) and FIREBASE_SERVICE_ACCOUNT_JSON (to delete).
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

export const config = { path: "/api/account" };

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

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
  return u ? u.localId : null;
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: "Bad request" }, 400);
  }
  if (!body || body.action !== "purge") return json({ error: "Unknown action" }, 400);

  const uid = await verify(req);
  if (!uid) return json({ error: "Sign in required" }, 401);

  const d = db();
  if (!d) return json({ error: "Deletion is not available right now" }, 503);

  try {
    await d.recursiveDelete(d.doc("growth/" + uid));
    const snap = await d.collection("aiUsage").where("uid", "==", uid).get();
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = d.batch();
      snap.docs.slice(i, i + 400).forEach((x) => batch.delete(x.ref));
      await batch.commit();
    }
    return json({ ok: true });
  } catch (e) {
    console.error("purge failed:", e.message);
    return json({ error: "Could not delete" }, 500);
  }
};
