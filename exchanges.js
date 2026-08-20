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
      if (ticker.volumeUsdt < minVolumeUsdt) continue;
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

module.exports = { EXCHANGES, computeBestSpread, scanAllCoins };
