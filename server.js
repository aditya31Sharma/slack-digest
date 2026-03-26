require('dotenv').config();
const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const os        = require('os');
const { WebClient }    = require('@slack/web-api');
const { App, LogLevel } = require('@slack/bolt');
const Anthropic  = require('@anthropic-ai/sdk');
const cron       = require('node-cron');

// ── State ─────────────────────────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'data', 'state.json');

function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    raw.summaries      = raw.summaries      || [];
    raw.watchedChannels = raw.watchedChannels || [];
    return raw;
  } catch {
    return {
      lastSummaryTs:    null,
      lastSummaryIST:   null,
      lastNewSummary:   null,
      lastTaggedSummary: null,
      watchedChannels:  [],
      summaries:        []
    };
  }
}

function writeState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function toIST(date) {
  return new Date(date).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: true
  });
}

function nowUnixSeconds() { return Math.floor(Date.now() / 1000); }

function getISTHour() {
  return parseInt(new Date().toLocaleString('en-US', {
    timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false
  }));
}

function isConfigured() {
  return !!(
    process.env.SLACK_BOT_TOKEN &&
    process.env.SLACK_USER_ID   &&
    process.env.ANTHROPIC_API_KEY &&
    process.env.SLACK_APP_TOKEN
  );
}

// ── Slack fetching ────────────────────────────────────────────────────────────
async function listAllChannels(client) {
  const channels = [];
  let cursor;
  do {
    const r = await client.conversations.list({
      types: 'public_channel,private_channel',
      exclude_archived: true, limit: 200, cursor
    });
    channels.push(...(r.channels || []).filter(c => c.is_member));
    cursor = r.response_metadata?.next_cursor;
  } while (cursor);
  return channels;
}

async function fetchMessages(client, channelId, oldest, newest) {
  const messages = [];
  let cursor;
  do {
    const r = await client.conversations.history({
      channel: channelId,
      oldest: oldest ? String(oldest) : undefined,
      latest: newest ? String(newest) : undefined,
      limit: 200, cursor
    });
    messages.push(...(r.messages || []).filter(m => m.type === 'message' && !m.subtype));
    cursor = r.response_metadata?.next_cursor;
  } while (cursor);
  return messages;
}

async function fetchThreadReplies(client, channelId, threadTs, oldest) {
  try {
    const replies = [];
    let cursor;
    do {
      const r = await client.conversations.replies({
        channel: channelId, ts: threadTs,
        oldest: oldest ? String(oldest) : undefined,
        limit: 200, cursor
      });
      // slice(1) skips the parent message — it's already in the main list
      replies.push(...(r.messages || []).slice(1).filter(m => m.type === 'message' && !m.subtype));
      cursor = r.response_metadata?.next_cursor;
    } while (cursor);
    return replies;
  } catch {
    return [];
  }
}

async function resolveUsers(client, userIds) {
  const map = {};
  await Promise.all([...userIds].map(async id => {
    try {
      const r = await client.users.info({ user: id });
      map[id] = r.user?.real_name || r.user?.name || id;
    } catch { map[id] = id; }
  }));
  return map;
}

function cleanText(text, userMap) {
  return (text || '')
    .replace(/<@([A-Z0-9]+)>/g, (_, uid) => userMap[uid] ? `@${userMap[uid]}` : '@someone')
    .replace(/<[^>]+>/g, '')
    .replace(/\n+/g, ' ')
    .trim();
}

