// Matchday Deal engine: count FIFA World Cup goals in the previous noon->noon IST
// window and turn them into a discount. Data: OpenFootball worldcup.json (free, no key,
// every match, per-city UTC offsets). Pure logic here - Shopify coupon creation +
// storefront update live in the integration layer.

const WC_JSON = process.env.WC_JSON_URL
  || 'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';

// ── discount config (env-overridable) ──
const RATE = parseFloat(process.env.MATCHDAY_RATE || '5');    // % per goal
const CAP = parseFloat(process.env.MATCHDAY_CAP || '60');     // safety ceiling (rarely binds in knockouts)
const FLOOR = parseFloat(process.env.MATCHDAY_FLOOR || '5');  // min discount on a goalless / no-match day

// "13:00 UTC-6" + date -> absolute UTC Date
function matchUTC(date, time) {
  const m = (time || '').match(/^(\d{1,2}):(\d{2})\s*UTC([+-]\d{1,2})/);
  if (!m) return null;
  const [, h, mi, off] = m;
  const localAsUTC = new Date(`${date}T${h.padStart(2, '0')}:${mi}:00Z`);
  return new Date(localAsUTC.getTime() - parseInt(off) * 3600 * 1000);
}

// Most recent noon-IST boundary at/just before `now` (the window's end).
function lastNoonIST(now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  const noon = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 12 - 5.5 * 0, 0, 0));
  // noon IST in UTC terms = 06:30 UTC same day
  let endUtc = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 6, 30, 0));
  if (now < endUtc) endUtc = new Date(endUtc.getTime() - 86400000); // before today's noon -> use yesterday's
  return endUtc; // UTC instant of the most recent IST-noon
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Compute the matchday deal for the window ending at `windowEndUtc` (default: last noon IST).
async function computeMatchdayDeal({ windowEndUtc = lastNoonIST(), now = new Date() } = {}) {
  const endUtc = windowEndUtc;
  const startUtc = new Date(endUtc.getTime() - 86400000);
  const res = await fetch(WC_JSON);
  if (!res.ok) throw new Error(`OpenFootball fetch ${res.status}`);
  const data = await res.json();
  const inWindow = [];
  for (const m of (data.matches || [])) {
    if (!m.score || !m.score.ft) continue;            // only finished matches with a score
    const utc = matchUTC(m.date, m.time);
    if (!utc || utc < startUtc || utc >= endUtc) continue;
    inWindow.push({
      team1: m.team1, team2: m.team2, score: `${m.score.ft[0]}-${m.score.ft[1]}`,
      teams: `${m.team1} ${m.score.ft[0]}-${m.score.ft[1]} ${m.team2}`,
      goals: m.score.ft[0] + m.score.ft[1],
      kickoffIST: new Date(utc.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' IST',
      round: m.round, group: m.group || null,
    });
  }
  const goals = inWindow.reduce((s, x) => s + x.goals, 0);
  const percent = Math.round(clamp(inWindow.length ? goals * RATE : FLOOR, FLOOR, CAP));
  const code = `GOALS${goals}`;                        // dynamic code from the goal value
  const validUntilUtc = new Date(endUtc.getTime() + 86400000 - 60000); // next noon IST minus 1 min
  return {
    windowStartIST: new Date(startUtc.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' '),
    windowEndIST: new Date(endUtc.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' '),
    matches: inWindow,
    matchCount: inWindow.length,
    goals, percent, code,
    rate: RATE, cap: CAP, floor: FLOOR,
    validFromUtc: endUtc.toISOString(),
    validUntilUtc: validUntilUtc.toISOString(),
  };
}

// ── LIVE actions (built + ready, but never auto-run; call explicitly to go live) ──
// Mint a fresh Myugen Admin token from the store's client creds (self-healing).
async function myugenToken() {
  const { loadStores } = require('./shopify-sales');
  const st = loadStores().MYUGEN;
  if (!st) throw new Error('MYUGEN store not configured');
  if (st.clientId && st.clientSecret) {
    const r = await fetch(`https://${st.domain}/admin/oauth/access_token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: st.clientId, client_secret: st.clientSecret, grant_type: 'client_credentials' }),
    });
    if (r.ok) { const j = await r.json(); if (j.access_token) return { token: j.access_token, domain: st.domain }; }
  }
  if (st.token) return { token: st.token, domain: st.domain };
  throw new Error('no Myugen credentials');
}

// Create today's Shopify discount code from the deal (percentage, valid noon->noon, 1/customer).
async function createMatchdayDiscount(deal) {
  const { token, domain } = await myugenToken();
  const q = `mutation($d:DiscountCodeBasicInput!){ discountCodeBasicCreate(basicCodeDiscount:$d){ codeDiscountNode{ id } userErrors{ field message } } }`;
  const d = {
    title: `Matchday Deal ${deal.code}`, code: deal.code,
    startsAt: deal.validFromUtc, endsAt: deal.validUntilUtc,
    customerSelection: { all: true }, appliesOncePerCustomer: true,
    customerGets: { value: { percentage: deal.percent / 100 }, items: { all: true } },
  };
  const r = await fetch(`https://${domain}/admin/api/2024-04/graphql.json`, {
    method: 'POST', headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q, variables: { d } }),
  });
  const j = await r.json();
  const out = j?.data?.discountCodeBasicCreate;
  if (out?.userErrors?.length) throw new Error(out.userErrors.map(e => e.message).join('; '));
  return out?.codeDiscountNode?.id;
}

