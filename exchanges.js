const axios = require('axios');

const HTTP_TIMEOUT_MS = 15000;

// A generic "axios/x.x.x" User-Agent is an easy fingerprint for bot-detection
// layers (separate from the regulatory geo-blocks that hit Vercel's US
// region). A realistic browser UA reduces false-positive blocks — it won't
// help against an actual regional restriction, but it costs nothing and
// helps with everything else.
const http = axios.create({
  timeout: HTTP_TIMEOUT_MS,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'application/json',
  },
});

// Some exchanges list a coin as "1000X" / "10000X" / "1000000X" instead of
// "X" when the real per-token price is too tiny to show nicely (e.g. Bybit's
// "1000PEPEUSDT" contract is priced per 1000 PEPE, not per 1 PEPE). If we
// don't undo this, comparing its raw price to a plain "PEPEUSDT" on another
// exchange produces a spread that's off by that exact multiplier — this is
// one of the ways a "huge fake spread" bug like the TROLL one shows up.
const MULTIPLIER_PREFIX = /^(1000000|100000|10000|1000)(?=[A-Z])/;

function splitMultiplier(rawBase) {
  const m = rawBase.match(MULTIPLIER_PREFIX);
  if (!m) return { base: rawBase, multiplier: 1 };
  return { base: rawBase.slice(m[1].length), multiplier: parseInt(m[1], 10) };
}

function makeTicker({ exchange, rawSymbol, last, bid, ask, volumeUsdt, fundingRate, market = 'futures' }) {
  if (!bid || !ask || !last) return null;
  const { base, multiplier } = splitMultiplier(rawSymbol.replace(/[-_]/g, ''));
  return {
    base,
    ticker: {
      exchange,
      rawSymbol,
      multiplier,
      market, // 'futures' | 'spot' — spot legs can only ever be the LONG side of a pair, see computeBestSpread/computeAllPairs
      last: last / multiplier,
      bid: bid / multiplier,
      ask: ask / multiplier,
      volumeUsdt,
      // Funding rate as a %, e.g. 0.01 means longs pay shorts 0.01% per
      // funding interval (usually every 8h, some exchanges do 1h/4h).
      // null when the exchange doesn't expose it in the bulk ticker call.
      fundingRatePct: fundingRate === null || fundingRate === undefined || Number.isNaN(fundingRate)
        ? null
        : fundingRate * 100,
    },
  };
}

/**
 * Bybit v5 — USDT perpetual futures (category=linear).
 * https://bybit-exchange.github.io/docs/v5/market/tickers
 */
async function getAllBybitTickers() {
  const { data } = await http.get('https://api.bybit.com/v5/market/tickers', {
    params: { category: 'linear' },
    timeout: HTTP_TIMEOUT_MS,
  });

  const map = new Map();
  for (const item of data?.result?.list || []) {
    // Dated futures contain a dash + expiry (e.g. BTC-26DEC25) — skip, we
    // only want the plain USDT perpetuals.
    if (!item.symbol?.endsWith('USDT') || item.symbol.includes('-')) continue;

    const entry = makeTicker({
      exchange: 'Bybit',
      rawSymbol: item.symbol,
      last: parseFloat(item.lastPrice),
      bid: parseFloat(item.bid1Price),
      ask: parseFloat(item.ask1Price),
      volumeUsdt: parseFloat(item.turnover24h) || 0,
      fundingRate: parseFloat(item.fundingRate),
    });
    if (entry) map.set(entry.base, entry.ticker);
  }
  return map;
}

/**
 * OKX — USDT-margined perpetual swaps (instType=SWAP).
 * https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-tickers
 */
async function getAllOkxTickers() {
  const { data } = await http.get('https://www.okx.com/api/v5/market/tickers', {
    params: { instType: 'SWAP' },
    timeout: HTTP_TIMEOUT_MS,
  });

  const map = new Map();
  for (const item of data?.data || []) {
    if (!item.instId?.endsWith('-USDT-SWAP')) continue; // skip USD/coin-margined
    const rawBase = item.instId.replace('-USDT-SWAP', '');

    const entry = makeTicker({
      exchange: 'OKX',
      rawSymbol: item.instId,
      last: parseFloat(item.last),
      bid: parseFloat(item.bidPx),
      ask: parseFloat(item.askPx),
      volumeUsdt: parseFloat(item.volCcy24h) || 0,
      fundingRate: null, // not in this endpoint — OKX only exposes it per-symbol, see README
    });
    if (entry) map.set(entry.base, entry.ticker);
  }
  return map;
}

