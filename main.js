const {
  app, BrowserWindow, ipcMain, globalShortcut,
  Menu, Tray, nativeImage, dialog, Notification,
  shell, powerSaveBlocker, net, session
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Store = require('electron-store');

// ---------- Миграция хранилища после ренейма (GrindoApp → VOLNA) ----------
// electron-store лежит в %APPDATA%/<имя приложения>/ — переносим старый файл данных,
// чтобы лайки, история и плейлисты не потерялись.
try {
  const targetDir = app.getPath('userData');
  const target = path.join(targetDir, 'grindoapp-data.json');
  if (!fs.existsSync(target)) {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    for (const oldName of ['GrindoApp', 'grindoapp']) {
      const src = path.join(appData, oldName, 'grindoapp-data.json');
      if (fs.existsSync(src)) {
        fs.mkdirSync(targetDir, { recursive: true });
        fs.copyFileSync(src, target);
        console.info('[VOLNA] данные перенесены из', oldName);
        break;
      }
    }
  }
} catch (_) {}

// ---------- Storage ----------
const store = new Store({
  name: 'grindoapp-data',
  defaults: {
    favorites: [],
    history: [],
    playlists: [],
    recentSearches: [],
    settings: {
      theme: 'dark',
      accent: 'neon',
      volume: 1,
      notifyOnLike: true,
      startMinimized: false,
      saveWindowState: true,
      windowBounds: { x: undefined, y: undefined, width: 1400, height: 900 },
      antiblock: { doh: true, proxy: '' },
    },
    stats: { totalPlayed: 0, totalTime: 0, sessionStart: Date.now() }
  }
});

// ---------- Антиблок: флаги сети (до app ready) ----------
// DoH — DNS-запросы через Cloudflare, обходит подмену/блокировку DNS.
// все флаги enable-features — одним значением: повторный appendSwitch затёр бы предыдущий
const features = [];
if (store.get('settings.antiblock.doh') !== false) {
  features.push('DnsOverHttps<DoHTrial');
  app.commandLine.appendSwitch('force-fieldtrials', 'DoHTrial/Group1');
  app.commandLine.appendSwitch('force-fieldtrial-params',
    'DoHTrial.Group1:DnsOverHttpsTemplates/https://cloudflare-dns.com/dns-query,Fallback/true');
}
// ECH — шифрует SNI в TLS ClientHello там, где хостинг поддерживает (Cloudflare/sndcdn).
// Не спасает на CloudFront (api-v2) — там выручает прокси-режим или драйверный обход (zapret и т.п.).
features.push('EncryptedClientHello');
app.commandLine.appendSwitch('enable-features', features.join(','));

// ---------- Single instance ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

// ---------- Window ----------
let win = null;
let tray = null;
let blockerId = null;

function createWindow() {
  const bounds = store.get('settings.windowBounds');

  win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#07070d',
    title: 'VOLNA',
    icon: path.join(__dirname, 'renderer', 'logo.png'),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: true,
      preload: false
    }
  });

  win.once('ready-to-show', () => {
    if (store.get('settings.startMinimized') && tray) win.hide();
    else win.show();
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Save window state on move/resize/close (debounced)
  let boundsTimer = null;
  const saveBounds = () => {
    if (!store.get('settings.saveWindowState') || !win) return;
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (win) store.set('settings.windowBounds', win.getBounds());
    }, 500);
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  // F12 — DevTools
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools();
    }
  });

  // Minimize to tray instead of quit (configurable)
  win.on('close', (e) => {
    if (app.isQuitting) return;
    if (tray && !app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---------- Tray ----------
let trayNow = null; // { title, artist, isPlaying } — что сейчас играет

function buildTrayMenu() {
  const template = [
    { label: 'VOLNA', enabled: false },
    { type: 'separator' },
    {
      label: '▶ / ❚❚  Play / Pause',
      click: () => win?.webContents.send('media:toggle')
    },
    {
      label: '⏭  Next',
      click: () => win?.webContents.send('media:next')
    },
    {
      label: '⏮  Previous',
      click: () => win?.webContents.send('media:prev')
    },
    { type: 'separator' },
    {
      label: 'Show Window',
      click: () => { if (win) { win.show(); win.focus(); } }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ];
  // now playing — первой строкой после заголовка
  if (trayNow) {
    template.splice(2, 0, {
      label: `${trayNow.isPlaying ? '▶' : '⏸'} ${trayNow.title}${trayNow.artist ? ' — ' + trayNow.artist : ''}`,
      enabled: false
    }, { type: 'separator' });
  }
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  const trayIcon = nativeImage
    .createFromPath(path.join(__dirname, 'renderer', 'logo.png'))
    .resize({ width: 16, height: 16 });
  tray = new Tray(trayIcon);

  buildTrayMenu();
  tray.setToolTip('VOLNA');
  tray.on('double-click', () => {
    if (win) { win.show(); win.focus(); }
  });
}

ipcMain.handle('tray:nowplaying', (_e, info) => {
  trayNow = info && info.title
    ? {
        title: String(info.title).slice(0, 60),
        artist: String(info.artist || '').slice(0, 40),
        isPlaying: !!info.isPlaying
      }
    : null;
  if (tray) {
    buildTrayMenu();
    tray.setToolTip(trayNow ? `${trayNow.isPlaying ? '▶' : '⏸'} ${trayNow.title} — VOLNA` : 'VOLNA');
  }
  return true;
});

// ---------- IPC Handlers ----------
// SoundCloud API proxy: net.fetch не ограничен CORS, а браузерный fetch
// из renderer заблокирован (api-v2 не отдаёт ACAO для чужих origin).
const SC_ALLOWED = /^https:\/\/([a-z0-9-]+\.)*(soundcloud|sndcdn)\.com\/|^https:\/\/lrclib\.net\//i;

async function applyProxy() {
  const p = (store.get('settings.antiblock.proxy') || '').trim();
  const rules = p
    ? { mode: 'fixed_servers', proxyRules: p, proxyBypassRules: '<local>' }
    : { mode: 'system' };
  try {
    await session.defaultSession.setProxy(rules);
    await session.fromPartition('persist:sc-auth').setProxy(rules); // окно входа тоже
    return true;
  } catch (e) { return false; }
}

ipcMain.handle('antiblock:proxy', async (_e, str) => {
  if (typeof str !== 'string') return false;
  const s = str.trim();
  if (s && !/^(socks5|socks4|http|https):\/\//i.test(s) && !/^[\w.-]+:\d+$/.test(s)) {
    return { ok: false, error: 'Формат: socks5://127.0.0.1:10808 или http://host:port' };
  }
  store.set('settings.antiblock.proxy', s);
  const ok = await applyProxy();
  return { ok, error: ok ? '' : 'Не удалось применить прокси' };
});

ipcMain.handle('antiblock:doh', (_e, on) => {
  store.set('settings.antiblock.doh', !!on);
  return true;
});

ipcMain.handle('antiblock:nettest', async () => {
  const targets = [
    { host: 'api-v2.soundcloud.com (поиск)', url: 'https://api-v2.soundcloud.com/' },
    { host: 'soundcloud.com (сайт)', url: 'https://soundcloud.com/' },
    { host: 'w.soundcloud.com (плеер)', url: 'https://w.soundcloud.com/player/' },
    { host: 'sndcdn.com (обложки/медиа)', url: 'https://i1.sndcdn.com/' }
  ];
  const results = [];
  for (const t of targets) {
    const t0 = Date.now();
    try {
      const res = await net.fetch(t.url, {
        session: session.defaultSession,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36' },
        signal: AbortSignal.timeout(6000)
      });
      results.push({ host: t.host, ok: true, ms: Date.now() - t0, status: res.status });
    } catch (e) {
      results.push({ host: t.host, ok: false, ms: Date.now() - t0, status: 0 });
    }
  }
  const allOk = results.every(r => r.ok);
  return { results, allOk, proxy: (store.get('settings.antiblock.proxy') || '').trim() };
});


ipcMain.handle('sc:fetch', async (_e, url, opts = {}) => {
  if (typeof url !== 'string' || !SC_ALLOWED.test(url)) {
    return { ok: false, status: 400, error: 'Blocked URL' };
  }
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/html, */*'
    };
    // авторизованные запросы: cookie-сессия окна входа или токен ручного входа
    const reqSession = session.fromPartition('persist:sc-auth');
    if (opts.token) headers.Authorization = 'OAuth ' + opts.token;
    else if (opts.auth) {
      const sa = store.get('settings.scAuth');
      if (sa?.mode === 'token' && sa.token) headers.Authorization = 'OAuth ' + sa.token;
    }
    const res = await net.fetch(url, {
      session: reqSession,
      method: opts.method || 'GET',
      signal: AbortSignal.timeout(15000),
      headers
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
});

// ---------- Аккаунт SoundCloud: вход через окно сайта (cookie-сессия) ----------
let authWin = null;
let authPending = null;

const SC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

ipcMain.handle('auth:login', async (_e, clientId) => {
  if (authPending) return { ok: false, error: 'Вход уже идёт' };
  if (!clientId) return { ok: false, error: 'Нет client_id' };
  const done = new Promise(res => { authPending = res; });
  const authSession = session.fromPartition('persist:sc-auth');
  authWin = new BrowserWindow({
    width: 480,
    height: 760,
    parent: win,
    show: true,
    title: 'Вход через SoundCloud',
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, partition: 'persist:sc-auth' }
  });
  authWin.webContents.setUserAgent(SC_UA);
  authSession.setUserAgent(SC_UA);
  authWin.loadURL('https://soundcloud.com/sign-in');

  // пока окно открыто — раз в 2.5с проверяем, не залогинились ли (куки сессии + /me)
  let finished = false;
  const finish = (r) => {
    if (finished) return;
    finished = true;
    clearInterval(poll);
    clearTimeout(timeout);
    if (authWin) { try { authWin.close(); } catch (_) {} }
    authWin = null;
    if (authPending) { const p = authPending; authPending = null; p(r); }
  };
  const poll = setInterval(async () => {
    if (!authWin || finished) { if (finished) clearInterval(poll); return; }
    try {
      const res = await net.fetch('https://api-v2.soundcloud.com/me?client_id=' + clientId, {
        session: authSession,
        signal: AbortSignal.timeout(6000),
        headers: { 'User-Agent': SC_UA, 'Accept': 'application/json' }
      });
      if (res.ok) {
        const me = JSON.parse(await res.text());
        if (me && me.username) finish({ ok: true, me });
      }
    } catch (_) {}
  }, 2500);
  const timeout = setTimeout(() => finish({ ok: false, error: 'Время ожидания вышло (5 мин)' }), 300000);

  authWin.on('closed', () => {
    clearInterval(poll);
    if (!finished && authPending) { const p = authPending; authPending = null; p({ ok: false, error: 'Окно закрыто' }); }
    authWin = null;
    finished = true;
  });
  return done;
});

ipcMain.handle('auth:logout', async () => {
  try { await session.fromPartition('persist:sc-auth').clearStorageData(); } catch (_) {}
  return true;
});

ipcMain.handle('auth:save', (_e, payload) => {
  store.set('settings.scAuth', payload || null);
  return true;
});

ipcMain.handle('store:get', (_e, key) => store.get(key));
ipcMain.handle('store:set', (_e, key, val) => { store.set(key, val); return val; });

ipcMain.handle('favorites:get', () => store.get('favorites'));
ipcMain.handle('favorites:save', (_e, favs) => { store.set('favorites', favs); return favs; });
ipcMain.handle('favorites:clear', () => { store.set('favorites', []); return []; });

ipcMain.handle('history:get', () => store.get('history'));
ipcMain.handle('history:save', (_e, hist) => { store.set('history', hist); return hist; });
ipcMain.handle('history:clear', () => { store.set('history', []); return []; });

ipcMain.handle('playlists:get', () => store.get('playlists'));
ipcMain.handle('playlists:save', (_e, pls) => { store.set('playlists', pls); return pls; });

ipcMain.handle('settings:get', () => store.get('settings'));
ipcMain.handle('settings:set', (_e, key, val) => {
  store.set(`settings.${key}`, val);
  return store.get('settings');
});
ipcMain.handle('settings:reset', () => {
  store.delete('settings');
  return store.get('settings');
});

ipcMain.handle('stats:get', () => store.get('stats'));
ipcMain.handle('stats:update', (_e, delta) => {
  const s = store.get('stats');
  s.totalPlayed += delta.played || 0;
  s.totalTime += delta.time || 0;
  store.set('stats', s);
  return s;
});
ipcMain.handle('stats:reset', () => {
  const fresh = { totalPlayed: 0, totalTime: 0, sessionStart: Date.now() };
  store.set('stats', fresh);
  return fresh;
});

ipcMain.handle('recentSearches:get', () => store.get('recentSearches'));
ipcMain.handle('recentSearches:push', (_e, q) => {
  let arr = store.get('recentSearches');
  arr = arr.filter(x => x !== q);
  arr.unshift(q);
  arr = arr.slice(0, 20);
  store.set('recentSearches', arr);
  return arr;
});

ipcMain.handle('dialog:exportFavs', async () => {
  if (!win) return { ok: false };
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export Favorites',
    defaultPath: 'volna-favorites.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (canceled || !filePath) return { ok: false };
  const data = store.get('favorites');
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return { ok: true, path: filePath };
});

ipcMain.handle('dialog:importFavs', async () => {
  if (!win) return { ok: false };
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import Favorites',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths.length) return { ok: false };
  try {
    const raw = fs.readFileSync(filePaths[0], 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { ok: false, error: 'Not an array' };
    return { ok: true, data: parsed };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('dialog:exportAll', async () => {
  if (!win) return { ok: false };
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export Full Backup',
    defaultPath: `volna-backup-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (canceled || !filePath) return { ok: false };
  const backup = {
    version: 1,
    exportedAt: new Date().toISOString(),
    favorites: store.get('favorites'),
    history: store.get('history'),
    playlists: store.get('playlists'),
    settings: store.get('settings'),
    stats: store.get('stats')
  };
  fs.writeFileSync(filePath, JSON.stringify(backup, null, 2), 'utf8');
  return { ok: true, path: filePath };
});

ipcMain.handle('dialog:importAll', async () => {
  if (!win) return { ok: false };
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import Full Backup',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths.length) return { ok: false };
  try {
    const raw = fs.readFileSync(filePaths[0], 'utf8');
    const backup = JSON.parse(raw);
    if (!backup || typeof backup !== 'object') return { ok: false, error: 'Invalid backup' };
    if (Array.isArray(backup.favorites)) store.set('favorites', backup.favorites);
    if (Array.isArray(backup.history)) store.set('history', backup.history);
    if (Array.isArray(backup.playlists)) store.set('playlists', backup.playlists);
    if (backup.settings) store.set('settings', { ...store.get('settings'), ...backup.settings });
    if (backup.stats) store.set('stats', backup.stats);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('shell:openExternal', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
    return true;
  }
  return false;
});

ipcMain.handle('notify', (_e, { title, body }) => {
  if (!Notification.isSupported()) return false;
  new Notification({ title, body, silent: false }).show();
  return true;
});

ipcMain.handle('app:version', () => ({
  version: app.getVersion(),
  name: app.getName(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform
}));

ipcMain.handle('app:quit', () => {
  app.isQuitting = true;
  app.quit();
});

ipcMain.handle('powerSave:enable', () => {
  if (blockerId !== null) powerSaveBlocker.stop(blockerId);
  blockerId = powerSaveBlocker.start('prevent-display-sleep');
  return blockerId;
});
ipcMain.handle('powerSave:disable', () => {
  if (blockerId !== null) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
  return true;
});

// ---------- Lifecycle ----------
app.whenReady().then(async () => {
  await applyProxy(); // применяем прокси (если задан) ко всему трафику приложения
  createWindow();
  createTray();

  // Global media keys
  try {
    globalShortcut.register('MediaPlayPause', () => win?.webContents.send('media:toggle'));
    globalShortcut.register('MediaNextTrack', () => win?.webContents.send('media:next'));
    globalShortcut.register('MediaPreviousTrack', () => win?.webContents.send('media:prev'));
    globalShortcut.register('MediaStop', () => win?.webContents.send('media:stop'));
  } catch (_) {}
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (blockerId !== null) {
    try { powerSaveBlocker.stop(blockerId); } catch (_) {}
  }
});
