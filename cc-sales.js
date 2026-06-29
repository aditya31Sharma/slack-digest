// Culture Circle (marketplace) sales adapter.
//
// Goal: return the SAME report shape as shopify-sales.fetchDigest so the dashboard
// renders Culture Circle data identically to Shopify data — just a different platform.
//
// ┌─────────────────────────────────────────────────────────────────────────────┐
// │  THE ONLY THING TO WIRE: fetchCCBrands(range)  (see below).                    │
// │  Until it returns data, /api/dashboard?platform=cc reports connected:false    │
// │  and the dashboard shows a clean "not connected yet" state (never breaks).     │
// └─────────────────────────────────────────────────────────────────────────────┘

const { resolveRange } = require('./shopify-sales');

// Each brand object the dashboard understands (ad fields optional):
//   {
//     key, brand, slug,
//     revenue, orders, aov, maxOrder, currency,
//     daily: { 'YYYY-MM-DD': { revenue, orders } },     // per-day, for trend charts
//     bestSeller: { title } | null,
//     topProducts: [ { title, qty, revenue } ],          // optional, top-5
//     sessions: number | null,                           // optional
//     // optional ad attribution (hidden if absent):
//     adSpend, adClicks, adImpr, roas, ctr, dailySpend, campaigns
//   }
//
// `range` = { from: Date|null, to: Date, label: string }  (IST window; from null = all-time)

async function fetchCCBrands(range) {
  // ===========================================================================
  // WIRE THE REAL CULTURE CIRCLE SOURCE HERE.
  // e.g. query the CC backend (Postgres / Django API) for sales + orders per brand
  // within [range.from, range.to), and map each into the brand object shape above.
  // Return `null` to signal "source not connected yet".
  //
  // Example skeleton once the source is known:
  //   const rows = await ccQuery(range.from, range.to);   // <- your source
  //   return rows.map(r => ({
  //     key: r.brandKey, brand: r.brandName, slug: r.brandKey.toLowerCase(),
  //     revenue: r.revenue, orders: r.orders, maxOrder: r.maxOrder,
  //     currency: 'INR', aov: r.orders ? r.revenue / r.orders : 0,
  //     daily: r.daily, bestSeller: r.bestSeller, topProducts: r.topProducts,
  //     sessions: r.sessions ?? null,
  //   }));
  // ===========================================================================
  return null;
}

// Builds the dashboard report for Culture Circle. Same shape the dashboard reads
// for Shopify; `platform` + `connected` let the UI label the mode and degrade
// gracefully before the source is wired.
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
  const hasAds = brands.some(b => (b.adSpend || 0) > 0);
  return { platform: 'cc', connected: true, range, brands, totals, dailyAll, ccy: 'INR', ads: { hasData: hasAds } };
}

function emptyTotals() { return { revenue: 0, orders: 0, maxOrder: 0, sessions: 0, sessionsKnown: false, aov: 0 }; }

module.exports = { fetchCCDigest, fetchCCBrands };
