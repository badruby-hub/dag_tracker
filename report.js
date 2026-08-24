const config = require('./config');
const { scanAllCoins, EXCHANGES } = require('./exchanges');

const VALID_PAIR_MODES = ['all', 'futures-futures', 'spot-futures'];

// overrides.minVolumeUsdt / overrides.pairMode let the Mini App settings
// page (or any caller) use different filters than the .env default for a
// single request, without needing a server restart.
async function buildReport(overrides = {}) {
  const minVolumeUsdt =
    overrides.minVolumeUsdt !== undefined && overrides.minVolumeUsdt !== null
      ? overrides.minVolumeUsdt
      : config.minVolumeUsdt;

  const pairMode = VALID_PAIR_MODES.includes(overrides.pairMode) ? overrides.pairMode : 'all';

  const { results, failedExchanges, exchangeCount, suspicious } = await scanAllCoins(
    minVolumeUsdt,
    config.maxSaneSpreadPercent,
    pairMode
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
    minVolumeUsdt,
    pairMode,
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
