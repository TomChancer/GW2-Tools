// app.js — GW2 Tools frontend

// ── Constants ────────────────────────────────────────────────────────────────
const DISCIPLINES = ['Weaponsmith','Armorsmith','Leatherworker','Tailor','Jeweler','Chef','Artificer','Huntsman','Scribe'];

const RARITY_ID = { Basic:0, Fine:1, Masterwork:2, Rare:3, Exotic:4, Ascended:5, Legendary:6 };
const RARITY_NAME = ['Basic','Fine','Masterwork','Rare','Exotic','Ascended','Legendary'];

// GW2 item IDs for key salvage outputs
const ECTO_ID    = 19721;
const TP_FEE     = 0.15;

// Salvage EV per rarity (master/mystic kit, level 68+)
// Source: community-verified rates
const SALVAGE_EV = {
  // Rare lv68+: 0.875 ectos expected
  Rare:   { ectoChance: 0.875 },
  // Exotic: 0–5 ectos, avg ~1.0–1.5 depending on item level; use conservative 0.875
  Exotic: { ectoChance: 0.875 },
};

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  apiKey: '',
  activeTab: 'crafts',
  analyzing: false,
  // Crafts
  disciplines: new Set(DISCIPLINES),
  includePartial: true,
  hideUnowned: false,
  craftResults: [],
  sortKey: 'profitVsRaw',
  historyCache: {}, // outputItemId → [{t,b,s}] — populated after analyze
  // Salvage
  includeBank: true,
  includeBags: true,
  profitableOnly: true,
  minRarity: 3,
  salvageResults: [],
};

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  buildDiscGrid();
  bindEvents();
  checkDbStatus();
  const saved = sessionStorage.getItem('gw2_api_key');
  if (saved) { document.getElementById('apiKeyInput').value = saved; state.apiKey = saved; }
});

// ── DB status ────────────────────────────────────────────────────────────────
async function checkDbStatus() {
  const dot = document.getElementById('dbStatusDot');
  const txt = document.getElementById('dbStatusText');
  try {
    const data = await apiFetch('/api/status');
    if (data.seeded) {
      dot.className = 'status-dot ok';
      txt.textContent = `DB ready — ${data.recipeCount.toLocaleString()} recipes`;
    } else {
      dot.className = 'status-dot warn';
      txt.textContent = 'DB not seeded — run: node seed.js';
    }
  } catch {
    dot.className = 'status-dot err';
    txt.textContent = 'Server offline';
  }
}

// ── Tab switching ────────────────────────────────────────────────────────────
function bindEvents() {
  // Tabs
  document.querySelectorAll('.tab[data-tab]').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // API key
  const keyInput = document.getElementById('apiKeyInput');
  keyInput.addEventListener('input', () => {
    state.apiKey = keyInput.value.trim();
    sessionStorage.setItem('gw2_api_key', state.apiKey);
    document.getElementById('keyStatus').className = 'key-status';
  });
  document.getElementById('validateBtn').addEventListener('click', validateKey);

  // Craft controls
  document.getElementById('partialToggle').addEventListener('click', () => {
    state.includePartial = !state.includePartial;
    document.getElementById('partialToggle').classList.toggle('on', state.includePartial);
  });
  document.getElementById('unownedToggle').addEventListener('click', () => {
    state.hideUnowned = !state.hideUnowned;
    document.getElementById('unownedToggle').classList.toggle('on', !state.hideUnowned);
    if (state.craftResults.length) renderCraftResults(state.craftResults);
  });
  document.getElementById('sortSelect').addEventListener('change', e => {
    state.sortKey = e.target.value;
    if (state.craftResults.length) renderCraftResults(state.craftResults);
  });
  document.getElementById('analyzeBtn').addEventListener('click', runCraftAnalysis);
  document.getElementById('materialsBtn').addEventListener('click', viewMaterials);

  // Salvage controls
  document.getElementById('bankToggle').addEventListener('click', () => {
    state.includeBank = !state.includeBank;
    document.getElementById('bankToggle').classList.toggle('on', state.includeBank);
  });
  document.getElementById('bagsToggle').addEventListener('click', () => {
    state.includeBags = !state.includeBags;
    document.getElementById('bagsToggle').classList.toggle('on', state.includeBags);
  });
  document.getElementById('profitableOnlyToggle').addEventListener('click', () => {
    state.profitableOnly = !state.profitableOnly;
    document.getElementById('profitableOnlyToggle').classList.toggle('on', state.profitableOnly);
    if (state.salvageResults.length) renderSalvageResults(state.salvageResults);
  });
  document.getElementById('minRaritySelect').addEventListener('change', e => {
    state.minRarity = parseInt(e.target.value);
  });
  document.getElementById('salvageBtn').addEventListener('click', runSalvageAnalysis);
  document.getElementById('blKitCost').addEventListener('input', e => {
    document.getElementById('blKitCostDisplay').textContent = (parseInt(e.target.value)||500) + 'c/use';
  });
}

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(el => el.classList.toggle('active', el.id === `tabpanel-${tab}`));
  document.querySelectorAll('.sidebar-panel').forEach(el => el.classList.toggle('active', el.id === `panel-${tab}`));
}

