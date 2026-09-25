const {
  app, BrowserWindow, ipcMain, globalShortcut,
  Menu, Tray, nativeImage, dialog, Notification,
  shell, powerSaveBlocker, net, session, clipboard, protocol, powerMonitor
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Store = require('electron-store');

// ---------- Мини-плеер: отдельное окно поверх всех окон ----------
let miniWin = null;
let miniBoundsTimer = null;

ipcMain.handle('mini:toggle', () => {
  if (miniWin) { miniWin.close(); return false; }
  if (!win) return false;
  miniWin = new BrowserWindow({
    width: 340, height: 120,
    minWidth: 300, maxWidth: 520, minHeight: 100, maxHeight: 160,
    frame: false, alwaysOnTop: true, show: false,
    backgroundColor: '#0a0a12', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'preload-mini.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });
  const mb = store.get('settings.miniBounds');
  if (mb && typeof mb.x === 'number') miniWin.setPosition(mb.x, mb.y);
  miniWin.setAlwaysOnTop(true, 'floating');
  miniWin.loadFile(path.join(__dirname, 'renderer', 'mini.html'));
  miniWin.once('ready-to-show', () => miniWin.show());
  miniWin.on('move', () => {
    clearTimeout(miniBoundsTimer);
    miniBoundsTimer = setTimeout(() => {
      if (miniWin) store.set('settings.miniBounds', miniWin.getBounds());
    }, 500);
  });
  miniWin.on('closed', () => {
    miniWin = null;
    win?.webContents.send('mini:closed');
  });
  return true;
});

ipcMain.on('mini:sync', (_e, data) => {
  if (miniWin && !miniWin.isDestroyed()) miniWin.webContents.send('mini:sync', data);
});

ipcMain.on('mini:action', (_e, a) => {
  if (!win) return;
  const map = { toggle: 'media:toggle', next: 'media:next', prev: 'media:prev' };
  if (map[a]) win.webContents.send(map[a]);
  if (a === 'close' && miniWin) miniWin.close();
});

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

// ---------- Discord Rich Presence ----------
// client_id приложения Discord (создаётся в Developer Portal)
const DISCORD_ID = '1552786913016942634';
let rpc = null;            // клиент discord-rpc
let rpcReady = false;      // рукопожатие с Discord прошло
let rpcPending = null;     // последний статус, ждущий ready
let rpcRetryTimer = null;
const rpcAssets = new Map(); // url обложки -> mp:external-ключ

// Discord не берёт картинки по URL напрямую — маппим обложку через external-assets API.
// API требует bot-токен приложения (портал → Bot → Reset Token); токен хранится
// только локально в настройках. Без токена (или если API не ответил) — фолбэк
// на загруженный в портал ассет volna_logo, статус работает в любом случае.
async function rpcExternalAsset(url) {
  if (!url) return 'volna_logo';
  if (rpcAssets.has(url)) return rpcAssets.get(url);
  try {
    const headers = { 'Content-Type': 'application/json' };
    const tok = (store.get('settings.discordBotToken') || '').trim();
    if (tok) headers.Authorization = 'Bot ' + tok;
    const res = await net.fetch(`https://discord.com/api/v9/applications/${DISCORD_ID}/external-assets`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ urls: [url] }),
      signal: AbortSignal.timeout(8000)
    });
    if (res.ok) {
      const arr = await res.json();
      const mapped = Array.isArray(arr) && arr[0]?.external_asset_path;
      if (mapped) { rpcAssets.set(url, mapped); return mapped; }
    }
  } catch (_) {}
  return 'volna_logo';
}

