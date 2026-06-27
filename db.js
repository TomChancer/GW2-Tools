// db.js — SQLite database setup and helpers (using sql.js, pure JS)
const initSqlJs = require('sql.js');
const fs   = require('fs');
const path = require('path');

// Under plain `node server.js`, the DB lives next to the source (as always).
// Under a packaged Electron build, __dirname is inside a read-only app.asar,
// so we copy the bundled seed DB into a writable per-user data folder on first run.
function resolveDbPath() {
  if (process.versions && process.versions.electron) {
    const { app } = require('electron');
    const userDbPath = path.join(app.getPath('userData'), 'gw2.db');
    const seedDbPath = path.join(__dirname, 'gw2.db');
    if (!fs.existsSync(userDbPath) && fs.existsSync(seedDbPath)) {
      fs.copyFileSync(seedDbPath, userDbPath);
    }
    return userDbPath;
  }
  return path.join(__dirname, 'gw2.db');
}

const DB_PATH       = resolveDbPath();
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
  migrateSchema(_db);
  return _db;
}

// Add columns that didn't exist in earlier versions — SQLite ignores errors if column already exists
function migrateSchema(db) {
  const migrations = [
    'ALTER TABLE tp_prices ADD COLUMN buy_quantity  INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE tp_prices ADD COLUMN sell_quantity INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE price_history ADD COLUMN buy_quantity  INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE price_history ADD COLUMN sell_quantity INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE items ADD COLUMN item_type    TEXT',
    'ALTER TABLE items ADD COLUMN item_subtype TEXT',
  ];
  for (const sql of migrations) {
    try { db.run(sql); } catch (e) { /* column already exists */ }
  }
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
      item_id       INTEGER PRIMARY KEY,
      buy_price     INTEGER NOT NULL DEFAULT 0,
      sell_price    INTEGER NOT NULL DEFAULT 0,
      buy_quantity  INTEGER NOT NULL DEFAULT 0,
      sell_quantity INTEGER NOT NULL DEFAULT 0,
      updated_at    INTEGER NOT NULL DEFAULT 0
    );

    -- Historical price snapshots: one row per item per hour, only on change
    -- snapped_at is the Unix timestamp of the hour boundary (e.g. 1718784000 = top of the hour)
    CREATE TABLE IF NOT EXISTS price_history (
      item_id       INTEGER NOT NULL,
      snapped_at    INTEGER NOT NULL,
      buy_price     INTEGER NOT NULL DEFAULT 0,
      sell_price    INTEGER NOT NULL DEFAULT 0,
      buy_quantity  INTEGER NOT NULL DEFAULT 0,
      sell_quantity INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (item_id, snapped_at)
    );

    -- Index for fast range queries: "give me all history for item X"
    CREATE INDEX IF NOT EXISTS idx_history_item ON price_history(item_id, snapped_at DESC);

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    -- Watchlist: items polled every 5 minutes for flip tracking
    CREATE TABLE IF NOT EXISTS watched_items (
      item_id  INTEGER PRIMARY KEY,
      added_at INTEGER NOT NULL DEFAULT 0
    );

    -- Short-term high-frequency snapshots for watched items (last ~60 min)
    CREATE TABLE IF NOT EXISTS watch_history (
      item_id       INTEGER NOT NULL,
      snapped_at    INTEGER NOT NULL,
      buy_price     INTEGER NOT NULL DEFAULT 0,
      sell_price    INTEGER NOT NULL DEFAULT 0,
      buy_quantity  INTEGER NOT NULL DEFAULT 0,
      sell_quantity INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (item_id, snapped_at)
    );
    CREATE INDEX IF NOT EXISTS idx_watch_item ON watch_history(item_id, snapped_at DESC);

    CREATE TABLE IF NOT EXISTS achievement_categories (
      id   INTEGER PRIMARY KEY,
      name TEXT,
      icon TEXT
    );

    CREATE TABLE IF NOT EXISTS achievements (
      id          INTEGER PRIMARY KEY,
      name        TEXT,
      description TEXT,
      requirement TEXT,
      type        TEXT,
      icon        TEXT,
      category_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS achievement_bits (
      achievement_id INTEGER NOT NULL,
      bit_index      INTEGER NOT NULL,
      type           TEXT,
      item_id        INTEGER,
      text           TEXT,
      PRIMARY KEY (achievement_id, bit_index)
    );
    CREATE INDEX IF NOT EXISTS idx_abit_item ON achievement_bits(item_id);
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
// Uses ON CONFLICT DO UPDATE (not INSERT OR REPLACE) so item_type/item_subtype
// — set separately by the type backfill — survive re-upserts from other code paths.
function upsertItems(items) {
  const stmt = _db.prepare(`
    INSERT INTO items (id, name, icon, rarity, vendor_value, flags, tradable)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, icon = excluded.icon, rarity = excluded.rarity,
      vendor_value = excluded.vendor_value, flags = excluded.flags, tradable = excluded.tradable`);
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
    INSERT OR REPLACE INTO tp_prices (item_id, buy_price, sell_price, buy_quantity, sell_quantity, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  for (const p of prices) stmt.run([p.item_id, p.buy_price, p.sell_price, p.buy_quantity||0, p.sell_quantity||0, now]);
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
    INSERT OR IGNORE INTO price_history (item_id, snapped_at, buy_price, sell_price, buy_quantity, sell_quantity)
    VALUES (?, ?, ?, ?, ?, ?)`);

  let written = 0;

  for (const p of prices) {
    // Get the most recent history row for this item
    const last = queryOne(
      `SELECT buy_price, sell_price, buy_quantity, sell_quantity, snapped_at FROM price_history
       WHERE item_id = ? ORDER BY snapped_at DESC LIMIT 1`,
      [p.item_id]
    );

    // Skip if we already have a row for this hour
    if (last && last.snapped_at === hourBucket) continue;

    // Record if price changed
    const priceChanged = !last || last.buy_price !== p.buy_price || last.sell_price !== p.sell_price;

    // Record if buy or sell quantity shifted by more than 25% (stock moving)
    const prevBq = last ? (last.buy_quantity  || 0) : 0;
    const prevSq = last ? (last.sell_quantity || 0) : 0;
    const bqShift = prevBq > 0 ? Math.abs((p.buy_quantity||0)  - prevBq) / prevBq : 0;
    const sqShift = prevSq > 0 ? Math.abs((p.sell_quantity||0) - prevSq) / prevSq : 0;
    const qtyShifted = bqShift > 0.25 || sqShift > 0.25;

    if (!priceChanged && !qtyShifted) continue;

    insertStmt.run([p.item_id, hourBucket, p.buy_price, p.sell_price, p.buy_quantity||0, p.sell_quantity||0]);
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
    result[row.item_id].push({ t: row.snapped_at, b: row.buy_price, s: row.sell_price, bq: row.buy_quantity||0, sq: row.sell_quantity||0 });
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

// ── Daily sync ────────────────────────────────────────────────────────────────
function getAllTradableItemIds() {
  return queryAll('SELECT id FROM items WHERE tradable = 1').map(r => r.id);
}

// Items in tp_prices that have never had their type populated — used by type backfill
function getItemsWithoutType() {
  return queryAll(`
    SELECT p.item_id AS id FROM tp_prices p
    JOIN items i ON i.id = p.item_id
    WHERE i.item_type IS NULL
  `).map(r => r.id);
}

// Bulk-update item_type / item_subtype from API response objects
function updateItemTypes(items) {
  const stmt = _db.prepare('UPDATE items SET item_type = ?, item_subtype = ? WHERE id = ?');
  let updated = 0;
  for (const i of items) {
    if (!i.id || !i.type) continue;
    stmt.run([i.type, i.subtype || null, i.id]);
    updated++;
  }
  stmt.free();
  if (updated > 0) save();
  return updated;
}

// Distinct type/subtype combos for items that have active buy & sell prices
function getAvailableCategories() {
  return queryAll(`
    SELECT DISTINCT i.item_type, i.item_subtype
    FROM items i
    JOIN tp_prices p ON p.item_id = i.id
    WHERE i.item_type IS NOT NULL
      AND p.buy_price  > 0
      AND p.sell_price > 0
    ORDER BY i.item_type, i.item_subtype
  `);
}

// ── Mystic Forge ──────────────────────────────────────────────────────────────
// Returns cheapest-4 rare and exotic weapons per weapon type, plus floor exotic value.
// sell_price = what you pay to instant-buy (this is the roll cost we care about).
// buy_price  = what you'd get if you sold to a buy order (used for floor value).
function getMysticForgeRolls() {
  const weapons = queryAll(`
    SELECT p.item_id, i.name, i.icon, i.rarity,
           i.item_subtype AS weapon_type,
           p.buy_price, p.sell_price, p.buy_quantity, p.sell_quantity
    FROM tp_prices p
    JOIN items i ON i.id = p.item_id
    WHERE i.item_type = 'Weapon'
      AND i.item_subtype IS NOT NULL
      AND i.rarity IN ('Rare', 'Exotic')
      AND p.sell_price > 0
      AND p.buy_price  > 0
      AND p.sell_quantity > 0
    ORDER BY i.item_subtype, i.rarity, p.sell_price ASC
  `);

  // Group by weapon_type + rarity, keep cheapest 4 of each
  const byType = {};
  for (const w of weapons) {
    if (!byType[w.weapon_type]) byType[w.weapon_type] = { Rare: [], Exotic: [] };
    const arr = byType[w.weapon_type][w.rarity];
    if (arr && arr.length < 4) arr.push(w);
  }

  const rareRolls   = [];
  const exoticRolls = [];

  for (const [type, byRarity] of Object.entries(byType)) {
    const rares   = byRarity.Rare   || [];
    const exotics = byRarity.Exotic || [];

    // Floor value = cheapest exotic of this type, sold to buy order, after 15% tax
    const floorExotic = exotics[0] || null;
    const floorValue  = floorExotic ? Math.floor(floorExotic.buy_price * 0.85) : 0;

    if (rares.length === 4) {
      const rollCost = rares.reduce((s, i) => s + i.sell_price, 0);
      const buyCost  = rares.reduce((s, i) => s + i.buy_price,  0);
      rareRolls.push({ weapon_type: type, items: rares, rollCost, buyCost, floorExotic, floorValue, delta: floorValue - rollCost });
    }

    if (exotics.length === 4) {
      const rollCost = exotics.reduce((s, i) => s + i.sell_price, 0);
      const buyCost  = exotics.reduce((s, i) => s + i.buy_price,  0);
      exoticRolls.push({ weapon_type: type, items: exotics, rollCost, buyCost, floorExotic, floorValue, delta: floorValue - rollCost });
    }
  }

  rareRolls.sort((a, b)   => a.rollCost - b.rollCost);
  exoticRolls.sort((a, b) => a.rollCost - b.rollCost);

  return { rareRolls, exoticRolls };
}

// ── Achievement collections ───────────────────────────────────────────────────

function upsertAchievementCategories(cats) {
  const stmt = _db.prepare('INSERT OR REPLACE INTO achievement_categories (id, name, icon) VALUES (?, ?, ?)');
  for (const c of cats) stmt.run([c.id, c.name, c.icon || null]);
  stmt.free();
  save();
}

function upsertAchievements(achievements) {
  const stmtA = _db.prepare(`
    INSERT OR REPLACE INTO achievements (id, name, description, requirement, type, icon, category_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const stmtB = _db.prepare(`
    INSERT OR REPLACE INTO achievement_bits (achievement_id, bit_index, type, item_id, text)
    VALUES (?, ?, ?, ?, ?)`);
  for (const a of achievements) {
    stmtA.run([a.id, a.name, a.description || null, a.requirement || null, a.type || null, a.icon || null, a.category_id || null]);
    for (let i = 0; i < (a.bits || []).length; i++) {
      const b = a.bits[i];
      stmtB.run([a.id, i, b.type || null, b.id || null, b.text || null]);
    }
  }
  stmtA.free();
  stmtB.free();
  save();
}

function getAchievementCollectionCategories() {
  return queryAll(`
    SELECT DISTINCT ac.id, ac.name, ac.icon
    FROM achievement_categories ac
    JOIN achievements a ON a.category_id = ac.id
    ORDER BY ac.name
  `);
}

function searchCollections(q, categoryId, limit = 50) {
  const likeQ = `%${q || ''}%`;
  const params = categoryId
    ? [likeQ, parseInt(categoryId), parseInt(limit)]
    : [likeQ, parseInt(limit)];
  const catFilter = categoryId ? 'AND a.category_id = ?' : '';
  return queryAll(`
    SELECT a.id, a.name, a.description, a.icon, a.category_id, a.type,
           ac.name AS category_name,
           COUNT(b.bit_index) AS bit_count,
           SUM(CASE WHEN b.item_id IS NOT NULL THEN 1 ELSE 0 END) AS item_bit_count
    FROM achievements a
    LEFT JOIN achievement_categories ac ON ac.id = a.category_id
    LEFT JOIN achievement_bits b ON b.achievement_id = a.id
    WHERE a.name LIKE ? ${catFilter}
    GROUP BY a.id
    ORDER BY a.name
    LIMIT ?
  `, params);
}

function getCollectionDetail(id) {
  const ach = queryOne(`
    SELECT a.*, ac.name AS category_name
    FROM achievements a
    LEFT JOIN achievement_categories ac ON ac.id = a.category_id
    WHERE a.id = ?
  `, [id]);
  if (!ach) return null;
  const bits = queryAll(`
    SELECT b.bit_index, b.type, b.item_id, b.text,
           i.name AS item_name, i.icon AS item_icon, i.rarity AS item_rarity, i.item_subtype AS item_subtype,
           p.buy_price, p.sell_price, p.buy_quantity, p.sell_quantity
    FROM achievement_bits b
    LEFT JOIN items i ON i.id = b.item_id
    LEFT JOIN tp_prices p ON p.item_id = b.item_id
    WHERE b.achievement_id = ?
    ORDER BY b.bit_index
  `, [id]);
  return { ...ach, bits };
}

function getMissingAchievementItems() {
  return queryAll(`
    SELECT DISTINCT b.item_id
    FROM achievement_bits b
    WHERE b.item_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM items i WHERE i.id = b.item_id)
  `).map(r => r.item_id);
}

// All collections with their bits + current sell price — used to rank
// a player's incomplete collections by remaining TP cost (account data layered in by the caller).
function getAllCollectionsWithBits() {
  const achs = queryAll(`
    SELECT a.id, a.name, a.icon, a.category_id, ac.name AS category_name
    FROM achievements a
    LEFT JOIN achievement_categories ac ON ac.id = a.category_id
  `);
  const bits = queryAll(`
    SELECT b.achievement_id, b.bit_index, b.type, b.item_id, p.sell_price
    FROM achievement_bits b
    LEFT JOIN tp_prices p ON p.item_id = b.item_id
    ORDER BY b.achievement_id, b.bit_index
  `);
  const byAch = {};
  for (const b of bits) (byAch[b.achievement_id] = byAch[b.achievement_id] || []).push(b);
  return achs.map(a => ({ ...a, bits: byAch[a.id] || [] }));
}

// ── Watched items ─────────────────────────────────────────────────────────────
function addWatchedItem(itemId) {
  const now = Math.floor(Date.now() / 1000);
  _db.run('INSERT OR IGNORE INTO watched_items (item_id, added_at) VALUES (?, ?)', [itemId, now]);
  save();
}

function removeWatchedItem(itemId) {
  _db.run('DELETE FROM watched_items WHERE item_id = ?', [itemId]);
  _db.run('DELETE FROM watch_history WHERE item_id = ?', [itemId]);
  save();
}

function getWatchedItems() {
  return queryAll(`
    SELECT w.item_id, w.added_at, i.name, i.icon, i.rarity
    FROM watched_items w JOIN items i ON i.id = w.item_id
  `);
}

function recordWatchSnapshot(prices) {
  const now    = Math.floor(Date.now() / 1000);
  const bucket = now - (now % 300); // 5-minute boundaries
  const stmt   = _db.prepare(`
    INSERT OR IGNORE INTO watch_history (item_id, snapped_at, buy_price, sell_price, buy_quantity, sell_quantity)
    VALUES (?, ?, ?, ?, ?, ?)`);
  let written = 0;
  for (const p of prices) {
    stmt.run([p.item_id, bucket, p.buy_price, p.sell_price, p.buy_quantity||0, p.sell_quantity||0]);
    written++;
  }
  stmt.free();
  if (written > 0) save();
  return written;
}

function pruneWatchHistory() {
  const cutoff = Math.floor(Date.now() / 1000) - 3600;
  _db.run('DELETE FROM watch_history WHERE snapped_at < ?', [cutoff]);
  const count = _db.getRowsModified();
  if (count > 0) save();
  return count;
}

function getWatchHistory(itemIds) {
  if (!itemIds.length) return {};
  const cutoff = Math.floor(Date.now() / 1000) - 3600;
  const rows   = queryAll(
    `SELECT item_id, snapped_at, buy_price, sell_price, buy_quantity, sell_quantity
     FROM watch_history
     WHERE item_id IN (${placeholders(itemIds)}) AND snapped_at >= ?
     ORDER BY item_id, snapped_at ASC`,
    [...itemIds, cutoff]
  );
  const result = {};
  for (const row of rows) {
    if (!result[row.item_id]) result[row.item_id] = [];
    result[row.item_id].push({ t: row.snapped_at, b: row.buy_price, s: row.sell_price, bq: row.buy_quantity, sq: row.sell_quantity });
  }
  return result;
}

// ── Flip queries ──────────────────────────────────────────────────────────────

// Quick wins: items currently priced below their 7-day average — buy cheap, relist at normal price
function getQuickWins({ minProfit = 1000, dropPct = 20, minSnapshots = 5, limit = 50 } = {}) {
  const cutoff    = Math.floor(Date.now() / 1000) - (7 * 86400);
  const threshold = (100 - dropPct) / 100;
  return queryAll(`
    SELECT
      p.item_id,
      p.buy_price,
      p.sell_price,
      p.buy_quantity,
      p.sell_quantity,
      i.name, i.icon, i.rarity,
      CAST(h.sell_avg AS INTEGER)  AS hist_sell_avg,
      CAST(h.sell_max AS INTEGER)  AS hist_sell_max,
      h.snapshots,
      CAST(h.sell_avg * 0.85 - p.sell_price AS INTEGER) AS expected_profit,
      CAST((1.0 - CAST(p.sell_price AS REAL) / h.sell_avg) * 100 AS INTEGER) AS drop_pct
    FROM tp_prices p
    JOIN items i ON i.id = p.item_id
    JOIN (
      SELECT item_id,
        AVG(sell_price) AS sell_avg,
        MAX(sell_price) AS sell_max,
        COUNT(*) AS snapshots
      FROM price_history
      WHERE snapped_at >= ? AND sell_price > 0
      GROUP BY item_id
      HAVING COUNT(*) >= ?
    ) h ON h.item_id = p.item_id
    WHERE p.sell_price > 0
      AND p.buy_price > 0
      AND CAST(p.sell_price AS REAL) < h.sell_avg * ?
      AND CAST(h.sell_avg * 0.85 - p.sell_price AS INTEGER) >= ?
    ORDER BY expected_profit DESC
    LIMIT ?
  `, [cutoff, minSnapshots, threshold, minProfit, limit]);
}

// Normal flips: items with a profitable buy-order / sell-listing spread
// maxSpreadRatio caps sell/buy ratio to filter thin markets (e.g. 2.0 = sell ≤ 2× buy)
function getNormalFlips({
  minProfit = 1000, minROI = 15, minBuyQty = 50, minSellQty = 5,
  maxBuyPrice = 0, maxSpreadRatio = 2.0,
  itemType = null, itemSubtype = null, limit = 100
} = {}) {
  const cutoff = Math.floor(Date.now() / 1000) - (7 * 86400);
  const typeFilter    = itemType    ? 'AND i.item_type    = ?' : '';
  const subtypeFilter = itemSubtype ? 'AND i.item_subtype = ?' : '';
  const extraParams   = [
    ...(itemType    ? [itemType]    : []),
    ...(itemSubtype ? [itemSubtype] : []),
  ];
  return queryAll(`
    SELECT
      p.item_id,
      p.buy_price,
      p.sell_price,
      p.buy_quantity,
      p.sell_quantity,
      i.name, i.icon, i.rarity, i.item_type, i.item_subtype,
      CAST(p.sell_price * 0.85 - p.buy_price AS INTEGER) AS flip_profit,
      ROUND((p.sell_price * 0.85 - p.buy_price) * 100.0 / p.buy_price, 1) AS roi_pct,
      COALESCE(h.snapshots, 0) AS snapshots,
      CAST(COALESCE(h.sell_avg, 0) AS INTEGER) AS hist_sell_avg
    FROM tp_prices p
    JOIN items i ON i.id = p.item_id
    LEFT JOIN (
      SELECT item_id, COUNT(*) AS snapshots, AVG(sell_price) AS sell_avg
      FROM price_history
      WHERE snapped_at >= ? AND sell_price > 0
      GROUP BY item_id
    ) h ON h.item_id = p.item_id
    WHERE p.sell_price > 0
      AND p.buy_price > 0
      AND p.buy_quantity >= ?
      AND p.sell_quantity >= ?
      AND CAST(p.sell_price * 0.85 - p.buy_price AS INTEGER) >= ?
      AND (p.sell_price * 0.85 - p.buy_price) * 100.0 / p.buy_price >= ?
      AND CAST(p.sell_price AS REAL) / p.buy_price <= ?
      AND (? = 0 OR p.buy_price <= ?)
      ${typeFilter}
      ${subtypeFilter}
    ORDER BY flip_profit DESC
    LIMIT ?
  `, [cutoff, minBuyQty, minSellQty, minProfit, minROI, maxSpreadRatio, maxBuyPrice, maxBuyPrice, ...extraParams, limit]);
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
  // Daily sync + type backfill
  getAllTradableItemIds,
  getItemsWithoutType, updateItemTypes,
  getAvailableCategories,
  // Watched items
  addWatchedItem, removeWatchedItem, getWatchedItems,
  recordWatchSnapshot, pruneWatchHistory, getWatchHistory,
  // Mystic Forge
  getMysticForgeRolls,
  // Flip queries
  getQuickWins, getNormalFlips,
  // Achievement collections
  upsertAchievementCategories, upsertAchievements,
  getAchievementCollectionCategories, searchCollections,
  getCollectionDetail, getMissingAchievementItems, getAllCollectionsWithBits,
};
