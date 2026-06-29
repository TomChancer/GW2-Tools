// Exposes electron-updater over HTTP so the plain web frontend (no preload/IPC)
// can show update status and let the user explicitly trigger download + install,
// instead of electron-updater's default silent-download/auto-install-on-quit behavior.
const express = require('express');
const router  = express.Router();

const state = { status: 'unsupported', version: null, progress: 0, error: null };

let autoUpdater = null;
if (process.versions && process.versions.electron) {
  try {
    const { app } = require('electron');
    if (app.isPackaged) {
      autoUpdater = require('electron-updater').autoUpdater;
    }
  } catch (e) { /* not actually running inside Electron's main process */ }
}

if (autoUpdater) {
  autoUpdater.autoDownload        = false; // wait for an explicit "download" click
  autoUpdater.autoInstallOnAppQuit = false; // wait for an explicit "install" click
  state.status = 'idle';

  autoUpdater.on('checking-for-update', () => { state.status = 'checking'; });
  autoUpdater.on('update-available', (info) => {
    state.status   = 'available';
    state.version  = info.version;
    state.progress = 0;
  });
  autoUpdater.on('update-not-available', () => {
    state.status  = 'up-to-date';
    state.version = null;
  });
  autoUpdater.on('download-progress', (p) => {
    state.status   = 'downloading';
    state.progress = Math.round(p.percent || 0);
  });
  autoUpdater.on('update-downloaded', (info) => {
    state.status   = 'downloaded';
    state.version  = info.version;
    state.progress = 100;
  });
  autoUpdater.on('error', (err) => {
    state.status = 'error';
    state.error  = err.message;
  });
}

router.get('/', (req, res) => res.json({ ok: true, ...state }));

router.post('/check', (req, res) => {
  if (!autoUpdater) return res.json({ ok: false, error: 'Updater not available in this build' });
  autoUpdater.checkForUpdates().catch(e => { state.status = 'error'; state.error = e.message; });
  res.json({ ok: true });
});

router.post('/download', (req, res) => {
  if (!autoUpdater) return res.json({ ok: false, error: 'Updater not available in this build' });
  if (state.status !== 'available') return res.json({ ok: false, error: 'No update available to download' });
  // Set this synchronously, before kicking off the actual (async) download — electron-updater's
  // own 'download-progress' event has a startup delay, and a poll landing in that gap would
  // otherwise still see 'available' and incorrectly re-render the clickable state.
  state.status   = 'downloading';
  state.progress = 0;
  autoUpdater.downloadUpdate().catch(e => { state.status = 'error'; state.error = e.message; });
  res.json({ ok: true });
});

router.post('/install', (req, res) => {
  if (!autoUpdater) return res.json({ ok: false, error: 'Updater not available in this build' });
  if (state.status !== 'downloaded') return res.json({ ok: false, error: 'Update not downloaded yet' });
  res.json({ ok: true });
  autoUpdater.quitAndInstall();
});

function start() {
  if (!autoUpdater) return;
  const check = () => autoUpdater.checkForUpdates().catch(e => { state.status = 'error'; state.error = e.message; });
  check();
  setInterval(check, 4 * 60 * 60 * 1000); // re-check every 4h in case the app stays open
}

module.exports = { router, start };
