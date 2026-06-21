// profit.js — Core crafting profit calculation engine

const db   = require('./db');
const { fetchPrices } = require('./gw2api');

const TP_FEE         = 0.15;
const PRICE_CACHE_TTL = 300; // 5 minutes

async function calcProfitableRecipes(materialStorage, unlockedRecipeIds, opts = {}) {
  const { disciplines=[], minProfit=1, includePartial=true, maxMissingCost=Infinity } = opts;

  const matMap = {};
  for (const m of materialStorage) matMap[m.id] = (matMap[m.id] || 0) + m.count;

  const unlockedSet  = new Set(unlockedRecipeIds);
  const allRecipes   = db.getAllRecipes();
  const priceItemIds = new Set();
  const recipeParsed = [];

  for (const recipe of allRecipes) {
    const ings  = JSON.parse(recipe.ingredients);
    const discs = JSON.parse(recipe.disciplines);
    if (disciplines.length > 0 && !discs.some(d => disciplines.includes(d))) continue;
    priceItemIds.add(recipe.output_item_id);
    for (const ing of ings) priceItemIds.add(ing.id);
    recipeParsed.push({ ...recipe, ingredients: ings, disciplines: discs, unlocked: unlockedSet.has(recipe.id) });
  }

  await refreshPrices([...priceItemIds]);

  const priceRows = db.getPricesByIds([...priceItemIds]);
  const priceMap  = {};
  for (const p of priceRows) priceMap[p.item_id] = p;

  const itemRows = db.getItemsByIds([...priceItemIds]);
  const itemMap  = {};
  for (const i of itemRows) itemMap[i.id] = i;

  const results = [];

  for (const recipe of recipeParsed) {
    const outputItem  = itemMap[recipe.output_item_id];
    if (!outputItem || !outputItem.tradable) continue;
    const outputPrice = priceMap[recipe.output_item_id];
    if (!outputPrice || outputPrice.buy_price === 0) continue;

    const sellValue = Math.floor(outputPrice.buy_price  * recipe.output_count * (1 - TP_FEE));
    const listValue = Math.floor(outputPrice.sell_price * recipe.output_count * (1 - TP_FEE));

    let matCostFromStorage = 0, matCostToBuy = 0, totalIngredientValue = 0;
    let canCraft = true, missingIngredients = [], allIngredients = [];

    for (const ing of recipe.ingredients) {
      const have      = matMap[ing.id] || 0;
      const need      = ing.count;
      const ingItem   = itemMap[ing.id];
      const ingPrice  = priceMap[ing.id];
      const ingSellPrice = ingPrice ? ingPrice.buy_price : (ingItem ? ingItem.vendor_value : 0);
      totalIngredientValue += ingSellPrice * need;

      if (have >= need) {
        matCostFromStorage += ingSellPrice * need;
        allIngredients.push({ id:ing.id, name:ingItem?ingItem.name:`Item #${ing.id}`, icon:ingItem?ingItem.icon:null, need, have, fromStorage:need, buyCount:0, unitPrice:ingSellPrice });
      } else {
        const fromStorage = have;
        const toBuy       = need - have;
        const buyPrice    = ingPrice ? ingPrice.sell_price : 0;
        if (buyPrice === 0 && toBuy > 0) {
          canCraft = false;
          allIngredients.push({ id:ing.id, name:ingItem?ingItem.name:`Item #${ing.id}`, icon:ingItem?ingItem.icon:null, need, have, fromStorage, buyCount:toBuy, unitPrice:0, unavailable:true });
          continue;
        }
        matCostToBuy       += buyPrice * toBuy;
        matCostFromStorage += ingSellPrice * fromStorage;
        allIngredients.push({ id:ing.id, name:ingItem?ingItem.name:`Item #${ing.id}`, icon:ingItem?ingItem.icon:null, need, have, fromStorage, buyCount:toBuy, unitPrice:buyPrice });
        if (toBuy > 0) missingIngredients.push(allIngredients[allIngredients.length-1]);
      }
    }

    const isFullyCraftable = missingIngredients.length === 0 && canCraft;
    if (!isFullyCraftable && !includePartial) continue;
    if (!isFullyCraftable && !canCraft) continue;
    if (!isFullyCraftable && matCostToBuy > maxMissingCost) continue;

    const totalCost      = matCostFromStorage + matCostToBuy;
    const profitVsRaw    = sellValue - totalIngredientValue;
    const profitAbsolute = sellValue - matCostToBuy;
    if (profitAbsolute < minProfit && profitVsRaw < minProfit) continue;

    results.push({
      recipeId: recipe.id,
      outputItemId: recipe.output_item_id,
      outputItemName: outputItem.name,
      outputItemIcon: outputItem.icon,
      outputRarity: outputItem.rarity,
      outputCount: recipe.output_count,
      disciplines: recipe.disciplines,
      unlocked: recipe.unlocked,
      isFullyCraftable,
      sellInstant: outputPrice.buy_price * recipe.output_count,
      sellInstantAfterFees: sellValue,
      sellList: outputPrice.sell_price * recipe.output_count,
      sellListAfterFees: listValue,
      buyQuantity:  outputPrice.buy_quantity  || 0,
      sellQuantity: outputPrice.sell_quantity || 0,
      matCostFromStorage, matCostToBuy, totalCost,
      profitVsRaw, profitAbsolute,
      profitMargin: totalCost > 0 ? ((sellValue - totalCost) / totalCost * 100).toFixed(1) : 'inf',
      allIngredients, missingIngredients,
    });
  }

  results.sort((a,b) => b.profitVsRaw - a.profitVsRaw);
  return results;
}