// Delete any existing discount with this code so we can recreate it with today's
// noon->noon window. Without this, re-running (or two days with the same goal
// count -> same GOALSn code) would either collide on create or leave an EXPIRED
// code in place. Safe no-op if the code doesn't exist yet.
async function deleteExistingCode(code) {
  const { token, domain } = await myugenToken();
  const q = `query($c:String!){ codeDiscountNodeByCode(code:$c){ id } }`;
  const r = await fetch(`https://${domain}/admin/api/2024-04/graphql.json`, {
    method: 'POST', headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q, variables: { c: code } }),
  });
  const id = (await r.json())?.data?.codeDiscountNodeByCode?.id;
  if (!id) return false;
  const dq = `mutation($id:ID!){ discountCodeDelete(id:$id){ userErrors{ message } } }`;
  await fetch(`https://${domain}/admin/api/2024-04/graphql.json`, {
    method: 'POST', headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: dq, variables: { id } }),
  });
  return true;
}

// Write the deal into a Shop metafield so the storefront section can read it live.
async function writeMetafield(deal) {
  const { token, domain } = await myugenToken();
  const value = JSON.stringify({ goals: deal.goals, percent: deal.percent, code: deal.code, matches: deal.matches, validUntil: deal.validUntilUtc });
  const q = `mutation($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ userErrors{ message } } }`;
  const shopQ = `{ shop { id } }`;
  let r = await fetch(`https://${domain}/admin/api/2024-04/graphql.json`, { method: 'POST', headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: shopQ }) });
  const shopId = (await r.json())?.data?.shop?.id;
  const m = [{ ownerId: shopId, namespace: 'custom', key: 'matchday_deal', type: 'json', value }];
  r = await fetch(`https://${domain}/admin/api/2024-04/graphql.json`, { method: 'POST', headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q, variables: { m } }) });
  const errs = (await r.json())?.data?.metafieldsSet?.userErrors;
  if (errs?.length) throw new Error(errs.map(e => e.message).join('; '));
  return true;
}

// Full daily run (compute -> create code -> write metafield). NOT scheduled anywhere.
async function runMatchdayDeal() {
  const deal = await computeMatchdayDeal();
  await deleteExistingCode(deal.code);   // clear yesterday's / stale same-name code first
  await createMatchdayDiscount(deal);
  await writeMetafield(deal);
  return deal;
}

module.exports = { computeMatchdayDeal, createMatchdayDiscount, deleteExistingCode, writeMetafield, runMatchdayDeal, lastNoonIST, matchUTC };

// CLI: `node matchday.js`
if (require.main === module) {
  computeMatchdayDeal().then(d => {
    console.log(`\n=== Matchday Deal · ${d.windowStartIST} -> ${d.windowEndIST} IST ===\n`);
    d.matches.forEach(m => console.log(`  ${m.kickoffIST}  ${m.teams}  [${m.round}]`));
    console.log(`\n  ${d.matchCount} matches · ${d.goals} goals`);
    console.log(`  Discount: ${d.goals} × ${d.rate}% = ${Math.round(d.goals * d.rate)}%  ->  applied ${d.percent}% (floor ${d.floor}, cap ${d.cap})`);
    console.log(`  Coupon code: ${d.code}`);
    console.log(`  Valid: now -> ${new Date(d.validUntilUtc).toISOString()} (next noon IST)`);
  }).catch(e => { console.error('ERR:', e.message); process.exit(1); });
}