/**
 * Binance Futures (USDT-M perpetuals). Needs THREE bulk endpoints combined —
 * bookTicker has bid/ask, 24hr stats has volume, premiumIndex has funding
 * rate. None of them include everything on their own.
 * https://binance-docs.github.io/apidocs/futures/en/#symbol-price-ticker
 */
async function getAllBinanceTickers() {
  const [bookRes, statsRes, premiumRes] = await Promise.all([
    http.get('https://fapi.binance.com/fapi/v1/ticker/bookTicker', {}),
    http.get('https://fapi.binance.com/fapi/v1/ticker/24hr', {}),
    http.get('https://fapi.binance.com/fapi/v1/premiumIndex', {}),
  ]);

  const volumeBySymbol = new Map();
  for (const item of statsRes.data || []) {
    volumeBySymbol.set(item.symbol, parseFloat(item.quoteVolume) || 0);
  }

  const fundingBySymbol = new Map();
  for (const item of premiumRes.data || []) {
    fundingBySymbol.set(item.symbol, parseFloat(item.lastFundingRate));
  }

  const map = new Map();
  for (const item of bookRes.data || []) {
    if (!item.symbol?.endsWith('USDT')) continue;

    const entry = makeTicker({
      exchange: 'Binance',
      rawSymbol: item.symbol,
      last: (parseFloat(item.bidPrice) + parseFloat(item.askPrice)) / 2, // no "last" in bookTicker
      bid: parseFloat(item.bidPrice),
      ask: parseFloat(item.askPrice),
      volumeUsdt: volumeBySymbol.get(item.symbol) || 0,
      fundingRate: fundingBySymbol.get(item.symbol),
    });
    if (entry) map.set(entry.base, entry.ticker);
  }
  return map;
}

/**
 * Bitget — USDT-M perpetual futures.
 * https://www.bitget.com/api-doc/contract/market/Get-Tickers
 */
async function getAllBitgetTickers() {
  const { data } = await http.get('https://api.bitget.com/api/v2/mix/market/tickers', {
    params: { productType: 'usdt-futures' },
    timeout: HTTP_TIMEOUT_MS,
  });

  const map = new Map();
  for (const item of data?.data || []) {
    if (!item.symbol?.endsWith('USDT')) continue;

    const entry = makeTicker({
      exchange: 'Bitget',
      rawSymbol: item.symbol,
      last: parseFloat(item.lastPr),
      bid: parseFloat(item.bidPr),
      ask: parseFloat(item.askPr),
      volumeUsdt: parseFloat(item.usdtVolume ?? item.quoteVolume) || 0,
      fundingRate: parseFloat(item.fundingRate),
    });
    if (entry) map.set(entry.base, entry.ticker);
  }
  return map;
}

/**
 * Gate.io — USDT-settled perpetual futures.
 * https://www.gate.io/docs/developers/apiv4/en/#futures-tickers
 */
async function getAllGateioTickers() {
  const { data } = await http.get('https://api.gateio.ws/api/v4/futures/usdt/tickers', {
    timeout: HTTP_TIMEOUT_MS,
  });

  const map = new Map();
  for (const item of data || []) {
    if (!item.contract?.endsWith('_USDT')) continue;

    const entry = makeTicker({
      exchange: 'Gate.io',
      rawSymbol: item.contract,
      last: parseFloat(item.last),
      bid: parseFloat(item.bid1_price),
      ask: parseFloat(item.ask1_price),
      volumeUsdt: parseFloat(item.volume_24h_quote) || 0,
    });
    if (entry) map.set(entry.base, entry.ticker);
  }
  return map;
}

/**
 * MEXC Futures (USDT-M perpetuals).
 * https://mexcdevelop.github.io/apidocs/contract_v1_en/#get-contract-ticker-information
 */
