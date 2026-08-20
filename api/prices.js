require('dotenv').config();
const { buildReport } = require('../report');

// Vercel Node.js serverless function: this file at /api/prices.js is
// automatically exposed at the URL path /api/prices — no extra routing
// config needed. Each request spins this up fresh, runs buildReport(),
// and returns; there's no persistent process here, which is exactly why
// the bot (long-polling) can't live here and stays on PM2 instead.
module.exports = async (req, res) => {
  try {
    const report = await buildReport();
    res.status(200).json(report);
  } catch (err) {
    console.error('Failed to build report', err);
    res.status(500).json({ ok: false, error: 'Не удалось получить цены. Попробуй ещё раз.' });
  }
};
