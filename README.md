# GW2 Tools

A desktop companion app for Guild Wars 2 that uses live Trading Post data to help you:

- **Crafting Profit** — analyse your material storage and find profitable recipes
- **Salvage Advisor** — decide what to salvage, sell, or extract upgrades from
- **Flipping** — spot Trading Post flips (quick wins from price dips, and steady buy-order/sell-listing spreads)
- **Mystic Forge** — find the cheapest rare/exotic weapon rolls for precursor and rare-skin hunting
- **Collections** — browse achievement collections with live TP prices for every required item, track your account progress, and find the cheapest collections left to finish

## Install (just want to use it)

Grab the latest installer from the [Releases page](https://github.com/TomChancer/GW2-Tools/releases) — no Node.js, no command line. Download `GW2 Tools Setup x.x.x.exe`, run it, done. The app checks for updates automatically on launch.

It's unsigned (no paid code-signing cert), so Windows SmartScreen will warn about an "unknown publisher" the first time — click **More info → Run anyway**.

### Getting an API key

Most tabs need a GW2 API key from https://account.arena.net/applications. Recommended permissions:

| Permission | Used by |
|---|---|
| `inventories` | Crafting, Salvage |
| `unlocks` | Crafting (recipe ownership) |
| `characters` | Salvage (character bags) |
| `achievements` | Collections (progress tracking, "cheapest to finish") |

Your key is stored only in the app's session and is never written to disk or sent anywhere except the official GW2 API.

## Developing

```bash
npm install
node seed.js        # one-time: downloads all recipes + items from the GW2 API (~2-3 min)
npm run electron     # launches the app like the packaged build, but live from source
```

Or run it as a plain browser app instead of the Electron shell:

```bash
npm start            # then open http://localhost:3000
```

### Building an installer

```bash
npm run dist         # builds dist/GW2 Tools Setup x.x.x.exe locally, no publish
npm run release       # builds AND uploads to GitHub Releases (needs $env:GH_TOKEN with repo write access)
```

If you change the app icon, regenerate it first: `node scripts/make-icon.js` (reads `build/icon-source.png`, writes `build/icon.ico`).

## Project structure

```
GW2Tools/
├── server.js          # Express app + shared schedulers; exports start() for Electron
├── electron/main.js   # Electron main process — boots server.js in-process, opens a window
├── routes/            # One Express router per feature (craft, salvage, history, forge, flip, collections)
├── db.js              # SQLite (sql.js) schema + queries
├── gw2api.js           # GW2 API client (batched fetches, rate limiting)
├── profit.js          # Crafting profit calculations
├── salvage-kits.js    # Salvage kit EV calculations
├── seed.js            # One-time DB population script
├── scripts/make-icon.js
├── build/icon.ico     # App icon (Windows)
├── public/            # Frontend — plain HTML/CSS/JS, no build step
└── gw2.db             # SQLite database (gitignored — created by seed.js, lives in %APPDATA% once packaged)
```

## How profits are calculated

All prices account for the 15% Trading Post fee (5% listing + 10% sale) unless noted otherwise.

| Term | Meaning |
|---|---|
| **Profit vs Raw** | Craft sell value − value of selling all ingredients individually |
| **Cash Profit** | Craft sell value − only the mats you need to buy |
| **Quick Win** | An item currently priced well below its 7-day average sell price |
| **Normal Flip** | Buy-order → sell-listing spread, filtered for real liquidity (min quantity, max spread ratio) |
