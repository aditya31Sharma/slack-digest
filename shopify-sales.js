// Brand sales / digest engine. Reads Shopify Admin tokens for every connected store,
// computes per-brand metrics (revenue, orders, AOV, highest order, daily buckets, best-effort
// sessions) for any date / range, and renders Slack blocks + a deep-digest HTML report.
// Shared by the local Slack bot (server.js) and the Firebase functions.
const fs = require('fs');

const SHOPIFY_ENV_PATH = process.env.SHOPIFY_ENV_PATH
  || '/Users/adityasharma/Codes/claude_projects/culture-circle-inventory/.env';
const API_VERSION = '2024-10';

// ── Load store credentials ──────────────────────────────────────────────────
const SHOPIFY_FIELDS = ['ACCESS_TOKEN', 'DOMAIN', 'CLIENT_ID', 'CLIENT_SECRET'];
const isShopifyKey = k => SHOPIFY_FIELDS.some(f => k.endsWith('_SHOPIFY_' + f));
function parseEnvText(text, src) {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('='); const k = t.slice(0, i).trim(), v = t.slice(i + 1).trim();
    if (isShopifyKey(k)) src[k] = v;
  }
}
function loadStores() {
  const src = {};
  // 1) one base64-encoded env blob (STORES_ENV_B64) is the simplest deploy: all creds in one var
  if (process.env.STORES_ENV_B64) {
    try { parseEnvText(Buffer.from(process.env.STORES_ENV_B64, 'base64').toString('utf8'), src); } catch { /* ignore */ }
  } else {
    // 2) individual *_SHOPIFY_* env vars
    for (const [k, v] of Object.entries(process.env)) if (isShopifyKey(k)) src[k] = v;
    // 3) fall back to a local env file only if nothing is set
    if (!Object.keys(src).length) {
      const path = fs.existsSync(SHOPIFY_ENV_PATH) ? SHOPIFY_ENV_PATH
        : (fs.existsSync(__dirname + '/stores.env') ? __dirname + '/stores.env' : null);
      if (path) parseEnvText(fs.readFileSync(path, 'utf8'), src);
    }
  }
  const names = new Set();
  for (const k of Object.keys(src)) { const m = k.match(/^(.+)_SHOPIFY_(?:ACCESS_TOKEN|DOMAIN|CLIENT_ID|CLIENT_SECRET)$/); if (m) names.add(m[1]); }
  const stores = {};
  for (const name of names) {
    const domain = src[`${name}_SHOPIFY_DOMAIN`];
    const token = src[`${name}_SHOPIFY_ACCESS_TOKEN`] || null;
    const clientId = src[`${name}_SHOPIFY_CLIENT_ID`] || null;
    const clientSecret = src[`${name}_SHOPIFY_CLIENT_SECRET`] || null;
    if (!domain) continue;
    if (!token && !(clientId && clientSecret)) continue; // no way to authenticate
    stores[name] = { token, domain, clientId, clientSecret };
  }
  return stores;
}

// ── Token resolution: prefer a freshly minted client-credentials token (self-
// healing, 24h), fall back to the static token. Cached in-memory per domain. ──
const _tokenCache = {};
async function mintToken({ domain, clientId, clientSecret }) {
  const cached = _tokenCache[domain];
  if (cached && cached.exp > Date.now()) return cached.token;
  const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
  });
  if (!res.ok) throw new Error(`mint ${res.status}`);
  const j = await res.json();
  if (!j.access_token) throw new Error('mint: no access_token');
  const ttl = Math.min(j.expires_in || 86400, 86400);
  _tokenCache[domain] = { token: j.access_token, exp: Date.now() + (ttl - 3600) * 1000 };
  return j.access_token;
}
async function resolveToken(store) {
  if (store.clientId && store.clientSecret) {
    try { return await mintToken(store); } catch { /* fall back to static token */ }
  }
  return store.token;
}

function prettyName(key) { return key.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()); }
function slugify(key) { return key.toLowerCase().replace(/_/g, '-'); }
function storeKeyFromText(text) {
  const stores = loadStores();
  const norm = s => (s || '').toLowerCase().replace(/^\//, '').replace(/[\s_\-]/g, '');
  const t = norm(text);
  if (!t) return null;
  const keys = Object.keys(stores);
  // space/underscore/hyphen-insensitive: "alan koch" -> ALANKOCH, "off supply" -> OFF_SUPPLY
  return keys.find(k => norm(k) === t || norm(slugify(k)) === t || norm(prettyName(k)) === t)
    || keys.find(k => t.includes(norm(k)))
    || null;
}

function toIST(d = new Date()) {
  return new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
}
function istYMD(d = new Date()) { return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); }
function istMidnight(ymd) { return new Date(`${ymd}T00:00:00+05:30`); }

// ── Ranges ──────────────────────────────────────────────────────────────────
function ddmmyyToYMD(s) {
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (!m) return null;
  let [, d, mo, y] = m; y = y.length === 2 ? '20' + y : y;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}