// ── API key validation ────────────────────────────────────────────────────────
async function validateKey() {
  if (!state.apiKey) { setKeyStatus('err','Enter a key first'); return; }
  setKeyStatus('','Validating…');
  try {
    const data = await apiFetch('/api/validate-key', { apiKey: state.apiKey });
    if (data.ok) {
      const p = data.permissions || [];
      const ok = p.includes('inventories') && p.includes('unlocks');
      ok ? setKeyStatus('ok', `✓ ${data.name}`) : setKeyStatus('err', 'Missing permissions');
    } else { setKeyStatus('err','Invalid key'); }
  } catch(e) { setKeyStatus('err', e.message); }
}
function setKeyStatus(t,m) {
  const el = document.getElementById('keyStatus');
  el.textContent = m; el.className = `key-status ${t}`;
}

// ── Discipline grid ───────────────────────────────────────────────────────────
function buildDiscGrid() {
  const grid = document.getElementById('discGrid');
  const all = document.createElement('div');
  all.className = 'disc-check checked'; all.style.gridColumn = 'span 2';
  all.textContent = 'All disciplines'; all.dataset.disc = 'all';
  grid.appendChild(all);
  DISCIPLINES.forEach(d => {
    const btn = document.createElement('div');
    btn.className = 'disc-check checked'; btn.textContent = d; btn.dataset.disc = d;
    grid.appendChild(btn);
  });
  grid.addEventListener('mousedown', e => {
    e.preventDefault();
    const btn = e.target.closest('.disc-check');
    if (!btn) return;
    const disc = btn.dataset.disc;
    if (disc === 'all') {
      state.disciplines.size === DISCIPLINES.length ? state.disciplines.clear() : DISCIPLINES.forEach(d => state.disciplines.add(d));
    } else {
      state.disciplines.has(disc) ? state.disciplines.delete(disc) : state.disciplines.add(disc);
    }
    grid.querySelectorAll('.disc-check').forEach(el => {
      el.classList.toggle('checked', el.dataset.disc === 'all' ? state.disciplines.size === DISCIPLINES.length : state.disciplines.has(el.dataset.disc));
    });
  });
}

// ── CRAFTS ───────────────────────────────────────────────────────────────────
async function runCraftAnalysis() {
  if (!state.apiKey) { showTabBanner('crafts','err','Enter your API key first.'); return; }
  if (state.analyzing) return;
  state.analyzing = true;
  const btn = document.getElementById('analyzeBtn');
  btn.disabled = true; btn.textContent = '⏳ Analyzing…';
  setTabLoading('crafts', 'Fetching material storage & recipes…');

  try {
    const data = await apiFetch('/api/analyze', {
      apiKey: state.apiKey,
      disciplines: state.disciplines.size === DISCIPLINES.length ? [] : [...state.disciplines],
      minProfit: Math.round((parseFloat(document.getElementById('minProfitInput').value)||0) * 10000),
      includePartial: state.includePartial,
      maxMissingCost: Math.round((parseFloat(document.getElementById('maxBuyInput').value)||100) * 10000),
      limit: parseInt(document.getElementById('limitInput').value)||100,
      hideUnowned: state.hideUnowned,
    });
    state.craftResults = data.results;
    renderCraftResults(data.results, data.total);
  } catch(e) {
    setTabContent('crafts', `<div class="banner err">Analysis failed: ${escHtml(e.message)}</div>`);
  } finally {
    state.analyzing = false;
    btn.disabled = false; btn.textContent = '⚒ Analyze Crafts';
  }
}

