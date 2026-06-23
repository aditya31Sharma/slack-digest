// Brand Sales Slack bot (Socket Mode).
// DM it a range ("today","yesterday","7d","30d","this month","last month","all") or a
// brand ("myugen"), OR use slash commands "/<brand>" and "/sales <range>".
// Daily digest at 12:00 PM IST for the full previous day (00:00-23:59).
// (When the Firebase scheduled function owns the digest, set DISABLE_LOCAL_CRON=true here.)
require('dotenv').config();
// Never let a Slack/socket/runtime error kill the process — the web server must stay up
// so the host's health check keeps passing.
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e?.message || e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e?.message || e));
const express = require('express');
const os = require('os');
const fs = require('fs');
const { WebClient } = require('@slack/web-api');
const { App, LogLevel } = require('@slack/bolt');
const cron = require('node-cron');
const {
  fetchAllBrandSales, loadStores, prettyName, slugify, storeKeyFromText, salesBlocks, toIST,
  parseCommand, fetchDigest, digestBlocks, buildDeepDigestHtml, resolveRange, helpText,
  trendBlocks, reportLink,
} = require('./shopify-sales');

function isConfigured() {
  return !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN && process.env.SLACK_USER_ID);
}

async function postSales({ client, channel, rangeText, brandKey = null, isAuto = false }) {
  const report = await fetchAllBrandSales(rangeText, brandKey ? { only: brandKey } : {});
  await client.chat.postMessage({
    channel, blocks: salesBlocks(report, { brandFilter: brandKey, isAuto }),
    text: `Brand sales — ${report.range.label}`,
  });
  return report;
}

// ── Bolt ────────────────────────────────────────────────────────────────────
async function startBolt() {
  const bolt = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: LogLevel.ERROR,
  });

  // Per-brand slash commands: /myugen, /voyd, ... + generic /sales
  const stores = loadStores();
  for (const key of Object.keys(stores)) {
    bolt.command(`/${slugify(key)}`, async ({ command, ack, respond }) => {
      await ack();
      try {
        const report = await fetchAllBrandSales(command.text || 'today', { only: key });
        await respond({ response_type: 'ephemeral', blocks: salesBlocks(report, { brandFilter: key }), text: `${prettyName(key)} sales` });
      } catch (e) { await respond({ response_type: 'ephemeral', text: `❌ ${e.message}` }); }
    });
  }
  bolt.command('/sales', async ({ command, ack, respond }) => {
    await ack();
    try {
      const brandKey = storeKeyFromText(command.text);
      const report = await fetchAllBrandSales(command.text || 'today', brandKey ? { only: brandKey } : {});
      await respond({ response_type: 'ephemeral', blocks: salesBlocks(report, { brandFilter: brandKey }), text: 'Brand sales' });
    } catch (e) { await respond({ response_type: 'ephemeral', text: `❌ ${e.message}` }); }
  });
  bolt.command('/help', async ({ ack, respond }) => { await ack(); await respond({ response_type: 'ephemeral', text: helpText() }); });

  // Free-text DMs
  bolt.message(async ({ message, client }) => {
    if (!message.channel?.startsWith('D') || message.bot_id || message.subtype) return;
    const text = (message.text || '').toLowerCase().trim();

    if (['help', '/help', '?', 'hi', 'hello', 'hey', 'start', 'commands'].includes(text)) {
      await client.chat.postMessage({ channel: message.channel, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: helpText() } }], text: 'help' });
      return;
    }
    if (/\b(brands?|stores?|list)\b/.test(text) && !/sales|digest|today|month|day|week|\d/.test(text)) {
      const names = Object.keys(loadStores()).map(k => `/${slugify(k)}`).sort();
      await client.chat.postMessage({ channel: message.channel, text: `*${names.length} brand commands:*\n${names.join('  ·  ')}\n\n\`digest\` = quick numbers · \`trend\` = full visual report\ne.g. \`myugen digest\` · \`{myugen,kaand} digest 30d\` · \`myugen trend 30d\` · \`{myugen,voyd} trend {01.06.26-23.06.26}\`` });
      return;
    }

    // ── grammar:  digest = Slack summary  ·  trend = visual HTML report link ──
    const cmd = parseCommand(text);
    if (cmd) {
      const thinking = await client.chat.postMessage({ channel: message.channel, text: cmd.kind === 'trend' ? '⏳ Building report…' : '⏳ Pulling digest…' });
      try {
        const report = await fetchDigest({ brandKeys: cmd.brandKeys, range: cmd.range, withSessions: true, withAds: true });
        report.unknown = cmd.unknown;
        const link = reportLink(text);
        if (cmd.kind === 'trend') {
          // visual report: Slack summary (with link) + the HTML report at the link
          await client.chat.postMessage({ channel: message.channel, blocks: digestBlocks(report, { link }), text: `Report — ${cmd.range.label}` });
          if (!link) {
            const file = `/tmp/report-${Date.now()}.html`;
            fs.writeFileSync(file, buildDeepDigestHtml(report));
            try { await client.files.uploadV2({ channel_id: message.channel, file, filename: `report-${cmd.range.label.replace(/[^\w]+/g, '-')}.html`, title: `Report · ${cmd.range.label}`, initial_comment: '📎 Open in a browser for the full visual report.' }); }
            catch { await client.chat.postMessage({ channel: message.channel, text: '📄 Report built but a link needs REPORT_BASE_URL and upload needs files:write.' }); }
          }
        } else {
          await client.chat.postMessage({ channel: message.channel, blocks: digestBlocks(report), text: `Digest — ${cmd.range.label}` });
        }
        await client.chat.delete({ channel: message.channel, ts: thinking.ts });
      } catch (e) {
        console.error('digest:', e.message);
        await client.chat.update({ channel: message.channel, ts: thinking.ts, text: `❌ ${e.message}` });
      }
      return;
    }

    const brandKey = storeKeyFromText(text);
    const thinking = await client.chat.postMessage({ channel: message.channel, text: '⏳ Pulling sales from Shopify…' });
    try {
      await postSales({ client, channel: message.channel, rangeText: text, brandKey });
      await client.chat.delete({ channel: message.channel, ts: thinking.ts });
    } catch (e) {
      console.error('sales handler:', e.message);
      await client.chat.update({ channel: message.channel, ts: thinking.ts, text: `❌ ${e.message}` });
    }
  });

  await bolt.start();
  console.log(`⚡  Sales bot connected — slash: ${Object.keys(stores).map(k => '/' + slugify(k)).join(' ')}`);
}

