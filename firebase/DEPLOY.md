# Brand Sales bot on Firebase — deploy guide

Two functions:
- **dailyDigest** — scheduled, runs **12:00 PM IST every day**, DMs you the **full previous day (00:00–23:59)** per-brand sales.
- **slack** — HTTPS endpoint that powers the slash commands `/myugen`, `/voyd`, … and `/sales`.

## Prerequisites
1. **Node 20** and the Firebase CLI: `npm i -g firebase-tools`
2. A **Firebase project** (console.firebase.google.com → Add project).
3. **Blaze (pay-as-you-go) plan** on that project — REQUIRED. Scheduled functions (Cloud Scheduler) and outbound calls to Shopify/Slack don't run on the free Spark plan. (Cost here is effectively pennies: a handful of invocations/day.)

## One-time setup
```bash
cd slack-summarizer-app/firebase
firebase login
# put your project id in .firebaserc (replace REPLACE_WITH_YOUR_FIREBASE_PROJECT_ID)
cp functions/.env.example functions/.env     # then fill in real tokens (Slack + all 14 stores)
cd functions && npm install && cd ..
```
`functions/.env` needs: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` (Slack app → Basic Information → Signing Secret), `SLACK_USER_ID`, and every `*_SHOPIFY_ACCESS_TOKEN` / `*_SHOPIFY_DOMAIN` pair.

## Deploy
```bash
firebase deploy --only functions
```
After deploy the CLI prints the **slack** function URL, e.g.
`https://slack-xxxxx-uc.a.run.app`  (or `https://us-central1-<project>.cloudfunctions.net/slack`).
Copy it — that's your **Slash Command Request URL**.

## Register the slash commands (Slack app config)
Easiest: **api.slack.com/apps → your app → App Manifest**, merge in the `slash_commands` block below
(replace `REQUEST_URL` with the slack function URL), **Save**, then **Install App → Reinstall**.

```json
"slash_commands": [
  { "command": "/help",        "url": "REQUEST_URL", "description": "Commands + brand list", "usage_hint": "" },
  { "command": "/sales",       "url": "REQUEST_URL", "description": "All brands sales", "usage_hint": "[today|7d|30d|month|all|<brand>]" },
  { "command": "/myugen",      "url": "REQUEST_URL", "description": "Myugen sales",       "usage_hint": "[range]" },
  { "command": "/voyd",        "url": "REQUEST_URL", "description": "Voyd sales",         "usage_hint": "[range]" },
  { "command": "/kaand",       "url": "REQUEST_URL", "description": "Kaand sales",        "usage_hint": "[range]" },
  { "command": "/gymbrat",     "url": "REQUEST_URL", "description": "Gymbrat sales",      "usage_hint": "[range]" },
  { "command": "/alankoch",    "url": "REQUEST_URL", "description": "Alan Koch sales",    "usage_hint": "[range]" },
  { "command": "/alicemeyers", "url": "REQUEST_URL", "description": "Alice Meyers sales", "usage_hint": "[range]" },
  { "command": "/be-autyst",   "url": "REQUEST_URL", "description": "Be Autyst sales",    "usage_hint": "[range]" },
  { "command": "/cityofdomes", "url": "REQUEST_URL", "description": "City Of Domes sales","usage_hint": "[range]" },
  { "command": "/comoatelier", "url": "REQUEST_URL", "description": "Como Atelier sales", "usage_hint": "[range]" },
  { "command": "/forfksake",   "url": "REQUEST_URL", "description": "Forfksake sales",    "usage_hint": "[range]" },
  { "command": "/off-supply",  "url": "REQUEST_URL", "description": "Off Supply sales",   "usage_hint": "[range]" },
  { "command": "/piereeric",   "url": "REQUEST_URL", "description": "Piere Eric sales",   "usage_hint": "[range]" },
  { "command": "/smilingcat",  "url": "REQUEST_URL", "description": "Smiling Cat sales",  "usage_hint": "[range]" },
  { "command": "/songs24",     "url": "REQUEST_URL", "description": "Songs24 sales",      "usage_hint": "[range]" }
]
```
(Manual alternative: Slack app → **Slash Commands → Create New Command**, repeat for each, Request URL = the slack URL.)

## Test
- In Slack type `/myugen` → today's Myugen sales. `/myugen 30d` → last 30 days. `/sales 7d` → all brands.
- Force the digest once without waiting for noon:
  `gcloud scheduler jobs run firebase-schedule-dailyDigest-asia-south1` (name shown in console → Cloud Scheduler), or just wait for 12:00 PM IST.

## Notes
- The local Socket-Mode bot (`server.js`) can keep running for DM free-text, but set `DISABLE_LOCAL_CRON=true` there so the digest fires only from Firebase (no double send).
- Region: defaults to us-central1; set `region` in the function options if you prefer asia-south1.
