# Slack Digest

AI-powered Slack channel summarizer. Delivers scheduled digest DMs with tagged mentions,
new activity, and previously covered content. Runs 24/7 on Koyeb (free tier, no credit card).

## For Claude Code — First-Time Setup

If a user just cloned this repo and wants to get it running, execute these steps in order:

### 1. Check prerequisites
Run `node --version` — must be v18+. If not, tell user to install from nodejs.org first.

### 2. Install dependencies
Run `npm install`

### 3. Slack App (user does in browser — guide them step by step)
Walk the user through each step before moving to the next:

- **api.slack.com/apps** → Create New App → From scratch → name it, pick workspace
- **Socket Mode** (left sidebar) → On → create App-Level Token with scope `connections:write` → this is **SLACK_APP_TOKEN**
- **OAuth & Permissions** → Bot Token Scopes → Add:
  `chat:write  im:history  im:read  im:write  channels:history  channels:read  groups:history  groups:read  users:read`
- **Event Subscriptions** → Enable → Subscribe to Bot Events → add `message.im` → Save Changes
- **App Home** → enable "Allow users to send Slash commands and messages from the messages tab"
- **Install App** → Install to Workspace → copy Bot User OAuth Token → this is **SLACK_BOT_TOKEN**
- User's own Slack ID: click profile photo → View Profile → ... menu → Copy member ID → this is **SLACK_USER_ID**

### 4. Anthropic API key (user does in browser)
console.anthropic.com → API Keys → Create key → this is **ANTHROPIC_API_KEY**

### 5. Create .env
```bash
cp .env.example .env
```
Fill in the 4 values collected above. PORT=3000 is already set.

### 6. Test locally
Run `npm start`. The bot should connect and send a DM. Verify with "help" in the Slack DM.

### 7. Deploy to Koyeb (always-on, free, no credit card)
Guide the user through the Koyeb web UI:

1. Sign up at **koyeb.com** — no credit card required
2. Dashboard → **Create App**
3. Source: **GitHub** → Authorize Koyeb → select this repo → branch: `main`
4. Instance type: **Nano** (free tier)
5. Add these environment variables (use exact values from their `.env`):
   - `SLACK_BOT_TOKEN`
   - `SLACK_USER_ID`
   - `SLACK_APP_TOKEN`
   - `ANTHROPIC_API_KEY`
   - `PORT` = `3000`
6. Click **Deploy** — build takes ~2 min
7. Check **Logs** tab — look for "Connected" in the output

After deploy: have user DM the bot "summarize now" from their phone — if it responds, they're live.
The Mac can be turned off. Bot runs 24/7 on Koyeb.

> Note: Koyeb free tier has ephemeral storage — state resets on code redeploys (rare).
> After a redeploy, user re-adds channels with `add #channel-name` in the DM.

### 8. iOS Widget (optional)
See README.md for Scriptable widget setup.

---

## Project Structure

- `server.js` — Slack Bolt + Express + cron scheduler (the whole bot, ~560 lines)
- `data/` — state.json persists digest history and watched channels (git-ignored)
- `widget/digest-widget.js` — iOS Scriptable widget
- `public/` — status page served at /
- `.env.example` — template for required environment variables

## Environment Variables

See `.env.example`. All 4 are required — no defaults exist.

## Running Locally

```bash
npm start
```

Bot connects via Socket Mode (no public URL needed). Visit http://localhost:3000 for status.

## Cron Schedule (auto-digests, IST timezone)

9AM · 12PM · 3PM · 6PM · 9PM · 11:59PM
