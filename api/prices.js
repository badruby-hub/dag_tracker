require('dotenv').config();
const { buildReport } = require('../report');

// Vercel Node.js serverless function: this file at /api/prices.js is
// automatically exposed at the URL path /api/prices — no extra routing
// config needed. Optional ?minVolume=1000000 and ?pairMode=futures-futures
// let the Mini App settings page override defaults per-request.
module.exports = async (req, res) => {
  try {
    const minVolumeParam = req.query?.minVolume;
    const minVolumeUsdt = minVolumeParam !== undefined ? parseFloat(minVolumeParam) : undefined;
    const pairMode = req.query?.pairMode;

    const report = await buildReport({ minVolumeUsdt, pairMode });
    res.status(200).json(report);
  } catch (err) {
    console.error('Failed to build report', err);
    res.status(500).json({ ok: false, error: 'Не удалось получить цены. Попробуй ещё раз.' });
  }
};
