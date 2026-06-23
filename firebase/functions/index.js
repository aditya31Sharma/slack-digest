// Firebase Cloud Functions for the Brand Sales bot.
//  - dailyDigest: scheduled 12:00 PM IST → DMs the FULL previous day (00:00-23:59) rich digest.
//  - slack: HTTPS endpoint for slash commands (/myugen, …, /sales) AND DM events
//           (digest / deepdigest grammar + free-text sales).
// All store + Slack creds come from environment variables (functions/.env on deploy).
const fs = require('fs');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const { WebClient } = require('@slack/web-api');
const { App, ExpressReceiver } = require('@slack/bolt');
const {
  fetchAllBrandSales, fetchDigest, salesBlocks, digestBlocks, buildDeepDigestHtml,
  loadStores, slugify, prettyName, storeKeyFromText, parseCommand, resolveRange, helpText,
  trendBlocks, reportLink,
} = require('./shopify-sales');

// ── Scheduled daily digest (12:00 PM IST, yesterday full day) ───────────────
exports.dailyDigest = onSchedule(
  { schedule: '0 12 * * *', timeZone: 'Asia/Kolkata', timeoutSeconds: 300, memory: '512MiB' },
  async () => {
    const client = new WebClient(process.env.SLACK_BOT_TOKEN);
    const report = await fetchDigest({ brandKeys: [], range: resolveRange('yesterday'), withSessions: true });
    await client.chat.postMessage({ channel: process.env.SLACK_USER_ID, blocks: digestBlocks(report), text: 'Daily brand digest' });
    console.log('dailyDigest sent:', report.totals.revenue);
  }
);

// ── Bolt over HTTPS (slash commands + DM events) ────────────────────────────
const receiver = new ExpressReceiver({ signingSecret: process.env.SLACK_SIGNING_SECRET || 'placeholder-signing-secret', processBeforeResponse: true });
const bolt = new App({ token: process.env.SLACK_BOT_TOKEN || 'xoxb-not-set', receiver, processBeforeResponse: true });

for (const key of Object.keys(loadStores())) {
  bolt.command(`/${slugify(key)}`, async ({ command, ack, respond }) => {
    await ack();
    try { const r = await fetchAllBrandSales(command.text || 'today', { only: key }); await respond({ response_type: 'ephemeral', blocks: salesBlocks(r, { brandFilter: key }) }); }
    catch (e) { await respond({ response_type: 'ephemeral', text: `❌ ${e.message}` }); }
  });
}
bolt.command('/sales', async ({ command, ack, respond }) => {
  await ack();
  try { const bk = storeKeyFromText(command.text); const r = await fetchAllBrandSales(command.text || 'today', bk ? { only: bk } : {}); await respond({ response_type: 'ephemeral', blocks: salesBlocks(r, { brandFilter: bk }) }); }
  catch (e) { await respond({ response_type: 'ephemeral', text: `❌ ${e.message}` }); }
});

bolt.command('/help', async ({ ack, respond }) => { await ack(); await respond({ response_type: 'ephemeral', text: helpText() }); });

// DM free-text: help + digest / deepdigest grammar + simple sales
bolt.message(async ({ message, client }) => {
  if (!message.channel?.startsWith('D') || message.bot_id || message.subtype) return;
  const text = (message.text || '').toLowerCase().trim();
  if (['help', '/help', '?', 'hi', 'hello', 'hey', 'start', 'commands'].includes(text)) {
    await client.chat.postMessage({ channel: message.channel, text: helpText() });
    return;
  }
  const cmd = parseCommand(text);
  if (cmd) {
    const report = await fetchDigest({ brandKeys: cmd.brandKeys, range: cmd.range, withSessions: cmd.kind !== 'trend' });
    report.unknown = cmd.unknown;
    const link = reportLink(text);
    if (cmd.kind === 'trend') {
      await client.chat.postMessage({ channel: message.channel, blocks: trendBlocks(report, { link }), text: `Trend — ${cmd.range.label}` });
    } else {
      await client.chat.postMessage({ channel: message.channel, blocks: digestBlocks(report), text: `Digest — ${cmd.range.label}` });
      if (cmd.kind === 'deepdigest') {
        if (link) await client.chat.postMessage({ channel: message.channel, text: `📊 Interactive report (open on any device): ${link}` });
        else {
          const file = `/tmp/deepdigest-${Date.now()}.html`;
          fs.writeFileSync(file, buildDeepDigestHtml(report));
          try { await client.files.uploadV2({ channel_id: message.channel, file, filename: `deepdigest-${cmd.range.label.replace(/[^\w]+/g, '-')}.html`, title: `Deep digest · ${cmd.range.label}` }); }
          catch { await client.chat.postMessage({ channel: message.channel, text: '📄 HTML built but upload needs files:write.' }); }
        }
      }
    }
    return;
  }
  const bk = storeKeyFromText(text);
  const r = await fetchDigest({ brandKeys: bk ? [bk] : [], range: resolveRange(text), withSessions: false });
  r.unknown = [];
  await client.chat.postMessage({ channel: message.channel, blocks: digestBlocks(r), text: 'Sales' });
});

exports.slack = onRequest({ timeoutSeconds: 120, memory: '512MiB' }, receiver.app);

// ── HTML report by query (mobile-friendly link): /report?q=myugen deepdigest 30d ──
exports.report = onRequest({ timeoutSeconds: 120, memory: '512MiB' }, async (req, res) => {
  try {
    const cmd = parseCommand(req.query.q || '');
    if (!cmd) return res.status(400).send('Add ?q=<command>, e.g. ?q=myugen deepdigest 30d');
    const report = await fetchDigest({ brandKeys: cmd.brandKeys, range: cmd.range, withSessions: true });
    report.unknown = cmd.unknown;
    res.set('Content-Type', 'text/html').send(buildDeepDigestHtml(report));
  } catch (e) { res.status(500).send('error: ' + e.message); }
});
