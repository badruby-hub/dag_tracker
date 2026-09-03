require('dotenv').config();
const { getPairTick } = require('../exchanges');

// GET /api/pair-tick?buyExchange=...&buyRawSymbol=...&sellExchange=...&sellRawSymbol=...
// Polled every ~1s by the coin detail page while it's open. Only touches
// the two exchanges involved — NOT a full market scan — so a 1s interval
// here is cheap, unlike doing that with /api/prices.
module.exports = async (req, res) => {
  // Every tick has to be genuinely fresh — no CDN/edge/browser is allowed
  // to serve a cached copy of a "live" price.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  try {
    const { buyExchange, buyRawSymbol, sellExchange, sellRawSymbol } = req.query || {};
    if (!buyExchange || !buyRawSymbol || !sellExchange || !sellRawSymbol) {
      res.status(400).json({ ok: false, error: 'Missing required query params.' });
      return;
    }

    const tick = await getPairTick({ buyExchange, buyRawSymbol, sellExchange, sellRawSymbol });
    if (!tick) {
      res.status(404).json({ ok: false, error: 'Одна из бирж не вернула эту монету — возможно, пара пропала.' });
      return;
    }

    res.status(200).json({ ok: true, ...tick });
  } catch (err) {
    console.error('pair-tick failed', err);
    res.status(500).json({ ok: false, error: 'Не удалось обновить цены.' });
  }
};
