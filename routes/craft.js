const express = require('express');
const router  = express.Router();
const { getAccountMaterials, getAccountRecipes } = require('../gw2api');
const { calcProfitableRecipes, formatCopper }     = require('../profit');
const db = require('../db');

router.post('/analyze', async (req, res) => {
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

module.exports = router;