async function getAllMexcTickers() {
  const { data } = await http.get('https://contract.mexc.com/api/v1/contract/ticker', {
    timeout: HTTP_TIMEOUT_MS,
  });

  const map = new Map();
  for (const item of data?.data || []) {
    if (!item.symbol?.endsWith('_USDT')) continue;

    const entry = makeTicker({
      exchange: 'MEXC',
      rawSymbol: item.symbol,
      last: parseFloat(item.lastPrice),
      bid: parseFloat(item.bid1),
      ask: parseFloat(item.ask1),
      volumeUsdt: parseFloat(item.amount24) || 0,
      fundingRate: parseFloat(item.fundingRate),
    });
    if (entry) map.set(entry.base, entry.ticker);
  }
  return map;
}

/**
 * Ourbit Futures — same API shape as MEXC (contractId, symbol, lastPrice,
 * bid1, ask1, amount24, fundingRate). Confirmed live.
 */
async function getAllOurbitTickers() {
  const { data } = await http.get('https://futures.ourbit.com/api/v1/contract/ticker', {
    timeout: HTTP_TIMEOUT_MS,
  });

  const map = new Map();
  for (const item of data?.data || []) {
    if (!item.symbol?.endsWith('_USDT')) continue;

    const entry = makeTicker({
      exchange: 'Ourbit',
      rawSymbol: item.symbol,
      last: parseFloat(item.lastPrice),
      bid: parseFloat(item.bid1),
      ask: parseFloat(item.ask1),
      volumeUsdt: parseFloat(item.amount24) || 0,
      fundingRate: parseFloat(item.fundingRate),
    });
    if (entry) map.set(entry.base, entry.ticker);
  }
  return map;
}

/**
 * KCEX Futures — same API shape as MEXC/Ourbit. Confirmed live. Also lists
 * USDC-margined pairs (e.g. BTC_USDC) — filtered out, USDT only.
 */
async function getAllKcexTickers() {
  const { data } = await http.get('https://www.kcex.com/fapi/v1/contract/ticker', {
    timeout: HTTP_TIMEOUT_MS,
  });

  const map = new Map();
  for (const item of data?.data || []) {
    if (!item.symbol?.endsWith('_USDT')) continue;

    const entry = makeTicker({
      exchange: 'KCEX',
      rawSymbol: item.symbol,
      last: parseFloat(item.lastPrice),
      bid: parseFloat(item.bid1),
      ask: parseFloat(item.ask1),
      volumeUsdt: parseFloat(item.amount24) || 0,
      fundingRate: parseFloat(item.fundingRate),
    });
    if (entry) map.set(entry.base, entry.ticker);
  }
  return map;
}

/**
 * BitMart Futures. Confirmed live, but this "details" endpoint has no
 * separate bid/ask — only last_price. We use last_price for both sides,
 * which means BitMart's contribution to a spread calc doesn't reflect a
 * real bid/ask cost the way the other exchanges do (slightly optimistic).
 * Also filters out delisted contracts (status must be "Trading").
 *
 * This approximation can be badly wrong on thin/illiquid contracts — see
 * getRealBitMartDepth() below, which double-checks the shortlisted coins
 * against BitMart's real order book before anything is shown as an alert.
 */
async function getAllBitMartTickers() {
  const { data } = await http.get('https://api-cloud-v2.bitmart.com/contract/public/details', {
    timeout: HTTP_TIMEOUT_MS,
  });

  const map = new Map();
  for (const item of data?.data?.symbols || []) {
    if (item.quote_currency !== 'USDT' || item.status !== 'Trading') continue;

    const last = parseFloat(item.last_price);
    const entry = makeTicker({
      exchange: 'BitMart',
      rawSymbol: item.symbol,
      last,
      bid: last,
      ask: last,
      volumeUsdt: parseFloat(item.turnover_24h) || 0,
      fundingRate: parseFloat(item.funding_rate),
    });
    if (entry) {
      entry.ticker.approximated = true; // bid/ask = last_price until enrichBitMartFinalists checks the real book
      map.set(entry.base, entry.ticker);
    }
  }
  return map;
}

/**
 * BitMart's real order book for one contract — used only as a targeted
 * follow-up check (see enrichBitMartFinalists), NOT for the initial bulk
 * scan: this is per-symbol and rate-limited to 12 req/2s, so calling it for
 * every BitMart contract (700+) isn't viable.
 * https://developer-pro.bitmart.com/en/futures/#get-market-depth
 */