function renderCraftResults(results, total) {
  let filtered = state.hideUnowned ? results.filter(r => r.unlocked || r.isFullyCraftable) : results;
  const sorted = [...filtered].sort((a,b) => {
    if (state.sortKey === 'matCostToBuy') return a[state.sortKey] - b[state.sortKey];
    if (state.sortKey === 'spread') {
      return (b.buyQuantity || 0) - (a.buyQuantity || 0);
    }
    return b[state.sortKey] - a[state.sortKey];
  });
  const full    = sorted.filter(r => r.isFullyCraftable);
  const partial = sorted.filter(r => !r.isFullyCraftable);

  let html = `
    <div class="results-header">
      <h2>Profitable Crafts</h2>
      <span class="results-meta">
        ${sorted.length} shown${total && total > sorted.length ? ` of ${total.toLocaleString()}` : ''}
        &nbsp;·&nbsp;<span style="color:var(--green)">${full.length} from storage</span>
        &nbsp;·&nbsp;<span style="color:var(--blue)">${partial.length} need mats</span>
      </span>
    </div>`;

  if (!sorted.length) {
    html += `<div class="banner info">No profitable crafts found. Try adjusting the filters.</div>`;
    setTabContent('crafts', html); return;
  }

  if (full.length) {
    html += `<div class="section-label">✓ Fully craftable from storage</div><div class="recipe-list">`;
    full.forEach(r => html += renderCraftCard(r));
    html += `</div>`;
  }
  if (partial.length) {
    html += `<div class="section-label" style="margin-top:12px;">🛒 Requires buying ingredients</div><div class="recipe-list">`;
    partial.forEach(r => html += renderCraftCard(r));
    html += `</div>`;
  }

  setTabContent('crafts', html);

  const resultMap = {};
  sorted.forEach(r => resultMap[r.recipeId] = r);

  document.querySelectorAll('#tabpanel-crafts .recipe-header').forEach(h => {
    h.addEventListener('click', () => {
      const card = h.closest('.recipe-card');
      card.classList.toggle('expanded');
      if (card.classList.contains('expanded')) {
        const mktDiv = document.getElementById(`mkt-${card.dataset.id}`);
        if (mktDiv && !mktDiv.dataset.loaded) {
          const r = resultMap[parseInt(card.dataset.id)];
          if (r) renderMarketDetail(mktDiv, r, state.historyCache[r.outputItemId] || []);
          mktDiv.dataset.loaded = '1';
        }
      }
    });
  });

  // Fetch 7-day trend data for output items and annotate cards
  fetchAndApplyTrends(sorted);
}

async function fetchAndApplyTrends(results) {
  if (!results.length) return;
  try {
    const itemIds = [...new Set(results.map(r => r.outputItemId))];
    const data    = await apiFetch('/api/history/batch', { itemIds, days: 7 });
    const history = data.history || {};

    // Cache for use in expanded market detail panels
    Object.assign(state.historyCache, history);

    results.forEach(r => {
      const h = history[r.outputItemId];

      // Trend badge (direction arrow)
      if (!h || h.length < 2) return;
      const first = h[0].s, last = h[h.length-1].s;
      if (!first || !last) return;
      const pct    = ((last - first) / first * 100);
      const absPct = Math.abs(pct).toFixed(1);
      const isUp   = pct > 1, isDown = pct < -1;
      if (!isUp && !isDown) return;

      const arrow = isUp ? '↑' : '↓';
      const color = isUp ? 'var(--green)' : 'var(--red)';
      const card  = document.querySelector(`[data-id="${r.recipeId}"] .item-meta`);
      if (card) {
        const badge = document.createElement('span');
        badge.className = 'tag';
        badge.style.cssText = `background:transparent;color:${color};font-weight:600;`;
        badge.title = `Sell price ${isUp ? 'up' : 'down'} ${absPct}% over last 7 days`;
        badge.textContent = `${arrow} ${absPct}% 7d`;
        card.appendChild(badge);
      }
    });
  } catch (e) {
    // History not available yet (no data collected) — silently skip
  }
}

