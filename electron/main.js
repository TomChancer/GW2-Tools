// Electron main process — boots the existing Express server in-process (no
// separate node install needed by the end user) and opens it in a normal window.
// Auto-update logic itself lives in routes/app-update.js, exposed over HTTP so
// the plain web frontend can show status and trigger download/install explicitly.
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

const ICON_PATH = path.join(__dirname, '..', 'build', 'icon.ico');

let mainWindow = null;

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
