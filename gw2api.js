const fetch = require('node-fetch');

const BASE       = 'https://api.guildwars2.com';
const BATCH_SIZE = 200;
const CONCURRENT = 4;
const RATE_DELAY = 100;

async function gw2Fetch(url, apiKey = null, retries = 3) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 429) { await sleep(Math.pow(2,attempt)*1000); continue; }
      if (!res.ok) { const b = await res.text(); throw new Error(`GW2 API error ${res.status}: ${b}`); }
      return res.json();
    } catch(e) { if (attempt===retries) throw e; await sleep(500*(attempt+1)); }
  }
}

// Generic endpoint fetch — used by server directly
async function apiFetch(endpoint, apiKey = null) {
  const url = endpoint.startsWith('http') ? endpoint : `${BASE}${endpoint}`;
  return gw2Fetch(url, apiKey);
}

async function fetchInBatches(endpoint, ids, apiKey = null, onProgress = null) {
  const results = [];
  const batches = chunk(ids, BATCH_SIZE);
  let done = 0;
  for (let i = 0; i < batches.length; i += CONCURRENT) {
    const group = batches.slice(i, i+CONCURRENT);
    const data  = await Promise.all(group.map(batch =>
      gw2Fetch(`${BASE}${endpoint}?ids=${batch.join(',')}`, apiKey)
    ));
    data.forEach(r => { if (Array.isArray(r)) results.push(...r); });
    done += group.reduce((s,b)=>s+b.length, 0);
    if (onProgress) onProgress(done, ids.length);
    if (i+CONCURRENT < batches.length) await sleep(RATE_DELAY);
  }
  return results;
}

async function getAccountMaterials(apiKey) { return gw2Fetch(`${BASE}/v2/account/materials`, apiKey); }
async function getAccountRecipes(apiKey)   { return gw2Fetch(`${BASE}/v2/account/recipes`, apiKey); }
async function validateApiKey(apiKey)      { return gw2Fetch(`${BASE}/v2/tokeninfo`, apiKey); }
async function getAllRecipeIds()            { return gw2Fetch(`${BASE}/v2/recipes`); }
async function getAllItemIds()              { return gw2Fetch(`${BASE}/v2/items`); }
async function fetchRecipes(ids, onProgress) { return fetchInBatches('/v2/recipes', ids, null, onProgress); }
async function fetchItems(ids, onProgress)   { return fetchInBatches('/v2/items', ids, null, onProgress); }
async function fetchPrices(ids)              { return fetchInBatches('/v2/commerce/prices', ids); }

function chunk(arr, size) { const c=[]; for(let i=0;i<arr.length;i+=size) c.push(arr.slice(i,i+size)); return c; }
function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

module.exports = { apiFetch, getAccountMaterials, getAccountRecipes, validateApiKey, getAllRecipeIds, getAllItemIds, fetchRecipes, fetchItems, fetchPrices };