function renderCraftCard(r) {
  const icon = r.outputItemIcon
    ? `<img class="item-icon" src="${r.outputItemIcon}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : `<div class="item-icon-placeholder">⚒</div>`;
  const profCls = r.profitVsRaw > 0 ? '' : r.profitVsRaw < 0 ? ' negative' : ' zero';
  const discs   = r.disciplines.slice(0,2).map(d=>`<span class="tag tag-disc">${d}</span>`).join('');
  const maxC    = r.isFullyCraftable ? calcMaxCraftable(r) : null;

  // Liquidity: classify by buy order depth (demand) and supply pressure
  const buyQty  = r.buyQuantity  || 0;
  const sellQty = r.sellQuantity || 0;
  let liqTier, liqTitle;
  if (buyQty === 0) {
    liqTier  = null;
  } else if (buyQty >= 500 && sellQty <= buyQty * 5) {
    liqTier  = 'liquid';
    liqTitle = `${buyQty.toLocaleString()} buy orders · ${sellQty.toLocaleString()} listings — active market`;
  } else if (buyQty >= 50) {
    liqTier  = 'slow';
    liqTitle = `${buyQty.toLocaleString()} buy orders · ${sellQty.toLocaleString()} listings — moderate demand`;
  } else {
    liqTier  = 'stale';
    liqTitle = `Only ${buyQty.toLocaleString()} buy orders · ${sellQty.toLocaleString()} listings — weak demand`;
  }
  const liqLabels = { liquid: '● Liquid', slow: '● Slow', stale: '● Stale' };
  const liqTag = liqTier
    ? `<span class="tag liq-tag liq-${liqTier}" data-liq="${r.recipeId}" title="${liqTitle}">${liqLabels[liqTier]}</span>`
    : '';

  const ingRows = r.allIngredients.map(ing => {
    let sc, st;
    if (ing.unavailable)                        { sc='missing'; st='N/A'; }
    else if (ing.buyCount>0 && ing.fromStorage>0){ sc='buy'; st=`Have ${ing.fromStorage}, buy ${ing.buyCount}`; }
    else if (ing.buyCount>0)                    { sc='buy'; st=`Buy ${ing.buyCount}`; }
    else                                         { sc='have'; st=`Have ${ing.have}`; }
    const ico = ing.icon ? `<img class="ing-icon" src="${ing.icon}" alt="" loading="lazy" onerror="this.style.display='none'">` : `<div class="ing-icon"></div>`;
    const buyStr = ing.buyCount>0&&ing.unitPrice>0 ? `<span class="ing-buy" style="color:var(--blue)">${formatCopper(ing.unitPrice*ing.buyCount)}</span>` : '';
    return `<div class="ingredient-row">${ico}<span class="ing-name">${escHtml(ing.name)}</span><span class="ing-count">×${ing.need}</span>${buyStr}<span class="ing-status ${sc}">${st}</span></div>`;
  }).join('');

  const pl = r.profitVsRaw>=0?'profit-positive':'profit-negative';
  const detail = `<div class="recipe-detail">
    <div class="recipe-detail-top">
      <div class="detail-section"><h4>Ingredients (×${r.outputCount} output)</h4>${ingRows||'<span style="color:var(--text-muted);font-size:12px;">No data</span>'}</div>
      <div class="detail-section"><h4>Price Breakdown</h4><div class="price-breakdown">
        <div class="price-row"><span class="price-row-label">Sell instant (after 15% tax)</span><span class="price-row-value">${r.fmt.sellInstantAfterFees}</span></div>
        <div class="price-row"><span class="price-row-label">Sell listing (after 15% tax)</span><span class="price-row-value" style="color:var(--text-secondary)">${r.fmt.sellListAfterFees}</span></div>
        <div class="price-row"><span class="price-row-label">Mats to buy from TP</span><span class="price-row-value" style="color:${r.matCostToBuy>0?'var(--red)':'var(--text-muted)'}">${r.matCostToBuy>0?r.fmt.matCostToBuy:'—'}</span></div>
        <div class="price-row total"><span class="price-row-label">Profit vs selling mats raw</span><span class="price-row-value ${pl}">${r.fmt.profitVsRaw}</span></div>
        <div class="price-row total"><span class="price-row-label">Cash profit (sell − buy only)</span><span class="price-row-value ${r.profitAbsolute>=0?'profit-positive':'profit-negative'}">${r.fmt.profitAbsolute}</span></div>
        <div class="price-row"><span class="price-row-label">Profit margin</span><span class="price-row-value">${r.profitMargin}%</span></div>
        ${maxC!==null?`<div class="price-row total" style="margin-top:4px;border-top:1px solid var(--border)"><span class="price-row-label">Max craftable from storage</span><span class="price-row-value" style="color:var(--green)">×${maxC}</span></div>
        <div class="price-row"><span class="price-row-label">Total profit if all crafted</span><span class="price-row-value ${r.profitVsRaw>=0?'profit-positive':'profit-negative'}">${formatCopper(r.profitVsRaw*maxC)}</span></div>`:''}
      </div></div>
    </div>
    <div class="recipe-detail-market" id="mkt-${r.recipeId}"></div>
  </div>`;

  return `<div class="recipe-card${liqTier ? ` liq-${liqTier}` : ''}" data-id="${r.recipeId}" data-output-id="${r.outputItemId}">
    <div class="recipe-header">
      ${icon}
      <div class="item-name-wrap">
        <div class="item-name ${r.outputRarity}">${escHtml(r.outputItemName)}</div>
        <div class="item-meta">${discs}${liqTag}${!r.isFullyCraftable?'<span class="tag tag-partial">Buy mats</span>':''}${!r.unlocked?'<span class="tag tag-locked">Recipe sheet</span>':''}${maxC!==null?`<span class="tag tag-green">×${maxC} max</span>`:''}</div>
      </div>
      <div class="col-sell"><div class="col-label">Sell instant</div><div class="col-value">${r.fmt.sellInstantAfterFees}</div></div>
      <div class="col-cost"><div class="col-label">Buy cost</div><div class="col-value" style="color:${r.matCostToBuy>0?'var(--red)':'var(--text-muted)'}">${r.matCostToBuy>0?r.fmt.matCostToBuy:'—'}</div></div>
      <div class="col-profit"><div class="col-label">vs Raw</div><div class="col-value${profCls}">${r.fmt.profitVsRaw}</div></div>
      <span class="expand-icon">▼</span>
    </div>${detail}</div>`;
}

function calcMaxCraftable(r) {
  let max = Infinity;
  for (const ing of r.allIngredients) {
    if (ing.buyCount > 0) return 0;
    const t = Math.floor(ing.have / ing.need);
    if (t < max) max = t;
  }
  return max === Infinity ? 1 : max;
}

// ── SALVAGE ──────────────────────────────────────────────────────────────────
async function runSalvageAnalysis() {
  if (!state.apiKey) { showTabBanner('salvage','err','Enter your API key first.'); return; }
  if (state.analyzing) return;
  state.analyzing = true;
  const btn = document.getElementById('salvageBtn');
  btn.disabled = true; btn.textContent = '⏳ Analyzing…';
  setTabLoading('salvage', 'Fetching inventory & live prices…');

  // Collect which kits the user owns
  const ownedKits = {
    copper:      document.getElementById('kit-copper').checked,
    silver:      document.getElementById('kit-silver').checked,
    masters:     document.getElementById('kit-masters').checked,
    runecrafter: document.getElementById('kit-runecrafter').checked,
    blacklion:   document.getElementById('kit-blacklion').checked,
  };
  const blKitCost = parseInt(document.getElementById('blKitCost').value) || 500;

  try {
    const data = await apiFetch('/api/salvage', {
      apiKey: state.apiKey,
      includeBank: state.includeBank,
      includeBags: state.includeBags,
      minRarity: state.minRarity,
      ownedKits,
      blKitCost,
    });
    state.salvageResults = data.items;
    renderSalvageResults(data.items, data.ectoPrice);
  } catch(e) {
    setTabContent('salvage', `<div class="banner err">Failed: ${escHtml(e.message)}</div>`);
  } finally {
    state.analyzing = false;
    btn.disabled = false; btn.textContent = '🔨 Analyze Salvage';
  }
}

function renderSalvageResults(items, ectoPrice) {
  let filtered = state.profitableOnly ? items.filter(i => i.action !== 'none') : items;

  const sells   = filtered.filter(i => i.action === 'sell');
  const salvage = filtered.filter(i => i.action === 'salvage');
  const extract = filtered.filter(i => i.action === 'extract');

  const totalGold = filtered.reduce((s,i) => s + (i.recommendedValue||0), 0);

  let html = `<div class="results-header">
    <h2>Salvage Advisor</h2>
    <span class="results-meta">
      ${filtered.length} items &nbsp;·&nbsp;
      <span style="color:var(--green)">${sells.length} sell</span> &nbsp;·&nbsp;
      <span style="color:var(--orange)">${salvage.length} salvage</span> &nbsp;·&nbsp;
      <span style="color:var(--purple)">${extract.length} extract upgrade</span>
      ${ectoPrice ? `&nbsp;·&nbsp; Ecto: ${formatCopper(ectoPrice)}` : ''}
    </span>
  </div>`;

  if (!filtered.length) {
    html += `<div class="banner info">No items found matching your filters.</div>`;
    setTabContent('salvage', html); return;
  }

  // Best total value callout
  if (totalGold > 0) {
    html += `<div class="banner info" style="display:block;">💰 Estimated total value from all recommendations: <strong>${formatCopperPlain(totalGold)}</strong></div>`;
  }

  const renderSection = (list, label) => {
    if (!list.length) return '';
    let s = `<div class="section-label">${label}</div><div class="salvage-list">`;
    list.forEach(item => s += renderSalvageCard(item));
    s += `</div>`;
    return s;
  };

  html += renderSection(extract, '💎 Extract upgrade first (Black Lion Kit)');
  html += renderSection(sells,   '✅ Sell on Trading Post');
  html += renderSection(salvage, '🔨 Salvage for materials');

  setTabContent('salvage', html);
  document.querySelectorAll('#tabpanel-salvage .salvage-header').forEach(h => {
    h.addEventListener('click', () => h.closest('.salvage-card').classList.toggle('expanded'));
  });
}

function renderSalvageCard(item) {
  const icon = item.icon
    ? `<img class="item-icon" src="${item.icon}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : `<div class="item-icon-placeholder">⚔</div>`;

  const actionClass = { sell:'sell', salvage:'salvage', extract:'extract' }[item.action] || '';
  const actionLabel = { sell:'Sell', salvage:'Salvage', extract:'Extract Upgrade' }[item.action] || '?';

  const location = item.location === 'bank' ? '<span class="tag tag-disc">Bank</span>' : `<span class="tag tag-disc">${item.location}</span>`;

  const detail = `<div class="salvage-detail">
    <div class="detail-section">
      <h4>Item Details</h4>
      <div class="price-breakdown">
        <div class="price-row"><span class="price-row-label">Rarity</span><span class="price-row-value item-name ${item.rarity}">${item.rarity}</span></div>
        <div class="price-row"><span class="price-row-label">Location</span><span class="price-row-value" style="color:var(--text-secondary)">${item.location}</span></div>
        ${item.upgradeName ? `<div class="price-row"><span class="price-row-label">Upgrade</span><span class="price-row-value" style="color:var(--text-secondary)">${escHtml(item.upgradeName)}</span></div>` : ''}
      </div>
    </div>
    <div class="detail-section">
      <h4>Value Comparison</h4>
      <div class="price-breakdown">
        <div class="price-row"><span class="price-row-label">TP sell (instant, after tax)</span><span class="price-row-value">${formatCopper(item.tpSellValue)}</span></div>
        <div class="price-row"><span class="price-row-label">Salvage EV (ectos + mats)</span><span class="price-row-value">${formatCopper(item.salvageEV)}</span></div>
        ${item.upgradeValue > 0 ? `<div class="price-row"><span class="price-row-label">Upgrade value (after extract)</span><span class="price-row-value" style="color:var(--purple)">${formatCopper(item.upgradeValue)}</span></div>
        <div class="price-row"><span class="price-row-label">Extract + salvage EV total</span><span class="price-row-value" style="color:var(--purple)">${formatCopper(item.extractTotalEV)}</span></div>` : ''}
        <div class="price-row total"><span class="price-row-label">Recommended action</span><span class="price-row-value"><span class="action-badge ${actionClass}">${actionLabel}</span></span></div>
        <div class="price-row total"><span class="price-row-label">Expected value</span><span class="price-row-value profit-positive">${formatCopper(item.recommendedValue)}</span></div>
      </div>
    </div>
  </div>`;

  return `<div class="salvage-card action-${actionClass}">
    <div class="salvage-header">
      ${icon}
      <div class="item-name-wrap">
        <div class="item-name ${item.rarity}">${escHtml(item.name)}</div>
        <div class="item-meta">${location}${item.upgradeName?`<span class="tag tag-gold">Has upgrade</span>`:''}</div>
      </div>
      <div class="col-sell"><div class="col-label">TP Value</div><div class="col-value">${formatCopper(item.tpSellValue)}</div></div>
      <div class="col-sell"><div class="col-label">Salvage EV</div><div class="col-value">${formatCopper(item.salvageEV)}</div></div>
      <div class="col-profit"><div class="col-label">Best Value</div><div class="col-value">${formatCopper(item.recommendedValue)}</div></div>
      <span class="action-badge ${actionClass}">${actionLabel}</span>
      <span class="expand-icon">▼</span>
    </div>${detail}
  </div>`;
}

