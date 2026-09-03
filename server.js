// Local/dev-only convenience server. Not used in production once the Mini
// App is on Vercel — kept so you can still run `node server.js` and open
// http://localhost:3000 to test the UI without deploying anything.
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { buildReport } = require('./report');
const { getPairTick, getPairHistory } = require('./exchanges');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/prices', async (req, res) => {
  try {
    const minVolumeParam = req.query?.minVolume;
    const minVolumeUsdt = minVolumeParam !== undefined ? parseFloat(minVolumeParam) : undefined;
    const pairMode = req.query?.pairMode;

    const report = await buildReport({ minVolumeUsdt, pairMode });
    res.json(report);
  } catch (err) {
    console.error('Failed to build report', err.message);
    res.status(500).json({ ok: false, error: 'Не удалось получить цены. Попробуй ещё раз.' });
  }
});

app.get('/api/pair-tick', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
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

    res.json({ ok: true, ...tick });
  } catch (err) {
    console.error('pair-tick failed', err.message);
    res.status(500).json({ ok: false, error: 'Не удалось обновить цены.' });
  }
});

app.get('/api/pair-history', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
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

    res.json({ ok: true, history: history || [] });
  } catch (err) {
    console.error('pair-history failed', err.message);
    res.status(500).json({ ok: false, error: 'Не удалось получить историю.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dev server running on http://localhost:${PORT}`));
