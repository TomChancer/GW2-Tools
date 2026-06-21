const express = require('express');
const path    = require('path');
const { getAccountMaterials, getAccountRecipes, validateApiKey, fetchItems, fetchPrices, apiFetch } = require('./gw2api');
const { calcProfitableRecipes, refreshPrices, formatCopper } = require('./profit');
const db = require('./db');

const app  = express();
const PORT = 3000;
const TP_FEE = 0.15;

// Ecto item ID
const ECTO_ID = 19721;

// Salvage EV rates (community-verified, master/mystic kit)
// Rare lv68+: avg 0.875 ectos. Exotic: similar.
const ECTO_RATE = 0.875;

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

// ── Craft analysis ────────────────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { apiKey, disciplines=[], minProfit=1, includePartial=true, maxMissingCost=10000000, limit=100, hideUnowned=false } = req.body;
  if (!apiKey) return res.status(400).json({ error:'apiKey required' });
  if (!db.getMeta('seeded_at')) return res.status(503).json({ error:'Database not seeded. Run: node seed.js' });

  try {
    const [materials, unlockedRecipes] = await Promise.all([
      getAccountMaterials(apiKey), getAccountRecipes(apiKey)
    ]);
    let results = await calcProfitableRecipes(materials.filter(m=>m.count>0), unlockedRecipes, { disciplines, minProfit, includePartial, maxMissingCost });
    if (hideUnowned) results = results.filter(r => r.unlocked || r.isFullyCraftable);
    const formatted = results.slice(0, limit).map(r => ({
      ...r,
      fmt: {
        sellInstant:          formatCopper(r.sellInstant),
        sellInstantAfterFees: formatCopper(r.sellInstantAfterFees),
        sellList:             formatCopper(r.sellList),
        sellListAfterFees:    formatCopper(r.sellListAfterFees),
        matCostToBuy:         formatCopper(r.matCostToBuy),
        profitVsRaw:          formatCopper(r.profitVsRaw),
        profitAbsolute:       formatCopper(r.profitAbsolute),
      }
    }));
    res.json({ ok:true, total:results.length, shown:formatted.length, results:formatted });
  } catch(e) { console.error('[Analyze]', e); res.status(500).json({ error:e.message }); }
});

// ── Kit definitions ──────────────────────────────────────────────────────────
const { SALVAGE_KITS, calcSalvageEV } = require('./salvage-kits');

