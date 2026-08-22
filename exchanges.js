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

function makeTicker({ exchange, rawSymbol, last, bid, ask, volumeUsdt, fundingRate }) {
  if (!bid || !ask || !last) return null;
  const { base, multiplier } = splitMultiplier(rawSymbol.replace(/[-_]/g, ''));
  return {
    base,
    ticker: {
      exchange,
      rawSymbol,
      multiplier,
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
    if (entry) map.set(entry.base, entry.ticker);
  }
  return map;
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

const EXCHANGES = [
  { name: 'Bybit', fetch: getAllBybitTickers },
  { name: 'OKX', fetch: getAllOkxTickers },
  { name: 'Binance', fetch: getAllBinanceTickers },
  { name: 'Bitget', fetch: getAllBitgetTickers },
  { name: 'Gate.io', fetch: getAllGateioTickers },
  { name: 'MEXC', fetch: getAllMexcTickers },
  { name: 'KuCoin', fetch: getAllKuCoinTickers },
  { name: 'HTX', fetch: getAllHtxTickers },
  { name: 'BingX', fetch: getAllBingxTickers },
  { name: 'ASTER', fetch: getAllAsterTickers },
  { name: 'Ourbit', fetch: getAllOurbitTickers },
  { name: 'KCEX', fetch: getAllKcexTickers },
  { name: 'BitMart', fetch: getAllBitMartTickers },
];

function computeBestSpread(tickers) {
  if (tickers.length < 2) return null;

  let best = null;
  for (const buyOn of tickers) {
    for (const sellOn of tickers) {
      if (buyOn === sellOn) continue;
      if (!buyOn.ask || !sellOn.bid) continue;
      const spreadPct = ((sellOn.bid - buyOn.ask) / buyOn.ask) * 100;
      if (!best || spreadPct > best.spreadPct) {
        best = {
          buyExchange: buyOn.exchange,
          buyPrice: buyOn.ask,
          buyRawSymbol: buyOn.rawSymbol,
          sellExchange: sellOn.exchange,
          sellPrice: sellOn.bid,
          sellRawSymbol: sellOn.rawSymbol,
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
function computeAllPairs(tickers) {
  const pairs = [];
  for (let i = 0; i < tickers.length; i++) {
    for (let j = i + 1; j < tickers.length; j++) {
      const a = tickers[i];
      const b = tickers[j];
      const spreadAB = a.ask && b.bid ? ((b.bid - a.ask) / a.ask) * 100 : null;
      const spreadBA = b.ask && a.bid ? ((a.bid - b.ask) / b.ask) * 100 : null;

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
async function scanAllCoins(minVolumeUsdt = 0, maxSaneSpreadPct = 50) {
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
    const spread = computeBestSpread(tickers);
    if (!spread) continue;

    if (spread.spreadPct > maxSaneSpreadPct) {
      suspicious.push({ symbol: base, spread });
      continue;
    }
    results.push({ symbol: base, tickers, spread });
  }

  results.sort((a, b) => b.spread.spreadPct - a.spread.spreadPct);
  return { results, failedExchanges, exchangeCount: EXCHANGES.length, suspicious };
}

module.exports = { EXCHANGES, computeBestSpread, computeAllPairs, scanAllCoins };