async function getRealBitMartDepth(rawSymbol) {
  const { data } = await http.get('https://api-cloud-v2.bitmart.com/contract/public/depth', {
    params: { symbol: rawSymbol },
    timeout: HTTP_TIMEOUT_MS,
  });

  const bestBid = data?.data?.bids?.[0]?.[0]; // bids sorted descending — [0] is the highest
  const bestAsk = data?.data?.asks?.[0]?.[0]; // asks sorted ascending — [0] is the lowest
  if (!bestBid || !bestAsk) return null;

  return { bid: parseFloat(bestBid), ask: parseFloat(bestAsk) };
}

/**
 * BitMart's ticker approximation (bid = ask = last_price) can make a coin
 * with a nearly-empty order book look like a juicy arbitrage opportunity
 * when it's really just illiquid — the real best bid can sit far below the
 * last traded price (exactly what a thin, barely-traded contract looks
 * like). Before anything is shown as an alert, re-check the handful of
 * coins where BitMart is on one side of the winning pair against its real
 * order book, and recompute the honest spread.
 *
 * Bounded to maxChecks so we never come close to BitMart's 12 req/2s rate
 * limit even if dozens of coins would otherwise qualify.
 */
async function enrichBitMartFinalists(results, maxSaneSpreadPct, pairMode = 'all', maxChecks = 15) {
  const candidates = results
    .filter((r) => r.spread.buyExchange === 'BitMart' || r.spread.sellExchange === 'BitMart')
    .slice(0, maxChecks);

  await Promise.all(
    candidates.map(async (r) => {
      const bmTicker = r.tickers.find((t) => t.exchange === 'BitMart');
      if (!bmTicker) return;
      try {
        const real = await getRealBitMartDepth(bmTicker.rawSymbol);
        if (!real) return;
        bmTicker.bid = real.bid / bmTicker.multiplier;
        bmTicker.ask = real.ask / bmTicker.multiplier;
        bmTicker.approximated = false;
      } catch {
        // Depth fetch failed (rate limit, delisted mid-scan, etc) — leave
        // the last_price approximation in place rather than breaking the scan.
      }
    })
  );

  // Recompute spread for every coin we touched — the real book might not
  // even involve BitMart in the winning pair anymore, or might no longer
  // clear the sanity threshold at all.
  const stillSane = [];
  const nowSuspicious = [];
  for (const r of candidates) {
    r.spread = computeBestSpread(r.tickers, pairMode);
    if (!r.spread) continue;
    if (r.spread.spreadPct > maxSaneSpreadPct) {
      nowSuspicious.push({ symbol: r.symbol, spread: r.spread });
    } else {
      stillSane.push(r);
    }
  }

  const candidateSymbols = new Set(candidates.map((r) => r.symbol));
  const untouched = results.filter((r) => !candidateSymbols.has(r.symbol));
  const merged = [...untouched, ...stillSane].sort((a, b) => b.spread.spreadPct - a.spread.spreadPct);

  return { results: merged, newlySuspicious: nowSuspicious };
}

/**
 * KuCoin Futures — USDT-M perpetuals.
 * https://www.kucoin.com/docs-new/rest/futures-trading/market-data/get-all-tickers
 * NOTE: this endpoint doesn't include 24h volume or funding rate, only
 * price/bid/ask. volumeUsdt is left null — scanAllCoins treats a null
 * volume as "unknown, don't filter out" rather than as zero.
 */
async function getAllKuCoinTickers() {
  const { data } = await http.get('https://api-futures.kucoin.com/api/v1/allTickers', {});

  const map = new Map();
  for (const item of data?.data || []) {
    if (!item.symbol?.endsWith('USDTM')) continue; // USDT-margined perpetuals end in "M"
    const rawBase = item.symbol.slice(0, -5); // strip "USDTM"
    // KuCoin uses "XBT" for Bitcoin instead of "BTC" — normalize so it
    // matches the same coin on every other exchange.
    const normalizedSymbol = rawBase === 'XBT' ? 'BTCUSDTM' : item.symbol;

    const entry = makeTicker({
      exchange: 'KuCoin',
      rawSymbol: item.symbol,
      last: parseFloat(item.price),
      bid: parseFloat(item.bestBidPrice),
      ask: parseFloat(item.bestAskPrice),
      volumeUsdt: null,
      fundingRate: null,
    });
    if (entry) {
      if (rawBase === 'XBT') entry.base = 'BTC';
      map.set(entry.base, entry.ticker);
    }
  }
  return map;
}