// ── Materials viewer ──────────────────────────────────────────────────────────
async function viewMaterials() {
  if (!state.apiKey) { showTabBanner('crafts','err','Enter your API key first.'); return; }
  setTabLoading('crafts','Loading material storage…');
  try {
    const data = await apiFetch('/api/materials', { apiKey: state.apiKey });
    let html = `<div class="results-header"><h2>Material Storage</h2><span class="results-meta">${data.materials.length} stacks</span></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:3px;">`;
    data.materials.forEach(mat => {
      const ico = mat.icon ? `<img style="width:26px;height:26px;border-radius:2px;flex-shrink:0;" src="${mat.icon}" alt="" loading="lazy">` : `<div style="width:26px;height:26px;background:var(--bg-elevated);border-radius:2px;flex-shrink:0;"></div>`;
      html += `<div style="display:flex;align-items:center;gap:7px;padding:5px 9px;background:var(--bg-panel);border:1px solid var(--border-light);border-radius:4px;">
        ${ico}<span class="item-name ${mat.rarity}" style="font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(mat.name)}</span>
        <span style="font-family:var(--font-data);font-size:11px;color:var(--text-secondary);flex-shrink:0;">×${mat.count.toLocaleString()}</span></div>`;
    });
    html += `</div>`;
    setTabContent('crafts', html);
  } catch(e) { showTabBanner('crafts','err',`Failed: ${e.message}`); }
}

