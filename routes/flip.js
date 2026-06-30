const express = require('express');
const router  = express.Router();
const { fetchPrices, fetchItems } = require('../gw2api');
const db = require('../db');

// ── Daily sync state (in-memory, not persisted) ───────────────────────────────
let syncRunning  = false;
const syncProgress = { done: 0, total: 0 };

// A score that balances absolute profit, capital efficiency (ROI), and market liquidity.
// Sorting by raw profit alone surfaces expensive but slow-moving items;
// ROI alone surfaces cheap items that tie up little capital but earn little.
// Log-scaling buy_quantity means liquidity has diminishing returns — going from
// 100 → 1000 orders matters, but 10,000 → 100,000 is marginal.
function calcFlipScore(profitCopper, roiPct, buyQty) {
  return profitCopper * (1 + roiPct / 100) * Math.log10(buyQty + 1);
}

// Assign A/B/C grades by percentile within the returned set, so grades are
// always relative to what's currently available — not absolute thresholds that
// mean nothing when the market is quiet.
function assignGrades(items) {
  if (!items.length) return items;
  items.sort((a, b) => b.score - a.score);
  const n   = items.length;
  const cutA = Math.ceil(n * 0.25); // top 25% → A
  const cutB = Math.ceil(n * 0.65); // next 40% → B, bottom 35% → C
  return items.map((item, i) => ({ ...item, grade: i < cutA ? 'A' : i < cutB ? 'B' : 'C' }));
}

