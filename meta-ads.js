// Meta Ads spend / clicks / CTR per brand, joined to the sales report for ROAS.
// Brand attribution = campaign name matching (catalog + non-brand campaigns are dropped).
// Reads META_TOKEN + META_AD_ACCOUNT from env; if META_TOKEN is missing, returns null
// and the digest degrades gracefully (ad fields show "—").

const AD_ACCOUNT = () => process.env.META_AD_ACCOUNT || 'act_6975164685832740';
const acctNum = () => AD_ACCOUNT().replace(/^act_/, '');
const campaignLink = id => `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${acctNum()}&selected_campaign_ids=${id}`;
const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ymd = d => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const MIN_IMPR = 200; // ignore tiny-impression campaigns when picking best/worst CTR
// "cc" ad sets = the shared Culture-Circle catalog/retargeting ads (named ...-cc-pv/cv).
// These are NOT a brand's own spend, so they're excluded from the Shopify total + per-brand.
const isCC = name => /(?:^|[^a-z])cc(?:[^a-z]|$)/.test((name || '').toLowerCase());
// Extra portfolios to add to the total (e.g. ForFkSake's own ad account, which lives
// outside CC2). Comma-separated act_ ids in META_EXTRA_ACCOUNTS; token needs access.
const EXTRA_ACCOUNTS = () => (process.env.META_EXTRA_ACCOUNTS || '').split(',').map(s => s.trim()).filter(Boolean).map(a => (a.startsWith('act_') ? a : 'act_' + a));

// Campaign-name → store key. Keys MUST equal the env-prefix store keys (loadStores)
// so the join to revenue is exact. raw = lowercased name, n = stripped.
const PATTERNS = {
  FORFKSAKE:   (n, raw) => /(?:^|[^a-z])ffs(?:[^a-z]|$)/.test(raw) || /for[\s_-]?fk[\s_-]?sake/.test(raw) || n.includes('forfksake'),
  OFF_SUPPLY:  (n) => /offsupp+ly/.test(n),
  '24SONGS':   (n) => n.includes('songs24') || n.includes('24songs'),
  BLACKLISTCO: (n) => n.includes('blacklist'),
  ALANKOCH:    (n) => n.includes('alankoch'),
  ALICEMEYERS: (n) => n.includes('alicemeyers'),
  BE_AUTYST:   (n) => n.includes('beautyst'),
  CITYOFDOMES: (n) => n.includes('cityofdomes'),
  COMOATELIER: (n) => n.includes('comoatelier'),
  GYMBRAT:     (n) => n.includes('gymbrat'),
  KAAND:       (n) => n.includes('kaand'),
  MYUGEN:      (n) => n.includes('myugen'),
  PIEREERIC:   (n) => n.includes('piereeric') || n.includes('pierreeric'),
  SMILINGCAT:  (n) => n.includes('smilingcat'),
  VOYD:        (n) => n.includes('voyd'),
  ELARAVOSS:   (n) => n.includes('elaravoss'),
};
function matchBrand(name) {
  const raw = (name || '').toLowerCase(), n = norm(name);
  for (const [k, fn] of Object.entries(PATTERNS)) if (fn(n, raw)) return k;
  return null;
}

async function getAll(url) {
  const out = []; let next = url, guard = 0;
  while (next && guard++ < 50) {
    const r = await fetch(next); const j = await r.json();
    if (j.error) throw new Error(`${j.error.message} (code ${j.error.code})`);
    out.push(...(j.data || [])); next = j.paging?.next || null;
  }
  return out;
}