/**
 * HTX (Huobi) — USDT-margined linear swaps.
 * Bulk endpoint: /linear-swap-ex/market/detail/batch_merged
 * Field names here are best-effort from HTX's general "merged tick" shape
 * (ask/bid as [price, size] pairs) — if this exchange ever shows nothing,
 * check the raw response shape first, HTX has changed field names before.
 */
async function getAllHtxTickers() {
  const { data } = await http.get('https://api.hbdm.com/linear-swap-ex/market/detail/batch_merged', {});

  const map = new Map();
  for (const item of data?.ticks || data?.data || []) {
    const contractCode = item.contract_code; // e.g. "BTC-USDT"
    if (!contractCode?.endsWith('-USDT')) continue;

    const bid = Array.isArray(item.bid) ? parseFloat(item.bid[0]) : parseFloat(item.bid);
    const ask = Array.isArray(item.ask) ? parseFloat(item.ask[0]) : parseFloat(item.ask);

    const entry = makeTicker({
      exchange: 'HTX',
      rawSymbol: contractCode,
      last: parseFloat(item.close),
      bid,
      ask,
      volumeUsdt: parseFloat(item.trade_turnover) || 0,
      fundingRate: null,
    });
    if (entry) map.set(entry.base, entry.ticker);
  }
  return map;
}

/**
 * BingX — USDT-M perpetual swaps, 24hr ticker (includes bid/ask/volume together).
 * https://bingx-api.github.io/docs/#/swapV2/market-api.html
 */
async function getAllBingxTickers() {
  const { data } = await http.get('https://open-api.bingx.com/openApi/swap/v2/quote/ticker', {});

  const map = new Map();
  for (const item of data?.data || []) {
    if (!item.symbol?.endsWith('-USDT')) continue;

    const entry = makeTicker({
      exchange: 'BingX',
      rawSymbol: item.symbol,
      last: parseFloat(item.lastPrice),
      bid: parseFloat(item.bidPrice),
      ask: parseFloat(item.askPrice),
      volumeUsdt: parseFloat(item.quoteVolume) || 0,
      fundingRate: null,
    });
    if (entry) map.set(entry.base, entry.ticker);
  }
  return map;
}

/**
 * Aster (ASTER) — a perp DEX whose API is intentionally Binance-compatible,
 * same endpoints/field names, just a different base URL.
 * https://github.com/asterdex/api-docs
 */
async function getAllAsterTickers() {
  const [bookRes, statsRes] = await Promise.all([
    http.get('https://fapi.asterdex.com/fapi/v1/ticker/bookTicker', {}),
    http.get('https://fapi.asterdex.com/fapi/v1/ticker/24hr', {}),
  ]);

  const volumeBySymbol = new Map();
  for (const item of statsRes.data || []) {
    volumeBySymbol.set(item.symbol, parseFloat(item.quoteVolume) || 0);
  }

  const map = new Map();
  for (const item of bookRes.data || []) {
    if (!item.symbol?.endsWith('USDT')) continue;

    const entry = makeTicker({
      exchange: 'ASTER',
      rawSymbol: item.symbol,
      last: (parseFloat(item.bidPrice) + parseFloat(item.askPrice)) / 2,
      bid: parseFloat(item.bidPrice),
      ask: parseFloat(item.askPrice),
      volumeUsdt: volumeBySymbol.get(item.symbol) || 0,
      fundingRate: null,
    });
    if (entry) map.set(entry.base, entry.ticker);
  }
  return map;
}

/**
 * BitMart SPOT — real bid/ask in this one (unlike the futures ticker
 * above), and for a lot of small-cap coins the spot market is far more
 * liquid than the futures listing. Response is a positional array, not
 * objects with named keys — see the index map below.
 * https://developer-pro.bitmart.com/en/spot/#get-ticker-of-all-pairs-v3
 */
