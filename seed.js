#!/usr/bin/env node
// seed.js — One-time DB population (downloads all GW2 recipes + items)
// Run: node seed.js

const { getAllRecipeIds, fetchRecipes, fetchItems } = require('./gw2api');
const db = require('./db');

const ITEM_FLAGS_BLOCK_TP = new Set([
  'AccountBound', 'SoulbindOnAcquire', 'MonsterOnly', 'NoSell', 'AccountBindOnUse'
]);

function isItemTradable(flags) {
  return !flags.some(f => ITEM_FLAGS_BLOCK_TP.has(f));
}

function progress(label, done, total) {
  const pct = Math.round((done / total) * 100);
  const bar = '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5));
  process.stdout.write(`\r  ${label}: [${bar}] ${pct}% (${done.toLocaleString()}/${total.toLocaleString()})`);
  if (done >= total) process.stdout.write('\n');
}

async function seed() {
  console.log('\n🌱 GW2 Craft Profit — Database Seeding');
  console.log('═'.repeat(45));

  // Init DB
  await db.getDb();

  // ── Step 1: Recipes ──────────────────────────────
  console.log('\n📜 Fetching recipe index...');
  const recipeIds = await getAllRecipeIds();
  console.log(`  Found ${recipeIds.length.toLocaleString()} recipes`);

  console.log('\n📜 Downloading recipe data...');
  const rawRecipes = await fetchRecipes(recipeIds, (d, t) => progress('Recipes', d, t));

  const recipes = rawRecipes
    .filter(r => r && r.output_item_id && r.ingredients?.length)
    .map(r => ({
      id: r.id,
      output_item_id: r.output_item_id,
      output_count: r.output_count || 1,
      disciplines: JSON.stringify(r.disciplines || []),
      ingredients: JSON.stringify(
        (r.ingredients || []).map(i => ({ id: i.item_id, count: i.count }))
      ),
    }));

  console.log(`  Storing ${recipes.length.toLocaleString()} valid recipes...`);
  db.upsertRecipes(recipes);

  // ── Step 2: Items ────────────────────────────────
  const neededItemIds = new Set();
  for (const r of recipes) {
    neededItemIds.add(r.output_item_id);
    const ings = JSON.parse(r.ingredients);
    for (const i of ings) neededItemIds.add(i.id);
  }

  const itemIdsToFetch = [...neededItemIds];
  console.log(`\n🧰 Downloading ${itemIdsToFetch.length.toLocaleString()} recipe-relevant items...`);
  const rawItems = await fetchItems(itemIdsToFetch, (d, t) => progress('Items', d, t));

  const items = rawItems
    .filter(i => i && i.id && i.name)
    .map(i => ({
      id: i.id,
      name: i.name,
      icon: i.icon || null,
      rarity: i.rarity || 'Basic',
      vendor_value: i.vendor_value || 0,
      flags: JSON.stringify(i.flags || []),
      tradable: isItemTradable(i.flags || []) ? 1 : 0,
    }));

  console.log(`  Storing ${items.length.toLocaleString()} items...`);
  db.upsertItems(items);

  // ── Done ─────────────────────────────────────────
  db.setMeta('seeded_at', Date.now());

  console.log('\n✅ Seed complete!');
  console.log(`   Recipes: ${db.getRecipeCount().toLocaleString()}`);
  console.log(`   Items:   ${db.getItemCount().toLocaleString()}`);
  console.log('\n   Now run: npm start\n');
}

seed().catch(err => {
  console.error('\n❌ Seed failed:', err.message);
  process.exit(1);
});