// ── Cron: daily 12:00 PM IST digest of the full previous day ────────────────
function startScheduler() {
  if (process.env.DISABLE_LOCAL_CRON === 'true') { console.log('⏸  Local cron disabled (Firebase owns the digest)'); return; }
  cron.schedule('0 12 * * *', async () => {
    if (!isConfigured()) return;
    try {
      const client = new WebClient(process.env.SLACK_BOT_TOKEN);
      console.log(`⏰  Daily digest at ${toIST()} (yesterday)`);
      const report = await fetchDigest({ brandKeys: [], range: resolveRange('yesterday'), withSessions: true, withAds: true });
      await client.chat.postMessage({ channel: process.env.SLACK_USER_ID, blocks: digestBlocks(report), text: 'Daily brand digest' });
    } catch (e) { console.error('scheduler:', e.message); }
  }, { timezone: 'Asia/Kolkata' });
  console.log('📅  Daily digest scheduled: 12:00 PM IST (yesterday, 00:00–23:59)');
}

// ── Express (health + JSON) ─────────────────────────────────────────────────
const webApp = express();
const PORT = process.env.PORT || 3000;
webApp.get('/healthz', (_q, r) => r.json({ ok: true, configured: isConfigured(), time: toIST() }));
webApp.get('/', (_q, r) => r.type('text').send(`Brand Sales Slack bot\nconfigured: ${isConfigured()}\nbrands: ${Object.keys(loadStores()).length}\ntime: ${toIST()} IST`));
webApp.get('/api/sales', async (req, res) => {
  try { res.json(await fetchAllBrandSales(req.query.range || 'today', req.query.brand ? { only: storeKeyFromText(req.query.brand) } : {})); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// HTML report by query, e.g. /report?q=myugen%20deepdigest%2030d  (mobile-friendly link)
webApp.get('/report', async (req, res) => {
  try {
    const cmd = parseCommand(req.query.q || '');
    if (!cmd) return res.status(400).type('text').send('Add ?q=<command>, e.g. ?q=myugen deepdigest 30d');
    const report = await fetchDigest({ brandKeys: cmd.brandKeys, range: cmd.range, withSessions: true, withAds: true });
    report.unknown = cmd.unknown;
    res.type('html').send(buildDeepDigestHtml(report));
  } catch (e) { res.status(500).type('text').send('error: ' + e.message); }
});
webApp.listen(PORT, () => {
  const ip = Object.values(os.networkInterfaces()).flat().find(n => n.family === 'IPv4' && !n.internal)?.address || 'localhost';
  if (!process.env.REPORT_BASE_URL) process.env.REPORT_BASE_URL = `http://${ip}:${PORT}/report`;
  console.log(`\n✅  Web/health → http://localhost:${PORT}  ·  reports → ${process.env.REPORT_BASE_URL}`);
  if (!isConfigured()) console.log('⚠️  Missing SLACK_BOT_TOKEN / SLACK_APP_TOKEN / SLACK_USER_ID');
});

// Keepalive: ping our own public URL every 4 min so Koyeb's free tier never
// idles the instance to sleep (which would drop the Slack socket). Only runs
// against a public https URL (no-op locally).
function startKeepalive() {
  const base = (process.env.REPORT_BASE_URL || '').replace(/\/report.*$/, '');
  if (!base.startsWith('https://')) return;
  const url = `${base}/healthz`;
  setInterval(() => { fetch(url).catch(() => {}); }, 4 * 60 * 1000);
  console.log(`🫀  keepalive → ${url} every 4m`);
}

if (isConfigured()) {
  startBolt().catch(e => console.error('Bolt error:', e.message));
  startScheduler();
  startKeepalive();
}
