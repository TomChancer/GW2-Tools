// db.js — SQLite database setup and helpers (using sql.js, pure JS)
const initSqlJs = require('sql.js');
const fs   = require('fs');
const path = require('path');

const DB_PATH       = path.join(__dirname, 'gw2.db');
const HISTORY_DAYS  = 30;
const HISTORY_SECS  = HISTORY_DAYS * 24 * 60 * 60;

let _db  = null;
let _SQL = null;

async function getDb() {
  if (_db) return _db;
  _SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    _db = new _SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    _db = new _SQL.Database();
  }
  initSchema(_db);
  return _db;
}

function save() {
  if (!_db) return;
  fs.writeFileSync(DB_PATH, Buffer.from(_db.export()));
}

function initSchema(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS items (
      id           INTEGER PRIMARY KEY,
      name         TEXT NOT NULL,
      icon         TEXT,
      rarity       TEXT,
      vendor_value INTEGER DEFAULT 0,
      flags        TEXT DEFAULT '[]',
      tradable     INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS recipes (
      id             INTEGER PRIMARY KEY,
      output_item_id INTEGER NOT NULL,
      output_count   INTEGER NOT NULL DEFAULT 1,
      disciplines    TEXT NOT NULL DEFAULT '[]',
      ingredients    TEXT NOT NULL DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_recipes_output ON recipes(output_item_id);

    -- Current price cache (fast lookup, always latest)
    CREATE TABLE IF NOT EXISTS tp_prices (
      item_id    INTEGER PRIMARY KEY,
      buy_price  INTEGER NOT NULL DEFAULT 0,
      sell_price INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    -- Historical price snapshots: one row per item per hour, only on change
    -- snapped_at is the Unix timestamp of the hour boundary (e.g. 1718784000 = top of the hour)
    CREATE TABLE IF NOT EXISTS price_history (
      item_id    INTEGER NOT NULL,
      snapped_at INTEGER NOT NULL,
      buy_price  INTEGER NOT NULL DEFAULT 0,
      sell_price INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (item_id, snapped_at)
    );

    -- Index for fast range queries: "give me all history for item X"
    CREATE INDEX IF NOT EXISTS idx_history_item ON price_history(item_id, snapped_at DESC);

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

// ── Meta ─────────────────────────────────────────────────────────────────────
function getMeta(key) {
  if (!_db) return null;
  const stmt = _db.prepare('SELECT value FROM meta WHERE key = ?');
  stmt.bind([key]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row ? row.value : null;
}

function setMeta(key, value) {
  _db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, String(value)]);
  save();
}

// ── Items ─────────────────────────────────────────────────────────────────────
function upsertItems(items) {
  const stmt = _db.prepare(`
    INSERT OR REPLACE INTO items (id, name, icon, rarity, vendor_value, flags, tradable)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const i of items) stmt.run([i.id, i.name, i.icon, i.rarity, i.vendor_value, i.flags, i.tradable]);
  stmt.free();
  save();
}

function getItemsByIds(ids) {
  if (!ids.length) return [];
  return queryAll(`SELECT * FROM items WHERE id IN (${placeholders(ids)})`, ids);
}

// ── Recipes ───────────────────────────────────────────────────────────────────
function upsertRecipes(recipes) {
  const stmt = _db.prepare(`
    INSERT OR REPLACE INTO recipes (id, output_item_id, output_count, disciplines, ingredients)
    VALUES (?, ?, ?, ?, ?)`);
  for (const r of recipes) stmt.run([r.id, r.output_item_id, r.output_count, r.disciplines, r.ingredients]);
  stmt.free();
  save();
}

function getAllRecipes() { return queryAll('SELECT * FROM recipes'); }
function getRecipeCount() { return (queryOne('SELECT COUNT(*) as n FROM recipes') || {}).n || 0; }
function getItemCount()   { return (queryOne('SELECT COUNT(*) as n FROM items')   || {}).n || 0; }

// ── Current prices ────────────────────────────────────────────────────────────
function upsertPrices(prices) {
  const now  = Math.floor(Date.now() / 1000);
  const stmt = _db.prepare(`
    INSERT OR REPLACE INTO tp_prices (item_id, buy_price, sell_price, updated_at)
    VALUES (?, ?, ?, ?)`);
  for (const p of prices) stmt.run([p.item_id, p.buy_price, p.sell_price, now]);
  stmt.free();
  save();
}

function getPricesByIds(ids) {
  if (!ids.length) return [];
  return queryAll(`SELECT * FROM tp_prices WHERE item_id IN (${placeholders(ids)})`, ids);
}

// ── Price history ─────────────────────────────────────────────────────────────

// Returns the Unix timestamp for the top of the current hour
function currentHourBucket() {
  const now = Math.floor(Date.now() / 1000);
  return now - (now % 3600);
}

// Called after upsertPrices — records a snapshot if:
//   1) No snapshot exists for this hour yet, AND
//   2) The price is different from the last recorded snapshot (change detection)
function recordHistoryIfChanged(prices) {
  const hourBucket = currentHourBucket();
  const now        = Math.floor(Date.now() / 1000);
  const cutoff     = now - HISTORY_SECS;

  const insertStmt = _db.prepare(`
    INSERT OR IGNORE INTO price_history (item_id, snapped_at, buy_price, sell_price)
    VALUES (?, ?, ?, ?)`);

  let written = 0;

  for (const p of prices) {
    // Get the most recent history row for this item
    const last = queryOne(
      `SELECT buy_price, sell_price, snapped_at FROM price_history
       WHERE item_id = ? ORDER BY snapped_at DESC LIMIT 1`,
      [p.item_id]
    );

    // Skip if we already have a row for this hour
    if (last && last.snapped_at === hourBucket) continue;

    // Skip if price hasn't changed since last snapshot
    if (last && last.buy_price === p.buy_price && last.sell_price === p.sell_price) continue;

    // Write the snapshot
    insertStmt.run([p.item_id, hourBucket, p.buy_price, p.sell_price]);
    written++;
  }

  insertStmt.free();

  if (written > 0) {
    save();
    console.log(`[History] Recorded ${written} price snapshots at hour ${new Date(hourBucket * 1000).toISOString()}`);
  }

  return written;
}

// Prune history older than 30 days — call periodically (e.g. on server start + daily)
function pruneOldHistory() {
  const cutoff = Math.floor(Date.now() / 1000) - HISTORY_SECS;
  const result = _db.run('DELETE FROM price_history WHERE snapped_at < ?', [cutoff]);
  const count  = _db.getRowsModified();
  if (count > 0) {
    save();
    console.log(`[History] Pruned ${count} rows older than ${HISTORY_DAYS} days`);
  }
  return count;
}

// Get history for a single item — returns [{snapped_at, buy_price, sell_price}]
function getPriceHistory(itemId, days = 7) {
  const cutoff = Math.floor(Date.now() / 1000) - (days * 86400);
  return queryAll(
    `SELECT snapped_at, buy_price, sell_price FROM price_history
     WHERE item_id = ? AND snapped_at >= ?
     ORDER BY snapped_at ASC`,
    [itemId, cutoff]
  );
}

// Get history for multiple items — returns {itemId: [{snapped_at, buy_price, sell_price}]}
function getPriceHistoryBatch(itemIds, days = 7) {
  if (!itemIds.length) return {};
  const cutoff = Math.floor(Date.now() / 1000) - (days * 86400);
  const rows   = queryAll(
    `SELECT item_id, snapped_at, buy_price, sell_price FROM price_history
     WHERE item_id IN (${placeholders(itemIds)}) AND snapped_at >= ?
     ORDER BY item_id, snapped_at ASC`,
    [...itemIds, cutoff]
  );
  const result = {};
  for (const row of rows) {
    if (!result[row.item_id]) result[row.item_id] = [];
    result[row.item_id].push({ t: row.snapped_at, b: row.buy_price, s: row.sell_price });
  }
  return result;
}

// Summary stats for a single item over a period
function getPriceSummary(itemId, days = 7) {
  const cutoff = Math.floor(Date.now() / 1000) - (days * 86400);
  return queryOne(
    `SELECT
       COUNT(*)          AS snapshots,
       MIN(buy_price)    AS buy_min,
       MAX(buy_price)    AS buy_max,
       AVG(buy_price)    AS buy_avg,
       MIN(sell_price)   AS sell_min,
       MAX(sell_price)   AS sell_max,
       AVG(sell_price)   AS sell_avg,
       -- First and last for trend direction
       (SELECT buy_price  FROM price_history WHERE item_id = ? AND snapped_at >= ? ORDER BY snapped_at ASC  LIMIT 1) AS buy_first,
       (SELECT buy_price  FROM price_history WHERE item_id = ? AND snapped_at >= ? ORDER BY snapped_at DESC LIMIT 1) AS buy_last,
       (SELECT sell_price FROM price_history WHERE item_id = ? AND snapped_at >= ? ORDER BY snapped_at ASC  LIMIT 1) AS sell_first,
       (SELECT sell_price FROM price_history WHERE item_id = ? AND snapped_at >= ? ORDER BY snapped_at DESC LIMIT 1) AS sell_last
     FROM price_history
     WHERE item_id = ? AND snapped_at >= ?`,
    [itemId, cutoff, itemId, cutoff, itemId, cutoff, itemId, cutoff, itemId, cutoff]
  );
}

// How many history rows do we have total?
function getHistoryCount() {
  return (queryOne('SELECT COUNT(*) as n FROM price_history') || {}).n || 0;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function queryAll(sql, params = []) {
  const stmt = _db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function queryOne(sql, params = []) {
  const stmt = _db.prepare(sql);
  stmt.bind(params);
  const result = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return result;
}

function placeholders(arr) {
  return arr.map(() => '?').join(',');
}

module.exports = {
  getDb, save,
  getMeta, setMeta,
  upsertItems, upsertRecipes,
  upsertPrices,
  getItemsByIds, getAllRecipes,
  getPricesByIds,
  getRecipeCount, getItemCount,
  // History
  recordHistoryIfChanged,
  pruneOldHistory,
  getPriceHistory,
  getPriceHistoryBatch,
  getPriceSummary,
  getHistoryCount,
  currentHourBucket,
};
