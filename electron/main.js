// Electron main process — boots the existing Express server in-process (no
// separate node install needed by the end user) and opens it in a normal window.
const { app, BrowserWindow, Menu } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

const ICON_PATH = path.join(__dirname, '..', 'build', 'icon.ico');

let mainWindow = null;

// electron-updater needs the packaged app's update metadata (app-update.yml),
// which only exists in a built installer — running via `npm run electron` would just error.
function setupAutoUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.logger = console;
  autoUpdater.on('error', (err) => console.error('[AutoUpdater]', err.message));

  const check = () => autoUpdater.checkForUpdatesAndNotify().catch(e => console.error('[AutoUpdater]', e.message));
  check();
  setInterval(check, 4 * 60 * 60 * 1000); // re-check every 4h in case the app stays open
}

async function createWindow() {
  const { start } = require('../server');
  const port = await start();

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1024,
    minHeight: 640,
    title: 'GW2 Tools',
    icon: ICON_PATH,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(`http://localhost:${port}`);

  mainWindow.on('closed', () => { mainWindow = null; });

  setupAutoUpdater();
}

// Single instance lock — relaunching the .exe focuses the existing window instead of opening a second copy
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  Menu.setApplicationMenu(null);

  app.whenReady().then(createWindow).catch(e => {
    console.error('Failed to start GW2 Tools:', e);
    app.quit();
  });

  app.on('window-all-closed', () => app.quit());
}