function resolveRange(text) {
  const now = new Date();
  const todayYMD = istYMD(now);
  const todayMid = istMidnight(todayYMD);
  const DAY = 86400000;
  const t = (text || '').trim().toLowerCase();
  if (!t) return { from: new Date(todayMid - DAY), to: todayMid, label: 'Yesterday' };

  // explicit DD.MM.YY - DD.MM.YY range
  const rng = t.match(/(\d{1,2}\.\d{1,2}\.\d{2,4})\s*-\s*(\d{1,2}\.\d{1,2}\.\d{2,4})/);
  if (rng) {
    const a = ddmmyyToYMD(rng[1]), b = ddmmyyToYMD(rng[2]);
    if (a && b) return { from: istMidnight(a), to: new Date(istMidnight(b).getTime() + DAY), label: `${rng[1]} → ${rng[2]}` };
  }
  // single DD.MM.YY
  const one = t.match(/^(\d{1,2}\.\d{1,2}\.\d{2,4})$/);
  if (one) { const a = ddmmyyToYMD(one[1]); if (a) return { from: istMidnight(a), to: new Date(istMidnight(a).getTime() + DAY), label: one[1] }; }

  if (/\btoday\b/.test(t))     return { from: todayMid, to: now, label: 'Today' };
  if (/\byesterday\b/.test(t)) return { from: new Date(todayMid - DAY), to: todayMid, label: 'Yesterday' };
  if (/last month/.test(t)) {
    const [y, m] = todayYMD.split('-').map(Number);
    const firstThis = istMidnight(`${y}-${String(m).padStart(2, '0')}-01`);
    const lm = m === 1 ? 12 : m - 1, ly = m === 1 ? y - 1 : y;
    return { from: istMidnight(`${ly}-${String(lm).padStart(2, '0')}-01`), to: firstThis, label: 'Last month' };
  }
  if (/\b(this month|month)\b/.test(t)) return { from: istMidnight(todayYMD.slice(0, 8) + '01'), to: now, label: 'This month' };
  if (/\b(all|all time|lifetime)\b/.test(t)) return { from: null, to: now, label: 'All time' };
  const nDays = t.match(/(\d+)\s*d(ay)?s?\b/);
  if (nDays) { const n = Math.min(parseInt(nDays[1]), 365); return { from: new Date(todayMid - (n - 1) * DAY), to: now, label: `Last ${n} days` }; }
  if (/\bweek\b/.test(t)) return { from: new Date(todayMid - 6 * DAY), to: now, label: 'Last 7 days' };
  return { from: new Date(todayMid - DAY), to: todayMid, label: 'Yesterday' };
}

// ── Command parser:  [{brand(s)} digest|deepdigest {date/range}] ─────────────
function parseCommand(raw) {
  const lower = (raw || '').toLowerCase();
  // trend + deepdigest are merged: both produce the visual HTML report.
  let kw = null, kind = null;
  if (lower.includes('deepdigest')) { kw = 'deepdigest'; kind = 'trend'; }
  else if (lower.includes('trend')) { kw = 'trend'; kind = 'trend'; }
  else if (lower.includes('digest')) { kw = 'digest'; kind = 'digest'; }
  if (!kind) return null;

  const idx = lower.indexOf(kw);
  let before = lower.slice(0, idx).replace(/[{}]/g, ' ').trim();
  let after = lower.slice(idx + kw.length).replace(/[{}]/g, ' ').trim();

  const brandKeys = [], unknown = [];
  if (before) {
    for (const tok of before.split(',').map(s => s.trim()).filter(Boolean)) {
      const k = storeKeyFromText(tok);
      if (k && !brandKeys.includes(k)) brandKeys.push(k); else if (!k) unknown.push(tok);
    }
  }
  return { kind, brandKeys, unknown, range: resolveRange(after), rawRange: after };
}

