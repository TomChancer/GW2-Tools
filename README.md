# GW2 Craft Profit

A localhost webapp that analyses your GW2 material storage and finds the most profitable crafting opportunities using live Trading Post prices.

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or later

### First-time setup

```bash
# 1. Install dependencies
npm install

# 2. Seed the database (downloads all recipes + items from the GW2 API)
#    This takes ~2-3 minutes and only needs to be done once.
node seed.js

# 3. Start the server
npm start
```

Then open **http://localhost:3000** in your browser.

---

## Usage

1. **Generate an API key** at https://account.arena.net/applications
   - Required permissions: `inventories`, `unlocks`
   - Optional but useful: `wallet`, `characters`

2. **Paste your key** in the sidebar and click **Test** to validate it.

3. **Configure filters:**
   - Toggle disciplines on/off
   - Enable/disable partial crafts (recipes where you need to buy some ingredients)
   - Set a minimum profit threshold and max spend on missing mats

4. **Click Analyze Crafts** — results appear ranked by profit vs selling the raw mats.

---

## How profits are calculated

| Term | Meaning |
|---|---|
| **Profit vs Raw** | Craft sell value − value of selling all ingredients individually. Positive = crafting beats raw selling. |
| **Cash Profit** | Craft sell value − only the mats you need to buy. Ignores opportunity cost of mats you already own. |
| **Sell instant** | Highest active buy order × output count × 0.85 (15% TP tax) |
| **Sell listing** | Lowest active sell listing × output count × 0.85 |

All prices include the 15% Trading Post fee (5% listing + 10% sale).

---

## Refreshing data

- **TP prices** refresh automatically every 5 minutes as you analyze.
- **Recipe/item data** is permanent until the game updates. To re-seed:
  ```bash
  node seed.js
  ```

---

## Project structure

```
gw2-craft/
├── server.js     # Express server + API routes
├── seed.js       # One-time DB population script
├── db.js         # SQLite helpers
├── gw2api.js     # GW2 API client (batching, rate limiting)
├── profit.js     # Profit calculation engine
├── gw2.db        # SQLite database (auto-created)
├── public/
│   ├── index.html
│   └── app.js
└── package.json
```