// Pull campaign-level spend/impressions/clicks for the range; aggregate per brand.
async function fetchMetaInsights(range) {
  const TOKEN = process.env.META_TOKEN;
  if (!TOKEN) return null;
  const since = range && range.from ? ymd(range.from) : '2023-01-01';
  const until = ymd(new Date((range && range.to ? range.to.getTime() : Date.now()) - 1));
  const tr = encodeURIComponent(JSON.stringify({ since, until }));
  // time_increment=1 → one row per campaign per day, so we get daily spend per brand
  const url = `https://graph.facebook.com/v21.0/${AD_ACCOUNT()}/insights`
    + `?level=campaign&fields=campaign_id,campaign_name,spend,impressions,clicks&time_range=${tr}&time_increment=1&limit=500&access_token=${TOKEN}`;
  const rows = await getAll(url);
  const byBrand = {}; const account = { spend: 0, clicks: 0, impr: 0, spendExCC: 0, clicksExCC: 0, imprExCC: 0 };
  const campAgg = {}; // brandKey -> { campaignId -> {id,name,link,spend,clicks,impr} }
  for (const r of rows) {
    const sp = parseFloat(r.spend || 0), cl = parseInt(r.clicks || 0), im = parseInt(r.impressions || 0);
    const date = r.date_start;
    account.spend += sp; account.clicks += cl; account.impr += im;   // raw CC2 total (incl catalog)
    if (isCC(r.campaign_name)) continue;                              // drop shared "cc"/catalog ad sets
    account.spendExCC += sp; account.clicksExCC += cl; account.imprExCC += im;
    const k = matchBrand(r.campaign_name);
    if (!k) continue;
    const b = byBrand[k] || (byBrand[k] = { spend: 0, clicks: 0, impr: 0, dailySpend: {}, dailyClicks: {}, dailyImpr: {} });
    b.spend += sp; b.clicks += cl; b.impr += im;
    if (date) {
      b.dailySpend[date] = (b.dailySpend[date] || 0) + sp;
      b.dailyClicks[date] = (b.dailyClicks[date] || 0) + cl;   // for daily CTR
      b.dailyImpr[date] = (b.dailyImpr[date] || 0) + im;       // for daily CTR
    }
    const cb = campAgg[k] || (campAgg[k] = {});
    const c = cb[r.campaign_id] || (cb[r.campaign_id] = { id: r.campaign_id, name: r.campaign_name, link: campaignLink(r.campaign_id), spend: 0, clicks: 0, impr: 0 });
    c.spend += sp; c.clicks += cl; c.impr += im;
  }
  for (const k in byBrand) {
    const b = byBrand[k]; b.ctr = b.impr ? b.clicks / b.impr * 100 : 0;
    b.campaigns = Object.values(campAgg[k] || {}).map(c => ({ ...c, ctr: c.impr ? c.clicks / c.impr * 100 : 0 }));
    // highest / lowest CTR campaign for this brand (ignore tiny-impression noise)
    const elig = b.campaigns.filter(c => c.impr >= MIN_IMPR);
    const pool = elig.length ? elig : b.campaigns;
    const sorted = [...pool].sort((a, c) => c.ctr - a.ctr);
    b.high = sorted[0] || null;
    b.low = sorted.length > 1 ? sorted[sorted.length - 1] : null;
  }
  account.ctr = account.impr ? account.clicks / account.impr * 100 : 0;
  account.ctrExCC = account.imprExCC ? account.clicksExCC / account.imprExCC * 100 : 0;
  // extra portfolios (e.g. ForFkSake's own ad account) - add their total spend
  let extraSpend = 0, extraClicks = 0, extraImpr = 0; const extraAccounts = [];
  for (const acc of EXTRA_ACCOUNTS()) {
    try {
      const u = `https://graph.facebook.com/v21.0/${acc}/insights?fields=spend,clicks,impressions&time_range=${tr}&access_token=${TOKEN}`;
      const rs = await getAll(u);
      const sp = rs.reduce((s, r) => s + parseFloat(r.spend || 0), 0);
      extraSpend += sp;
      extraClicks += rs.reduce((s, r) => s + parseInt(r.clicks || 0), 0);
      extraImpr += rs.reduce((s, r) => s + parseInt(r.impressions || 0), 0);
      extraAccounts.push({ account: acc, spend: sp });
    } catch (e) { extraAccounts.push({ account: acc, error: e.message }); }
  }
  return { byBrand, account, since, until, extraSpend, extraClicks, extraImpr, extraAccounts };
}

// Attach ad spend / ROAS / CTR onto each brand and a report.ads summary.
function attachAds(report, ins) {
  if (!ins) { report.ads = { hasData: false }; return report; }
  const scope = report.brands || [];
  for (const b of scope) {
    const a = ins.byBrand[b.key];
    b.adSpend = a ? a.spend : 0; b.adClicks = a ? a.clicks : 0; b.adImpr = a ? a.impr : 0;
    b.ctr = a && a.impr ? a.ctr : null;
    b.roas = b.adSpend > 0 ? b.revenue / b.adSpend : null;
    b.topCampaign = a && a.high ? a.high : null;   // highest-CTR campaign (with link)
    b.worstCampaign = a && a.low ? a.low : null;   // lowest-CTR campaign (with link)
    b.campaigns = a ? a.campaigns : [];            // full campaign list (for single-brand views)
    b.dailySpend = a ? a.dailySpend : {};          // {date: spend} for spend-vs-revenue-over-time
    b.dailyClicks = a ? a.dailyClicks : {};        // {date: clicks} for daily CTR
    b.dailyImpr = a ? a.dailyImpr : {};            // {date: impressions} for daily CTR
  }
  // Shopify total ad spend = all CC2 spend EXCLUDING "cc"/catalog ad sets + extra portfolios (ForFkSake).
  const extraSpend = ins.extraSpend || 0;
  const totalSpend = (ins.account.spendExCC || 0) + extraSpend;
  const totalClicks = (ins.account.clicksExCC || 0) + (ins.extraClicks || 0);
  const totalImpr = (ins.account.imprExCC || 0) + (ins.extraImpr || 0);
  // account-wide best/worst CTR campaign across all in-scope brands (for the headline)
  const allC = scope.flatMap(b => (ins.byBrand[b.key]?.campaigns || []).filter(c => c.impr >= 200));
  allC.sort((a, c) => c.ctr - a.ctr);
  report.ads = {
    hasData: totalSpend > 0,
    totalSpend, totalClicks, totalImpr,
    accountSpend: ins.account.spend,                          // raw CC2 total (incl catalog) - reference
    cc2ExCC: ins.account.spendExCC || 0,                      // CC2 minus "cc"/catalog
    catalogSpend: (ins.account.spend || 0) - (ins.account.spendExCC || 0),
    extraSpend, extraAccounts: ins.extraAccounts || [],       // ForFkSake portfolio etc.
    avgCtr: totalImpr ? totalClicks / totalImpr * 100 : null,
    roas: totalSpend > 0 ? report.totals.revenue / totalSpend : null,
    high: allC[0] || null,
    low: allC.length > 1 ? allC[allC.length - 1] : null,
  };
  return report;
}

module.exports = { fetchMetaInsights, attachAds, matchBrand };