async function initRpc() {
  if (rpc || store.get('settings.discordRpc') === false) return;
  try {
    const DiscordRpc = require('discord-rpc');
    rpc = new DiscordRpc.Client({ transport: 'ipc' });
    rpc.on('ready', () => {
      rpcReady = true;
      console.info('[RPC] Discord: подключено');
      if (rpcPending) { const p = rpcPending; rpcPending = null; setRpcActivity(p).catch(() => {}); }
    });
    rpc.on('disconnected', () => { rpcReady = false; });
    await rpc.login({ clientId: DISCORD_ID });
  } catch (_) {
    // Discord не запущен — тихо пробуем позже
    try { rpc?.destroy().catch(() => {}); } catch (_) {}
    rpc = null; rpcReady = false;
    clearTimeout(rpcRetryTimer);
    rpcRetryTimer = setTimeout(initRpc, 30000); // Discord могли просто запустить позже
  }
}

async function setRpcActivity(info) {
  if (!rpc || !rpcReady) { rpcPending = info; return; }
  if (!info || !info.title) {
    try { await rpc.clearActivity(); } catch (_) {}
    return;
  }
  let start, end;
  if (info.isPlaying) {
    const pos = Math.max(0, info.positionMs || 0);
    start = Date.now() - pos;
    if ((info.durationMs || 0) > pos) end = Date.now() + (info.durationMs - pos);
  }
  const art = await rpcExternalAsset(info.artwork);
  try {
    await rpc.setActivity({
      details: String(info.title).slice(0, 128),
      state: ((info.liked ? '❤️ ' : '') + (info.artist || '')).slice(0, 128) || undefined,
      startTimestamp: start,
      endTimestamp: end,
      largeImageKey: art,
      largeImageText: String(info.title).slice(0, 128),
      buttons: info.permalink ? [{ label: 'Слушать на SoundCloud', url: info.permalink }] : undefined,
      instance: false
    });
  } catch (_) {}
}

ipcMain.handle('rpc:update', (_e, info) => {
  if (!rpc) initRpc(); // играем, а связи нет — коннектимся сразу, не ждём ретраю
  setRpcActivity(info).catch(() => {});
  return true;
});
ipcMain.handle('rpc:assets-clear', () => { rpcAssets.clear(); return true; });

// CORS-проба медиа-хоста: если отдаёт ACAO — можно включить Web Audio анализатор
// (иначе MediaElementSource «промьютит» звук). Кэш по origin делает рендерер.
ipcMain.handle('net:cors', async (_e, url) => {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return '';
  try {
    const res = await net.fetch(url, {
      headers: { Range: 'bytes=0-1' },
      signal: AbortSignal.timeout(6000)
    });
    return res.headers.get('access-control-allow-origin') || '';
  } catch (_) {
    return '';
  }
});
ipcMain.handle('rpc:enable', () => { clearTimeout(rpcRetryTimer); return initRpc(); });
ipcMain.handle('rpc:disable', async () => {
  clearTimeout(rpcRetryTimer);
  rpcPending = null;
  if (rpc) { try { await rpc.destroy(); } catch (_) {} rpc = null; rpcReady = false; }
  return true;
});

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
    frame: false, // кастомный тайтлбар в renderer
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

  win.loadURL('app://local/index.html');


  // Save window state on move/resize/close (debounced)
  let boundsTimer = null;
  const saveBounds = () => {
    if (!store.get('settings.saveWindowState') || !win) return;
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (win) store.set('settings.windowBounds', win.getBounds());
    }, 500);
  };
  win.on('resize', () => { if (!win.isMaximized()) saveBounds(); });
  win.on('move', saveBounds);
  win.on('maximize', () => store.set('settings.windowMax', true));
  win.on('unmaximize', () => store.set('settings.windowMax', false));
  if (store.get('settings.windowMax')) win.maximize();

  // контролы кастомного тайтлбара
  ipcMain.on('win:minimize', () => win?.minimize());
  ipcMain.on('win:maximize', () => { if (!win) return; win.isMaximized() ? win.unmaximize() : win.maximize(); });
  ipcMain.on('win:close', () => win?.close());

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
  const scOnly = store.get('settings.antiblock.proxyScOnly') !== false; // по умолчанию ВКЛ
  let rules;
  if (p && scOnly) {
    // сплит-режим: прокси только для доменов SoundCloud, всё остальное — напрямую.
    // Не конфликтует с системным zapret/GoodbyeDPI: чужой трафик не трогаем.
    const host = p.replace(/^(socks5|socks4|https?|http):\/\//i, '');
    const pac = [
      'function FindProxyForURL(url, host) {',
      "  if (shExpMatch(host, 'soundcloud.com') || shExpMatch(host, '*.soundcloud.com') ||",
      "      shExpMatch(host, 'sndcdn.com') || shExpMatch(host, '*.sndcdn.com') ||",
      "      shExpMatch(host, 'lrclib.net') || shExpMatch(host, 'api-v2.soundcloud.com')) {",
      `    return '${/^socks/i.test(p) ? 'SOCKS5' : 'PROXY'} ${host}';`,
      '  }',
      "  return 'DIRECT';",
      '}'
    ].join('\n');
    rules = { mode: 'pac_script', pacScript: { data: pac, mandatory: false } };
  } else if (p) {
    rules = { mode: 'fixed_servers', proxyRules: p, proxyBypassRules: '<local>' };
  } else {
    rules = { mode: 'system' };
  }
  try {
    await session.defaultSession.setProxy(rules);
    await session.fromPartition('persist:sc-auth').setProxy(rules); // окно входа тоже
    return true;
  } catch (e) { return false; }
}

