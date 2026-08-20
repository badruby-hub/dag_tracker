const config = require('./config');
const { scanAllCoins, EXCHANGES } = require('./exchanges');

async function buildReport() {
  const { results, failedExchanges, exchangeCount, suspicious } = await scanAllCoins(
    config.minVolumeUsdt,
    config.maxSaneSpreadPercent
  );

  const coins = results.map((r) => ({
    symbol: r.symbol,
    tickers: r.tickers, // every exchange this coin trades on, with bid/ask/last
    spread: r.spread,
    alert: r.spread.spreadPct >= config.threshold,
  }));

  const alertsCount = coins.filter((c) => c.alert).length;

  return {
    ok: true,
    threshold: config.threshold,
    minVolumeUsdt: config.minVolumeUsdt,
    maxSaneSpreadPercent: config.maxSaneSpreadPercent,
    totalScanned: coins.length,
    alertsCount,
    suspiciousCount: suspicious.length,
    exchangeCount,
    failedExchanges,
    exchanges: EXCHANGES.map((e) => e.name),
    coins,
    ts: Date.now(),
  };
}

module.exports = { buildReport };
