// Culture Circle (marketplace) sales adapter.
//
// Returns the SAME report shape as shopify-sales.fetchDigest so the dashboard
// renders Culture Circle data identically to Shopify — a different platform.
//
// Data source: Culture Circle GraphQL API (api.culture-circle.com/graphql).
// The 16 D2C brands live on CC as PRODUCT brands (variant.product.brandName),
// so we pull each brand's paid orders for the range and aggregate.
//
// Auth: a long-lived refresh token (CC_REFRESH_TOKEN env) is exchanged for a
// short-lived access token via the `refreshToken` mutation on each fetch.
// NOTE: the API's WAF returns 403 to non-browser User-Agents — always send a
// browser UA header.

const { resolveRange } = require('./shopify-sales');

const CC_API = 'https://api.culture-circle.com/graphql';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Shopify brand key -> Culture Circle product brandName (exact).
const BRAND_MAP = {
  '24SONGS': '24Songs',
  ALANKOCH: 'Alan Koch',
  ALICEMEYERS: 'Alice Meyers',
  BE_AUTYST: 'Be Autyst',
  BLACKLISTCO: 'Blacklist Co',
  CITYOFDOMES: 'City of Domes',
  COMOATELIER: 'Como Atelier',
  ELARAVOSS: 'Elara Voss',
  FORFKSAKE: 'forfksake',
  GYMBRAT: 'Gymbrat',
  KAAND: 'Kaand',
  MYUGEN: 'Myugen',
  OFF_SUPPLY: 'Off Supply',
  PIEREERIC: 'House of Piere Eric',
  SMILINGCAT: 'Smiling Cat',
  VOYD: 'Voyd',
};

async function ccGraphQL(query, variables, token) {
  const res = await fetch(CC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA, // WAF blocks non-browser UAs with 403
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  if (!res.ok) throw new Error(`cc_http_${res.status}`);
  const j = await res.json();
  if (j.errors) throw new Error('cc_gql: ' + (j.errors[0]?.message || 'error'));
  return j.data;
}

// Exchange the stored refresh token for a fresh access token.
async function ccAccessToken() {
  const rt = process.env.CC_REFRESH_TOKEN;
  if (!rt) return null;
  const data = await ccGraphQL(
    'mutation($r: String!) { refreshToken(refreshToken: $r) { token } }',
    { r: rt },
  );
  return data?.refreshToken?.token || null;
}

const istDay = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

// Paginate one brand's paid orders in [gte, lte) and aggregate.
async function fetchBrandOrders(brandName, gte, lte, token) {
  const q = `query CCBrandOrders($brand: String!, $gte: DateTime!, $lte: DateTime!, $after: String) {
    allOrders(first: 100, after: $after, filters: {
      variant: { product: { brandName: { exact: $brand } } }
      masterOrder: { isPaid: { exact: true }, createdAt: { gte: $gte, lte: $lte } }
      NOT: { status: { inList: ["refunded", "alt_cancelled"] } }
    }) {
      pageInfo { hasNextPage endCursor }
      edges { node { amount masterOrder { createdAt } } }
    }
  }`;
  let after = null, guard = 0;
  let revenue = 0, orders = 0, maxOrder = 0;
  const daily = {};
  while (guard++ < 40) {
    const data = await ccGraphQL(q, { brand: brandName, gte, lte, after }, token);
    const conn = data?.allOrders;
    for (const e of (conn?.edges || [])) {
      const amt = parseFloat(e.node?.amount || 0) || 0;
      const created = e.node?.masterOrder?.createdAt;
      if (!created) continue;
      revenue += amt; orders++; if (amt > maxOrder) maxOrder = amt;
      const day = istDay(created);
      daily[day] = daily[day] || { revenue: 0, orders: 0 };
      daily[day].revenue += amt; daily[day].orders++;
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return { revenue, orders, maxOrder, daily, aov: orders ? revenue / orders : 0 };
}

async function fetchCCBrands(range) {
  const token = await ccAccessToken();
  if (!token) return null; // no CC_REFRESH_TOKEN -> "not connected"

  const gte = (range && range.from ? range.from : new Date('2020-01-01')).toISOString();
  const lte = (range && range.to ? range.to : new Date()).toISOString();

  const keys = Object.keys(BRAND_MAP);
  const out = new Array(keys.length);
  const LIMIT = 4; let i = 0;
  async function worker() {
    while (i < keys.length) {
      const idx = i++; const key = keys[idx]; const brandName = BRAND_MAP[key];
      try {
        const m = await fetchBrandOrders(brandName, gte, lte, token);
        out[idx] = {
          key, brand: brandName, slug: key.toLowerCase(),
          revenue: m.revenue, orders: m.orders, maxOrder: m.maxOrder, aov: m.aov,
          currency: 'INR', daily: m.daily, sessions: null, bestSeller: null, topProducts: [],
        };
      } catch (e) {
        out[idx] = { key, brand: brandName, slug: key.toLowerCase(), revenue: 0, orders: 0, maxOrder: 0, aov: 0, currency: 'INR', daily: {}, sessions: null, bestSeller: null, topProducts: [], error: e.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(LIMIT, keys.length) }, worker));
  return out.filter(Boolean);
}

// Builds the dashboard report for Culture Circle (same shape as Shopify).
async function fetchCCDigest({ range } = {}) {
  range = range || resolveRange('yesterday');
  let brands;
  try { brands = await fetchCCBrands(range); }
  catch (e) { return { platform: 'cc', connected: false, error: e.message, range, brands: [], totals: emptyTotals(), dailyAll: {}, ccy: 'INR', ads: { hasData: false } }; }

  if (!brands || !brands.length) {
    return { platform: 'cc', connected: false, range, brands: [], totals: emptyTotals(), dailyAll: {}, ccy: 'INR', ads: { hasData: false } };
  }

  brands.sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
  const totals = emptyTotals();
  const dailyAll = {};
  for (const b of brands) {
    totals.revenue += b.revenue || 0; totals.orders += b.orders || 0;
    totals.maxOrder = Math.max(totals.maxOrder, b.maxOrder || 0);
    if (b.sessions != null) { totals.sessions += b.sessions; totals.sessionsKnown = true; }
    for (const [d, v] of Object.entries(b.daily || {})) {
      dailyAll[d] = dailyAll[d] || { revenue: 0, orders: 0 };
      dailyAll[d].revenue += v.revenue || 0; dailyAll[d].orders += v.orders || 0;
    }
  }
  totals.aov = totals.orders ? totals.revenue / totals.orders : 0;
  return { platform: 'cc', connected: true, range, brands, totals, dailyAll, ccy: 'INR', ads: { hasData: false } };
}

function emptyTotals() { return { revenue: 0, orders: 0, maxOrder: 0, sessions: 0, sessionsKnown: false, aov: 0 }; }

module.exports = { fetchCCDigest, fetchCCBrands };