async function getAllBitMartSpotTickers() {
  const { data } = await http.get('https://api-cloud.bitmart.com/spot/quotation/v3/tickers', {
    timeout: HTTP_TIMEOUT_MS,
  });

  // [symbol, last, v_24h, qv_24h, open_24h, high_24h, low_24h, fluctuation, bid_px, bid_sz, ask_px, ask_sz, ts]
  const IDX = { symbol: 0, last: 1, qv24h: 3, bidPx: 8, askPx: 10 };

  const map = new Map();
  for (const row of data?.data || []) {
    const symbol = row[IDX.symbol];
    if (!symbol?.endsWith('_USDT')) continue;

    const entry = makeTicker({
      exchange: 'BitMart Spot',
      rawSymbol: symbol,
      last: parseFloat(row[IDX.last]),
      bid: parseFloat(row[IDX.bidPx]),
      ask: parseFloat(row[IDX.askPx]),
      volumeUsdt: parseFloat(row[IDX.qv24h]) || 0,
      fundingRate: null, // spot has no funding rate
      market: 'spot',
    });
    if (entry) map.set(entry.base, entry.ticker);
  }
  return map;
}

/**
 * Gate.io SPOT — real bid/ask (lowest_ask / highest_bid), confirmed live.
 * https://www.gate.io/docs/developers/apiv4/en/#retrieve-ticker-information
 */
async function getAllGateioSpotTickers() {
  const { data } = await http.get('https://api.gateio.ws/api/v4/spot/tickers', { timeout: HTTP_TIMEOUT_MS });

  const map = new Map();
  for (const item of data || []) {
    if (!item.currency_pair?.endsWith('_USDT')) continue;

    const entry = makeTicker({
      exchange: 'Gate.io Spot',
      rawSymbol: item.currency_pair,
      last: parseFloat(item.last),
      bid: parseFloat(item.highest_bid),
      ask: parseFloat(item.lowest_ask),
      volumeUsdt: parseFloat(item.quote_volume) || 0,
      fundingRate: null,
      market: 'spot',
    });
    if (entry) map.set(entry.base, entry.ticker);
  }
  return map;
}

/**
 * HTX SPOT — real bid/ask, confirmed live. Symbols are lowercase with no
 * separator (e.g. "btcusdt"), unlike HTX's futures contract_code format.
 * https://huobiapi.github.io/docs/spot/v1/en/#get-latest-tickers-for-all-pairs
 */
async function getAllHtxSpotTickers() {
  const { data } = await http.get('https://api.huobi.pro/market/tickers', { timeout: HTTP_TIMEOUT_MS });

  const map = new Map();
  for (const item of data?.data || []) {
    if (!item.symbol?.endsWith('usdt')) continue;

    const entry = makeTicker({
      exchange: 'HTX Spot',
      rawSymbol: item.symbol.toUpperCase(),
      last: parseFloat(item.close),
      bid: parseFloat(item.bid),
      ask: parseFloat(item.ask),
      volumeUsdt: parseFloat(item.vol) || 0, // 'vol' is quote-currency volume on Huobi/HTX, 'amount' is base
      fundingRate: null,
      market: 'spot',
    });
    if (entry) map.set(entry.base, entry.ticker);
  }
  return map;
}

/**
 * BingX SPOT. Endpoint confirmed live via BingX docs, but exact field
 * names here are inferred from BingX's own futures ticker convention
 * (same team, same API style) rather than a directly-sighted spot sample —
 * slightly lower confidence than the other three additions in this block.
 * If this comes back empty, check the raw response shape first.
 * https://bingx-api.github.io/docs/#/spot/market-api.html
 */
async function getAllBingxSpotTickers() {
  const { data } = await http.get('https://open-api.bingx.com/openApi/spot/v1/ticker/24hr', {
    timeout: HTTP_TIMEOUT_MS,
  });

  const map = new Map();
  for (const item of data?.data || []) {
    if (!item.symbol?.endsWith('-USDT')) continue;

    const entry = makeTicker({
      exchange: 'BingX Spot',
      rawSymbol: item.symbol,
      last: parseFloat(item.lastPrice ?? item.trades),
      bid: parseFloat(item.bidPrice),
      ask: parseFloat(item.askPrice),
      volumeUsdt: parseFloat(item.quoteVolume) || 0,
      fundingRate: null,
      market: 'spot',
    });
    if (entry) map.set(entry.base, entry.ticker);
  }
  return map;
}

/**
 * KuCoin SPOT — real bid/ask (buy/sell fields), confirmed live via official docs.
 * https://www.kucoin.com/docs-new/rest/spot-trading/market-data/get-all-tickers
 */
