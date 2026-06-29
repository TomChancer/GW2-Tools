// Electron main process — boots the existing Express server in-process (no
// separate node install needed by the end user) and opens it in a normal window.
// Auto-update logic itself lives in routes/app-update.js, exposed over HTTP so
// the plain web frontend can show status and trigger download/install explicitly.
const { app, BrowserWindow, Menu, globalShortcut, screen } = require('electron');
const path = require('path');

const ICON_PATH = path.join(__dirname, '..', 'build', 'icon.ico');
const OVERLAY_HOTKEY = 'Control+Shift+B';
const OVERLAY_WIDTH  = 420;
const OVERLAY_HEIGHT = 600;
const OVERLAY_MARGIN = 24;

let mainWindow    = null;
let overlayWindow = null;
let isQuitting    = false;
let serverPort    = null;
let pinInterval   = null;

// Windows ties native toast notifications to a registered AppUserModelID — without
// this, Notification.show() often fails silently (no error, nothing appears),
// especially in dev-mode runs that don't have a Start Menu shortcut. Must match
// the appId in package.json's build config for the installed app's shortcut to agree.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.ringo.gw2tools');
}

async function createWindow() {
  const { start } = require('../server');
  serverPort = await start();

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

  mainWindow.loadURL(`http://localhost:${serverPort}`);

  // The overlay window persists hidden (not destroyed) so the hotkey can keep reusing it,
  // which means window-all-closed won't reliably fire from the main window alone — quit explicitly.
  mainWindow.on('closed', () => { mainWindow = null; app.quit(); });

  createOverlayWindow(serverPort);
  globalShortcut.register(OVERLAY_HOTKEY, toggleOverlay);

  // Fullscreen-exclusive games bypass normal window Z-order entirely — a single
  // alwaysOnTop flag often isn't enough to stay above them. Keep re-asserting the
  // highest priority level on an interval while visible to fight back against that.
  pinInterval = setInterval(() => {
    if (overlayWindow && overlayWindow.isVisible()) {
      overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    }
  }, 2000);
}

// Wiki search overlay — a small always-on-top window, separate from the main
// app window, toggled by a global hotkey so it works while GW2 has focus.
function createOverlayWindow(port) {
  const db = require('../db');
  const saved = db.getMeta('overlay_pos');
  let x, y;
  if (saved) {
    try { ({ x, y } = JSON.parse(saved)); } catch(e) { /* fall through to default */ }
  }
  if (x == null || y == null) {
    const { workArea } = screen.getPrimaryDisplay();
    x = workArea.x + workArea.width  - OVERLAY_WIDTH  - OVERLAY_MARGIN;
    y = workArea.y + OVERLAY_MARGIN;
  }

  overlayWindow = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    x, y,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    icon: ICON_PATH,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // The constructor's alwaysOnTop flag alone defaults to a lower priority level —
  // explicitly bump to the highest ('screen-saver') so it has the best chance of
  // staying above other always-on-top windows and most fullscreen content.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');

  overlayWindow.loadURL(`http://localhost:${port}/overlay.html`);

  // Persist position (debounced) so it stays where the user dragged it across launches
  let moveTimer = null;
  overlayWindow.on('moved', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      const [px, py] = overlayWindow.getPosition();
      db.setMeta('overlay_pos', JSON.stringify({ x: px, y: py }));
    }, 400);
  });

  // The titlebar's ✕ button calls window.close() — intercept that to hide instead of
  // destroying the window, so the hotkey can bring the same instance back later.
  // Only let it actually close during real app shutdown.
  overlayWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      overlayWindow.hide();
    }
  });
  overlayWindow.on('closed', () => { overlayWindow = null; });
}

function toggleOverlay() {
  // Self-healing: if the reference is ever lost for any reason, just rebuild it
  // rather than leaving the hotkey permanently dead for the rest of the session.
  if (!overlayWindow) {
    if (serverPort) createOverlayWindow(serverPort);
    if (!overlayWindow) return;
  }
  if (overlayWindow.isVisible()) {
    overlayWindow.hide();
  } else {
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    overlayWindow.show();
    overlayWindow.focus();
  }
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
  app.on('before-quit', () => { isQuitting = true; });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); clearInterval(pinInterval); });
}
