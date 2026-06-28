// Proxies the GW2 wiki's public MediaWiki search API server-side (avoids any
// CORS issues calling it directly from the renderer, same pattern as gw2api.js).
const express     = require('express');
const router      = express.Router();
const fetch       = require('node-fetch');

const WIKI_BASE = 'https://wiki.guildwars2.com';

router.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ ok: true, results: [] });
  try {
    const url  = `${WIKI_BASE}/api.php?action=opensearch&search=${encodeURIComponent(q)}&format=json&limit=12`;
    const data = await fetch(url).then(r => r.json());
    const titles = data[1] || [];
    const urls   = data[3] || [];
    const results = titles.map((title, i) => ({ title, url: urls[i] }));
    res.json({ ok: true, results });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
