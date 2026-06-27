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
  // Flipping
  flipResults: { quickWins: [], normalFlips: [] },
  watchedIds: new Set(),
};

let syncPollTimer = null;

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

  // Flipping
  document.getElementById('flipBtn').addEventListener('click', runFlipAnalysis);
  document.getElementById('nfCategory').addEventListener('change', onCategoryChange);

  // Forge
  document.getElementById('forgeRefreshBtn').addEventListener('click', () => loadForgeData(true));

  document.getElementById('collSyncBtn').addEventListener('click', triggerAchievementSync);
  document.getElementById('collCheapestBtn').addEventListener('click', loadCheapestToFinish);
  document.getElementById('collCategory').addEventListener('change', searchCollections);
  document.getElementById('collSearch').addEventListener('input', () => {
    clearTimeout(collSearchTimer);
    collSearchTimer = setTimeout(searchCollections, 350);
  });
}

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(el => el.classList.toggle('active', el.id === `tabpanel-${tab}`));
  document.querySelectorAll('.sidebar-panel').forEach(el => el.classList.toggle('active', el.id === `panel-${tab}`));

  if (tab === 'flipping') {
    clearTimeout(syncPollTimer);
    pollSyncStatus();
    loadFlipCategories();
  }
  if (tab === 'forge') {
    loadForgeData();
  }
  if (tab === 'collections') {
    loadCollectionCategories();
    pollAchieveSyncStatus();
    searchCollections();
  }
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
  const profitActualOf = r => r.sellInstantAfterFees - r.totalCost;
  const sorted = [...filtered].sort((a,b) => {
    if (state.sortKey === 'matCostToBuy') return a[state.sortKey] - b[state.sortKey];
    if (state.sortKey === 'spread')       return (b.buyQuantity || 0) - (a.buyQuantity || 0);
    if (state.sortKey === 'profitVsRaw')  return profitActualOf(b) - profitActualOf(a);
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
    html += `<div class="section-label">✓ Ready to craft — you have everything</div><div class="recipe-list">`;
    full.forEach(r => html += renderCraftCard(r));
    html += `</div>`;
  }
  if (partial.length) {
    html += `<div class="section-label" style="margin-top:12px;">🛒 Need to buy some ingredients first</div><div class="recipe-list">`;
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

  // Craft cost = owned mats at buy price + mats to buy at sell price.
  // Using totalCost means Sells for − Craft cost = Profit always adds up visibly.
  const craftCost   = r.totalCost;
  const profitActual = r.sellInstantAfterFees - craftCost;

  // Craft cost sub-note
  const craftNote = r.isFullyCraftable
    ? `<div class="col-sub" style="color:var(--green)">all from storage</div>`
    : r.matCostToBuy > 0
      ? `<div class="col-sub" style="color:var(--blue)">buy ${r.fmt.matCostToBuy} + storage</div>`
      : '';

  // Listing price hint — only show if listing would get >10% more than instant
  const listingHint = r.sellListAfterFees > r.sellInstantAfterFees * 1.10
    ? `<div class="col-sub">or list: ${r.fmt.sellListAfterFees}</div>`
    : '';

  const ingRows = r.allIngredients.map(ing => {
    let sc, st;
    if (ing.unavailable)                         { sc='missing'; st='N/A'; }
    else if (ing.buyCount>0 && ing.fromStorage>0) { sc='buy'; st=`Have ${ing.fromStorage}, buy ${ing.buyCount}`; }
    else if (ing.buyCount>0)                      { sc='buy'; st=`Buy ${ing.buyCount}`; }
    else                                           { sc='have'; st=`Have ${ing.have}`; }
    const ico = ing.icon ? `<img class="ing-icon" src="${ing.icon}" alt="" loading="lazy" onerror="this.style.display='none'">` : `<div class="ing-icon"></div>`;
    const buyStr = ing.buyCount>0&&ing.unitPrice>0 ? `<span class="ing-buy" style="color:var(--blue)">${formatCopper(ing.unitPrice*ing.buyCount)}</span>` : '';
    return `<div class="ingredient-row">${ico}<span class="ing-name">${escHtml(ing.name)}</span><span class="ing-count">×${ing.need}</span>${buyStr}<span class="ing-status ${sc}">${st}</span></div>`;
  }).join('');

  const pl    = profitActual >= 0 ? 'profit-positive' : 'profit-negative';
  const detail = `<div class="recipe-detail">
    <div class="recipe-detail-top">
      <div class="detail-section"><h4>Ingredients (×${r.outputCount} crafted)</h4>${ingRows||'<span style="color:var(--text-muted);font-size:12px;">No data</span>'}</div>
      <div class="detail-section"><h4>Breakdown</h4><div class="price-breakdown">
        <div class="price-row"><span class="price-row-label">Sell to buy order (after 15% tax)</span><span class="price-row-value">${r.fmt.sellInstantAfterFees}</span></div>
        <div class="price-row"><span class="price-row-label">Sell by listing (after 15% tax)</span><span class="price-row-value" style="color:var(--text-secondary)">${r.fmt.sellListAfterFees}</span></div>
        <div class="price-row" style="margin-top:6px;border-top:1px solid var(--border-light);padding-top:6px"><span class="price-row-label">Craft cost</span><span class="price-row-value">${formatCopper(craftCost)}</span></div>
        <div class="price-row" style="padding-left:10px"><span class="price-row-label" style="font-size:11px">↳ From your storage</span><span class="price-row-value" style="color:var(--green);font-size:11px">${r.matCostFromStorage > 0 ? formatCopper(r.matCostFromStorage) : '—'}</span></div>
        <div class="price-row" style="padding-left:10px"><span class="price-row-label" style="font-size:11px">↳ Need to buy</span><span class="price-row-value" style="color:${r.matCostToBuy>0?'var(--blue)':'var(--text-muted)'};font-size:11px">${r.matCostToBuy>0?r.fmt.matCostToBuy:'—'}</span></div>
        <div class="price-row total" style="margin-top:6px;border-top:1px solid var(--border)"><span class="price-row-label">Profit</span><span class="price-row-value ${pl}">${formatCopper(profitActual)}</span></div>
        <div class="price-row"><span class="price-row-label">Margin</span><span class="price-row-value">${r.profitMargin}%</span></div>
        ${maxC!==null?`<div class="price-row" style="margin-top:6px;border-top:1px solid var(--border-light);padding-top:6px"><span class="price-row-label">Can craft ×${maxC} from storage</span><span class="price-row-value" style="color:var(--green)">total ${formatCopper(profitActual*maxC)}</span></div>`:''}
      </div></div>
    </div>
    <div class="recipe-detail-market" id="mkt-${r.recipeId}"></div>
  </div>`;

  return `<div class="recipe-card${liqTier ? ` liq-${liqTier}` : ''}" data-id="${r.recipeId}" data-output-id="${r.outputItemId}">
    <div class="recipe-header">
      ${icon}
      <div class="item-name-wrap">
        <div class="item-name ${r.outputRarity}">${escHtml(r.outputItemName)}</div>
        <div class="item-meta">${discs}${liqTag}${!r.unlocked?'<span class="tag tag-locked">Recipe sheet</span>':''}${maxC!==null?`<span class="tag tag-green">×${maxC} max</span>`:''}</div>
      </div>
      <div class="col-sell"><div class="col-label">Sells for</div><div class="col-value">${r.fmt.sellInstantAfterFees}</div>${listingHint}</div>
      <div class="col-cost"><div class="col-label">Craft cost</div><div class="col-value">${formatCopper(craftCost)}</div>${craftNote}</div>
      <div class="col-profit"><div class="col-label">Profit</div><div class="col-value ${pl}">${formatCopper(profitActual)}</div></div>
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

// ── FLIPPING ─────────────────────────────────────────────────────────────────

// Human-readable labels for GW2 API type names
const TYPE_LABELS = {
  Armor: 'Armor', Back: 'Back Items', Bag: 'Bags', Consumable: 'Consumables',
  Container: 'Containers', CraftingMaterial: 'Crafting Materials', Gathering: 'Gathering Tools',
  Gizmo: 'Gizmos', MiniPet: 'Miniatures', Trinket: 'Trinkets', Trophy: 'Trophies',
  UpgradeComponent: 'Upgrade Components', Weapon: 'Weapons', Key: 'Keys', Tool: 'Tools',
};
const SUBTYPE_LABELS = {
  Boots: 'Boots', Coat: 'Chest', Gloves: 'Gloves', Helm: 'Helm', HelmAquatic: 'Helm (Aquatic)',
  Leggings: 'Legs', Shoulders: 'Shoulders',
  Axe: 'Axe', Dagger: 'Dagger', Focus: 'Focus', Greatsword: 'Greatsword', Hammer: 'Hammer',
  LongBow: 'Longbow', Mace: 'Mace', Pistol: 'Pistol', Rifle: 'Rifle', Scepter: 'Scepter',
  Shield: 'Shield', ShortBow: 'Shortbow', Speargun: 'Speargun', Staff: 'Staff',
  Sword: 'Sword', Torch: 'Torch', Trident: 'Trident', Warhorn: 'Warhorn',
  Amulet: 'Amulet', Earring: 'Earring', Ring: 'Ring',
  Dye: 'Dyes', Food: 'Food', Utility: 'Utility', Transmutation: 'Transmutation',
  Unlock: 'Unlock', Generic: 'Generic', Immediate: 'Immediate',
  Default: 'Enhancement', Gem: 'Gem', Rune: 'Rune', Sigil: 'Sigil',
  Infusion: 'Infusion', Enrichment: 'Enrichment',
};
function labelType(t)    { return TYPE_LABELS[t]    || t; }
function labelSubtype(t) { return SUBTYPE_LABELS[t] || t; }

// State for category data
let flipCategories = {}; // { TypeName: ['sub1', 'sub2', ...] }

async function loadFlipCategories() {
  try {
    const data = await fetch('/api/flip/categories').then(r => r.json());
    if (!data.ok || !data.categories) return;
    flipCategories = data.categories;
    const catSelect = document.getElementById('nfCategory');
    const currentCat = catSelect.value;
    // Rebuild category options (preserve selection)
    while (catSelect.options.length > 1) catSelect.remove(1);
    Object.keys(flipCategories).sort().forEach(type => {
      const opt = document.createElement('option');
      opt.value = type; opt.textContent = labelType(type);
      catSelect.appendChild(opt);
    });
    catSelect.value = currentCat;
    onCategoryChange();
  } catch(e) { /* categories not available yet — silent */ }
}

function onCategoryChange() {
  const catSelect = document.getElementById('nfCategory');
  const subSelect = document.getElementById('nfSubcategory');
  const type = catSelect.value;
  const currentSub = subSelect.value;

  while (subSelect.options.length > 1) subSelect.remove(1);
  subSelect.disabled = !type;

  if (type && flipCategories[type]) {
    flipCategories[type].sort().forEach(sub => {
      const opt = document.createElement('option');
      opt.value = sub; opt.textContent = labelSubtype(sub);
      subSelect.appendChild(opt);
    });
    subSelect.value = currentSub;
  }
}

async function runFlipAnalysis() {
  if (state.analyzing) return;
  state.analyzing = true;
  const btn = document.getElementById('flipBtn');
  btn.disabled = true; btn.textContent = '⏳ Scanning…';
  setTabLoading('flipping', 'Scanning for flip opportunities…');

  const itemType    = document.getElementById('nfCategory').value    || null;
  const itemSubtype = document.getElementById('nfSubcategory').value || null;

  try {
    const data = await apiFetch('/api/flip', {
      quickMinProfit:   Math.round((parseFloat(document.getElementById('qwMinProfit').value) || 10) * 100),
      quickDropPct:     parseFloat(document.getElementById('qwDropPct').value) || 20,
      normalMinProfit:  Math.round((parseFloat(document.getElementById('nfMinProfit').value) || 10) * 100),
      normalMinROI:     parseFloat(document.getElementById('nfMinROI').value) || 15,
      normalMinBuyQty:  parseInt(document.getElementById('nfMinBuyQty').value) || 50,
      normalMaxBuyPrice: Math.round((parseFloat(document.getElementById('nfMaxBuy').value) || 0) * 10000),
      normalMaxSpread:  parseFloat(document.getElementById('nfMaxSpread').value) || 2.0,
      itemType,
      itemSubtype,
      limit: 50,
    });

    state.watchedIds  = new Set((data.watchedIds || []).map(Number));
    state.flipResults = { quickWins: data.quickWins || [], normalFlips: data.normalFlips || [] };
    renderFlipResults();
  } catch(e) {
    setTabContent('flipping', `<div class="banner err">Failed: ${escHtml(e.message)}</div>`);
  } finally {
    state.analyzing = false;
    btn.disabled = false; btn.textContent = '📈 Find Flip Opportunities';
  }
}

function renderFlipResults() {
  const { quickWins, normalFlips } = state.flipResults;

  let html = `<div class="results-header">
    <h2>Flip Opportunities</h2>
    <span class="results-meta">
      <span style="color:var(--blue)">${quickWins.length} quick win${quickWins.length !== 1 ? 's' : ''}</span>
      &nbsp;·&nbsp;
      <span style="color:var(--gold)">${normalFlips.length} normal flip${normalFlips.length !== 1 ? 's' : ''}</span>
    </span>
  </div>`;

  if (!quickWins.length && !normalFlips.length) {
    html += `<div class="banner info">No opportunities found with current filters. Try lowering min profit or adjusting other filters.</div>`;
    html += `<div class="banner warn" style="margin-top:8px;">Quick Wins require price history that builds over time. Normal Flips need the daily price sync — check the sidebar for sync status.</div>`;
    setTabContent('flipping', html);
    return;
  }

  if (quickWins.length) {
    html += `<div class="section-label">⚡ Quick Wins — underpriced listings, buy &amp; relist</div><div class="flip-list">`;
    quickWins.forEach(item => { html += renderQuickWinCard(item); });
    html += `</div>`;
  }

  if (normalFlips.length) {
    html += `<div class="section-label" style="margin-top:12px;">📊 Normal Flips — buy order + relist for spread profit</div><div class="flip-list">`;
    normalFlips.forEach(item => { html += renderNormalFlipCard(item); });
    html += `</div>`;
  }

  setTabContent('flipping', html);

  document.querySelectorAll('#tabpanel-flipping .flip-header').forEach(h => {
    h.addEventListener('click', () => h.closest('.flip-card').classList.toggle('expanded'));
  });
}

function renderQuickWinCard(item) {
  const isWatched  = state.watchedIds.has(item.item_id);
  const icon = item.icon
    ? `<img class="item-icon" src="${item.icon}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : `<div class="item-icon-placeholder">⚡</div>`;

  const liqTier  = item.buy_quantity >= 500 ? 'liquid' : item.buy_quantity >= 50 ? 'slow' : 'stale';
  const liqLabel = liqTier === 'liquid' ? '● Liquid' : liqTier === 'slow' ? '● Slow' : '● Stale';
  const liqTag   = `<span class="tag liq-tag liq-${liqTier}" title="${item.buy_quantity.toLocaleString()} buy orders">${liqLabel}</span>`;

  const relistAfterTax = Math.floor(item.hist_sell_avg * 0.85);
  const watchBtn = `<button class="watch-btn${isWatched ? ' watching' : ''}" onclick="toggleWatch(event,${item.item_id})">${isWatched ? '★ Watching' : '☆ Watch'}</button>`;

  const detail = `<div class="flip-detail">
    <div class="flip-detail-grid">
      <div class="detail-section">
        <h4>Trade Details</h4>
        <div class="price-breakdown">
          <div class="price-row"><span class="price-row-label">Buy now (instant buy at)</span><span class="price-row-value">${formatCopper(item.sell_price)}</span></div>
          <div class="price-row"><span class="price-row-label">7-day avg sell price</span><span class="price-row-value">${formatCopper(item.hist_sell_avg)}</span></div>
          <div class="price-row"><span class="price-row-label">7-day peak sell price</span><span class="price-row-value" style="color:var(--text-secondary)">${formatCopper(item.hist_sell_max)}</span></div>
          <div class="price-row" style="margin-top:6px;border-top:1px solid var(--border-light);padding-top:6px"><span class="price-row-label">Relist at avg (after 15% tax)</span><span class="price-row-value" style="color:var(--gold)">${formatCopper(relistAfterTax)}</span></div>
          <div class="price-row total"><span class="price-row-label">Expected profit</span><span class="price-row-value profit-positive">${formatCopper(item.expected_profit)}</span></div>
        </div>
      </div>
      <div class="detail-section">
        <h4>Market Activity</h4>
        <div class="price-breakdown">
          <div class="price-row"><span class="price-row-label">Buy orders (demand)</span><span class="price-row-value">${item.buy_quantity.toLocaleString()}</span></div>
          <div class="price-row"><span class="price-row-label">Sell listings (supply)</span><span class="price-row-value">${item.sell_quantity.toLocaleString()}</span></div>
          <div class="price-row"><span class="price-row-label">History snapshots (7d)</span><span class="price-row-value">${item.snapshots}</span></div>
          <div class="price-row" style="margin-top:6px;padding-top:6px;border-top:1px solid var(--border-light)"><span style="font-size:11px;color:var(--text-muted)">Relist near the 7d avg — competing listings will be above it</span></div>
        </div>
        <div style="margin-top:10px;">${watchBtn}</div>
      </div>
    </div>
  </div>`;

  return `<div class="flip-card quick-win${isWatched ? ' watching' : ''}" data-item-id="${item.item_id}">
    <div class="flip-header">
      ${icon}
      <div class="item-name-wrap">
        <div class="item-name ${item.rarity}">${escHtml(item.name)}</div>
        <div class="item-meta">${liqTag}<span class="drop-badge">↓ ${item.drop_pct}% below avg</span></div>
      </div>
      <div class="col-sell"><div class="col-label">Buy now</div><div class="col-value">${formatCopper(item.sell_price)}</div><div class="col-sub">avg: ${formatCopperPlain(item.hist_sell_avg)}</div></div>
      <div class="col-sell"><div class="col-label">Relist at</div><div class="col-value" style="color:var(--gold)">${formatCopperPlain(item.hist_sell_avg)}</div><div class="col-sub">nets: ${formatCopperPlain(relistAfterTax)}</div></div>
      <div class="col-profit"><div class="col-label">Profit</div><div class="col-value">${formatCopper(item.expected_profit)}</div></div>
      <span class="expand-icon">▼</span>
    </div>${detail}</div>`;
}

function renderNormalFlipCard(item) {
  const isWatched  = state.watchedIds.has(item.item_id);
  const icon = item.icon
    ? `<img class="item-icon" src="${item.icon}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : `<div class="item-icon-placeholder">📊</div>`;

  const liqTier  = item.buy_quantity >= 500 ? 'liquid' : item.buy_quantity >= 50 ? 'slow' : 'stale';
  const liqLabel = liqTier === 'liquid' ? '● Liquid' : liqTier === 'slow' ? '● Slow' : '● Stale';
  const liqTag   = `<span class="tag liq-tag liq-${liqTier}" title="${item.buy_quantity.toLocaleString()} buy orders">${liqLabel}</span>`;
  const roiBadge = `<span class="roi-badge">${item.roi_pct}% ROI</span>`;
  const catTag   = item.item_type
    ? `<span class="tag tag-disc">${labelType(item.item_type)}${item.item_subtype ? ' › ' + labelSubtype(item.item_subtype) : ''}</span>`
    : '';

  const netSell   = Math.floor(item.sell_price * 0.85);
  const watchBtn  = `<button class="watch-btn${isWatched ? ' watching' : ''}" onclick="toggleWatch(event,${item.item_id})">${isWatched ? '★ Watching' : '☆ Watch'}</button>`;

  const histNote = item.snapshots > 0
    ? `<div class="price-row"><span class="price-row-label">7d avg sell</span><span class="price-row-value">${formatCopper(item.hist_sell_avg)}</span></div>`
    : `<div class="price-row"><span class="price-row-label">7d history</span><span class="price-row-value" style="color:var(--text-muted)">No data yet</span></div>`;

  const detail = `<div class="flip-detail">
    <div class="flip-detail-grid">
      <div class="detail-section">
        <h4>Trade Details</h4>
        <div class="price-breakdown">
          <div class="price-row"><span class="price-row-label">Place buy order at</span><span class="price-row-value" style="color:var(--blue)">${formatCopper(item.buy_price)}</span></div>
          <div class="price-row"><span class="price-row-label">Lowest sell listing</span><span class="price-row-value">${formatCopper(item.sell_price)}</span></div>
          <div class="price-row" style="margin-top:6px;border-top:1px solid var(--border-light);padding-top:6px"><span class="price-row-label">After 15% TP tax</span><span class="price-row-value">${formatCopper(netSell)}</span></div>
          <div class="price-row total"><span class="price-row-label">Profit per flip</span><span class="price-row-value profit-positive">${formatCopper(item.flip_profit)}</span></div>
          <div class="price-row"><span class="price-row-label">ROI</span><span class="price-row-value" style="color:var(--green)">${item.roi_pct}%</span></div>
        </div>
      </div>
      <div class="detail-section">
        <h4>Market Activity</h4>
        <div class="price-breakdown">
          <div class="price-row"><span class="price-row-label">Buy orders (demand)</span><span class="price-row-value">${item.buy_quantity.toLocaleString()}</span></div>
          <div class="price-row"><span class="price-row-label">Sell listings (supply)</span><span class="price-row-value">${item.sell_quantity.toLocaleString()}</span></div>
          ${histNote}
          <div class="price-row" style="margin-top:6px;padding-top:6px;border-top:1px solid var(--border-light)"><span style="font-size:11px;color:var(--text-muted)">List 1c below the lowest listing to move inventory faster</span></div>
        </div>
        <div style="margin-top:10px;">${watchBtn}</div>
      </div>
    </div>
  </div>`;

  return `<div class="flip-card normal-flip${isWatched ? ' watching' : ''}" data-item-id="${item.item_id}">
    <div class="flip-header">
      ${icon}
      <div class="item-name-wrap">
        <div class="item-name ${item.rarity}">${escHtml(item.name)}</div>
        <div class="item-meta">${liqTag}${roiBadge}${catTag}</div>
      </div>
      <div class="col-sell"><div class="col-label">Buy order</div><div class="col-value" style="color:var(--blue)">${formatCopper(item.buy_price)}</div></div>
      <div class="col-sell"><div class="col-label">Sell listing</div><div class="col-value">${formatCopper(item.sell_price)}</div></div>
      <div class="col-profit"><div class="col-label">Profit</div><div class="col-value">${formatCopper(item.flip_profit)}</div></div>
      <span class="expand-icon">▼</span>
    </div>${detail}</div>`;
}

async function toggleWatch(event, itemId) {
  event.stopPropagation();
  const action = state.watchedIds.has(itemId) ? 'remove' : 'add';
  try {
    const data = await apiFetch('/api/flip/watch', { itemId, action });
    state.watchedIds = new Set((data.watched || []).map(w => Number(w.item_id)));

    document.querySelectorAll(`.flip-card[data-item-id="${itemId}"]`).forEach(card => {
      const now = state.watchedIds.has(itemId);
      card.classList.toggle('watching', now);
      const btn = card.querySelector('.watch-btn');
      if (btn) { btn.classList.toggle('watching', now); btn.textContent = now ? '★ Watching' : '☆ Watch'; }
    });
  } catch(e) { console.error('[Watch]', e); }
}

// ── MYSTIC FORGE ─────────────────────────────────────────────────────────────

// Weapon types that have a Gen 1 legendary — used to flag precursor potential
const LEGENDARY_TYPES = new Set([
  'Sword', 'Greatsword', 'Axe', 'Dagger', 'Focus', 'Hammer',
  'LongBow', 'ShortBow', 'Mace', 'Pistol', 'Rifle', 'Scepter',
  'Shield', 'Staff', 'Torch', 'Warhorn',
]);

// Known rare-skin targets per weapon type (primarily Halloween)
const RARE_SKIN_TARGETS = {
  Staff:  ['Scythe'],
  Shield: ['Grinning Ghastly Shield'],
};

let forgeLoaded = false;

async function loadForgeData(force = false) {
  if (forgeLoaded && !force) return;
  setTabLoading('forge', 'Fetching Mystic Forge prices…');
  try {
    const data = await fetch('/api/forge').then(r => r.json());
    if (!data.ok) throw new Error(data.error || 'Unknown error');
    forgeLoaded = true;
    renderForgeResults(data);
  } catch(e) {
    setTabContent('forge', `<div class="banner err">Failed to load forge data: ${escHtml(e.message)}</div>
      <div class="banner warn" style="margin-top:8px;">Forge data requires the daily price sync to run first. Check the Flipping tab for sync status.</div>`);
  }
}

function renderForgeResults(data) {
  const { rareRolls = [], exoticRolls = [] } = data;

  if (!rareRolls.length && !exoticRolls.length) {
    setTabContent('forge', `<div class="banner warn">No weapon price data yet — the daily price sync needs to complete first. Visit the Flipping tab to check sync status.</div>`);
    return;
  }

  let html = `<div class="results-header">
    <h2>Mystic Forge Rolls</h2>
    <span class="results-meta">
      <span style="color:var(--rarity-rare)">${rareRolls.length} rare types</span>
      &nbsp;·&nbsp;
      <span style="color:var(--rarity-exotic)">${exoticRolls.length} exotic types</span>
      &nbsp;·&nbsp;
      <span style="color:var(--text-muted)">sorted cheapest first</span>
    </span>
  </div>`;

  if (rareRolls.length) {
    html += `<div class="section-label">🟡 Rare → Exotic &nbsp;— 4× cheapest rares per weapon type, get a random exotic back</div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;padding:0 2px;">
        Roll cost = instant-buy price for all 4. Floor value = cheapest output exotic sold to buy order after 15% tax.
        Delta is almost always negative — you're paying a premium for a chance at a precursor or rare skin.
      </div>
      <div class="forge-list">`;
    rareRolls.forEach(r => { html += renderForgeCard(r, 'rare'); });
    html += `</div>`;
  }

  if (exoticRolls.length) {
    html += `<div class="section-label" style="margin-top:16px;">🟠 Exotic → Exotic &nbsp;— 4× cheapest exotics per type, get a random exotic back</div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;padding:0 2px;">
        Higher floor value than rare rolls, but much more expensive per roll. Best for targeting rare skins like the Scythe or Grinning Ghastly Shield.
      </div>
      <div class="forge-list">`;
    exoticRolls.forEach(r => { html += renderForgeCard(r, 'exotic'); });
    html += `</div>`;
  }

  setTabContent('forge', html);

  document.querySelectorAll('#tabpanel-forge .forge-header').forEach(h => {
    h.addEventListener('click', () => h.closest('.forge-card').classList.toggle('expanded'));
  });
}

function renderForgeCard(roll, mode) {
  const typeLabel = labelSubtype(roll.weapon_type);
  const hasLeg    = LEGENDARY_TYPES.has(roll.weapon_type);
  const skinTargets = RARE_SKIN_TARGETS[roll.weapon_type] || [];

  // Pick an icon from the cheapest item
  const iconItem = roll.items[0];
  const icon = iconItem && iconItem.icon
    ? `<img class="item-icon" src="${iconItem.icon}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : `<div class="item-icon-placeholder">⚗</div>`;

  // Tags
  const legTag  = hasLeg ? `<span class="tag tag-gold">⭐ Has legendary</span>` : '';
  const skinTag = skinTargets.length
    ? `<span class="tag" style="background:rgba(155,56,247,0.15);color:var(--purple)">🎃 ${skinTargets.join(', ')}</span>`
    : '';

  const deltaCls  = roll.delta >= 0 ? 'delta-positive' : 'delta-negative';
  const deltaSign = roll.delta >= 0 ? '+' : '';

  // Buy order total — cheaper but you wait for fills
  const buySavings = roll.rollCost - roll.buyCost;

  // Items breakdown
  const itemRows = roll.items.map((item, i) => {
    const ico = item.icon
      ? `<img class="ing-icon" src="${item.icon}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : `<div class="ing-icon"></div>`;
    return `<div class="forge-item-row">
      ${ico}
      <span class="ing-name item-name ${item.rarity}" style="font-size:12px;">${escHtml(item.name)}</span>
      <span style="margin-left:auto;font-family:var(--font-data);font-size:11px;white-space:nowrap;flex-shrink:0;">
        ${formatCopper(item.sell_price)}
        <span style="color:var(--text-muted);margin-left:4px;">(${item.sell_quantity.toLocaleString()} listed)</span>
      </span>
    </div>`;
  }).join('');

  // Floor exotic info
  const floorRow = roll.floorExotic
    ? `<div class="price-row">
         <span class="price-row-label">Floor exotic (cheapest output)</span>
         <span class="price-row-value item-name Exotic" style="font-size:12px;">${escHtml(roll.floorExotic.name)}</span>
       </div>
       <div class="price-row">
         <span class="price-row-label">Floor exotic buy order (after 15% tax)</span>
         <span class="price-row-value">${formatCopper(roll.floorValue)}</span>
       </div>`
    : '';

  const precursorNote = hasLeg
    ? `<div style="margin-top:10px;padding:8px 10px;background:rgba(200,164,90,0.08);border-radius:var(--radius-sm);border-left:2px solid var(--gold);">
         <div style="font-size:11px;color:var(--gold);font-weight:600;margin-bottom:3px;">⭐ Precursor potential</div>
         <div style="font-size:11px;color:var(--text-secondary);">This weapon type has a Gen 1 legendary. Each roll has an independent chance to produce the precursor. Drop rates are unpublished.</div>
       </div>`
    : '';

  const skinNote = skinTargets.length
    ? `<div style="margin-top:10px;padding:8px 10px;background:rgba(155,56,247,0.08);border-radius:var(--radius-sm);border-left:2px solid var(--purple);">
         <div style="font-size:11px;color:var(--purple);font-weight:600;margin-bottom:3px;">🎃 Rare skin target</div>
         <div style="font-size:11px;color:var(--text-secondary);">${skinTargets.join(', ')} — Halloween event exotic. Highly sought after when active.</div>
       </div>`
    : '';

  const detail = `<div class="forge-detail">
    <div class="forge-detail-grid">
      <div class="detail-section">
        <h4>Items to buy (cheapest 4)</h4>
        <div class="forge-items">${itemRows}</div>
        <div class="price-breakdown" style="margin-top:10px;">
          <div class="price-row total"><span class="price-row-label">Total instant-buy cost</span><span class="price-row-value">${formatCopper(roll.rollCost)}</span></div>
          <div class="price-row"><span class="price-row-label">Total via buy orders (slower)</span><span class="price-row-value" style="color:var(--green)">${formatCopper(roll.buyCost)} <small style="color:var(--text-muted)">save ${formatCopperPlain(buySavings)}</small></span></div>
        </div>
      </div>
      <div class="detail-section">
        <h4>Output &amp; value</h4>
        <div class="price-breakdown">
          ${floorRow}
          <div class="price-row total" style="margin-top:6px;border-top:1px solid var(--border);">
            <span class="price-row-label">Delta (floor − roll cost)</span>
            <span class="price-row-value ${deltaCls}">${deltaSign}${formatCopperPlain(roll.delta)}</span>
          </div>
          <div class="price-row"><span class="price-row-label" style="font-size:11px;color:var(--text-muted);">Negative delta is normal — you're paying for a chance at something rare.</span></div>
        </div>
        ${precursorNote}${skinNote}
      </div>
    </div>
  </div>`;

  return `<div class="forge-card ${mode}-roll" data-type="${roll.weapon_type}">
    <div class="forge-header">
      ${icon}
      <div class="item-name-wrap">
        <div class="item-name" style="color:var(--text-primary);font-size:13px;font-weight:600;">${typeLabel}</div>
        <div class="item-meta">${legTag}${skinTag}</div>
      </div>
      <div class="col-sell"><div class="col-label">Roll cost</div><div class="col-value">${formatCopper(roll.rollCost)}</div><div class="col-sub">orders: ${formatCopperPlain(roll.buyCost)}</div></div>
      <div class="col-sell"><div class="col-label">Floor value</div><div class="col-value" style="color:var(--text-secondary)">${formatCopper(roll.floorValue)}</div></div>
      <div class="col-profit"><div class="col-label">Delta/roll</div><div class="col-value ${deltaCls}">${deltaSign}${formatCopperPlain(roll.delta)}</div></div>
      <span class="expand-icon">▼</span>
    </div>${detail}</div>`;
}

// ── COLLECTIONS ──────────────────────────────────────────────────────────────

let collSearchTimer  = null;
let achieveSyncPoll  = null;

async function loadCollectionCategories() {
  try {
    const data = await fetch('/api/collections/categories').then(r => r.json());
    if (!data.ok) return;
    const sel = document.getElementById('collCategory');
    const cur = sel.value;
    sel.innerHTML = '<option value="">All categories</option>';
    for (const c of data.categories) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      if (String(c.id) === cur) opt.selected = true;
      sel.appendChild(opt);
    }
  } catch(e) {}
}

async function searchCollections() {
  const q        = (document.getElementById('collSearch').value || '').trim();
  const category = document.getElementById('collCategory').value;

  if (!q && !category) {
    setTabContent('collections', `<div class="banner info" style="margin:16px;">
      Type a name above or pick a category to browse collections — e.g. "Dragon", "Mini", "Outfit".
    </div>`);
    return;
  }

  setTabLoading('collections', 'Searching…');
  try {
    const params = new URLSearchParams({ q, category, limit: 150 });
    const data   = await fetch(`/api/collections/search?${params}`).then(r => r.json());
    if (!data.ok) throw new Error(data.error);
    renderCollectionResults(data.results);
  } catch(e) {
    setTabContent('collections', `<div class="banner err">Search failed: ${escHtml(e.message)}</div>`);
  }
}

function renderCollectionResults(results) {
  if (!results.length) {
    setTabContent('collections', `<div class="banner warn" style="margin:16px;">No collections found. Try a different search or run a sync first.</div>`);
    return;
  }
  let html = `<div class="results-header">
    <h2>Collections</h2>
    <span class="results-meta">${results.length} result${results.length !== 1 ? 's' : ''}</span>
  </div>`;
  for (const r of results) html += renderCollectionCard(r);
  setTabContent('collections', html);
  bindCollHeaders();
}

async function loadCheapestToFinish() {
  if (!state.apiKey) {
    setTabContent('collections', `<div class="banner err" style="margin:16px;">Add your API key in the sidebar first — this needs your account's achievement progress.</div>`);
    return;
  }
  setTabLoading('collections', 'Checking your progress across every collection…');
  try {
    const data = await fetch('/api/collections/progress-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: state.apiKey }),
    }).then(r => r.json());
    if (!data.ok) throw new Error(data.error || 'Failed');
    renderCheapestResults(data.results);
  } catch(e) {
    setTabContent('collections', `<div class="banner err">Failed: ${escHtml(e.message)}<br><span style="font-size:11px;color:var(--text-muted);">Make sure your API key has the "achievements" permission.</span></div>`);
  }
}

function renderCheapestResults(results) {
  if (!results.length) {
    setTabContent('collections', `<div class="banner warn" style="margin:16px;">No incomplete collections with TP-buyable items found — either you've finished everything, or achievements haven't been synced yet.</div>`);
    return;
  }
  let html = `<div class="results-header">
    <h2>Cheapest to Finish</h2>
    <span class="results-meta">${results.length} incomplete · sorted by remaining TP cost</span>
  </div>`;
  for (const r of results) html += renderCollectionCard(r);
  setTabContent('collections', html);
  bindCollHeaders();
}

function bindCollHeaders() {
  document.querySelectorAll('#tabpanel-collections .coll-header').forEach(h => {
    h.addEventListener('click', () => {
      const card = h.closest('.coll-card');
      const expanding = !card.classList.contains('expanded');
      card.classList.toggle('expanded');
      if (expanding && !card.dataset.loaded) {
        card.dataset.loaded = '1';
        loadCollectionDetail(parseInt(card.dataset.id), card);
      }
    });
  });
}

function renderCollectionCard(ach) {
  const icon = ach.icon
    ? `<img class="item-icon" src="${ach.icon}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : `<div class="item-icon-placeholder"></div>`;
  const catTag = ach.category_name
    ? `<span class="tag" style="background:rgba(200,164,90,0.1);color:var(--gold);font-size:10px;">${escHtml(ach.category_name)}</span>`
    : '';

  // "Cheapest to finish" results carry remainingCost/doneCount — show those instead of a flat item count
  const hasProgress = ach.remainingCost !== undefined;
  const countBlock = hasProgress
    ? `<div style="font-size:11px;color:var(--text-muted);white-space:nowrap;text-align:right;">
         <div>${ach.doneCount}/${ach.totalCount}</div>
         <div style="font-family:var(--font-data);color:var(--gold);">${formatCopperPlain(ach.remainingCost)}</div>
       </div>`
    : `<div style="font-size:11px;color:var(--text-muted);white-space:nowrap;">${ach.item_bit_count || ach.bit_count || 0} item${(ach.item_bit_count || ach.bit_count) !== 1 ? 's' : ''}</div>`;

  return `<div class="coll-card" data-id="${ach.id}">
    <div class="coll-header">
      ${icon}
      <div class="item-name-wrap">
        <div style="font-size:13px;font-weight:600;color:var(--text-primary);">${escHtml(ach.name)}</div>
        <div class="item-meta">${catTag}</div>
      </div>
      ${countBlock}
      <span class="expand-icon">▼</span>
    </div>
    <div class="coll-detail"><div style="color:var(--text-muted);font-size:12px;padding:4px 0;">Loading…</div></div>
  </div>`;
}

async function loadCollectionDetail(id, card) {
  const detailEl = card.querySelector('.coll-detail');
  try {
    const headers = state.apiKey ? { 'X-GW2-Key': state.apiKey } : {};
    const data = await fetch(`/api/collections/${id}`, { headers }).then(r => r.json());
    if (!data.ok) throw new Error(data.error || 'Failed');
    detailEl.innerHTML = renderCollectionDetail(data);
  } catch(e) {
    detailEl.innerHTML = `<div class="banner err">Failed: ${escHtml(e.message)}</div>`;
  }
}

function renderCollectionDetail(ach) {
  const bits         = ach.bits || [];
  const allDone      = ach.completedBits === 'all';
  const doneBitSet   = new Set(allDone ? bits.map((_, i) => i) : (ach.completedBits || []));
  const hasProgress  = ach.completedBits !== null && ach.completedBits !== undefined;

  // Only count remaining (not yet collected) items for TP cost
  const needBits  = bits.filter((b, i) => !doneBitSet.has(i));
  const tpNeed    = needBits.filter(b => b.item_id && b.sell_price > 0);
  const totalCost = tpNeed.reduce((s, b) => s + b.sell_price, 0);
  const doneCount = doneBitSet.size;

  const desc = ach.description
    ? `<div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;">${escHtml(ach.description)}</div>` : '';
  const req  = ach.requirement
    ? `<div style="font-size:11px;color:var(--text-muted);font-style:italic;margin-bottom:8px;">${escHtml(ach.requirement)}</div>` : '';

  // Progress bar if we have account data
  const progressBar = hasProgress ? (() => {
    const pct = bits.length ? Math.round(doneCount / bits.length * 100) : 0;
    const barColor = allDone ? 'var(--green)' : 'var(--gold)';
    return `<div style="margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-secondary);margin-bottom:4px;">
        <span>${allDone ? '✓ Complete' : `${doneCount} / ${bits.length} collected`}</span>
        <span>${pct}%</span>
      </div>
      <div style="height:4px;background:var(--bg-elevated);border-radius:2px;overflow:hidden;">
        <div style="height:100%;width:${pct}%;background:${barColor};border-radius:2px;transition:width 0.3s;"></div>
      </div>
    </div>`;
  })() : '';

  const tpSummary = tpNeed.length
    ? `<div style="font-size:11px;color:var(--text-secondary);margin-bottom:10px;">
        ${tpNeed.length} still needed on TP — remaining instant-buy:
        <strong style="font-family:var(--font-data);color:var(--text-primary);">${formatCopperPlain(totalCost)}</strong>
       </div>`
    : (tpBitsTotal(bits) > 0
        ? `<div style="font-size:11px;color:var(--green);margin-bottom:10px;">✓ All TP-available items collected</div>`
        : '');

  const wikiUrl = `https://wiki.guildwars2.com/wiki/${encodeURIComponent((ach.name || '').replace(/ /g, '_'))}`;

  const bitsHtml = bits.map((b, i) => {
    const done     = doneBitSet.has(i);
    const hasPrice = b.item_id && b.sell_price > 0 && !done;
    const icon     = b.item_icon
      ? `<img class="bit-icon" src="${b.item_icon}" alt="" loading="lazy" onerror="this.style.display='none'" style="${done ? 'opacity:0.35;' : ''}">`
      : `<div class="bit-icon" style="${done ? 'opacity:0.35;' : ''}"></div>`;
    const doneTag  = done
      ? `<span style="color:var(--green);font-size:13px;flex-shrink:0;">✓</span>` : '';
    const name = b.item_name
      ? `<span class="bit-name item-name ${b.item_rarity || ''}" style="${done ? 'opacity:0.5;text-decoration:line-through;' : ''}">${escHtml(b.item_name)}</span>`
      : `<span class="bit-name" style="color:var(--text-muted);${done ? 'opacity:0.5;' : ''}">${escHtml(b.text || `Item #${b.item_id}`)}</span>`;
    const source = b.text && b.item_name
      ? `<div class="bit-source" style="${done ? 'opacity:0.5;' : ''}">${escHtml(b.text)}</div>` : '';
    const price = hasPrice
      ? `<div class="bit-price">${formatCopperPlain(b.sell_price)}</div>` : '';
    const itemWiki = b.item_name
      ? `<a href="https://wiki.guildwars2.com/wiki/${encodeURIComponent(b.item_name.replace(/ /g,'_'))}" target="_blank" rel="noopener" class="bit-wiki" title="Wiki">↗</a>`
      : '';
    // Cross-link: an Exotic weapon of a type with a Gen-1 legendary is precursor-shaped —
    // point at the Mystic Forge tab's rare-roll hunting instead of just showing "buy this".
    const isPrecursorCandidate = !done && b.item_rarity === 'Exotic' && b.item_subtype && LEGENDARY_TYPES.has(b.item_subtype);
    const forgeHint = isPrecursorCandidate
      ? `<button class="bit-wiki" style="background:none;border:none;cursor:pointer;color:var(--purple);" title="This weapon type has a legendary — try Mystic Forge rare rolls instead of buying outright" onclick="switchTab('forge')">⚗</button>`
      : '';
    return `<div class="bit-item${hasPrice ? ' has-tp' : ''}${done ? ' bit-done' : ''}">
      ${doneTag || icon}
      <div class="bit-info">${name}${source}</div>
      ${forgeHint}
      ${price}${itemWiki}
    </div>`;
  }).join('');

  const noKeyNote = !hasProgress && state.apiKey
    ? '' // had key but no data — achievements permission missing, but don't spam a warning
    : (!hasProgress && !state.apiKey
        ? `<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">Add your API key (top of sidebar) to see which items you've already collected.</div>`
        : '');

  return `${desc}${req}${progressBar}${noKeyNote}
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
      <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--gold);">${bits.length} items</span>
      <a href="${wikiUrl}" target="_blank" rel="noopener" class="bit-wiki" style="font-size:12px;margin-left:auto;">Open in wiki ↗</a>
    </div>
    ${tpSummary}
    <div class="bit-grid">${bitsHtml}</div>`;
}

function tpBitsTotal(bits) {
  return bits.filter(b => b.item_id && b.sell_price > 0).length;
}

// Achievement sync status polling
async function pollAchieveSyncStatus() {
  clearTimeout(achieveSyncPoll);
  try {
    const data = await fetch('/api/collections/sync-status').then(r => r.json());
    updateCollSyncBanner(data);
    if (data.status === 'running') {
      achieveSyncPoll = setTimeout(pollAchieveSyncStatus, 2000);
    } else if (data.status === 'done') {
      // Refresh categories in case they just populated
      loadCollectionCategories();
    }
  } catch(e) {}
}

function updateCollSyncBanner(data) {
  const banner = document.getElementById('collSyncBanner');
  if (!banner) return;
  if (data.status === 'running') {
    const pct = data.progress.total ? Math.round(data.progress.done / data.progress.total * 100) : 0;
    banner.className = 'sync-banner running';
    banner.textContent = `Syncing… ${pct}% (${(data.progress.done||0).toLocaleString()} / ${(data.progress.total||0).toLocaleString()})`;
  } else if (data.status === 'done') {
    banner.className = 'sync-banner done';
    banner.textContent = `Last synced ${formatAgo(data.lastSync)}`;
  } else {
    banner.className = 'sync-banner never';
    banner.textContent = 'Not yet synced';
  }
}

async function triggerAchievementSync() {
  const btn = document.getElementById('collSyncBtn');
  btn.disabled = true;
  try {
    await fetch('/api/collections/sync', { method: 'POST' });
    pollAchieveSyncStatus();
  } catch(e) {}
  setTimeout(() => { btn.disabled = false; }, 3000);
}

// ── Sync status polling ───────────────────────────────────────────────────────

async function pollSyncStatus() {
  try {
    const res  = await fetch('/api/flip/sync-status');
    const data = await res.json();
    updateSyncBanner(data);
    if (data.status === 'running' && state.activeTab === 'flipping') {
      syncPollTimer = setTimeout(pollSyncStatus, 2000);
    }
  } catch(e) { /* server offline — silent */ }
}

async function triggerSync() {
  try { await apiFetch('/api/flip/sync', {}); } catch(e) { /* already running */ }
  clearTimeout(syncPollTimer);
  setTimeout(pollSyncStatus, 500);
}

function updateSyncBanner(data) {
  const el = document.getElementById('syncStatusBanner');
  if (!el) return;
  const { status, progress, lastSync } = data;

  if (status === 'running') {
    const pct    = progress && progress.total > 0 ? Math.round(progress.done / progress.total * 100) : 0;
    const doneK  = progress ? Math.round(progress.done / 1000) : 0;
    const totalK = progress && progress.total > 0 ? Math.round(progress.total / 1000) : '…';
    el.innerHTML = `<div class="sync-banner running">
      <div style="flex:1;min-width:0">
        <div>Syncing all TP prices — ${doneK}k / ${totalK}k items (${pct}%)</div>
        <div style="height:2px;background:var(--border);border-radius:1px;margin-top:5px;">
          <div style="height:100%;width:${pct}%;background:var(--blue);border-radius:1px;transition:width 0.5s;"></div>
        </div>
      </div>
    </div>`;
  } else if (status === 'done') {
    const ago = lastSync ? formatAgo(lastSync) : null;
    el.innerHTML = `<div class="sync-banner done" style="justify-content:space-between;">
      <span>✓ Prices synced${ago ? ` · ${ago}` : ''}</span>
      <button class="btn btn-ghost" onclick="triggerSync()" style="font-size:11px;padding:2px 8px;">↺ Sync now</button>
    </div>`;
  } else if (status === 'error') {
    el.innerHTML = `<div class="sync-banner error" style="justify-content:space-between;">
      <span>⚠ Sync failed</span>
      <button class="btn btn-ghost" onclick="triggerSync()" style="font-size:11px;padding:2px 8px;">Retry</button>
    </div>`;
  } else {
    el.innerHTML = `<div class="sync-banner never">⏳ Initial price sync starting… Quick Wins appear once complete</div>`;
  }
}

function formatAgo(unixTs) {
  const secs = Math.floor(Date.now() / 1000) - unixTs;
  if (secs < 120)   return 'just now';
  if (secs < 3600)  return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
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