// ── Salvage analysis ──────────────────────────────────────────────────────────
app.post('/api/salvage', async (req, res) => {
  const { apiKey, includeBank=true, includeBags=true, minRarity=3,
          ownedKits={ silver:true }, blKitCost=500 } = req.body;
  const kits = { ...SALVAGE_KITS };
  kits.blacklion = { ...kits.blacklion, costPerUse: blKitCost };
  if (!apiKey) return res.status(400).json({ error:'apiKey required' });

  const RARITY_ORDER = { Basic:0, Fine:1, Masterwork:2, Rare:3, Exotic:4, Ascended:5, Legendary:6 };

  try {
    // ── Step 1: Fetch all account data in parallel ──────────────────────────
    console.log('[Salvage] Fetching account data...');
    const fetches = [];
    if (includeBank) fetches.push(apiFetch('/v2/account/bank', apiKey).catch(() => []));
    if (includeBags) fetches.push(apiFetch('/v2/characters', apiKey).catch(() => []));

    const fetchResults = await Promise.all(fetches);
    let bankRaw   = includeBank ? (fetchResults[0] || []) : [];
    let charNames = includeBags ? (fetchResults[includeBank ? 1 : 0] || []) : [];

    // ── Step 2: Fetch all character inventories in parallel (with timeout) ──
    let rawItems = [];

    if (includeBank && Array.isArray(bankRaw)) {
      bankRaw.forEach(slot => {
        if (slot && slot.id) rawItems.push({ ...slot, location: 'Bank' });
      });
    }

    if (includeBags && Array.isArray(charNames) && charNames.length) {
      console.log(`[Salvage] Fetching inventory for ${charNames.length} characters...`);

      // Wrap each character fetch with a 8s timeout so one slow char can't hang everything
      const withTimeout = (promise, ms) => Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
      ]);

      const charInventories = await Promise.all(
        charNames.map(name =>
          withTimeout(
            apiFetch(`/v2/characters/${encodeURIComponent(name)}/inventory`, apiKey)
              .then(inv => ({ name, bags: inv.bags || [] })),
            8000
          ).catch(() => null) // silently skip failed/timed-out characters
        )
      );

      charInventories.forEach(char => {
        if (!char) return;
        (char.bags || []).forEach(bag => {
          if (!bag) return;
          (bag.inventory || []).forEach(slot => {
            if (slot && slot.id) rawItems.push({ ...slot, location: char.name });
          });
        });
      });
    }

    console.log(`[Salvage] ${rawItems.length} raw items collected`);
    if (!rawItems.length) return res.json({ ok:true, items:[], ectoPrice:0 });

    // ── Step 3: Resolve item details from DB cache (fast, no API call) ─────
    const uniqueItemIds = [...new Set(rawItems.map(i => i.id))];
    const dbItems = db.getItemsByIds(uniqueItemIds);
    const itemMap = {};
    dbItems.forEach(i => itemMap[i.id] = i);

    // Only fetch from API what's genuinely missing from DB
    const missing = uniqueItemIds.filter(id => !itemMap[id]);
    if (missing.length) {
      console.log(`[Salvage] Fetching ${missing.length} unknown items from API...`);
      const fetched = await fetchItems(missing);
      const rows = fetched.filter(i=>i&&i.id).map(i=>({
        id:i.id, name:i.name, icon:i.icon||null, rarity:i.rarity||'Basic',
        vendor_value:i.vendor_value||0, flags:JSON.stringify(i.flags||[]), tradable:1,
      }));
      db.upsertItems(rows);
      rows.forEach(i => itemMap[i.id] = i);
    }

    // ── Step 4: Filter to salvageable items at or above minRarity ───────────
    const equippable = rawItems.filter(slot => {
      const item = itemMap[slot.id];
      if (!item) return false;
      return (RARITY_ORDER[item.rarity] || 0) >= minRarity;
    });

    console.log(`[Salvage] ${equippable.length} equippable items after rarity filter`);
    if (!equippable.length) return res.json({ ok:true, items:[], ectoPrice:0 });

    // ── Step 5: Fetch TP prices — use DB cache, only refresh stale ones ─────
    // Collect all IDs we need prices for upfront (items + upgrades + ecto)
    const upgradeIds      = [...new Set(equippable.filter(s=>s.upgrades&&s.upgrades[0]).map(s=>s.upgrades[0]))];
    const allPriceIds     = [...new Set([...equippable.map(s=>s.id), ...upgradeIds, ECTO_ID])];

    // Use cached prices where available — only refresh what's stale
    await refreshPrices(allPriceIds);

    const priceRows = db.getPricesByIds(allPriceIds);
    const priceMap  = {};
    priceRows.forEach(p => priceMap[p.item_id] = p);

    const ectoPrice  = priceMap[ECTO_ID]?.buy_price || 0;
    const ectoSellEV = ectoPrice * ECTO_RATE;

    // Resolve upgrade item names from DB
    const upgradeDbItems = db.getItemsByIds(upgradeIds);
    const upgradeItemMap = {};
    upgradeDbItems.forEach(i => upgradeItemMap[i.id] = i);

    // Fetch any upgrade items missing from DB
    const missingUpgrades = upgradeIds.filter(id => !upgradeItemMap[id]);
    if (missingUpgrades.length) {
      const fetched = await fetchItems(missingUpgrades);
      fetched.filter(i=>i&&i.id).forEach(i => {
        upgradeItemMap[i.id] = i;
        db.upsertItems([{ id:i.id, name:i.name, icon:i.icon||null, rarity:i.rarity||'Basic', vendor_value:i.vendor_value||0, flags:JSON.stringify(i.flags||[]), tradable:1 }]);
      });
    }

    const results = equippable.map(slot => {
      const item    = itemMap[slot.id];
      if (!item) return null;

      const itemPrice   = priceMap[slot.id];
      const flags       = JSON.parse(item.flags || '[]');
      const isSoulbound = flags.includes('SoulbindOnAcquire') || flags.includes('AccountBound') || slot.binding === 'Soulbound' || slot.binding === 'Account';
      const tpSellValue = isSoulbound ? 0 : Math.floor((itemPrice?.buy_price||0) * (1 - TP_FEE));

      // Salvage EV: ectos (for Rare/Exotic lv68+) + some base mats
      // We use ecto EV as primary signal; base mats add ~3-8s but vary heavily
      const rarityNum = RARITY_ORDER[item.rarity] || 0;
      const canEcto   = rarityNum >= 3 && !isSoulbound; // Rare+
      const salvageEV = canEcto
        ? Math.floor(ectoSellEV * (1 - TP_FEE))  // sell ectos on TP
        : Math.floor((item.vendor_value||0) * 1.2); // rough mat estimate for lower rarity

      // Upgrade value
      const upgradeId    = slot.upgrades && slot.upgrades[0];
      const upgradeItem  = upgradeId ? upgradeItemMap[upgradeId] : null;
      const upgradePrice = upgradeId ? priceMap[upgradeId] : null;
      const upgradeValue = upgradePrice ? Math.floor(upgradePrice.buy_price * (1 - TP_FEE)) : 0;



      // ── Determine best kit and action ──────────────────────────────────────
      // Work out the best EV for each available kit the user owns
      const kitOptions = [];

      if (ownedKits.copper && rarityNum <= 2) {
        // Copper-fed: only good for Fine/Masterwork and below
        const ev = calcSalvageEV(item, kits.copper, ectoPrice, 0);
        kitOptions.push({ kit: 'copper', action: 'salvage', ev: ev.totalEV, label: 'Salvage (Copper-fed)' });
      }

      // Silver-fed or Master's — equivalent rates, pick whichever user has
      const hasEctoKit = ownedKits.silver || ownedKits.masters;
      if (hasEctoKit && canEcto) {
        const kit = ownedKits.silver ? kits.silver : kits.masters;
        const ev  = calcSalvageEV(item, kit, ectoPrice, 0);
        kitOptions.push({ kit: kit.id, action: 'salvage', ev: ev.totalEV, label: `Salvage (${kit.shortName})` });
      }

      // Black Lion: use when upgrade is worth recovering
      if (ownedKits.blacklion && upgradeValue > 0) {
        const ev = calcSalvageEV(item, kits.blacklion, ectoPrice, upgradeValue);
        if (ev.totalEV > 0) {
          kitOptions.push({ kit: 'blacklion', action: 'extract', ev: ev.totalEV, label: 'Extract upgrade (Black Lion Kit)' });
        }
      }

      // TP sell value
      if (!isSoulbound && tpSellValue > 0) {
        kitOptions.push({ kit: null, action: 'sell', ev: tpSellValue, label: 'Sell on Trading Post' });
      }

      // Vendor value as last resort
      if (item.vendor_value > 0) {
        kitOptions.push({ kit: null, action: 'vendor', ev: item.vendor_value, label: 'Sell to vendor' });
      }

      // Pick the best option
      kitOptions.sort((a,b) => b.ev - a.ev);
      const best = kitOptions[0] || { action: 'none', ev: 0, label: 'No profitable action' };

      const action           = best.action;
      const recommendedValue = Math.max(0, best.ev);
      const recommendedLabel = best.label;
      const recommendedKit   = best.kit;

      // Also compute BL extract EV for display even if not best
      const extractTotalEV = (ownedKits.blacklion && upgradeValue > 0)
        ? Math.max(0, calcSalvageEV(item, kits.blacklion, ectoPrice, upgradeValue).totalEV)
        : 0;

      return {
        id: slot.id,
        name: item.name,
        icon: item.icon,
        rarity: item.rarity,
        location: slot.location,
        isSoulbound,
        tpSellValue,
        salvageEV,
        upgradeValue,
        upgradeId,
        upgradeName: upgradeItem?.name || null,
        extractTotalEV,
        action,
        recommendedValue,
        recommendedLabel,
        recommendedKit,
        allOptions: kitOptions,
      };
    }).filter(Boolean);

    // Sort by recommended value descending
    results.sort((a,b) => b.recommendedValue - a.recommendedValue);

    res.json({ ok:true, items:results, ectoPrice });
  } catch(e) {
    console.error('[Salvage]', e);
    res.status(500).json({ error:e.message });
  }
});