// ── Core digest engine ────────────────────────────────────────────────────────
async function buildDigest({ oldest, newest = null, channelIds = null }) {
  const client    = new WebClient(process.env.SLACK_BOT_TOKEN);
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const userId    = process.env.SLACK_USER_ID;

  const channels = channelIds?.length
    ? channelIds.map(id => ({ id, name: id }))
    : await listAllChannels(client);

  // Fetch top-level messages + expand thread replies inline
  const fetched = await Promise.all(channels.map(async ch => {
    try {
      const msgs     = await fetchMessages(client, ch.id, oldest, newest);
      const threaded = msgs.filter(m => m.reply_count > 0 && m.thread_ts);
      const replyBatches = await Promise.all(
        threaded.map(m => fetchThreadReplies(client, ch.id, m.thread_ts, oldest))
      );
      // Interleave replies after their parent message
      const expanded = [];
      for (const msg of msgs) {
        expanded.push(msg);
        if (msg.reply_count > 0 && msg.thread_ts) {
          const idx = threaded.indexOf(msg);
          if (idx !== -1) replyBatches[idx].forEach(r => expanded.push({ ...r, _isReply: true }));
        }
      }
      return { ch, msgs: expanded };
    } catch (e) { console.warn(`Skip ${ch.id}: ${e.message}`); return { ch, msgs: [] }; }
  }));

  const allUserIds = new Set(
    fetched.flatMap(({ msgs }) => msgs.map(m => m.user).filter(Boolean))
  );
  const userMap = await resolveUsers(client, allUserIds);

  const tagged      = [];
  const channelData = [];

  for (const { ch, msgs } of fetched) {
    if (!msgs.length) continue;

    msgs.filter(m => m.text?.includes(`<@${userId}>`)).forEach(m =>
      tagged.push({
        channel: ch.name || ch.id,
        user:    userMap[m.user] || 'someone',
        text:    cleanText(m.text, userMap)
      })
    );

    const lines = [...msgs].reverse()
      .map(m => {
        const name = userMap[m.user] || 'someone';
        const text = cleanText(m.text, userMap);
        return m._isReply ? `  ↳ ${name}: ${text}` : `${name}: ${text}`;
      })
      .filter(l => l.trim().length > 3);

    if (lines.length) channelData.push({ name: ch.name || ch.id, lines: lines.slice(-60) });
  }

  const fromIST  = toIST(new Date(oldest * 1000));
  const toISTStr = newest ? toIST(new Date(newest * 1000)) : toIST(new Date());
  const total    = fetched.reduce((s, { msgs }) => s + msgs.length, 0);

  if (total === 0) return { tagged: null, newContent: null, fromIST, toIST: toISTStr, isEmpty: true };

  const taggedCtx = tagged.length
    ? `MESSAGES WHERE USER WAS TAGGED:\n${tagged.map(t => `[#${t.channel}] ${t.user}: ${t.text}`).join('\n')}`
    : 'TAGGED: none';

  const channelCtx = channelData
    .map(ch => `#${ch.name} (${ch.lines.length} msgs):\n${ch.lines.join('\n')}`)
    .join('\n\n---\n\n');

  const prompt = `You are writing a casual Slack digest — like a teammate giving a quick heads-up.
Reader has 30 seconds max. Brief, specific, human. Emojis ok, not on every line.
Lines marked with ↳ are thread replies — treat them equally important as new messages.

Period: ${fromIST} → ${toISTStr}

${taggedCtx}

CHANNEL ACTIVITY:
${channelCtx}

Write exactly two sections:

---TAGGED---
[If no mentions: write exactly — nothing for you here 👌]
[If mentions: • @Name in #channel — what they said (max 12 words each, max 5 bullets)]

---NEW---
[One line per active channel: #channel — casual one-liner]
[Thread replies count as updates — include if interesting]
[Skip bot noise. Max 6 channels, each line under 18 words]
[If nothing interesting: all quiet — your channels are napping 😴]

Hard rules: no **bold**, no ## headers, no --- separators inside your text. Casual. Specific names and topics. Never vague. Under 150 words total.`;

  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = msg.content[0].text;
  const taggedMatch = raw.match(/---TAGGED---\n([\s\S]*?)(?=---NEW---|$)/);
  const newMatch    = raw.match(/---NEW---\n([\s\S]*?)$/);

  const taggedContent = taggedMatch?.[1]?.trim() || null;
  const newContent    = newMatch?.[1]?.trim()    || null;

  const isEmptyTagged = !taggedContent ||
    taggedContent.toLowerCase().includes('nothing') ||
    taggedContent.toLowerCase().includes('none') ||
    !tagged.length;

  return {
    tagged:       isEmptyTagged ? null : taggedContent,
    newContent,
    fromIST,
    toIST:        toISTStr,
    channelCount: channelData.length,
    isEmpty:      false
  };
}

// ── Slack Block Kit builder ───────────────────────────────────────────────────
function makeBlocks({ tagged, newContent, covered, fromIST, toISTStr, isAuto }) {
  const blocks = [];

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: isAuto ? '⚡ Auto Digest' : '📋 Your Digest', emoji: true }
  });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `🕐 *${fromIST}*  →  *${toISTStr}*` }]
  });
  blocks.push({ type: 'divider' });

  // TAGGED — always shown
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*👋 Tagged*\n${tagged || '_Nobody tagged you this round — enjoying the peace_ ✌️'}`
    }
  });

  blocks.push({ type: 'divider' });

  // NEW — always shown
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*🆕 What's New*\n${newContent || '_All quiet — your channels are napping_ 😴'}`
    }
  });

  blocks.push({ type: 'divider' });

  // COVERED — always shown, graceful first-run state
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: covered
        ? `*📖 Already Covered*\n_From your last digest —_\n${covered}`
        : `*📖 Already Covered*\n_Nothing before this — fresh start_ 🌅`
    }
  });

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `_Say "last 6h", "today", "channels", or "help"_ ✨` }]
  });

  return blocks;
}

