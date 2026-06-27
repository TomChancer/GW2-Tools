const express = require('express');
const router  = express.Router();
const { fetchAchievements, getAllAchievementIds, getAchievementCategories, fetchItems, apiFetch } = require('../gw2api');
const db = require('../db');

// ── Achievement sync state ────────────────────────────────────────────────────
let achieveSyncRunning = false;
const achieveProgress  = { done: 0, total: 0 };

// Fetches item details for missing bit items and stores name/icon/rarity + type/subtype.
// Type/subtype population matters for the Mystic Forge cross-link (precursor weapon hint).
async function fetchAndStoreItems(ids) {
  if (!ids.length) return;
  const items = await fetchItems(ids);
  const rows  = items.filter(i => i && i.id).map(i => ({
    id: i.id, name: i.name, icon: i.icon || null, rarity: i.rarity || 'Basic',
    vendor_value: i.vendor_value || 0, flags: JSON.stringify(i.flags || []), tradable: 1,
  }));
  if (rows.length) db.upsertItems(rows);
  const typed = items.filter(i => i && i.id && i.type).map(i => ({
    id: i.id, type: i.type, subtype: (i.details && i.details.type) || null,
  }));
  if (typed.length) db.updateItemTypes(typed);
}

async function syncAchievements() {
  if (achieveSyncRunning) return;
  achieveSyncRunning = true;
  achieveProgress.done = 0;
  achieveProgress.total = 0;
  try {
    console.log('[AchieveSync] Fetching categories…');
    const cats = await getAchievementCategories();
    const achCatMap = {};
    for (const cat of cats) {
      for (const id of (cat.achievements || [])) achCatMap[id] = cat.id;
    }
    db.upsertAchievementCategories(cats.map(c => ({ id: c.id, name: c.name, icon: c.icon || null })));

    console.log('[AchieveSync] Fetching achievement IDs…');
    const allIds = await getAllAchievementIds();
    achieveProgress.total = allIds.length;

    console.log(`[AchieveSync] Fetching ${allIds.length} achievements…`);
    const all = await fetchAchievements(allIds, (done) => { achieveProgress.done = done; });

    const collections = all
      .filter(a => a && a.bits && a.bits.some(b => b.type === 'Item'))
      .map(a => ({ ...a, category_id: achCatMap[a.id] || null }));

    console.log(`[AchieveSync] Storing ${collections.length} item-collection achievements…`);
    db.upsertAchievements(collections);

    // Fetch item details (incl. type/subtype) for any bit items not already in items table
    const missing = db.getMissingAchievementItems();
    if (missing.length) {
      console.log(`[AchieveSync] Fetching ${missing.length} missing item details…`);
      await fetchAndStoreItems(missing);
    }

    db.setMeta('last_achievement_sync', String(Math.floor(Date.now() / 1000)));
    console.log('[AchieveSync] Done');
  } catch(e) {
    console.error('[AchieveSync] Failed:', e.message);
  } finally {
    achieveSyncRunning = false;
  }
}

function scheduleAchievementSync() {
  const lastSync = parseInt(db.getMeta('last_achievement_sync') || '0');
  const elapsed  = Math.floor(Date.now() / 1000) - lastSync;
  const WEEK     = 7 * 86400;
  if (elapsed > WEEK) {
    console.log('[AchieveSync] Overdue — starting in 30s');
    setTimeout(syncAchievements, 30000);
  } else {
    const nextMs = (WEEK - elapsed) * 1000;
    console.log(`[AchieveSync] Next sync in ${Math.round((WEEK - elapsed) / 3600)}h`);
    setTimeout(syncAchievements, nextMs);
  }
  setInterval(syncAchievements, WEEK * 1000);
}

router.get('/sync-status', (req, res) => {
  const lastSync = db.getMeta('last_achievement_sync');
  const status = achieveSyncRunning ? 'running' : (lastSync ? 'done' : 'never');
  res.json({ ok: true, status, progress: achieveProgress, lastSync: lastSync ? parseInt(lastSync) : null });
});

router.post('/sync', (req, res) => {
  if (achieveSyncRunning) return res.json({ ok: false, error: 'Already running' });
  syncAchievements().catch(e => console.error('[AchieveSync]', e.message));
  res.json({ ok: true });
});

router.get('/categories', (req, res) => {
  try {
    res.json({ ok: true, categories: db.getAchievementCollectionCategories() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/search', (req, res) => {
  const { q = '', category = '', limit = '100' } = req.query;
  try {
    const results = db.searchCollections(q, category || null, Math.min(parseInt(limit) || 100, 300));
    res.json({ ok: true, results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// "Cheapest to finish" — ranks the player's incomplete collections by remaining TP cost.
// apiKey travels in the POST body (not a query string) since it's a credential.
router.post('/progress-summary', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'apiKey required' });
  try {
    const acct = await apiFetch('/v2/account/achievements', apiKey);
    const acctMap = {};
    for (const a of acct) acctMap[a.id] = a;

    const collections = db.getAllCollectionsWithBits();
    const results = [];
    for (const c of collections) {
      if (!c.bits.length) continue;
      const prog = acctMap[c.id];
      const doneSet = prog
        ? (prog.done ? new Set(c.bits.map((_, i) => i)) : new Set(prog.bits || []))
        : new Set();
      if (doneSet.size >= c.bits.length) continue; // fully done — skip

      const needBits = c.bits.filter((b, i) => !doneSet.has(i));
      const tpNeed    = needBits.filter(b => b.item_id && b.sell_price > 0);
      if (!tpNeed.length) continue; // nothing purchasable left to rank by cost

      results.push({
        id: c.id, name: c.name, icon: c.icon, category_name: c.category_name,
        doneCount: doneSet.size, totalCount: c.bits.length,
        remainingCost: tpNeed.reduce((s, b) => s + b.sell_price, 0),
        tpNeedCount: tpNeed.length, nonTpNeedCount: needBits.length - tpNeed.length,
      });
    }
    results.sort((a, b) => a.remainingCost - b.remainingCost);
    res.json({ ok: true, results });
  } catch(e) {
    // Most likely cause: API key is missing the "achievements" permission
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  const id     = parseInt(req.params.id);
  const apiKey = req.get('x-gw2-key') || null; // header, not query string — keeps the key out of logs/history
  if (!id) return res.status(400).json({ error: 'invalid id' });
  try {
    let detail = db.getCollectionDetail(id);
    if (!detail) return res.status(404).json({ error: 'Not found' });

    // Fetch item details for bits with no name yet
    const missingIds = detail.bits.filter(b => b.item_id && !b.item_name).map(b => b.item_id);
    if (missingIds.length) {
      await fetchAndStoreItems(missingIds);
      detail = db.getCollectionDetail(id);
    }

    // Fetch account progress if an API key was supplied
    let completedBits = null;
    if (apiKey) {
      try {
        const acctData = await apiFetch(`/v2/account/achievements?ids=${id}`, apiKey);
        const entry    = Array.isArray(acctData) ? acctData[0] : null;
        if (entry) completedBits = entry.done ? 'all' : (entry.bits || []);
      } catch(e) {
        // Missing achievements permission — silently skip
      }
    }

    res.json({ ok: true, ...detail, completedBits });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function start() {
  scheduleAchievementSync();
}

module.exports = { router, start };