// ── Materials viewer ──────────────────────────────────────────────────────────
app.post('/api/materials', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error:'apiKey required' });
  try {
    const materials = await getAccountMaterials(apiKey);
    const withItems = materials.filter(m=>m.count>0);
    const ids       = withItems.map(m=>m.id);
    const dbItems   = db.getItemsByIds(ids);
    const dbMap     = {};
    dbItems.forEach(i => dbMap[i.id]=i);
    const missing   = ids.filter(id=>!dbMap[id]);
    if (missing.length) {
      const fetched = await fetchItems(missing);
      const rows = fetched.filter(i=>i&&i.id).map(i=>({ id:i.id, name:i.name, icon:i.icon||null, rarity:i.rarity||'Basic', vendor_value:i.vendor_value||0, flags:JSON.stringify(i.flags||[]), tradable:1 }));
      db.upsertItems(rows);
      rows.forEach(i=>dbMap[i.id]=i);
    }
    res.json({ ok:true, materials: withItems.map(m=>({ id:m.id, count:m.count, name:dbMap[m.id]?.name||`Item #${m.id}`, icon:dbMap[m.id]?.icon||null, rarity:dbMap[m.id]?.rarity||'Basic' })).sort((a,b)=>a.name.localeCompare(b.name)) });
  } catch(e) { res.status(500).json({ error:e.message }); }
});


