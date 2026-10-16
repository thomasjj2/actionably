# Actionably

Actionably turns the posts you save on social media into things you actually do. Upload screenshots or paste a caption, and Actionably pulls out the useful part, then helps you plan your week around it.

## What it does

- **Extract**: reads screenshots (up to 4 slides) or caption text and returns a title, summary, steps or items, time needed, effort level and one concrete next action.
- **Plan**: builds a weekly plan from the saves you pick, within the hours you have.
- **Goals**: proposes 1 to 3 measurable weekly goals based on the themes in your saves.

Instagram has no public API for saved posts, so saves come in as screenshots or pasted text.

## Stack

- Frontend: a single `index.html`
- Auth and storage: Firebase Authentication (Google sign in) and Firestore
- Backend: one Netlify function at `/api/ai`
- AI: Claude API
- Hosting: Netlify, auto deployed from this repo

## Repo layout

```
index.html                  frontend
netlify/functions/ai.mjs         AI function (extract, plan, goals)
netlify/functions/account.mjs    Deletes data browsers cannot delete: reset (action records) and purge (records plus usage counts)
js/progress.mjs                  Progress calculations (completion rate, weekly series, trend). Loaded by the app and covered by tests
tests/progress.test.mjs          Unit tests for the calculations. Run with: npm test
package.json                function dependency (firebase-admin) and the test script
netlify.toml                Netlify build config
firestore.rules             Firestore security rules
```

## Setup

### 1. Firebase

1. Create a project and add a Web app.
2. Authentication: enable the Google provider.
3. Firestore: create a database and publish the rules in `firestore.rules`. Each user can only read and write their own document in `actionablyApp`.
4. Paste the web config (`apiKey`, `authDomain`, `projectId`, `appId`) into the `FB` object near the top of the script in `index.html`. While it still says PASTE, the app runs in local demo mode.

### 2. Netlify

1. Import this repo. No build command is needed. Publish directory is `.`.
2. Add these environment variables:

| Variable | Required | Notes |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Yes | Use a key with a prepaid budget cap |
| `FIREBASE_API_KEY` | Yes | The Firebase web apiKey. When set, every request must carry a signed in user's token |
| `SECRETS_SCAN_SMART_DETECTION_OMIT_VALUES` | Yes | Set to the same Firebase web apiKey so Netlify's secrets scan passes |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | For the daily cap and for account deletion | Service account key for this Firebase project (Project settings, Service accounts, Generate new private key). Paste the raw JSON only. Mark as secret |
| `DAILY_TOKEN_LIMIT` | No | Tokens per user per day. Defaults to 100000, and 0 turns the cap off |
| `UNLIMITED_EMAILS` | No | Comma separated emails that skip the hourly and daily limits |
| `ANTHROPIC_MODEL` | No | Defaults to `claude-sonnet-5-5` |

3. After the first deploy, add your Netlify domain in Firebase under Authentication, Settings, Authorized domains. Google sign in fails without it.

## Limits and notes

- Each user is limited to 40 AI requests per hour. The counter is best effort and resets when the function restarts.
- Each user also has a daily token budget (`DAILY_TOKEN_LIMIT`). Usage is counted from the token totals Claude reports and stored by the function in the `aiUsage` collection, which the Firestore rules block from browsers. The check happens before a request, so a user can go over the limit by at most one request. The day resets at midnight UTC.
- Netlify functions cap request bodies at about 6 MB, so downscale screenshots in the browser before sending.
- The function only returns what a post actually shows. It is told never to invent quantities, steps or details.

## Local demo mode

Open `index.html` with the Firebase config left as PASTE and the app runs with saves kept in the browser's local storage. AI features need the deployed Netlify function.

## Action records

Every plan action ends the week with an outcome: done, partly done, skipped on purpose, moved to next week, or missed. These are stored one document per action under `growth/{uid}/records` in Firestore, and the Growth view in Progress draws its graph from them. The calculations live in `js/progress.mjs` so they are tested and the AI is never asked to produce numbers.

After changing `firestore.rules`, publish the new rules in the Firebase console (Firestore, Rules, Publish). The Rules Playground there can check that you can write your own records and cannot write someone else's.

Reset all progress (My Account) deletes a user's records through `/api/account` with the `reset` action, then clears weekly history, completed actions, streak and this week's plan in the app. Saves and settings are kept. AI usage counts are deliberately not reset.

Deleting an account calls `/api/account` with the `purge` action first, which needs `FIREBASE_SERVICE_ACCOUNT_JSON`. Without it, deletion is blocked so records are never left behind.
