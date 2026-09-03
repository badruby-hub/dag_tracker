require('dotenv').config();
const { getPairHistory } = require('../exchanges');

// GET /api/pair-history?buyExchange=...&buyRawSymbol=...&sellExchange=...&sellRawSymbol=...&minutes=60
// Called ONCE when the coin detail page opens, to pre-populate the chart
// with real history pulled straight from each exchange's own candles —
// no background collection process needed.
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  try {
    const { buyExchange, buyRawSymbol, sellExchange, sellRawSymbol, minutes } = req.query || {};
    if (!buyExchange || !buyRawSymbol || !sellExchange || !sellRawSymbol) {
      res.status(400).json({ ok: false, error: 'Missing required query params.' });
      return;
    }

    const history = await getPairHistory({
      buyExchange,
      buyRawSymbol,
      sellExchange,
      sellRawSymbol,
      minutes: minutes ? parseInt(minutes, 10) : 60,
    });

    // null just means "not covered / not available" — not an error, the
    // frontend handles this by starting the live chart from scratch.
    res.status(200).json({ ok: true, history: history || [] });
  } catch (err) {
    console.error('pair-history failed', err);
    res.status(500).json({ ok: false, error: 'Не удалось получить историю.' });
  }
};