async function refreshPrices(itemIds) {
  const now    = Math.floor(Date.now() / 1000);
  const cutoff = now - PRICE_CACHE_TTL;

  const existing    = db.getPricesByIds(itemIds);
  const existingMap = {};
  for (const p of existing) existingMap[p.item_id] = p;

  const toRefresh = itemIds.filter(id => {
    const p = existingMap[id];
    return !p || p.updated_at < cutoff;
  });

  if (toRefresh.length === 0) return;
  console.log(`[Prices] Refreshing ${toRefresh.length} prices...`);

  try {
    const prices = await fetchPrices(toRefresh);
    const rows   = prices.map(p => ({
      item_id:      p.id,
      buy_price:    (p.buys  && p.buys.unit_price)  || 0,
      sell_price:   (p.sells && p.sells.unit_price) || 0,
      buy_quantity: (p.buys  && p.buys.quantity)    || 0,
      sell_quantity:(p.sells && p.sells.quantity)   || 0,
    }));

    db.upsertPrices(rows);

    // Record hourly history snapshot (change-detection inside)
    db.recordHistoryIfChanged(rows);

    // Items not returned have no TP listing — cache as zero so we don't re-request
    const returnedIds = new Set(prices.map(p => p.id));
    const noListing   = toRefresh.filter(id => !returnedIds.has(id));
    if (noListing.length) {
      db.upsertPrices(noListing.map(id => ({ item_id:id, buy_price:0, sell_price:0 })));
      console.log(`[Prices] ${noListing.length} items have no TP listing (cached)`);
    }
  } catch (err) {
    if (err.message.indexOf('404') !== -1 || err.message.indexOf('all ids provided are invalid') !== -1) {
      db.upsertPrices(toRefresh.map(id => ({ item_id:id, buy_price:0, sell_price:0 })));
      console.log(`[Prices] Batch had no TP listings — ${toRefresh.length} items marked untradeable`);
    } else {
      console.warn('[Prices] Refresh failed (will use cached):', err.message);
    }
  }
}

function formatCopper(copper) {
  if (copper === 0 || copper == null) return '0c';
  const sign = copper < 0 ? '-' : '';
  const abs  = Math.abs(copper);
  const g = Math.floor(abs/10000), s = Math.floor((abs%10000)/100), c = abs%100;
  const parts = [];
  if (g) parts.push(g+'g');
  if (s) parts.push(s+'s');
  if (c) parts.push(c+'c');
  return sign + (parts.length ? parts.join(' ') : '0c');
}

module.exports = { calcProfitableRecipes, refreshPrices, formatCopper };
