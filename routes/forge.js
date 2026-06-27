const express = require('express');
const router  = express.Router();
const db = require('../db');

router.get('/', (req, res) => {
  try {
    res.json({ ok: true, ...db.getMysticForgeRolls() });
  } catch(e) {
    console.error('[Forge]', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