// ── Market detail (expanded panel) ───────────────────────────────────────────

function makeSpark(points, w = 120, h = 28) {
  if (!points || points.length < 2) return '';
  const vals = points.map(p => p.s).filter(Boolean);
  if (vals.length < 2) return '';
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const xs = vals.map((_, i) => (i / (vals.length - 1)) * w);
  const ys = vals.map(v => h - 2 - ((v - min) / range) * (h - 4));
  const d  = xs.map((x, i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  const isUp  = vals[vals.length - 1] >= vals[0];
  const color = isUp ? 'var(--green)' : 'var(--red)';
  const lx = xs[xs.length - 1].toFixed(1), ly = ys[ys.length - 1].toFixed(1);
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="overflow:visible;display:block;">
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="${lx}" cy="${ly}" r="2.5" fill="${color}"/>
  </svg>`;
}

function renderMarketDetail(el, r, history) {
  const buyQty     = r.buyQuantity  || 0;
  const sellQty    = r.sellQuantity || 0;
  const spreadPct  = r.sellList > 0 ? Math.round((r.sellList - r.sellInstant) / r.sellList * 100) : null;
  const hasData    = history.length >= 2;
  const sellPrices = history.map(p => p.s).filter(Boolean);
  const sellMin    = hasData ? Math.min(...sellPrices) : null;
  const sellMax    = hasData ? Math.max(...sellPrices) : null;
  const sellAvg    = hasData ? Math.round(sellPrices.reduce((a, b) => a + b, 0) / sellPrices.length) : null;

  // Quantity trend: latest vs earliest snapshot in history
  const qtyPoints  = history.filter(p => p.bq > 0 || p.sq > 0);
  const bqFirst    = qtyPoints.length ? qtyPoints[0].bq : null;
  const bqLast     = qtyPoints.length ? qtyPoints[qtyPoints.length-1].bq : null;
  const bqTrend    = (bqFirst && bqLast && bqFirst > 0)
    ? ((bqLast - bqFirst) / bqFirst * 100).toFixed(0)
    : null;

  const spark      = makeSpark(history);
  const spreadColor = spreadPct === null ? 'var(--text-muted)'
    : spreadPct < 15 ? 'var(--green)' : spreadPct < 35 ? 'var(--orange)' : 'var(--red)';
  const bqColor = buyQty >= 500 ? 'var(--green)' : buyQty >= 50 ? 'var(--orange)' : 'var(--red)';
  const sqColor = sellQty > buyQty * 5 ? 'var(--red)' : sellQty > buyQty ? 'var(--orange)' : 'var(--green)';

  el.innerHTML = `<div class="market-section">
    <h4>Market Activity (7d)</h4>
    ${spark ? `<div class="market-spark">${spark}</div>` : ''}
    <div class="market-stats">
      <div class="mstat">
        <span class="mstat-label">Buy orders (demand)</span>
        <span class="mstat-value" style="color:${bqColor}">${buyQty.toLocaleString()}${bqTrend !== null ? ` <small style="opacity:.7">${bqTrend > 0 ? '+' : ''}${bqTrend}% 7d</small>` : ''}</span>
      </div>
      <div class="mstat">
        <span class="mstat-label">Sell listings (supply)</span>
        <span class="mstat-value" style="color:${sqColor}">${sellQty.toLocaleString()}</span>
      </div>
      <div class="mstat">
        <span class="mstat-label">Buy/sell spread</span>
        <span class="mstat-value" style="color:${spreadColor}">${spreadPct ?? '?'}%</span>
      </div>
      <div class="mstat">
        <span class="mstat-label">Snapshots (7d)</span>
        <span class="mstat-value">${history.length > 0 ? history.length : '—'}</span>
      </div>
      ${hasData
        ? `<div class="mstat">
             <span class="mstat-label">7d sell range</span>
             <span class="mstat-value">${formatCopperPlain(sellMin)} – ${formatCopperPlain(sellMax)}</span>
           </div>
           <div class="mstat">
             <span class="mstat-label">7d avg sell</span>
             <span class="mstat-value">${formatCopperPlain(sellAvg)}</span>
           </div>`
        : `<div class="mstat" style="grid-column:span 2">
             <span class="mstat-label">History</span>
             <span class="mstat-value" style="color:var(--text-muted)">Building — check back in a few hours</span>
           </div>`}
    </div>
  </div>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function setTabLoading(tab, text) {
  document.getElementById(`tabpanel-${tab}`).innerHTML =
    `<div class="loading-state"><div class="spinner"></div><div class="loading-text">${text}</div></div>`;
}

function setTabContent(tab, html) {
  document.getElementById(`tabpanel-${tab}`).innerHTML = html;
}

function showTabBanner(tab, type, msg) {
  const panel = document.getElementById(`tabpanel-${tab}`);
  const existing = panel.querySelector('.banner');
  if (existing) existing.remove();
  const b = document.createElement('div');
  b.className = `banner ${type}`; b.textContent = msg;
  panel.prepend(b);
}

async function apiFetch(url, body) {
  const opts = body
    ? { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) }
    : { method:'GET' };
  const res  = await fetch(url, opts);
  const data = await res.json();
  if (!data.ok && data.error) throw new Error(data.error);
  return data;
}

function formatCopper(copper) {
  if (!copper) return '<span style="color:var(--text-muted)">—</span>';
  const sign = copper < 0 ? '-' : '';
  const abs  = Math.abs(Math.round(copper));
  const g = Math.floor(abs/10000), s = Math.floor((abs%10000)/100), c = abs%100;
  const parts = [];
  if (g) parts.push(`<span style="color:var(--gold)">${g}<small>g</small></span>`);
  if (s) parts.push(`<span style="color:#c0c0c0">${s}<small>s</small></span>`);
  if (c||(!g&&!s)) parts.push(`<span style="color:#b87333">${c}<small>c</small></span>`);
  return sign + parts.join(' ');
}

function formatCopperPlain(copper) {
  const abs = Math.abs(Math.round(copper));
  const g = Math.floor(abs/10000), s = Math.floor((abs%10000)/100), c = abs%100;
  const parts = [];
  if (g) parts.push(`${g}g`);
  if (s) parts.push(`${s}s`);
  if (c||(!g&&!s)) parts.push(`${c}c`);
  return parts.join(' ');
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
