const express = require('express');
const router  = express.Router();
const { getAccountMaterials, apiFetch, fetchItems } = require('../gw2api');
const { refreshPrices } = require('../profit');
const { SALVAGE_KITS, calcSalvageEV } = require('../salvage-kits');
const db = require('../db');

const TP_FEE    = 0.15;
const ECTO_ID   = 19721;  // Glob of Ectoplasm
const ECTO_RATE = 0.875;  // avg ectos per salvage of Rare/Exotic lv68+ (community-verified, master/mystic kit)

router.post('/salvage', async (req, res) => {
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

    // Fetch anything missing entirely OR missing its item_type. The latter matters here:
    // type-backfill normally only runs for items that show up in tp_prices, but soulbound/
    // account-bound gear (exactly what people salvage) never gets TP-listed, so it never
    // gets typed through that path — we need the type to filter correctly below.
    const needsFetch = uniqueItemIds.filter(id => !itemMap[id] || !itemMap[id].item_type);
    if (needsFetch.length) {
      console.log(`[Salvage] Fetching ${needsFetch.length} items missing data/type from API...`);
      const fetched = await fetchItems(needsFetch);
      const rows = fetched.filter(i=>i&&i.id).map(i=>({
        id:i.id, name:i.name, icon:i.icon||null, rarity:i.rarity||'Basic',
        vendor_value:i.vendor_value||0, flags:JSON.stringify(i.flags||[]), tradable:1,
      }));
      db.upsertItems(rows);
      const typed = fetched.filter(i => i && i.id && i.type).map(i => ({
        id: i.id, type: i.type, subtype: (i.details && i.details.type) || null,
      }));
      db.updateItemTypes(typed);
      // Merge type into itemMap directly — db.updateItemTypes only writes when NULL,
      // but we need it in this in-memory map right now regardless of what was already stored.
      fetched.forEach(i => {
        if (i && i.id) {
          itemMap[i.id] = { ...(itemMap[i.id] || {}), id: i.id, name: i.name, icon: i.icon||null,
            rarity: i.rarity||'Basic', vendor_value: i.vendor_value||0,
            flags: JSON.stringify(i.flags||[]), tradable: 1, item_type: i.type || null };
        }
      });
    }

    // ── Step 4: Filter to salvageable items at or above minRarity ───────────
    // Salvageable equipment slots per the GW2 wiki: Weapon, Armor, Back, Trinket — rarity
    // doesn't restrict eligibility for those. The real exclusions (starter gear, karma/coin
    // purchases, level rewards) are encoded by ArenaNet via the NoSalvage flag, not by type/rarity.
    const SALVAGEABLE_TYPES = new Set(['Weapon', 'Armor', 'Back', 'Trinket']);
    const equippable = rawItems.filter(slot => {
      const item = itemMap[slot.id];
      if (!item) return false;
      if ((RARITY_ORDER[item.rarity] || 0) < minRarity) return false;
      if (!SALVAGEABLE_TYPES.has(item.item_type)) return false;
      const flags = JSON.parse(item.flags || '[]');
      if (flags.includes('NoSalvage')) return false;
      return true;
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

router.post('/materials', async (req, res) => {
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

module.exports = router;
