# GW2 Tools — working notes for Claude

A GW2 desktop companion app (Crafting Profit, Salvage Advisor, Flipping, Mystic Forge, Collections). Plain Express + `sql.js` + vanilla HTML/JS frontend, wrapped in Electron for distribution. Public repo: https://github.com/TomChancer/GW2-Tools (Thomas Chance / TomChancer).

## Performing a release

When asked to "release", "ship", "cut a new version", etc.:

1. Bump `"version"` in `package.json` to whatever the user specifies (or the next patch/minor if unspecified — ask if ambiguous).
2. `git add package.json && git commit -m "Bump version to X.X.X" && git push`
3. **Stop there.** Do NOT run `npm run release` yourself — it needs `$env:GH_TOKEN`, a credential that lives only in the user's own terminal session. Tell the user to run it themselves:
   ```powershell
   cd C:\Users\ringo\Desktop\GW2Tools
   $env:GH_TOKEN = "ghp_..."
   npm run release
   ```
4. After they confirm it ran, verify it actually published — `WebFetch` on `https://api.github.com/repos/TomChancer/GW2-Tools/releases/latest` and check `tag_name`, `draft: false`, `prerelease: false`, and that 3 assets exist (`GW2-Tools-Setup-X.X.X.exe`, `.exe.blockmap`, `latest.yml`). The GitHub API has a short cache — if it still shows the old version right after a release, wait a moment and recheck before assuming failure.
5. `releaseType: "release"` is already set in `package.json`'s `build.publish` config, so releases auto-publish — no manual "Edit draft → Publish" step needed anymore.

**Never ask the user to paste their `GH_TOKEN` into chat.** It's a credential; it only ever belongs in their own terminal.

## Running in dev mode

- `npm run electron` — launches exactly like the packaged app (own window, same DB-path logic, etc.) but live from source. This is the default for "let me test this."
- `npm start` then open `http://localhost:3000` — plain browser, no Electron shell. Useful for quick UI iteration without an extra window.
- Both read `gw2.db` directly from the project root (gitignored, not committed). The **packaged/installed** app instead uses `%APPDATA%\gw2-craft-profit\gw2.db`, seeded by copying the project's `gw2.db` on first launch (see `db.js` → `resolveDbPath()`). Reinstalling/updating the app never touches that folder, so account data/sync history persists across releases.

## Machine-specific quirk (this machine)

This machine has `nvm4w` (nvm for Windows) installed under a different Windows user profile (`TomWork`), with the active version symlinked at `C:\nvm4w\nodejs`. **A non-elevated PowerShell/terminal silently falls back to an old Node (14.x)**, which breaks `electron-builder` (`Cannot find module 'node:url'`). If a build/release command fails with that error, the fix is: open PowerShell/terminal **as Administrator**, run `nvm use 20.20.2` once — it persists across normal (non-elevated) sessions afterward, no need to repeat it every time.

Also: `nvm` commands run through my own Bash/PowerShell tool calls pop up a blocking "NVM should be run from a terminal" GUI dialog and don't actually work — don't bother retrying that yourself; tell the user to run `nvm` commands in their own terminal window instead.

## Architecture conventions

- `server.js` is intentionally slim — it only holds `/api/status`, `/api/validate-key`, the hourly snapshot scheduler, and router mounting. Everything else lives in `routes/*.js`, one file per feature (`craft`, `salvage`, `history`, `forge`, `flip`, `collections`, `app-update`).
- Routers with their own background schedulers (`flip`, `collections`, `app-update`) export `{ router, start() }` — `start()` is called once from `server.js`'s own `start()`, after `app.listen` resolves. Follow this pattern for any new feature that needs a recurring job.
- `server.js` exports `{ start, PORT }` and only auto-runs when invoked directly (`node server.js`) — `require.main === module` guard. `electron/main.js` requires it and calls `start()` itself, awaiting the resolved port before creating the window. Don't reintroduce a top-level auto-invoked `start()` call outside that guard.
- `db.upsertItems()` uses `INSERT ... ON CONFLICT DO UPDATE` (not `INSERT OR REPLACE`) specifically so `item_type`/`item_subtype` (set separately by the type backfill) survive being re-upserted by other code paths. Don't revert this to `OR REPLACE`.
- Auto-update (`routes/app-update.js`) talks to the frontend over plain HTTP polling (`/api/app-update`), not Electron IPC/preload/contextBridge — the BrowserWindow just loads `http://localhost:PORT` like a normal browser tab, so the renderer has zero Node/Electron access by design (`nodeIntegration: false`). Keep it that way; don't add a preload script unless there's a real reason to.
- `electron-updater`'s default behavior (`checkForUpdatesAndNotify`) auto-downloads and auto-installs-on-quit. This is **intentionally disabled** (`autoDownload = false`, `autoInstallOnAppQuit = false`) — the user wants explicit click-to-download and click-to-install via the topbar status indicator, not silent background updates.

## Deliberate policy decisions (don't undo without asking)

- The README documents installing the pre-built app and developing from source — **not** how to build an installer or regenerate the icon. Those are maintainer-only steps and intentionally undocumented for end users.
- `scripts/make-icon.js` and `build/icon-source.png` were deleted after one-time use. If the icon ever needs to change again, recreate the resize+pack step from scratch (`sharp` to resize to 16/24/32/48/64/128/256px, `png-to-ico` to pack into `build/icon.ico`) — don't assume the tooling still exists.
- The repo is public; the GW2 API key is never persisted server-side (verified — it's `sessionStorage` only, request-scoped on the server). Keep it that way if touching auth-related code.
