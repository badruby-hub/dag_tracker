// Local/dev-only convenience server. Not used in production once the Mini
// App is on Vercel — kept so you can still run `node server.js` and open
// http://localhost:3000 to test the UI without deploying anything.
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { buildReport } = require('./report');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/prices', async (_req, res) => {
  try {
    const report = await buildReport();
    res.json(report);
  } catch (err) {
    console.error('Failed to build report', err.message);
    res.status(500).json({ ok: false, error: 'Не удалось получить цены. Попробуй ещё раз.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dev server running on http://localhost:${PORT}`));