async function getAllKuCoinSpotTickers() {
  const { data } = await http.get('https://api.kucoin.com/api/v1/market/allTickers', {
    timeout: HTTP_TIMEOUT_MS,
  });

  const map = new Map();
  for (const item of data?.data?.ticker || []) {
    if (!item.symbol?.endsWith('-USDT')) continue;

    const entry = makeTicker({
      exchange: 'KuCoin Spot',
      rawSymbol: item.symbol,
      last: parseFloat(item.last),
      bid: parseFloat(item.buy),
      ask: parseFloat(item.sell),
      volumeUsdt: parseFloat(item.volValue) || 0,
      fundingRate: null,
      market: 'spot',
    });
    if (entry) {
      if (item.symbol === 'XBT-USDT') entry.base = 'BTC'; // KuCoin spot also uses XBT for Bitcoin
      map.set(entry.base, entry.ticker);
    }
  }
  return map;
}

const EXCHANGES = [
  { name: 'Bybit', fetch: getAllBybitTickers },
  { name: 'OKX', fetch: getAllOkxTickers },
  { name: 'Binance', fetch: getAllBinanceTickers },
  { name: 'Bitget', fetch: getAllBitgetTickers },
  { name: 'Gate.io', fetch: getAllGateioTickers },
  { name: 'MEXC', fetch: getAllMexcTickers },
  { name: 'KuCoin', fetch: getAllKuCoinTickers },
  { name: 'HTX', fetch: getAllHtxTickers },
  // 'HTX Spot' отключён: подтверждено на практике, что HTX не сразу убирает
  // делистнутые пары из /market/tickers — тикер продолжает "тикать" живой
  // ценой даже для монет, которых на самом деле уже нет на споте (пример:
  // ZEC/USDT — цена в фиде была реальной и совпадала со страницей HTX, но
  // монеты физически нет в списке спот-торговли). Наличие в тикер-фиде не
  // гарантирует, что пара реально торгуется — нужен отдельный запрос
  // статуса символа (что-то вроде "Get all Supported Trading Symbol"), но
  // я не смог найти точное имя нужного поля с уверенностью. Пока честнее
  // не показывать это как факт, чем показывать потенциально мёртвые пары.
  // { name: 'HTX Spot', fetch: getAllHtxSpotTickers },
  { name: 'BingX', fetch: getAllBingxTickers },
  { name: 'ASTER', fetch: getAllAsterTickers },
  { name: 'Ourbit', fetch: getAllOurbitTickers },
  { name: 'KCEX', fetch: getAllKcexTickers },
  { name: 'BitMart', fetch: getAllBitMartTickers },
  { name: 'BitMart Spot', fetch: getAllBitMartSpotTickers },
  { name: 'Gate.io Spot', fetch: getAllGateioSpotTickers },
  { name: 'HTX Spot', fetch: getAllHtxSpotTickers },
  { name: 'BingX Spot', fetch: getAllBingxSpotTickers },
  { name: 'KuCoin Spot', fetch: getAllKuCoinSpotTickers },
];

function computeBestSpread(tickers, pairMode = 'all') {
  if (tickers.length < 2) return null;

  let best = null;
  for (const buyOn of tickers) {
    for (const sellOn of tickers) {
      if (buyOn === sellOn) continue;
      // The short/sell leg has to be a real position you can open without
      // already owning the coin — that means futures. Spot can only ever
      // be the long leg (you buy it outright, no borrowing modeled here).
      if (sellOn.market !== 'futures') continue;
      // pairMode narrows what the LONG leg is allowed to be:
      //   'all'             — no restriction (spot or futures)
      //   'futures-futures' — long leg must also be futures
      //   'spot-futures'    — long leg must be spot
      if (pairMode === 'futures-futures' && buyOn.market !== 'futures') continue;
      if (pairMode === 'spot-futures' && buyOn.market !== 'spot') continue;
      if (!buyOn.ask || !sellOn.bid) continue;
      const spreadPct = ((sellOn.bid - buyOn.ask) / buyOn.ask) * 100;
      if (!best || spreadPct > best.spreadPct) {
        best = {
          buyExchange: buyOn.exchange,
          buyPrice: buyOn.ask,
          buyRawSymbol: buyOn.rawSymbol,
          buyMarket: buyOn.market,
          sellExchange: sellOn.exchange,
          sellPrice: sellOn.bid,
          sellRawSymbol: sellOn.rawSymbol,
          sellMarket: sellOn.market,
          spreadPct,
        };
      }
    }
  }
  return best;
}