// ── Per-store metrics ───────────────────────────────────────────────────────
function apiGet(domain, token, path) {
  return fetch(`https://${domain}/admin/api/${API_VERSION}/${path}`, { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' } });
}
async function storeMetrics(store, range) {
  const domain = store.domain;
  let token;
  try { token = await resolveToken(store); } catch (e) { return { error: 'auth_failed' }; }
  if (!token) return { error: 'no_token' };
  const params = new URLSearchParams({ status: 'any', limit: '250', fields: 'id,total_price,financial_status,cancelled_at,currency,created_at,line_items' });
  if (range.from) params.set('created_at_min', range.from.toISOString());
  if (range.to) params.set('created_at_max', range.to.toISOString());
  let url = `orders.json?${params.toString()}`;
  let orders = 0, revenue = 0, maxOrder = 0, currency = 'INR', guard = 0;
  const daily = {}; const products = {}; // title -> { qty, revenue }
  while (url && guard++ < 400) {
    const res = await apiGet(domain, token, url);
    if (res.status === 403 || res.status === 401) return { error: 'no_orders_scope' };
    if (res.status === 429) { await new Promise(r => setTimeout(r, 2000)); continue; }
    if (!res.ok) return { error: `http_${res.status}` };
    const data = await res.json();
    for (const o of (data.orders || [])) {
      if (o.cancelled_at || ['refunded', 'voided'].includes(o.financial_status)) continue;
      const amt = parseFloat(o.total_price || '0');
      revenue += amt; orders++; if (amt > maxOrder) maxOrder = amt;
      if (o.currency) currency = o.currency;
      const day = new Date(o.created_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      daily[day] = daily[day] || { revenue: 0, orders: 0 };
      daily[day].revenue += amt; daily[day].orders++;
      for (const li of (o.line_items || [])) {
        const title = (li.title || 'Unknown').trim();
        const qty = parseInt(li.quantity || 0);
        const lineRev = parseFloat(li.price || 0) * qty;
        const p = products[title] || (products[title] = { qty: 0, revenue: 0 });
        p.qty += qty; p.revenue += lineRev;
      }
    }
    const link = res.headers.get('link') || res.headers.get('Link') || '';
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1].split(`/admin/api/${API_VERSION}/`)[1] : null;
  }
  const topProducts = Object.entries(products).sort((a, b) => b[1].qty - a[1].qty || b[1].revenue - a[1].revenue)
    .slice(0, 5).map(([title, v]) => ({ title, qty: v.qty, revenue: v.revenue }));
  return { orders, revenue, maxOrder, currency, daily, aov: orders ? revenue / orders : 0, bestSeller: topProducts[0] || null, topProducts };
}

// Best-effort sessions via ShopifyQL (needs read_analytics scope; null if unavailable).
async function fetchSessions(store, range) {
  try {
    const domain = store.domain;
    const token = await resolveToken(store);
    if (!token || !range.from) return null;
    const since = istYMD(range.from);
    const until = istYMD(new Date((range.to ? range.to.getTime() : Date.now()) - 1));
    const ql = `FROM sessions SHOW sum(sessions) AS s SINCE ${since} UNTIL ${until}`;
    const res = await fetch(`https://${domain}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST', headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `{ shopifyqlQuery(query: ${JSON.stringify(ql)}) { __typename ... on TableResponse { tableData { rowData } } } }` }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const rd = j?.data?.shopifyqlQuery?.tableData?.rowData;
    if (rd && rd[0] && rd[0][0] != null) return parseInt(rd[0][0]) || 0;
    return null;
  } catch { return null; }
}

// ── Aggregate a digest over brands ──────────────────────────────────────────
async function fetchDigest({ brandKeys = [], range, withSessions = false, withAds = false }) {
  const stores = loadStores();
  const keys = brandKeys.length ? brandKeys.filter(k => stores[k]) : Object.keys(stores);
  const out = [];
  const LIMIT = 6; let i = 0;
  async function worker() {
    while (i < keys.length) {
      const key = keys[i++];
      try {
        const m = await storeMetrics(stores[key], range);
        let sessions = null;
        if (withSessions && !m.error) sessions = await fetchSessions(stores[key], range);
        out.push({ key, brand: prettyName(key), slug: slugify(key), sessions, ...m });
      } catch (e) { out.push({ key, brand: prettyName(key), slug: slugify(key), error: e.message }); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(LIMIT, keys.length || 1) }, worker));
  const ok = out.filter(r => !r.error).sort((a, b) => b.revenue - a.revenue);
  const noAccess = out.filter(r => r.error === 'no_orders_scope').map(r => r.brand);
  const errored = out.filter(r => r.error && r.error !== 'no_orders_scope').map(r => `${r.brand} (${r.error})`);
  const totals = { revenue: 0, orders: 0, maxOrder: 0, sessions: 0, sessionsKnown: false, ccy: {} };
  const dailyAll = {}; const prodAll = {};
  for (const r of ok) {
    totals.revenue += r.revenue; totals.orders += r.orders;
    totals.maxOrder = Math.max(totals.maxOrder, r.maxOrder || 0);
    if (r.sessions != null) { totals.sessions += r.sessions; totals.sessionsKnown = true; }
    totals.ccy[r.currency] = (totals.ccy[r.currency] || 0) + r.revenue;
    for (const [d, v] of Object.entries(r.daily || {})) { dailyAll[d] = dailyAll[d] || { revenue: 0, orders: 0 }; dailyAll[d].revenue += v.revenue; dailyAll[d].orders += v.orders; }
    for (const p of (r.topProducts || [])) { const e = prodAll[p.title] || (prodAll[p.title] = { qty: 0, revenue: 0 }); e.qty += p.qty; e.revenue += p.revenue; }
  }
  totals.aov = totals.orders ? totals.revenue / totals.orders : 0;
  totals.topProducts = Object.entries(prodAll).sort((a, b) => b[1].qty - a[1].qty || b[1].revenue - a[1].revenue).slice(0, 5).map(([title, v]) => ({ title, qty: v.qty, revenue: v.revenue }));
  totals.bestSeller = totals.topProducts[0] || null;
  const ccy = ok[0]?.currency || 'INR';
  const report = { range, brands: ok, noAccess, errored, unknown: [], totals, dailyAll, ccy };
  if (withAds) {
    try { const ma = require('./meta-ads'); ma.attachAds(report, await ma.fetchMetaInsights(range)); }
    catch (e) { console.error('ads:', e.message); report.ads = { hasData: false }; }
  }
  return report;
}

// Back-compat for the slash-command path.
async function fetchAllBrandSales(rangeText, { only = null } = {}) {
  const r = await fetchDigest({ brandKeys: only ? [only] : [], range: resolveRange(rangeText) });
  return { range: r.range, ok: r.brands, noAccess: r.noAccess, errored: r.errored,
    byCcy: Object.fromEntries(Object.entries(r.totals.ccy).map(([c, rev]) => [c, { revenue: rev, orders: r.brands.filter(b => b.currency === c).reduce((s, b) => s + b.orders, 0) }])),
    storeCount: r.brands.length + r.noAccess.length + r.errored.length };
}

function helpText() {
  const keys = Object.keys(loadStores()).sort();
  const brands = keys.map(k => `• *${prettyName(k)}* — \`/${slugify(k)}\``).join('\n');
  return `*📊 Brand Sales — help*

*digest* — quick numbers in Slack   \`{brands} digest {date/range}\`
• \`digest\` — yesterday, all brands
• \`myugen digest\` — one brand, yesterday
• \`digest today\` — today 00:00 → now
• \`digest 7d\` · \`digest30d\` — last N days
• \`digest 20.06.26\` — a specific day (DD.MM.YY)
• \`{myugen,kaand} digest 30d\` — club brands ({} required for multi/range)

*trend* — full visual report (opens as a mobile-friendly link)   \`{brands} trend {range}\`
• \`trend 30d\` · \`myugen trend 7d\` · \`{myugen,voyd} trend {01.06.26-23.06.26}\`

Both show *Revenue · Orders · AOV · Highest order · Sessions · Ad spend · ROAS · CTR · best/worst CTR campaign (links) · best seller · status · ideas to improve*.

*Slash commands* (work anywhere): \`/<brand>\` · \`/<brand> 30d\` · \`/sales\` · \`/help\`

*Brands* (${keys.length}):
${brands}

_Daily digest auto-sends at 12:00 PM IST (yesterday, full day)._`;
}

function fmtMoney(n, ccy = 'INR') {
  try { return new Intl.NumberFormat('en-IN', { style: 'currency', currency: ccy, maximumFractionDigits: 0 }).format(n); }
  catch { return `${ccy} ${Math.round(n).toLocaleString('en-IN')}`; }
}
function fmtNum(n) { return Number(n || 0).toLocaleString('en-IN'); }
function reportLink(text) { const b = process.env.REPORT_BASE_URL; return b ? `${b}?q=${encodeURIComponent(text)}` : null; }

// ── Status badge + improvement ideas (data-driven) ──────────────────────────
// m: { revenue, orders, adSpend, roas, ctr, aov, sessions }
function healthStatus(m) {
  if (m.adSpend > 0 && m.revenue === 0) return { emoji: '⛔', label: 'Burning - spend, zero sales', tone: 'bad' };
  if (m.roas == null) return { emoji: '⚪', label: 'No ads running', tone: 'neutral' };
  if (m.roas >= 2.5) return { emoji: '🟢', label: 'Strong - scale it', tone: 'good' };
  if (m.roas >= 1.5) return { emoji: '🟢', label: 'Profitable', tone: 'good' };
  if (m.roas >= 1) return { emoji: '🟡', label: 'Break-even', tone: 'warn' };
  return { emoji: '🔴', label: 'Losing money on ads', tone: 'bad' };
}
// returns array of short actionable strings; topCampaign/worstCampaign optional {name,ctr}
function improvementIdeas(m) {
  const tips = [];
  const ctr = m.ctr, roas = m.roas, money = n => fmtMoney(n, m.currency || 'INR');
  if (m.adSpend > 0 && m.revenue === 0) {
    tips.push(`⛔ ${money(m.adSpend)} spent with *0 sales* - pause these ads now and audit the funnel (broken checkout? wrong audience? dead landing page?).`);
  } else if (roas != null) {
    if (roas < 1) tips.push(`🔴 ROAS ${roas.toFixed(2)}x - you're losing money. Pause every campaign under 1x and move that budget to your best performer${m.topCampaign ? ` (*${m.topCampaign.name}*)` : ''}. Tighten the audience and test stronger hooks.`);
    else if (roas < 1.5) tips.push(`🟡 ROAS ${roas.toFixed(2)}x - break-even. Trim the weakest campaign${m.worstCampaign ? ` (*${m.worstCampaign.name}*)` : ''}, double down on winners, and lift AOV with bundles/upsells.`);
    else tips.push(`🟢 ROAS ${roas.toFixed(2)}x - profitable. Scale budget 20-30% on the top campaign${m.topCampaign ? ` (*${m.topCampaign.name}*)` : ''} while ROAS holds, and clone its creative.`);
  }
  if (ctr != null) {
    if (ctr < 1) tips.push(`🎯 CTR ${ctr.toFixed(2)}% is low - the creative isn't grabbing attention. Refresh the thumbnail / first 3 seconds, try UGC and pattern-interrupt hooks.`);
    else if (ctr >= 2 && roas != null && roas < 1) tips.push(`👀 CTR is healthy (${ctr.toFixed(2)}%) but ROAS is weak - clicks aren't converting. Fix the PDP, price, offer or checkout, not the ad.`);
  }
  if (m.bestSeller) tips.push(`🏆 *${m.bestSeller.title}* is your best seller (${fmtNum(m.bestSeller.qty)} sold) - feature it in ads and as the homepage hero.`);
  if (m.sessions != null && m.orders && m.sessions) {
    const cv = 100 * m.orders / m.sessions;
    if (cv < 1) tips.push(`🛒 Conversion is ${cv.toFixed(2)}% (under 1%) - traffic is arriving but not buying. Audit page speed, trust signals and the offer.`);
  }
  return tips.length ? tips : ['No issues flagged for this range.'];
}

// ── Slack: simple sales blocks (slash) ──────────────────────────────────────
function salesBlocks(report, { brandFilter = null, isAuto = false } = {}) {
  const { range, ok, noAccess, errored, byCcy, storeCount } = report;
  const rows = brandFilter ? ok.filter(r => r.key === brandFilter) : ok;
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `${isAuto ? '📊 Daily sales' : '💰 Brand sales'} · ${range.label}`, emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `🕐 as of ${toIST()} IST` }] },
    { type: 'divider' },
  ];
  if (!rows.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_No sales in this range._' } });
  else {
    const lines = rows.map((r, i) => `${!brandFilter && i < 3 ? ['🥇','🥈','🥉'][i] + ' ' : ''}*${r.brand}* — ${fmtMoney(r.revenue, r.currency)}${r.orders ? `  ·  ${r.orders} ord  ·  ${fmtMoney(r.aov, r.currency)} AOV` : '  ·  no orders'}`);
    for (let i = 0; i < lines.length; i += 20) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.slice(i, i + 20).join('\n') } });
  }
  if (!brandFilter && byCcy && Object.keys(byCcy).length) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*🧮 Total (${rows.length} brands)*\n${Object.entries(byCcy).map(([c, v]) => `*${fmtMoney(v.revenue, c)}*  ·  ${v.orders} orders`).join('\n')}` } });
  }
  return blocks;
}

// ── Slack: rich digest blocks ───────────────────────────────────────────────
function digestBlocks(report, { link = null } = {}) {
  const { range, brands, totals, noAccess = [], errored = [], unknown = [], ccy } = report;
  const a = report.ads || {};
  const single = brands.length === 1;
  const scope = single ? brands[0].brand : `${brands.length} brands`;
  const pct = v => v != null ? v.toFixed(2) + '%' : '—';
  const aggM = { revenue: totals.revenue, orders: totals.orders, adSpend: a.totalSpend || 0, roas: a.hasData ? a.roas : null, ctr: a.hasData ? a.avgCtr : null, aov: totals.aov, sessions: totals.sessionsKnown ? totals.sessions : null, currency: ccy, bestSeller: totals.bestSeller, topCampaign: a.high, worstCampaign: a.low };
  const st = healthStatus(aggM);
  const sessions = totals.sessionsKnown ? fmtNum(totals.sessions) : '—';
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `${st.emoji} ${scope} digest · ${range.label}`, emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `🕐 ${toIST()} IST   ·   *${st.label}*` }] },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: `*💰 Revenue*\n${fmtMoney(totals.revenue, ccy)}` },
      { type: 'mrkdwn', text: `*🧾 Orders*\n${fmtNum(totals.orders)}` },
      { type: 'mrkdwn', text: `*📊 AOV*\n${fmtMoney(totals.aov, ccy)}` },
      { type: 'mrkdwn', text: `*🔝 Highest order*\n${fmtMoney(totals.maxOrder, ccy)}` },
      { type: 'mrkdwn', text: `*👀 Sessions*\n${sessions}` },
      { type: 'mrkdwn', text: `*🛒 Conv.*\n${totals.sessionsKnown && totals.sessions ? (100 * totals.orders / totals.sessions).toFixed(1) + '%' : '—'}` },
    ] },
  ];
  if (a.hasData) blocks[2].fields.push(
    { type: 'mrkdwn', text: `*📣 Ad spend*\n${fmtMoney(a.totalSpend, ccy)}` },
    { type: 'mrkdwn', text: `*📈 ROAS*\n${a.roas != null ? a.roas.toFixed(2) + 'x' : '—'}` },
  );
  // CTR + best/worst campaign with deep links
  if (a.hasData) {
    let ctr = `*🎯 CTR* — avg ${pct(a.avgCtr)}`;
    if (a.high) ctr += `\n▲ Best: <${a.high.link}|${a.high.name}> · ${pct(a.high.ctr)}`;
    if (a.low) ctr += `\n▼ Worst: <${a.low.link}|${a.low.name}> · ${pct(a.low.ctr)}`;
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: ctr } });
  }
  if (totals.bestSeller) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `🏆 Best seller: *${totals.bestSeller.title}* — ${fmtNum(totals.bestSeller.qty)} sold` }] });
  // per-brand breakdown
  if (!single) {
    blocks.push({ type: 'divider' });
    const lines = brands.map((r, i) => `${i < 3 ? ['🥇','🥈','🥉'][i] + ' ' : ''}*${r.brand}* — ${fmtMoney(r.revenue, r.currency)} · ${fmtNum(r.orders)} ord${r.roas != null ? ` · ${r.roas.toFixed(2)}x` : (r.adSpend ? ` · ${fmtMoney(r.adSpend, r.currency)} ad/0 rev` : '')}${r.bestSeller ? ` · 🏆 ${r.bestSeller.title}` : ''}`);
    for (let i = 0; i < lines.length; i += 15) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.slice(i, i + 15).join('\n') } });
    // per-brand best/worst CTR campaign links only when the scope is small (avoid clutter)
    if (brands.length <= 5 && a.hasData) {
      const cl = brands.filter(b => b.topCampaign || b.worstCampaign).map(b =>
        `*${b.brand}*  ${b.topCampaign ? `▲ <${b.topCampaign.link}|${b.topCampaign.name}> ${pct(b.topCampaign.ctr)}` : ''}${b.worstCampaign ? `  ▼ <${b.worstCampaign.link}|${b.worstCampaign.name}> ${pct(b.worstCampaign.ctr)}` : ''}`);
      if (cl.length) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: cl.join('\n') }] });
    } else if (a.hasData && link) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `_per-brand best/worst campaign links → open the full report_` }] });
    }
  }
  // improvement ideas
  const tips = improvementIdeas(aggM);
  blocks.push({ type: 'divider' });
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*💡 Ideas to improve*\n${tips.slice(0, single ? 4 : 3).map(t => '• ' + t).join('\n')}` } });
  if (link) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `📊 <${link}|Open full visual report>` }] });
  const notes = [];
  if (!totals.sessionsKnown) notes.push('_sessions need `read_analytics` on the store token_');
  if (unknown && unknown.length) notes.push(`⚠️ unknown brand: ${unknown.join(', ')}`);
  if (noAccess.length) notes.push(`⚠️ no order access: ${noAccess.join(', ')}`);
  if (errored.length) notes.push(`⚠️ errors: ${errored.join(', ')}`);
  if (notes.length) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: notes.join('\n') }] });
  return blocks;
}

