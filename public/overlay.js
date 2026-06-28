// overlay.js — GW2 Wiki search overlay (separate mini-app from the main index.html/app.js)

const els = {
  searchInput: document.getElementById('searchInput'),
  searchBtn:   document.getElementById('searchBtn'),
  results:     document.getElementById('results'),
  pageFrame:   document.getElementById('pageFrame'),
  pageToolbar: document.getElementById('pageToolbar'),
  pageTitle:   document.getElementById('pageTitle'),
  backBtn:     document.getElementById('backBtn'),
  closeBtn:    document.getElementById('closeBtn'),
};

let searchTimer = null;

els.searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 300);
});
els.searchBtn.addEventListener('click', runSearch);
els.searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
els.backBtn.addEventListener('click', showSearchView);
els.closeBtn.addEventListener('click', () => window.close());

async function runSearch() {
  const q = els.searchInput.value.trim();
  if (!q) {
    els.results.innerHTML = `<div class="empty-hint">Type a search term above — items, achievements, mobs, mechanics, anything on the wiki.</div>`;
    return;
  }
  els.results.innerHTML = `<div class="empty-hint">Searching…</div>`;
  try {
    const data = await fetch(`/api/wiki/search?q=${encodeURIComponent(q)}`).then(r => r.json());
    if (!data.ok) throw new Error(data.error || 'Search failed');
    renderResults(data.results);
  } catch(e) {
    els.results.innerHTML = `<div class="empty-hint">Search failed: ${escHtml(e.message)}</div>`;
  }
}

function renderResults(results) {
  if (!results.length) {
    els.results.innerHTML = `<div class="empty-hint">No results found.</div>`;
    return;
  }
  els.results.innerHTML = results.map(r =>
    `<div class="result-item" data-title="${escHtml(r.title)}" data-url="${escHtml(r.url)}">${escHtml(r.title)}</div>`
  ).join('');
  document.querySelectorAll('.result-item').forEach(el => {
    el.addEventListener('click', () => openPage(el.dataset.title, el.dataset.url));
  });
}

function openPage(title, url) {
  els.pageFrame.src = url;
  els.pageFrame.classList.add('active');
  els.pageTitle.textContent = title;
  els.pageToolbar.classList.add('active');
  els.searchInput.parentElement.style.display = 'none';
}

function showSearchView() {
  els.pageFrame.classList.remove('active');
  els.pageFrame.src = '';
  els.pageToolbar.classList.remove('active');
  els.searchInput.parentElement.style.display = 'flex';
  els.searchInput.focus();
}

function escHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