/**
 * Like computeBestSpread, but returns EVERY profitable unique exchange-pair
 * combination for a coin (not just the best one), sorted by spread
 * descending. Used for the "all pairs for this coin" views (coin picker
 * detail, cards mode, bot alert messages).
 */
function computeAllPairs(tickers, pairMode = 'all') {
  const pairs = [];
  const buyAllowed = (t) => {
    if (pairMode === 'futures-futures') return t.market === 'futures';
    if (pairMode === 'spot-futures') return t.market === 'spot';
    return true;
  };

  for (let i = 0; i < tickers.length; i++) {
    for (let j = i + 1; j < tickers.length; j++) {
      const a = tickers[i];
      const b = tickers[j];
      // Same rule as computeBestSpread: only a futures ticker can be the
      // sell/short leg, and pairMode narrows which market the long leg
      // must be.
      const spreadAB = b.market === 'futures' && buyAllowed(a) && a.ask && b.bid ? ((b.bid - a.ask) / a.ask) * 100 : null;
      const spreadBA = a.market === 'futures' && buyAllowed(b) && b.ask && a.bid ? ((a.bid - b.ask) / b.ask) * 100 : null;

      if (spreadAB !== null && (spreadBA === null || spreadAB >= spreadBA)) {
        pairs.push({
          buyExchange: a.exchange,
          buyPrice: a.ask,
          buyTicker: a,
          sellExchange: b.exchange,
          sellPrice: b.bid,
          sellTicker: b,
          spreadPct: spreadAB,
        });
      } else if (spreadBA !== null) {
        pairs.push({
          buyExchange: b.exchange,
          buyPrice: b.ask,
          buyTicker: b,
          sellExchange: a.exchange,
          sellPrice: a.bid,
          sellTicker: a,
          spreadPct: spreadBA,
        });
      }
    }
  }
  pairs.sort((x, y) => y.spreadPct - x.spreadPct);
  return pairs;
}

/**
 * Scans perpetual futures across every configured exchange and returns
 * every coin that trades on 2+ of them, with its best spread.
 *
 * maxSaneSpreadPct guards against a very real failure mode: two exchanges
 * listing an unrelated coin under the same ticker (extremely common with
 * meme coins — tickers aren't globally unique). A "spread" of thousands of
 * percent is never a real arbitrage opportunity; it means the two sides
 * aren't actually the same asset, or one side's book is broken/stale. Those
 * are dropped rather than shown.
 */
async function scanAllCoins(minVolumeUsdt = 0, maxSaneSpreadPct = 50, pairMode = 'all') {
  const settled = await Promise.allSettled(EXCHANGES.map((e) => e.fetch()));

  const failedExchanges = [];
  const perCoin = new Map();

  settled.forEach((outcome, i) => {
    const exchangeName = EXCHANGES[i].name;
    if (outcome.status !== 'fulfilled') {
      failedExchanges.push(exchangeName);
      return;
    }
    for (const [base, ticker] of outcome.value) {
      // null volume = exchange doesn't report it (e.g. KuCoin) — don't
      // filter it out for that, only filter when we KNOW it's too thin.
      if (ticker.volumeUsdt !== null && ticker.volumeUsdt < minVolumeUsdt) continue;
      if (!perCoin.has(base)) perCoin.set(base, []);
      perCoin.get(base).push(ticker);
    }
  });

  const results = [];
  const suspicious = [];
  for (const [base, tickers] of perCoin) {
    if (tickers.length < 2) continue;
    const spread = computeBestSpread(tickers, pairMode);
    if (!spread) continue;

    if (spread.spreadPct > maxSaneSpreadPct) {
      suspicious.push({ symbol: base, spread });
      continue;
    }
    results.push({ symbol: base, tickers, spread });
  }

  results.sort((a, b) => b.spread.spreadPct - a.spread.spreadPct);

  // Before returning, double-check the top BitMart-involved candidates
  // against its real order book — see enrichBitMartFinalists for why.
  const { results: verifiedResults, newlySuspicious } = await enrichBitMartFinalists(
    results,
    maxSaneSpreadPct,
    pairMode
  );
  suspicious.push(...newlySuspicious);

  return { results: verifiedResults, failedExchanges, exchangeCount: EXCHANGES.length, suspicious };
}

module.exports = { EXCHANGES, computeBestSpread, computeAllPairs, scanAllCoins };