router.post('/', (req, res) => {
  const {
    quickMinProfit    = 5000,
    quickDropPct      = 20,
    quickMinSnaps     = 5,
    normalMinProfit   = 5000,
    normalMinROI      = 20,
    normalMinBuyQty   = 250,
    normalMinSellQty  = 50,
    normalMaxBuyPrice = 0,
    normalMaxSpread   = 2.0,
    itemType          = null,
    itemSubtype       = null,
    limit             = 75,
  } = req.body;

  try {
    const quickWinsRaw = db.getQuickWins({ minProfit: quickMinProfit, dropPct: quickDropPct, minSnapshots: quickMinSnaps, limit });
    const quickWins = assignGrades(quickWinsRaw.map(f => ({
      ...f,
      score: Math.round(calcFlipScore(f.expected_profit, f.drop_pct, f.buy_quantity)),
    })));

    const normalFlipsRaw = db.getNormalFlips({
      minProfit: normalMinProfit, minROI: normalMinROI,
      minBuyQty: normalMinBuyQty, minSellQty: normalMinSellQty,
      maxBuyPrice: normalMaxBuyPrice, maxSpreadRatio: normalMaxSpread,
      itemType, itemSubtype, limit,
    });
    const normalFlips = assignGrades(normalFlipsRaw.map(f => ({
      ...f,
      score: Math.round(calcFlipScore(f.flip_profit, f.roi_pct, f.buy_quantity)),
    })));

    const watchedIds = db.getWatchedItems().map(w => w.item_id);
    res.json({ ok: true, quickWins, normalFlips, watchedIds });
  } catch(e) {
    console.error('[Flip]', e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/categories', (req, res) => {
  const rows = db.getAvailableCategories();
  // Build { TypeName: ['subtype1', 'subtype2', ...] }
  const grouped = {};
  for (const r of rows) {
    if (!grouped[r.item_type]) grouped[r.item_type] = [];
    if (r.item_subtype) grouped[r.item_type].push(r.item_subtype);
  }
  res.json({ ok: true, categories: grouped });
});

router.get('/sync-status', (req, res) => {
  res.json({
    ok:       true,
    status:   db.getMeta('full_sync_status') || 'never',
    progress: { done: syncProgress.done, total: syncProgress.total },
    lastSync: parseInt(db.getMeta('last_full_sync') || '0') || null,
  });
});

router.post('/sync', (req, res) => {
  if (syncRunning) return res.json({ ok: false, error: 'Sync already running' });
  res.json({ ok: true });
  runDailySync();
});

router.post('/watch', (req, res) => {
  const { itemId, action } = req.body;
  if (!itemId) return res.status(400).json({ error: 'itemId required' });
  if (action === 'add')    db.addWatchedItem(itemId);
  if (action === 'remove') db.removeWatchedItem(itemId);
  res.json({ ok: true, watched: db.getWatchedItems() });
});

// ── Daily price sync ──────────────────────────────────────────────────────────

async function runDailySync() {
  if (syncRunning) return;
  syncRunning = true;
  db.setMeta('full_sync_status', 'running');
  syncProgress.done  = 0;
  syncProgress.total = 0;

  try {
    const allIds = db.getAllTradableItemIds();
    syncProgress.total = allIds.length;
    console.log(`[DailySync] Starting — ${allIds.length} tradable items`);

    const prices = await fetchPrices(allIds, (done, total) => {
      syncProgress.done  = done;
      syncProgress.total = total;
    });

    const rows = prices.filter(p => p && p.id).map(p => ({
      item_id:      p.id,
      buy_price:    (p.buys  && p.buys.unit_price)  || 0,
      sell_price:   (p.sells && p.sells.unit_price) || 0,
      buy_quantity: (p.buys  && p.buys.quantity)    || 0,
      sell_quantity:(p.sells && p.sells.quantity)   || 0,
    }));

    db.upsertPrices(rows);
    db.setMeta('last_full_sync', String(Math.floor(Date.now() / 1000)));
    db.setMeta('full_sync_status', 'done');
    console.log(`[DailySync] Complete — ${rows.length} prices updated`);
    backfillItemTypes().catch(e => console.error('[TypeSync]', e.message));
  } catch(e) {
    console.error('[DailySync] Failed:', e.message);
    db.setMeta('full_sync_status', 'error');
  } finally {
    syncRunning = false;
  }
}

function scheduleDailySync() {
  const lastSync = parseInt(db.getMeta('last_full_sync') || '0');
  const elapsed  = Math.floor(Date.now() / 1000) - lastSync;
  const DAY_SECS = 86400;
  const delayMs  = elapsed > DAY_SECS ? 5000 : (DAY_SECS - elapsed) * 1000;

  if (elapsed > DAY_SECS) {
    console.log('[DailySync] Overdue — starting in 5s');
  } else {
    console.log(`[DailySync] Next sync in ${Math.round((DAY_SECS - elapsed) / 3600)}h`);
  }

  setTimeout(() => {
    runDailySync();
    setInterval(runDailySync, DAY_SECS * 1000);
  }, delayMs);
}

// ── Item type backfill ────────────────────────────────────────────────────────
// Populates item_type / item_subtype for items in tp_prices that are missing it.
// Runs after daily sync and on startup. One-time cost per item; skips already-typed ones.

async function backfillItemTypes() {
  const missing = db.getItemsWithoutType();
  if (!missing.length) return;
  console.log(`[TypeSync] Backfilling types for ${missing.length} items…`);
  try {
    const items = await fetchItems(missing);
    const typed = items.filter(i => i && i.id && i.type).map(i => ({
      id:      i.id,
      type:    i.type,
      subtype: (i.details && i.details.type) || null,
    }));
    const n = db.updateItemTypes(typed);
    console.log(`[TypeSync] Updated types for ${n} items`);
  } catch(e) {
    console.error('[TypeSync] Failed:', e.message);
  }
}

// ── 5-minute watchlist poll ───────────────────────────────────────────────────

async function runWatchPoll() {
  const watched = db.getWatchedItems();
  if (!watched.length) return;

  const ids = watched.map(w => w.item_id);
  try {
    const prices = await fetchPrices(ids);
    const rows   = prices.filter(p => p && p.id).map(p => ({
      item_id:      p.id,
      buy_price:    (p.buys  && p.buys.unit_price)  || 0,
      sell_price:   (p.sells && p.sells.unit_price) || 0,
      buy_quantity: (p.buys  && p.buys.quantity)    || 0,
      sell_quantity:(p.sells && p.sells.quantity)   || 0,
    }));
    db.upsertPrices(rows);
    db.recordWatchSnapshot(rows);
    db.pruneWatchHistory();
    console.log(`[WatchPoll] Updated ${rows.length} watched items`);
  } catch(e) {
    console.error('[WatchPoll] Failed:', e.message);
  }
}

function start() {
  scheduleDailySync();
  setTimeout(() => backfillItemTypes().catch(e => console.error('[TypeSync]', e.message)), 10000);
  runWatchPoll();
  setInterval(runWatchPoll, 5 * 60 * 1000);
}

module.exports = { router, start };
