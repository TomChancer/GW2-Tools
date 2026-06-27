const express = require('express');
const path    = require('path');
const { apiFetch, fetchPrices } = require('./gw2api');
const db = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Status ───────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ ok:true, seeded:!!db.getMeta('seeded_at'), recipeCount:db.getRecipeCount(), itemCount:db.getItemCount() });
});

// ── Validate key ─────────────────────────────────────────────────────────────
app.post('/api/validate-key', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error:'apiKey required' });
  try {
    const info = await apiFetch(`/v2/tokeninfo`, apiKey);
    res.json({ ok:true, name:info.name, permissions:info.permissions });
  } catch(e) { res.status(401).json({ ok:false, error:e.message }); }
});

// ── Feature routers ────────────────────────────────────────────────────────────
const flip        = require('./routes/flip');
const collections = require('./routes/collections');

app.use('/api', require('./routes/craft'));
app.use('/api', require('./routes/salvage'));
app.use('/api/history', require('./routes/history'));
app.use('/api/forge', require('./routes/forge'));
app.use('/api/flip', flip.router);
app.use('/api/collections', collections.router);

// ── Hourly price history scheduler ───────────────────────────────────────────
// Runs at the top of every hour to snapshot prices for all recipe-relevant items
async function runHourlySnapshot() {
  console.log('[Scheduler] Running hourly price snapshot...');
  try {
    // Get all unique item IDs referenced by recipes
    const recipes      = db.getAllRecipes();
    const priceItemIds = new Set();
    for (const recipe of recipes) {
      priceItemIds.add(recipe.output_item_id);
      const ings = JSON.parse(recipe.ingredients);
      for (const ing of ings) priceItemIds.add(ing.id);
    }

    const ids = [...priceItemIds].filter(id => id > 0);
    if (!ids.length) return;

    const prices = await fetchPrices(ids);
    const rows   = prices.map(p => ({
      item_id:      p.id,
      buy_price:    (p.buys  && p.buys.unit_price)  || 0,
      sell_price:   (p.sells && p.sells.unit_price) || 0,
      buy_quantity: (p.buys  && p.buys.quantity)    || 0,
      sell_quantity:(p.sells && p.sells.quantity)   || 0,
    }));

    db.upsertPrices(rows);
    const written = db.recordHistoryIfChanged(rows);
    console.log(`[Scheduler] Snapshot done — ${written} new history rows from ${ids.length} items`);

    // Prune old history once per day (at midnight-ish)
    const hour = new Date().getHours();
    if (hour === 0) {
      const pruned = db.pruneOldHistory();
      console.log(`[Scheduler] Pruned ${pruned} old history rows`);
    }
  } catch (err) {
    console.error('[Scheduler] Hourly snapshot failed:', err.message);
  }
}

function scheduleHourlySnapshots() {
  const now          = Date.now();
  const nextHour     = Math.ceil(now / 3600000) * 3600000;
  const msUntilHour  = nextHour - now;

  console.log(`[Scheduler] First snapshot in ${Math.round(msUntilHour / 60000)} minutes`);

  setTimeout(() => {
    runHourlySnapshot();
    setInterval(runHourlySnapshot, 3600000);
  }, msUntilHour);
}

// ── Start ─────────────────────────────────────────────────────────────────────
// Returns the resolved port once the server is actually listening — lets an
// Electron main process await readiness before pointing a window at it.
async function start() {
  await db.getDb();

  // Prune any history older than 30 days on startup
  db.pruneOldHistory();

  await new Promise((resolve) => {
    app.listen(PORT, () => {
      console.log(`\n🗡️  GW2 Tools running at http://localhost:${PORT}`);
      console.log('   Press Ctrl+C to stop\n');
      resolve();
    });
  });

  scheduleHourlySnapshots();
  flip.start();
  collections.start();

  return PORT;
}

module.exports = { start, PORT };

// Only auto-start when run directly (`node server.js`) — when required as a
// module (e.g. from Electron's main process), the caller decides when to start.
if (require.main === module) {
  start().catch(e => { console.error('Failed to start:', e); process.exit(1); });
}