// ── Send digest to user DM ────────────────────────────────────────────────────
async function sendDigest({ oldest, newest = null, channelIds = null, isAuto = false }) {
  const state = readState();

  // Build covered from previous digest's tagged + new
  const prevTagged = state.lastTaggedSummary || null;
  const prevNew    = state.lastNewSummary    || null;
  let covered = null;
  if (prevTagged && prevNew)  { covered = `Mentions: ${prevTagged}\nChannels: ${prevNew}`; }
  else if (prevNew)           { covered = prevNew; }
  else if (prevTagged)        { covered = prevTagged; }

  // Use watchedChannels from state if no explicit channelIds passed
  const resolvedChannelIds = channelIds ?? (state.watchedChannels?.length ? state.watchedChannels : null);
  const digest = await buildDigest({ oldest, newest, channelIds: resolvedChannelIds });
  const client = new WebClient(process.env.SLACK_BOT_TOKEN);

  const blocks = makeBlocks({
    tagged:     digest.tagged,
    newContent: digest.newContent,
    covered,
    fromIST:    digest.fromIST,
    toISTStr:   digest.toIST,
    isAuto
  });

  await client.chat.postMessage({
    channel: process.env.SLACK_USER_ID,
    blocks,
    text: `Digest: ${digest.fromIST} → ${digest.toIST}`
  });

  const nowTs = nowUnixSeconds();
  state.lastSummaryTs      = nowTs;
  state.lastSummaryIST     = toIST(new Date());
  state.lastNewSummary     = digest.newContent;
  state.lastTaggedSummary  = digest.tagged;
  state.summaries = [
    {
      ts:      nowTs,
      ist:     state.lastSummaryIST,
      fromIST: digest.fromIST,
      tagged:  digest.tagged  || '',
      summary: digest.newContent || ''
    },
    ...state.summaries.slice(0, 9)
  ];
  writeState(state);

  return digest;
}

