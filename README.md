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
netlify/functions/ai.mjs    AI function (extract, plan, goals)
netlify.toml                Netlify build config
firestore.rules             Firestore security rules
```

## Setup

### 1. Firebase

1. Create a project and add a Web app.
2. Authentication: enable the Google provider.
3. Firestore: create a database and publish the rules in `firestore.rules`. Each user can only read and write their own document in `savedApp`.
4. Paste the web config (`apiKey`, `authDomain`, `projectId`, `appId`) into the `FB` object near the top of the script in `index.html`. While it still says PASTE, the app runs in local demo mode.

### 2. Netlify

1. Import this repo. No build command is needed. Publish directory is `.`.
2. Add these environment variables:

| Variable | Required | Notes |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Yes | Use a key with a prepaid budget cap |
| `FIREBASE_API_KEY` | Yes | The Firebase web apiKey. When set, every request must carry a signed in user's token |
| `SECRETS_SCAN_SMART_DETECTION_OMIT_VALUES` | Yes | Set to the same Firebase web apiKey so Netlify's secrets scan passes |
| `ANTHROPIC_MODEL` | No | Defaults to `claude-sonnet-5-5` |

3. After the first deploy, add your Netlify domain in Firebase under Authentication, Settings, Authorized domains. Google sign in fails without it.

## Limits and notes

- Each user is limited to 40 AI requests per hour. The counter is best effort and resets when the function restarts.
- Netlify functions cap request bodies at about 6 MB, so downscale screenshots in the browser before sending.
- The function only returns what a post actually shows. It is told never to invent quantities, steps or details.

## Local demo mode

Open `index.html` with the Firebase config left as PASTE and the app runs with saves kept in the browser's local storage. AI features need the deployed Netlify function.