// ── Trend: daily revenue series with a unicode sparkline ────────────────────
function sparkline(vals) {
  const bars = '▁▂▃▄▅▆▇█';
  const mx = Math.max(...vals, 1);
  return vals.map(v => bars[Math.min(7, Math.floor((v / mx) * 7 + 1e-9))]).join('');
}
function trendBlocks(report, { link = null } = {}) {
  const { range, dailyAll, totals, brands, ccy } = report;
  const scope = brands.length === 1 ? brands[0].brand : (brands.length ? `${brands.length} brands` : 'All brands');
  const days = Object.keys(dailyAll).sort();
  if (!days.length) return [{ type: 'section', text: { type: 'mrkdwn', text: `📈 *${scope} trend · ${range.label}*\n_No sales in this range._` } }];
  const rev = days.map(d => dailyAll[d].revenue);
  const peak = rev.indexOf(Math.max(...rev));
  const low = rev.indexOf(Math.min(...rev));
  const avg = totals.revenue / days.length;
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `📈 ${scope} trend · ${range.label}`, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Daily revenue*\n\`${sparkline(rev)}\`\n📈 Peak *${days[peak]}* ${fmtMoney(rev[peak], ccy)}  ·  📉 Low *${days[low]}* ${fmtMoney(rev[low], ccy)}  ·  Avg/day ${fmtMoney(avg, ccy)}` } },
  ];
  const lines = days.map((d, i) => `\`${d}\`  ${fmtMoney(rev[i], ccy)}  ·  ${dailyAll[d].orders} ord`);
  blocks.push(days.length <= 16
    ? { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }
    : { type: 'section', text: { type: 'mrkdwn', text: lines.slice(0, 8).join('\n') + '\n  …\n' + lines.slice(-4).join('\n') } });
  const a = report.ads;
  if (a && a.hasData) {
    const pct = v => v != null ? v.toFixed(2) + '%' : '—';
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*📣 Ads* — spend ${fmtMoney(a.totalSpend, ccy)} · ROAS ${a.roas != null ? a.roas.toFixed(2) + 'x' : '—'} · avg CTR ${pct(a.avgCtr)}${a.high ? ` · ▲ ${a.high.label} ${pct(a.high.ctr)}` : ''}${a.low ? ` · ▼ ${a.low.label} ${pct(a.low.ctr)}` : ''}` } });
  }
  if (link) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `📊 <${link}|Open interactive chart>` }] });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Total ${fmtMoney(totals.revenue, ccy)} · ${fmtNum(totals.orders)} orders over ${days.length} days` }] });
  return blocks;
}

