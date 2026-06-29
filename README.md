# House of CC Analyser

> AI-powered summaries of your Slack channels, delivered every 3 hours via DM.

Never open Slack just to catch up again. The bot watches your channels and sends you a clean digest — tagged mentions, what's new, and what was already covered.

## What it does

- **Auto-digests** at 9AM · 12PM · 3PM · 6PM · 9PM · 11:59PM IST
- **3 sections** per digest: 👋 Tagged / 🆕 What's New / 📖 Already Covered
- **Thread replies** counted equally to new messages
- **Ask anytime** via DM: `last 6h`, `today`, `summarize now`
- **Manage channels** via DM: `add #general`, `remove #eng`, `channels`
- **iOS widget** — see latest digest on your iPhone home screen

## DM Commands

| Say this | What happens |
|---|---|
| `summarize now` | Force fetch since last digest (max 12h) |
| `summary` | Since your last digest |
| `last 6h` | Last N hours (any number 1–168) |
| `today` | Since 9AM today |
| `yesterday` | Last 24 hours |
| `this week` | Last 7 days |
| `channels` | See which channels are being watched |
| `add #general` | Add a channel |
| `remove #general` | Remove a channel |
| `help` | Show all commands |

---

## Self-hosting — quick start with Claude Code

The easiest way to set this up is with [Claude Code](https://claude.ai/code). It reads the `CLAUDE.md` file in this repo and walks you through the entire setup — Slack app creation, API keys, and deployment — with minimal manual steps.

```bash
git clone https://github.com/aditya31Sharma/slack-digest.git
cd slack-digest
claude   # Claude Code reads CLAUDE.md and guides you through setup
```

---

## Self-hosting — manual setup

### What you'll need
- [Node.js](https://nodejs.org) v18+
- A [Slack workspace](https://slack.com) where you're an admin (or can install apps)
- An [Anthropic API key](https://console.anthropic.com) (free signup)

### Step 1 — Get the code

```bash
git clone https://github.com/aditya31Sharma/slack-digest.git
cd slack-digest
npm install
```

### Step 2 — Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Name it anything (e.g. "Digest Bot"), pick your workspace

**Enable Socket Mode** (left sidebar → Socket Mode → On)
- Create an App-Level Token with scope `connections:write` → copy this as `SLACK_APP_TOKEN`

**Bot Token Scopes** (OAuth & Permissions → Bot Token Scopes → Add):
```
chat:write
im:history  im:read  im:write
channels:history  channels:read
groups:history  groups:read
users:read
```

**Event Subscriptions** → Enable → Subscribe to Bot Events → add `message.im` → Save Changes

**App Home** → enable "Allow users to send Slash commands and messages from the messages tab"

**Install App** → Install to Workspace → copy the Bot User OAuth Token → this is `SLACK_BOT_TOKEN`

**Your User ID**: Slack → click your profile → ... → Copy member ID → this is `SLACK_USER_ID`

### Step 3 — Configure

```bash
cp .env.example .env
# Edit .env and fill in all 4 values
```

### Step 4 — Invite bot to channels

In each Slack channel you want summarized:
```
/invite @YourBotName
```

### Step 5 — Run

```bash
npm start
```

Visit [http://localhost:3000](http://localhost:3000) to confirm it's connected.

The bot will DM you on startup. Digests auto-send from 9AM–11:59PM IST.

### Keep it running locally (optional)

```bash
npm install -g pm2
pm2 start server.js --name slack-digest
pm2 save && pm2 startup
```

---

## Deploy to Koyeb — free, always-on, no credit card

Koyeb's free tier never sleeps and requires no credit card. Your bot runs 24/7 even when your computer is off.

1. Sign up at [koyeb.com](https://koyeb.com) — no credit card required
2. **Create App** → GitHub → select `aditya31Sharma/slack-digest` → branch: `main`
3. **Instance type**: Nano (free)
4. **Environment variables** — add all 5:
   ```
   SLACK_BOT_TOKEN     = xoxb-...
   SLACK_USER_ID       = U...
   SLACK_APP_TOKEN     = xapp-...
   ANTHROPIC_API_KEY   = sk-ant-...
   PORT                = 3000
   ```
5. Click **Deploy** — build takes ~2 min
6. **Logs** tab → look for "Connected"

DM the bot "summarize now" from your phone. If it responds, you're live. Turn your computer off. ✓

Any `git push` to `main` triggers an automatic redeploy.

> **Note**: Koyeb's free tier has ephemeral storage. State (watched channels, digest history)
> resets on redeploy. After a redeploy, re-add channels with `add #channel-name` in the DM.

---

## iOS Widget

Shows your latest digest on your iPhone home screen. Tapping it opens the Slack DM directly.

1. Install [Scriptable](https://apps.apple.com/app/scriptable/id1405459188) (free)
2. Open `widget/digest-widget.js`, copy the entire file
3. Paste into a new Scriptable script
4. Update `BASE_URL` to your Koyeb app URL (e.g. `https://your-app.koyeb.app`) or local IP
5. Long-press home screen → + → Scriptable → select this script

---

## Tech stack

[Slack Bolt](https://github.com/slackapi/bolt-js) · [Anthropic Claude](https://anthropic.com) · [node-cron](https://github.com/node-cron/node-cron) · [Express](https://expressjs.com)

## License

MIT