/* обнаружение системных обходчиков (zapret/GoodbyeDPI и т.п.) — чтобы честно
   сказать пользователю, что встроенные средства им не мешают */
ipcMain.handle('antiblock:detect', async () => {
  try {
    const { exec } = require('child_process');
    const out = await new Promise(res => {
      exec('tasklist /fo csv /nh', { encoding: 'utf8', windowsHide: true },
        (e, stdout) => res(e ? '' : String(stdout)));
    });
    const low = out.toLowerCase();
    const found = [];
    if (low.includes('winws.exe')) found.push('zapret (winws)');
    else if (low.includes('zapret')) found.push('zapret');
    if (low.includes('goodbyedpi')) found.push('GoodbyeDPI');
    return found;
  } catch (_) { return []; }
});

ipcMain.handle('antiblock:proxy', async (_e, str, opts) => {
  if (typeof str !== 'string') return false;
  const s = str.trim();
  if (s && !/^(socks5|socks4|http|https):\/\//i.test(s) && !/^[\w.-]+:\d+$/.test(s)) {
    return { ok: false, error: 'Формат: socks5://127.0.0.1:10808 или http://host:port' };
  }
  store.set('settings.antiblock.proxy', s);
  if (opts && typeof opts.scOnly === 'boolean') store.set('settings.antiblock.proxyScOnly', opts.scOnly);
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
  const bypass = await new Promise(res => {
    const { exec } = require('child_process');
    exec('tasklist /fo csv /nh', { encoding: 'utf8', windowsHide: true }, (e, stdout) => {
      if (e) return res([]);
      const low = String(stdout).toLowerCase();
      const f = [];
      if (low.includes('winws.exe') || low.includes('zapret')) f.push('zapret');
      if (low.includes('goodbyedpi')) f.push('GoodbyeDPI');
      res(f);
    });
  });
  return { results, allOk, bypass, proxy: (store.get('settings.antiblock.proxy') || '').trim() };
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
      signal: AbortSignal.timeout(Math.min(60000, Math.max(5000, Number(opts.timeout) || 15000))),
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

// атмосферные фоны для «Визуала»: Wallhaven (аниме-категория, SFW, keyless)
ipcMain.handle('img:search', async (_e, payload) => {
  try {
    const q = String((payload && payload.q) || '');
    const seed = String((payload && payload.seed) || 'volna');
    const u = 'https://wallhaven.cc/api/v1/search?q=' + encodeURIComponent(q) +
      '&categories=010&purity=100&sorting=random&seed=' + encodeURIComponent(seed);
    const res = await net.fetch(u, { headers: { 'User-Agent': 'VOLNA' }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return [];
    const j = await res.json();
    return (j.data || []).map(x => (x.thumbs && x.thumbs.large) || x.path).filter(Boolean).slice(0, 40);
  } catch (_) { return []; }
});

// поиск клипа на YouTube по «артист + название» (грубый скрейп выдачи)
ipcMain.handle('yt:search', async (_e, q) => {
  try {
    if (typeof q !== 'string' || !q.trim()) return null;
    // sp=EgIQAQ%3D%3D — фильтр «только видео»; cookie — обход страницы согласия
    const res = await net.fetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(q) + '&sp=EgIQAQ%3D%3D&hl=en&gl=US', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
        Cookie: 'CONSENT=YES+cb.20210328-17-p0.en+FX+419; SOCS=CAI'
      },
      signal: AbortSignal.timeout(12000)
    });
    const html = await res.text();
    const m2 = html.match(/"videoRenderer":\{"videoId":"([\w-]{11})"/)
      || html.match(/"videoId":"([\w-]{11})"/)
      || html.match(/watch\?v=([\w-]{11})/);
    return m2 ? m2[1] : null;
  } catch (_) { return null; }
});

// буфер обмена: шаринг-карточка трека (PNG dataURL из renderer)
ipcMain.handle('share:clipboard', (_e, dataUrl) => {  try {
    clipboard.writeImage(nativeImage.createFromDataURL(String(dataUrl)));
    return true;
  } catch (_) { return false; }
});

ipcMain.handle('notify', (_e, { title, body }) => {
  if (!Notification.isSupported()) return false;
  new Notification({ title, body, silent: false }).show();
  return true;
});

// экспорт/импорт плейлиста файлом (.volna.json) — шеринг между друзьями
ipcMain.handle('dialog:exportPlaylistFile', async (_e, payload) => {
  if (!win || !payload || !Array.isArray(payload.tracks)) return { ok: false };
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Экспорт плейлиста',
    defaultPath: String(payload.name || 'playlist').replace(/[\\/:*?"<>|]/g, '_') + '.volna.json',
    filters: [{ name: 'VOLNA Playlist', extensions: ['json'] }]
  });
  if (canceled || !filePath) return { ok: false };
  try {
    fs.writeFileSync(filePath, JSON.stringify({
      app: 'volna', type: 'playlist', version: 1,
      name: payload.name, tracks: payload.tracks,
      exportedAt: new Date().toISOString()
    }, null, 2), 'utf8');
    return { ok: true, path: filePath };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('dialog:importPlaylistFile', async () => {
  if (!win) return { ok: false };
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Импорт плейлиста',
    filters: [{ name: 'VOLNA Playlist', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths.length) return { ok: false };
  try {
    const data = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    if (!data || data.type !== 'playlist' || !Array.isArray(data.tracks)) {
      return { ok: false, error: 'Это не файл плейлиста VOLNA' };
    }
    return { ok: true, name: String(data.name || 'Импорт'), tracks: data.tracks };
  } catch (e) { return { ok: false, error: e.message }; }
});

// последний трек + позиция — для «Продолжить где остановился»
ipcMain.handle('lastTrack:set', (_e, obj) => {
  try { store.set('lastTrack', obj); return true; } catch (_) { return false; }
});
ipcMain.handle('lastTrack:get', () => store.get('lastTrack') || null);

// ---------- 📱 пульт с телефона (LAN, адрес с токеном) ----------
let remoteSrv = null, remoteLastState = {}, remoteUrls = [];
ipcMain.on('remote:state', (_e, d) => { remoteLastState = d || {}; });
ipcMain.handle('remote:info', () => startRemoteServer());

function remoteCandidateIPs() {
  const nets = require('os').networkInterfaces();
  const ips = [];
  for (const k of Object.keys(nets)) {
    for (const x of nets[k] || []) {
      if (x.family !== 'IPv4' || x.internal) continue;
      // отсекаем виртуальные/VPN-адреса: zapret-туннели (198.18.x), апилинки (169.254.x)
      if (/^169.254./.test(x.address) || /^198.1[89]./.test(x.address)) continue;
      if (/virtual|vmware|virtualbox|hyper-v|vethernet|wsl|tun|tap|loopback/i.test(k)) continue;
      ips.push(x.address);
    }
  }
  // 192.168.* — домашний Wi-Fi, ставим первым; остальное — в конец
  return [...new Set(ips)].sort((a, b) => (/^192.168./.test(b) ? 1 : 0) - (/^192.168./.test(a) ? 1 : 0));
}

function startRemoteServer() {
  if (remoteSrv) return Promise.resolve(remoteUrls);
  const http = require('http');
  const crypto = require('crypto');
  let token = store.get('settings.remoteToken');
  if (!token) { token = crypto.randomBytes(8).toString('hex'); store.set('settings.remoteToken', token); }
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://local');
      if (u.pathname !== '/ctrl/' + token) { res.writeHead(404); res.end(); return; }
      const cmd = u.searchParams.get('cmd');
      if (cmd) {
        const map = { toggle: 'media:toggle', next: 'media:next', prev: 'media:prev', pause: 'media:pause' };
        if (map[cmd] && win) win.webContents.send(map[cmd]);
        const vol = u.searchParams.get('vol');
        if (cmd === 'vol' && vol !== null && win) {
          win.webContents.send('remote:vol', Math.min(1, Math.max(0, Number(vol))));
        }
        if (cmd === 'like' && win) win.webContents.send('remote:like');
        if (cmd === 'back' && win) win.webContents.send('remote:seek', -15000);
        if (cmd === 'fwd' && win) win.webContents.send('remote:seek', 15000);
        if (cmd === 'shuffle' && win) win.webContents.send('remote:shuffle');
        if (cmd === 'repeat' && win) win.webContents.send('remote:repeat');
        res.writeHead(204); res.end(); return;
      }
      if (u.searchParams.has('state')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(remoteLastState || {}));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(__dirname, 'renderer', 'remote.html'), 'utf8'));
    });
    srv.on("error", () => resolve([]));
    srv.listen(0, "0.0.0.0", () => {
      const port = srv.address().port;
      const ips = remoteCandidateIPs();
      if (!ips.length) ips.push('127.0.0.1');
      remoteUrls = ips.map(ip => "http://" + ip + ":" + port + "/ctrl/" + token);
      resolve(remoteUrls);
    });
  });
}

// ---------- Lifecycle ----------
// app:// — собственный origin для renderer. YouTube-плеер отказывается работать
// со страниц file:// («видео ограничено»), с настоящим origin — встраивается.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);

app.whenReady().then(async () => {
  await applyProxy(); // применяем прокси (если задан) ко всему трафику приложения

  const { pathToFileURL } = require('url');
  const rendererDir = path.join(__dirname, 'renderer');
  protocol.handle('app', (request) => {
    const u = new URL(request.url);
    const rel = decodeURIComponent(u.pathname.replace(/^\//, '')) || 'index.html';
    const abs = path.join(rendererDir, path.normalize(rel));
    if (!abs.startsWith(rendererDir)) return new Response(null, { status: 403 });
    return net.fetch(pathToFileURL(abs).toString());
  });

  createWindow();
  createTray();
  initRpc(); // Discord Rich Presence (если включён и Discord запущен)

  // уснул ПК / ушла батарея в сон — глушим музыку, чтобы не играла в пустоту
  powerMonitor.on('suspend', () => {
    try { win?.webContents.send('media:pause'); } catch (_) {}
  });

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
  if (rpc) { try { rpc.destroy(); } catch (_) {} }
});
