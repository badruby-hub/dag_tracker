// Best-effort deep links to each exchange's futures trading page for a
// symbol. Exchanges change their URL structure occasionally — if a link
// ever 404s, this is the one place to fix it. Keep in sync with
// public/app.js's EXCHANGE_URL_BUILDERS (duplicated because the frontend
// has no bundler to share a module with the backend).
const EXCHANGE_URL_BUILDERS = {
  Bybit: (rawSymbol) => `https://www.bybit.com/trade/usdt/${rawSymbol}`,
  OKX: (rawSymbol) => `https://www.okx.com/trade-swap/${rawSymbol.toLowerCase()}`,
  Binance: (rawSymbol) => `https://www.binance.com/en/futures/${rawSymbol}`,
  Bitget: (rawSymbol) => `https://www.bitget.com/futures/usdt/${rawSymbol}`,
  'Gate.io': (rawSymbol) => `https://www.gate.io/futures_trade/USDT/${rawSymbol}`,
  MEXC: (rawSymbol) => `https://www.mexc.com/futures/${rawSymbol}`,
  KuCoin: (rawSymbol) => `https://www.kucoin.com/futures/trade/${rawSymbol}`,
  HTX: (rawSymbol) => `https://www.htx.com/en-us/futures/linear_swap/exchange/#contract_code=${rawSymbol}`,
  BingX: (rawSymbol) => `https://bingx.com/en/perpetual/${rawSymbol}`,
  ASTER: (rawSymbol) => `https://www.asterdex.com/en/futures/${rawSymbol}`,
  Ourbit: (rawSymbol) => `https://futures.ourbit.com/exchange/${rawSymbol}`,
  KCEX: (rawSymbol) => `https://www.kcex.com/futures/exchange/${rawSymbol}`,
  BitMart: (rawSymbol) => `https://www.bitmart.com/ru-RU/futures/${rawSymbol}`,
};

function buildExchangeUrl(exchange, rawSymbol) {
  const build = EXCHANGE_URL_BUILDERS[exchange];
  return build ? build(rawSymbol) : null;
}

module.exports = { EXCHANGE_URL_BUILDERS, buildExchangeUrl };
