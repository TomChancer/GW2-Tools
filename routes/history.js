const express = require('express');
const router  = express.Router();
const db = require('../db');

// History stats — registered before /:itemId so "stats" isn't swallowed as an item id
router.get('/stats', (req, res) => {
  const count = db.getHistoryCount();
  const estimatedMB = ((count * 16) / 1024 / 1024).toFixed(2); // rough size estimate: ~16 bytes/row
  res.json({ ok: true, rowCount: count, estimatedMB, maxDays: 30 });
});

// Batch history for multiple items (used by craft results)
router.post('/batch', (req, res) => {
  const { itemIds, days = 7 } = req.body;
  if (!Array.isArray(itemIds) || !itemIds.length) return res.status(400).json({ error: 'itemIds required' });
  const limitedDays = Math.min(days, 30);
  const history     = db.getPriceHistoryBatch(itemIds, limitedDays);
  res.json({ ok: true, history, days: limitedDays });
});

// Single item history
router.get('/:itemId', (req, res) => {
  const itemId = parseInt(req.params.itemId);
  const days   = Math.min(parseInt(req.query.days) || 7, 30);
  if (!itemId) return res.status(400).json({ error: 'invalid itemId' });

  const history = db.getPriceHistory(itemId, days);
  const summary = db.getPriceSummary(itemId, days);
  const item    = db.getItemsByIds([itemId])[0] || null;

  // Compute trend: % change in sell price from first to last snapshot
  let trend = null;
  if (summary && summary.sell_first && summary.sell_last && summary.sell_first > 0) {
    trend = ((summary.sell_last - summary.sell_first) / summary.sell_first * 100).toFixed(1);
  }

  res.json({ ok: true, itemId, item, history, summary, trend, days });
});

module.exports = router;