// ── Bolt: DM listener ─────────────────────────────────────────────────────────
async function startBolt() {
  const bolt = new App({
    token:      process.env.SLACK_BOT_TOKEN,
    appToken:   process.env.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel:   LogLevel.ERROR,
  });

  bolt.message(async ({ message, client }) => {
    // Only handle real user DMs
    if (!message.channel?.startsWith('D') || message.bot_id || message.subtype) return;

    const text = (message.text || '').toLowerCase().trim();

    // ── Help / greeting ───────────────────────────────────────────────────────
    if (['help', '?', 'hi', 'hello', 'hey', 'start'].includes(text)) {
      await client.chat.postMessage({
        channel: message.channel,
        blocks: [{
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Hey! 👋 Here's what I can do:*\n\n*Digests*\n• *"summarize now"* → force fetch since last digest (max 12h)\n• *"summary"* → since your last digest\n• *"last 6h"* → last 6 hours (any number 1–168)\n• *"today"* → since 9AM today\n• *"yesterday"* → last 24 hours\n• *"this week"* → last 7 days\n\n*Channels*\n• *"channels"* → see what I'm watching\n• *"add #general"* → add a channel\n• *"remove #engineering"* → drop a channel\n\n_Auto-sends every 3h: 9AM · 12PM · 3PM · 6PM · 9PM · 11:59PM IST_\n_Silent midnight–9AM so you can sleep_ 🌙`
          }
        }]
      });
      return;
    }

    // ── Channel management ────────────────────────────────────────────────────
    const addIntent    = /\b(add|watch|include|track)\b/i.test(text);
    const removeIntent = /\b(remove|drop|stop|unwatch|exclude)\b/i.test(text);
    const listIntent   = /\b(channels?|list channels?|which channels?|what am i watching)\b/i.test(text);

    if (addIntent || removeIntent) {
      const nameMatch = text.match(/#([\w-]+)/) || text.match(/(?:add|remove|watch|drop|include|track|unwatch|stop|exclude)\s+([\w-]+)/i);
      const query     = nameMatch?.[1]?.toLowerCase();

      if (!query || ['channels', 'all', 'everything'].includes(query)) {
        if (removeIntent && (!query || query === 'all' || query === 'everything')) {
          // "remove all" → reset to watch everything
          const state = readState();
          state.watchedChannels = [];
          writeState(state);
          await client.chat.postMessage({ channel: message.channel,
            text: `Reset — now watching all channels I'm in 👀` });
          return;
        }
        await client.chat.postMessage({ channel: message.channel,
          text: `Which channel? Try: "add #general" or "remove #engineering" 🔍` });
        return;
      }

      const allChannels = await listAllChannels(new WebClient(process.env.SLACK_BOT_TOKEN));
      const found = allChannels.find(c =>
        c.name.toLowerCase() === query || c.name.toLowerCase().includes(query)
      );

      if (!found) {
        await client.chat.postMessage({ channel: message.channel,
          text: `Couldn't find *#${query}*. Make sure I'm invited to that channel first 🔍` });
        return;
      }

      const state = readState();
      state.watchedChannels = state.watchedChannels || [];

      if (addIntent) {
        if (!state.watchedChannels.includes(found.id)) {
          state.watchedChannels.push(found.id);
          writeState(state);
        }
        await client.chat.postMessage({ channel: message.channel,
          text: `✅ Added *#${found.name}* to your digest` });
      } else {
        state.watchedChannels = state.watchedChannels.filter(id => id !== found.id);
        writeState(state);
        await client.chat.postMessage({ channel: message.channel,
          text: state.watchedChannels.length === 0
            ? `Removed *#${found.name}* — now watching all channels I'm in`
            : `Removed *#${found.name}* from your digest` });
      }
      return;
    }

    if (listIntent) {
      const state       = readState();
      const allChannels = await listAllChannels(new WebClient(process.env.SLACK_BOT_TOKEN));

      if (!state.watchedChannels?.length) {
        const names = allChannels.map(c => `#${c.name}`).join('  ·  ');
        await client.chat.postMessage({ channel: message.channel,
          text: `Watching all ${allChannels.length} channels I'm in:\n${names}\n\nSay "add #channel" or "remove #channel" to customize 👆` });
      } else {
        const names = state.watchedChannels
          .map(id => allChannels.find(c => c.id === id))
          .filter(Boolean)
          .map(c => `#${c.name}`).join('  ·  ');
        await client.chat.postMessage({ channel: message.channel,
          text: `Watching ${state.watchedChannels.length} channel${state.watchedChannels.length === 1 ? '' : 's'}:\n${names}\n\nSay "add #channel" to add more, or "remove all" to reset` });
      }
      return;
    }

    // ── Parse time range ──────────────────────────────────────────────────────
    let oldest;
    const hoursMatch = text.match(/(\d+)\s*h(our)?s?/);

    if (/\b(summarize now|now|go|fetch now|get now)\b/.test(text) || text === 'now') {
      // Force fetch since last digest, capped at 12 hours
      const st  = readState();
      const cap = nowUnixSeconds() - 12 * 3600;
      oldest = st.lastSummaryTs ? Math.max(st.lastSummaryTs, cap) : cap;
    } else if (['summary', 'digest', 'catch me up', 'update me', 'update'].includes(text)) {
      const st = readState();
      oldest = st.lastSummaryTs || (nowUnixSeconds() - 3 * 3600);
    } else if (hoursMatch) {
      const h = Math.min(parseInt(hoursMatch[1]), 168);
      oldest = nowUnixSeconds() - h * 3600;
    } else if (text.includes('today')) {
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      now.setHours(9, 0, 0, 0);
      oldest = Math.floor(now.getTime() / 1000);
    } else if (text.includes('yesterday')) {
      oldest = nowUnixSeconds() - 86400;
    } else if (text.includes('week')) {
      oldest = nowUnixSeconds() - 7 * 86400;
    } else {
      oldest = nowUnixSeconds() - 3 * 3600;
    }

    // Show thinking message
    const thinking = await client.chat.postMessage({
      channel: message.channel,
      text: '⏳ Generating your digest...'
    });

    try {
      await sendDigest({ oldest, isAuto: false });
      await client.chat.delete({ channel: message.channel, ts: thinking.ts });
    } catch (e) {
      console.error('DM handler error:', e.message);
      await client.chat.update({
        channel: message.channel,
        ts: thinking.ts,
        text: `❌ Something went wrong: ${e.message}`
      });
    }
  });

  await bolt.start();
  console.log('⚡  Bolt connected — DM the bot to get a digest');

  // Cache DM channel ID + team ID for iOS widget deep link
  try {
    const wc   = new WebClient(process.env.SLACK_BOT_TOKEN);
    const auth = await wc.auth.test();
    const dm   = await wc.conversations.open({ users: process.env.SLACK_USER_ID });
    const st   = readState();
    st.teamId      = auth.team_id;
    st.dmChannelId = dm.channel.id;
    writeState(st);
  } catch (e) { console.warn('Could not cache Slack deep link info:', e.message); }
}

// ── Cron: auto-digest ─────────────────────────────────────────────────────────
function startScheduler() {
  // Main schedule: 9AM, 12PM, 3PM, 6PM, 9PM IST
  cron.schedule('0 9,12,15,18,21 * * *', async () => {
    if (!isConfigured()) return;
    try {
      const istHour = getISTHour();
      const state   = readState();
      const oldest  = istHour === 9
        ? nowUnixSeconds() - 9 * 3600                              // overnight window
        : (state.lastSummaryTs || nowUnixSeconds() - 3 * 3600);   // since last digest
      console.log(`⏰  Auto-digest at ${toIST(new Date())} — from ${toIST(new Date(oldest * 1000))}`);
      await sendDigest({ oldest, isAuto: true });
    } catch (e) { console.error('Scheduler error:', e.message); }
  }, { timezone: 'Asia/Kolkata' });

  // Last digest of the day at 11:59PM
  cron.schedule('59 23 * * *', async () => {
    if (!isConfigured()) return;
    try {
      const state  = readState();
      const oldest = state.lastSummaryTs || nowUnixSeconds() - 3 * 3600;
      console.log(`🌙  Night digest at ${toIST(new Date())} — from ${toIST(new Date(oldest * 1000))}`);
      await sendDigest({ oldest, isAuto: true });
    } catch (e) { console.error('Scheduler error:', e.message); }
  }, { timezone: 'Asia/Kolkata' });

  console.log('📅  Scheduled: 9AM · 12PM · 3PM · 6PM · 9PM · 11:59PM IST — silent midnight–9AM');
}

// ── Express: web fallback ─────────────────────────────────────────────────────
const webApp = express();
const PORT   = process.env.PORT || 3000;

webApp.use(express.json());
webApp.use(express.static(path.join(__dirname, 'public')));

webApp.get('/', (_req, res) => {
  if (!isConfigured()) return res.redirect('/setup.html');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

webApp.post('/api/setup', async (req, res) => {
  const { slackToken, slackUserId, anthropicKey, appToken } = req.body;
  if (!slackToken || !slackUserId || !anthropicKey || !appToken) {
    return res.status(400).json({ error: 'All four fields are required.' });
  }

  const results = { slack: null, dm: null, anthropic: null, appToken: null };

  try {
    await new WebClient(slackToken).auth.test();
    results.slack = 'ok';
  } catch (e) {
    return res.status(400).json({ error: 'Slack bot token is invalid: ' + e.message, results });
  }

  try {
    await new WebClient(slackToken).chat.postMessage({
      channel: slackUserId,
      text: "✅ Connected! DM me anytime — say *\"summary\"* or *\"last 6h\"* to get a digest. Say *\"help\"* for all commands. I auto-send every 3 hours from 9AM–11:59PM IST 🤖",
      mrkdwn: true
    });
    results.dm = 'ok';
  } catch (e) {
    return res.status(400).json({ error: 'Could not DM you — double-check your User ID: ' + e.message, results });
  }

  try {
    await new Anthropic({ apiKey: anthropicKey }).messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }]
    });
    results.anthropic = 'ok';
  } catch (e) {
    return res.status(400).json({ error: 'Anthropic API key is invalid: ' + e.message, results });
  }

  if (!appToken.startsWith('xapp-')) {
    return res.status(400).json({ error: 'App token should start with xapp-', results });
  }
  results.appToken = 'ok';

  // Save .env
  fs.writeFileSync(
    path.join(__dirname, '.env'),
    `SLACK_BOT_TOKEN=${slackToken}\nSLACK_USER_ID=${slackUserId}\nANTHROPIC_API_KEY=${anthropicKey}\nSLACK_APP_TOKEN=${appToken}\nPORT=${process.env.PORT || 3000}\n`
  );
  process.env.SLACK_BOT_TOKEN   = slackToken;
  process.env.SLACK_USER_ID     = slackUserId;
  process.env.ANTHROPIC_API_KEY = anthropicKey;
  process.env.SLACK_APP_TOKEN   = appToken;

  res.json({ ok: true, results });

  // Boot Bolt + scheduler now that creds are live
  setTimeout(() => {
    startBolt().catch(e => console.error('Bolt start error:', e.message));
    startScheduler();
  }, 300);
});