// ── Smart sectioned HTML performance report (the "trend" report) ─────────────
function buildDeepDigestHtml(report) {
  const { range, brands, totals, dailyAll, ccy } = report;
  const ads = report.ads || {};
  const hasAds = !!ads.hasData;
  const single = brands.length === 1;
  const multi = brands.length > 1;
  const scope = single ? brands[0].brand : (brands.length ? `${brands.length} brands` : 'All brands');
  const money = n => fmtMoney(n, ccy);
  const pct = v => v != null ? v.toFixed(2) + '%' : '—';
  const J = JSON.stringify;
  const esc = s => String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

  const days = Object.keys(dailyAll).sort();
  const dailyRev = days.map(d => Math.round(dailyAll[d].revenue));
  const dailyOrd = days.map(d => dailyAll[d].orders);
  const brandNames = brands.map(b => b.brand);
  const brandRev = brands.map(b => Math.round(b.revenue));
  const brandSpend = brands.map(b => Math.round(b.adSpend || 0));
  const brandRoas = brands.map(b => b.roas != null ? +b.roas.toFixed(2) : 0);
  const brandCtr = brands.map(b => b.ctr != null ? +b.ctr.toFixed(2) : 0);

  // status (single brand → that brand; multi → aggregate)
  const aggM = { revenue: totals.revenue, orders: totals.orders, adSpend: ads.totalSpend || 0, roas: hasAds ? ads.roas : null, ctr: hasAds ? ads.avgCtr : null, aov: totals.aov, sessions: totals.sessionsKnown ? totals.sessions : null, currency: ccy, bestSeller: totals.bestSeller, topCampaign: ads.high, worstCampaign: ads.low };
  const st = healthStatus(aggM);
  const statusSummary = hasAds
    ? `${money(totals.revenue)} revenue on ${money(ads.totalSpend)} ad spend · ROAS ${ads.roas != null ? ads.roas.toFixed(2) + 'x' : '—'} · CTR ${pct(ads.avgCtr)}`
    : `${money(totals.revenue)} revenue · ${fmtNum(totals.orders)} orders · AOV ${money(totals.aov)}`;

  const kpis = [['Revenue', money(totals.revenue)], ['Orders', fmtNum(totals.orders)], ['AOV', money(totals.aov)], ['Highest order', money(totals.maxOrder)]];
  if (hasAds) kpis.push(['Ad spend', money(ads.totalSpend)], ['ROAS', ads.roas != null ? ads.roas.toFixed(2) + 'x' : '—'], ['Avg CTR', pct(ads.avgCtr)]);
  kpis.push(['Sessions', totals.sessionsKnown ? fmtNum(totals.sessions) : 'n/a']);
  if (multi) kpis.push(['Brands', String(brands.length)]);

  const brandW = Math.max(560, brands.length * 78);
  const dayW = Math.max(560, days.length * 38);
  const chart = (id, title, minW) => `<div class=card><h2>${title}</h2><div class=scroll><div class=cbox style="min-width:${minW}px"><canvas id=${id}></canvas></div></div><div class=hint>← swipe sideways →</div></div>`;
  const section = (title, inner) => `<div class=sec><div class=sech>${title}</div>${inner}</div>`;
  const cmpLink = c => c ? `<a href="${c.link}" target=_blank>${esc(c.name)}</a> · ${pct(c.ctr)}` : '—';

  // ── SALES section ──
  let sales = chart('daily', 'Daily revenue', dayW);
  if (days.length) sales += chart('dailyOrd', 'Daily orders', dayW);
  if (multi) sales += chart('byBrand', 'Revenue by brand', brandW);

  // ── ADS section ──
  let adsSec = '';
  if (hasAds) {
    if (multi) {
      adsSec += chart('roas', 'ROAS by brand (green ≥ 1x · red < 1x)', brandW);
      adsSec += chart('spendRev', 'Ad spend vs revenue by brand', brandW);
      adsSec += chart('ctr', 'CTR by brand (%)', brandW);
    } else if (single) {
      const c = (brands[0].campaigns || []).filter(x => x.spend > 0);
      if (c.length) {
        adsSec += chart('campSpend', 'Spend by campaign', Math.max(560, c.length * 70));
        adsSec += chart('campCtr', 'CTR by campaign (%)', Math.max(560, c.length * 70));
      }
    }
    // best/worst CTR campaign with links (per brand)
    const rowsCtr = (multi ? brands : brands).filter(b => b.topCampaign || b.worstCampaign).map(b =>
      `<tr><td>${esc(b.brand)}</td><td>${cmpLink(b.topCampaign)}</td><td>${cmpLink(b.worstCampaign)}</td></tr>`).join('');
    if (rowsCtr) adsSec += `<div class=card><h2>Best / worst CTR campaign ${multi ? 'per brand' : ''} (tap to open in Ads Manager)</h2><div class=scroll><table><tr><th>Brand</th><th>▲ Best CTR</th><th>▼ Worst CTR</th></tr>${rowsCtr}</table></div></div>`;
  }

  // ── BEST SELLERS section ──
  const tp = (single ? brands[0].topProducts : totals.topProducts) || [];
  let sellers = '';
  if (tp.length) {
    const r = tp.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.title)}</td><td>${fmtNum(p.qty)}</td><td>${money(p.revenue)}</td></tr>`).join('');
    sellers = `<div class=card><h2>Top products ${single ? '' : '(all brands combined)'}</h2><div class=scroll><table><tr><th>#</th><th>Product</th><th>Units</th><th>Revenue</th></tr>${r}</table></div></div>`;
  }

  // ── PER-BRAND TABLE (multi only) ──
  let table = '';
  if (multi) {
    const rows = brands.map(b => `<tr><td>${esc(b.brand)}</td><td>${money(b.revenue)}</td><td>${fmtNum(b.orders)}</td><td>${money(b.aov)}</td>`
      + (hasAds ? `<td>${money(b.adSpend || 0)}</td><td class="${b.roas != null && b.roas >= 1 ? 'pos' : 'neg'}">${b.roas != null ? b.roas.toFixed(2) + 'x' : '—'}</td><td>${b.ctr != null ? b.ctr.toFixed(2) + '%' : '—'}</td>` : '')
      + `<td>${b.bestSeller ? esc(b.bestSeller.title) : '—'}</td></tr>`).join('');
    table = `<div class=card><h2>Per-brand breakdown</h2><div class=scroll><table><tr><th>Brand</th><th>Revenue</th><th>Orders</th><th>AOV</th>${hasAds ? '<th>Ad spend</th><th>ROAS</th><th>CTR</th>' : ''}<th>Best seller</th></tr>${rows}</table></div></div>`;
  }

  // ── RECOMMENDATIONS section ──
  let recs;
  if (single) {
    const b = brands[0];
    const m = { revenue: b.revenue, orders: b.orders, adSpend: b.adSpend || 0, roas: b.roas, ctr: b.ctr, aov: b.aov, sessions: b.sessions, currency: b.currency, bestSeller: b.bestSeller, topCampaign: b.topCampaign, worstCampaign: b.worstCampaign };
    recs = `<ul class=ideas>${improvementIdeas(m).map(t => `<li>${esc(t.replace(/\*/g, ''))}</li>`).join('')}</ul>`;
  } else {
    recs = brands.slice(0, 8).map(b => {
      const m = { revenue: b.revenue, orders: b.orders, adSpend: b.adSpend || 0, roas: b.roas, ctr: b.ctr, aov: b.aov, sessions: b.sessions, currency: b.currency, bestSeller: b.bestSeller, topCampaign: b.topCampaign, worstCampaign: b.worstCampaign };
      const s = healthStatus(m);
      return `<div class=brec><div class=brh>${s.emoji} ${esc(b.brand)} <span class=bmut>${s.label}</span></div><ul class=ideas>${improvementIdeas(m).slice(0, 2).map(t => `<li>${esc(t.replace(/\*/g, ''))}</li>`).join('')}</ul></div>`;
    }).join('');
  }

  return `<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(scope)} · ${esc(range.label)} · report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
:root{--bg:#0b0b0d;--panel:#15151a;--line:#26262e;--fg:#f4f4f6;--mut:#9a9aa3;--pos:#36d399;--warn:#ffd166;--neg:#ff5a5a}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:radial-gradient(1200px 600px at 75% -10%,#1b1b24,#0b0b0d 60%);color:var(--fg);font:15px/1.55 ui-sans-serif,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:26px 16px 80px}
h1{font:800 24px/1.1 'Helvetica Neue',Arial;margin:0 0 3px;text-transform:uppercase;letter-spacing:.01em}
.sub{color:var(--mut);margin-bottom:18px;font-size:13px}
.status{border-radius:16px;padding:18px 20px;margin-bottom:22px;border:1px solid var(--line)}
.status.good{background:linear-gradient(120deg,rgba(54,211,153,.16),rgba(54,211,153,.04));border-color:rgba(54,211,153,.4)}
.status.warn{background:linear-gradient(120deg,rgba(255,209,102,.16),rgba(255,209,102,.04));border-color:rgba(255,209,102,.4)}
.status.bad{background:linear-gradient(120deg,rgba(255,90,90,.16),rgba(255,90,90,.04));border-color:rgba(255,90,90,.4)}
.status .big{font:800 22px/1.15 'Helvetica Neue',Arial}
.status .sm{color:var(--mut);font-size:13px;margin-top:4px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:8px}
@media(max-width:880px){.kpis{grid-template-columns:repeat(3,1fr)}}
@media(max-width:560px){.kpis{grid-template-columns:repeat(2,1fr);gap:10px}}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:13px 15px}
.kpi .l{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.07em}
.kpi .v{font:800 21px/1.2 'Helvetica Neue',Arial;margin-top:4px;word-break:break-word}
.sec{margin-top:26px}
.sech{font:800 13px/1 'Helvetica Neue',Arial;text-transform:uppercase;letter-spacing:.12em;color:#fff;margin:0 0 12px;padding-left:10px;border-left:3px solid var(--neg)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px;margin-bottom:14px}
.card h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);margin:0 0 12px}
.scroll{overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;border-radius:10px}
.scroll::-webkit-scrollbar{height:8px}.scroll::-webkit-scrollbar-thumb{background:#34343f;border-radius:8px}
.cbox{position:relative;height:300px}@media(max-width:560px){.cbox{height:260px}}
.hint{display:none;color:var(--mut);font-size:11px;margin-top:8px;text-align:center}
@media(max-width:760px){.hint{display:block}}
.scroll table{min-width:560px}
table{width:100%;border-collapse:collapse;font-size:14px}
td,th{padding:9px 12px;text-align:left;border-bottom:1px solid #1f1f27;white-space:nowrap}
th{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
tr td:first-child{font-weight:600}
td.pos{color:var(--pos);font-weight:700}td.neg{color:var(--neg);font-weight:700}
a{color:#7cb8ff;text-decoration:none}a:hover{text-decoration:underline}
.ideas{margin:0;padding-left:18px}.ideas li{margin:7px 0}
.brec{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin-bottom:12px}
.brh{font-weight:700;margin-bottom:4px}.bmut{color:var(--mut);font-weight:400;font-size:13px}
.foot{color:var(--mut);font-size:12px;margin-top:22px}
</style></head><body><div class=wrap>
<h1>${esc(scope)} report</h1>
<div class=sub>${esc(range.label)} &nbsp;·&nbsp; generated ${toIST()} IST</div>
<div class="status ${st.tone}"><div class=big>${st.emoji} ${st.label}</div><div class=sm>${statusSummary}</div></div>
<div class=kpis>${kpis.map(([l, v]) => `<div class=kpi><div class=l>${l}</div><div class=v>${v}</div></div>`).join('')}</div>
${section('Sales', sales)}
${hasAds ? section('Ads &amp; ROAS', adsSec) : ''}
${sellers ? section('Best sellers', sellers) : ''}
${multi ? section('Per-brand breakdown', table) : ''}
${section('💡 How to improve', recs)}
<div class=foot>${hasAds ? 'Ad spend / ROAS / CTR from Meta, brand-named campaigns only (shared catalog ad excluded). ROAS = revenue ÷ ad spend. ' : ''}${totals.sessionsKnown ? '' : 'Sessions n/a where the store token lacks read_analytics. '}Brand Sales bot.</div>
<script>
const C={grid:'#1f1f27',tick:'#9a9aa3'};
const ax=(leg)=>({maintainAspectRatio:false,interaction:{intersect:false,mode:'index'},scales:{x:{ticks:{color:C.tick,maxRotation:60,minRotation:0,autoSkip:false},grid:{color:C.grid}},y:{beginAtZero:true,ticks:{color:C.tick},grid:{color:C.grid}}},plugins:{legend:{display:!!leg,labels:{color:C.tick}}}});
new Chart(daily,{type:'line',data:{labels:${J(days)},datasets:[{data:${J(dailyRev)},borderColor:'#ff8a4d',backgroundColor:'rgba(255,138,77,.15)',fill:true,tension:.3,pointRadius:2}]},options:ax(false)});
${days.length ? `new Chart(dailyOrd,{type:'bar',data:{labels:${J(days)},datasets:[{data:${J(dailyOrd)},backgroundColor:'#7c5cff',borderRadius:4}]},options:ax(false)});` : ''}
${multi ? `new Chart(byBrand,{type:'bar',data:{labels:${J(brandNames)},datasets:[{data:${J(brandRev)},backgroundColor:'#ff3b3b',borderRadius:6}]},options:ax(false)});` : ''}
${multi && hasAds ? `new Chart(roas,{type:'bar',data:{labels:${J(brandNames)},datasets:[{data:${J(brandRoas)},backgroundColor:${J(brandRoas.map(v => v >= 1 ? '#36d399' : '#ff5a5a'))},borderRadius:6}]},options:ax(false)});` : ''}
${multi && hasAds ? `new Chart(spendRev,{type:'bar',data:{labels:${J(brandNames)},datasets:[{label:'Ad spend',data:${J(brandSpend)},backgroundColor:'#7c5cff',borderRadius:5},{label:'Revenue',data:${J(brandRev)},backgroundColor:'#36d399',borderRadius:5}]},options:ax(true)});` : ''}
${multi && hasAds ? `new Chart(ctr,{type:'bar',data:{labels:${J(brandNames)},datasets:[{data:${J(brandCtr)},backgroundColor:'#ffb454',borderRadius:6}]},options:ax(false)});` : ''}
${single && hasAds && (brands[0].campaigns || []).filter(x => x.spend > 0).length ? (() => { const c = brands[0].campaigns.filter(x => x.spend > 0); const lbl = c.map(x => x.name); return `new Chart(campSpend,{type:'bar',data:{labels:${J(lbl)},datasets:[{data:${J(c.map(x => Math.round(x.spend)))},backgroundColor:'#7c5cff',borderRadius:5}]},options:ax(false)});new Chart(campCtr,{type:'bar',data:{labels:${J(lbl)},datasets:[{data:${J(c.map(x => +x.ctr.toFixed(2)))},backgroundColor:'#ffb454',borderRadius:5}]},options:ax(false)});`; })() : ''}
</script></div></body></html>`;
}

module.exports = {
  loadStores, prettyName, slugify, storeKeyFromText, toIST, resolveRange, parseCommand,
  fetchDigest, fetchAllBrandSales, fmtMoney, fmtNum, salesBlocks, digestBlocks, buildDeepDigestHtml, helpText,
  trendBlocks, sparkline, reportLink,
};