// ── Price history API ─────────────────────────────────────────────────────────

// Single item history
app.get('/api/history/:itemId', (req, res) => {
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

// Batch history for multiple items (used by craft results)
app.post('/api/history/batch', (req, res) => {
  const { itemIds, days = 7 } = req.body;
  if (!Array.isArray(itemIds) || !itemIds.length) return res.status(400).json({ error: 'itemIds required' });
  const limitedDays = Math.min(days, 30);
  const history     = db.getPriceHistoryBatch(itemIds, limitedDays);
  res.json({ ok: true, history, days: limitedDays });
});

// History stats
app.get('/api/history/stats', (req, res) => {
  const count = db.getHistoryCount();
  // Rough size estimate: each row ~16 bytes
  const estimatedMB = ((count * 16) / 1024 / 1024).toFixed(2);
  res.json({ ok: true, rowCount: count, estimatedMB, maxDays: 30 });
});


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

    // Fetch fresh prices from GW2 API
    const { fetchPrices } = require('./gw2api');
    const prices = await fetchPrices(ids);
    const rows   = prices.map(p => ({
      item_id:    p.id,
      buy_price:  (p.buys  && p.buys.unit_price)  || 0,
      sell_price: (p.sells && p.sells.unit_price) || 0,
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
  // Calculate ms until next top of hour
  const now          = Date.now();
  const nextHour     = Math.ceil(now / 3600000) * 3600000;
  const msUntilHour  = nextHour - now;

  console.log(`[Scheduler] First snapshot in ${Math.round(msUntilHour / 60000)} minutes`);

  setTimeout(() => {
    runHourlySnapshot();
    // Then every hour exactly
    setInterval(runHourlySnapshot, 3600000);
  }, msUntilHour);
}

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  await db.getDb();

  // Prune any history older than 30 days on startup
  db.pruneOldHistory();

  app.listen(PORT, () => {
    console.log(`\n🗡️  GW2 Tools running at http://localhost:${PORT}`);
    console.log('   Press Ctrl+C to stop\n');
  });

  // Start hourly snapshot scheduler
  scheduleHourlySnapshots();
}
start().catch(e => { console.error('Failed to start:', e); process.exit(1); });