webApp.get('/api/status', (_req, res) => {
  const state = readState();
  res.json({
    configured:     isConfigured(),
    lastSummaryTs:  state.lastSummaryTs,
    lastSummaryIST: state.lastSummaryIST,
    summaryCount:   state.summaries.length,
    serverTimeIST:  toIST(new Date())
  });
});

webApp.get('/api/channels', async (_req, res) => {
  if (!isConfigured()) return res.status(400).json({ error: 'Not configured' });
  try {
    const channels = await listAllChannels(new WebClient(process.env.SLACK_BOT_TOKEN));
    res.json({ channels: channels.map(c => ({ id: c.id, name: c.name, is_private: c.is_private, num_members: c.num_members })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

webApp.post('/api/summarize', async (req, res) => {
  if (!isConfigured()) return res.status(400).json({ error: 'Not configured.' });
  const { channelIds, hours, fromTs, toTs } = req.body;
  const state = readState();
  const oldest = fromTs || (hours > 0
    ? nowUnixSeconds() - hours * 3600
    : state.lastSummaryTs || (nowUnixSeconds() - 86400));

  try {
    const digest = await sendDigest({ oldest, newest: toTs || null, channelIds, isAuto: false });
    res.json({
      summary:      digest.newContent || 'No new messages',
      tagged:       digest.tagged,
      fromIST:      digest.fromIST,
      toIST:        digest.toIST,
      channelCount: digest.channelCount || 0,
      dmStatus:     'sent'
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

webApp.get('/api/history', (_req, res) => {
  res.json({ summaries: readState().summaries });
});

// Widget endpoint — returns latest digest + Slack deep link for iOS widget
webApp.get('/api/latest', (_req, res) => {
  const state   = readState();
  const latest  = state.summaries?.[0] || null;
  const slackLink = (state.teamId && state.dmChannelId)
    ? `slack://channel?team=${state.teamId}&id=${state.dmChannelId}`
    : null;
  res.json({
    hasData:        !!latest,
    lastSummaryIST: state.lastSummaryIST || 'Never',
    tagged:         latest?.tagged  || null,
    summary:        latest?.summary || null,
    fromIST:        latest?.fromIST || null,
    slackLink,
  });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
webApp.listen(PORT, () => {
  const localIp = Object.values(os.networkInterfaces()).flat()
    .find(n => n.family === 'IPv4' && !n.internal)?.address || 'localhost';
  console.log(`\n✅  Web UI     → http://localhost:${PORT}`);
  console.log(`📱  Widget API → http://${localIp}:${PORT}/api/latest`);
  if (!isConfigured()) {
    console.log('⚠️   Credentials missing — open the Web UI to set up\n');
  }
});

if (isConfigured()) {
  startBolt().catch(e => console.error('Bolt error:', e.message));
  startScheduler();
}
