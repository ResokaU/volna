/* ============================================================
   VOLNA · app.js — ядро: state, утилиты, курсор, view,
   шорткаты, контекст-меню, тосты, модалки, init
   ============================================================ */
'use strict';

/* ---------- IPC (Electron) с fallback на localStorage ---------- */
const ipc = (() => {
  try { if (typeof require === 'function') return require('electron').ipcRenderer; } catch (_) {}
  return null;
})();

function lsGet(key, def) {
  try { const v = JSON.parse(localStorage.getItem('ga:' + key)); return v === null || v === undefined ? def : v; }
  catch (_) { return def; }
}
function lsSet(key, val) { try { localStorage.setItem('ga:' + key, JSON.stringify(val)); } catch (_) {} }

/* ---------- глобальный state ---------- */
const state = {
  favorites: [], history: [], playlists: [], queue: [],
  tracks: [],              // сырые результаты поиска
  visibleTracks: [],       // после фильтров
  trending: [],
  artists: [], playlistsFound: [],
  searchMode: 'tracks', searchSort: 'relevance', searchDur: 'any', searchSource: 'search',
  trendTab: 'world', trendTabId: null,
  currentPlaylistTracks: [],
  currentPlaylistId: null,
  trackIndex: new Map(),   // id -> track (для лайков/контекст-меню)
  currentTrack: null,
  currentListKey: null, currentIdx: -1,
  isPlaying: false, shuffle: false, repeat: false,
  engine: 'widget',          // 'audio' — нативный mp3, 'widget' — iframe-фолбэк
  audio: null, audioCors: null, analyser: null, audioCtx: null, vizData: null,
  corsCache: new Map(),      // origin -> доступен ли Web Audio
  rate: 1,                   // скорость воспроизведения
  listenedCounted: false,    // честная статистика: засчитан ли текущий трек
  eqGains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // 10 полос, дБ
  eqPreset: 'flat', eqNodes: null,
  dislikes: [],              // артисты, скрытые из Radio
  volume: 1, muted: false,
  filter: 'all', sortFavs: 'date',
  widget: null, mini: false,
  sleepTimer: null, sleepEnd: 0,
  recentCache: [],
  lyrics: { status: 'idle', lines: [], plain: '', trackId: null, offset: 0, lastIdx: null },
  lyricsCache: {},
  scAuth: null, serverLikes: [], favSource: 'local', foryouTracks: [],
  stats: { totalPlayed: 0, totalTime: 0, sessionStart: Date.now() },
  settings: { theme: 'dark', accent: 'neon', volume: 1, notifyOnLike: true, startMinimized: false, saveWindowState: true, autoLyrics: true, waves: true, mascot: true }
};

const DONATE_URL = 'https://www.donationalerts.com/r/meerphys1';
function openDonation() {
  if (ipc) ipc.invoke('shell:openExternal', DONATE_URL).catch(() => {});
  else window.open(DONATE_URL, '_blank');
}

/* ---------- утилиты ---------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return h ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`;
}
function fmtCount(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace('.0', '') + 'K';
  return String(n);
}
function artwork(track) {
  return (track?.artwork_url || track?.user?.avatar_url || '').replace('large', 't500x500');
}
function rememberTrack(t) { if (t && t.id != null) state.trackIndex.set(t.id, t); }

function emptyHTML(icon, title, text) {
  return `<div class="empty" style="grid-column:1/-1"><div class="empty-icon"><svg class="ic" viewBox="0 0 24 24"><use href="#${icon}"/></svg></div><h3>${title}</h3><p>${text}</p></div>`;
}

/* ---------- тосты ---------- */
function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 350); }, 2400);
}

/* ---------- модалки ---------- */
function openModal(id) { $('#' + id)?.classList.add('show'); }
function closeModal(id) { $('#' + id)?.classList.remove('show'); }
function openShortcuts() { openModal('shortcuts_modal'); }
function openSleepModal() { openModal('sleep_modal'); }
function openNewPlaylistModal() { openModal('playlist_modal'); }
function openAbout() { openModal('about_modal'); fillAbout(); }

/* ---------- переключение view ---------- */
const NAV_ALIAS = { 'playlist-detail': 'playlists' };
function switchView(name) {
  $$('.view').forEach(v => v.classList.remove('active'));
  $('#view-' + name)?.classList.add('active');
  const navName = NAV_ALIAS[name] || name;
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === navName));
  $('.main')?.scrollTo({ top: 0 });
  if (name === 'favorites') renderFavorites();
  if (name === 'playlists') renderPlaylists();
  if (name === 'history') renderHistory();
  if (name === 'queue') renderQueue();
  if (name === 'stats') renderStats();
  if (name === 'trending') loadTrending();
  if (name === 'foryou') loadForyou();
  if (name === 'lyrics' && typeof renderLyrics === 'function') renderLyrics();
  if (typeof updateMascot === 'function') updateMascot();
}

/* ---------- бейджи ---------- */
function updateBadges() {
  const f = $('#fav-badge'); if (f) f.textContent = state.favorites.length;
  const p = $('#pl-badge'); if (p) p.textContent = state.playlists.length;
  const q = $('#queue-badge'); if (q) q.textContent = state.queue.length;
}

/* ---------- контекст-меню трека ---------- */
function showTrackMenu(e, trackId) {
  e.preventDefault();
  e.stopPropagation();
  const track = state.trackIndex.get(trackId);
  if (!track) return;
  const menu = $('#context-menu');
  const isFav = state.favorites.some(f => f.id === trackId);
  menu.innerHTML = `
    <div class="context-item" data-act="play"><svg class="ic fill" viewBox="0 0 24 24"><use href="#i-play"/></svg>Слушать сейчас</div>
    <div class="context-item" data-act="next"><svg class="ic" viewBox="0 0 24 24"><use href="#i-next"/></svg>Играть следующим</div>
    <div class="context-item" data-act="queue"><svg class="ic" viewBox="0 0 24 24"><use href="#i-queue"/></svg>В очередь</div>
    <div class="context-item" data-act="like"><svg class="ic" viewBox="0 0 24 24"><use href="#i-heart"/></svg>${isFav ? 'Убрать из лайков' : 'В лайки'}</div>
    <div class="context-item" data-act="playlist"><svg class="ic" viewBox="0 0 24 24"><use href="#i-folder"/></svg>В плейлист…</div>
    <div class="context-sep"></div>
    <div class="context-item" data-act="copy"><svg class="ic" viewBox="0 0 24 24"><use href="#i-copy"/></svg>Копировать ссылку</div>
    <div class="context-item" data-act="open"><svg class="ic" viewBox="0 0 24 24"><use href="#i-external"/></svg>Открыть на SoundCloud</div>
    <div class="context-item" data-act="dislike">🚫 Скрывать «${escapeHtml(track.user?.username || '')}» из Radio</div>`;
  menu.dataset.trackId = trackId;
  menu.classList.add('show');
  menu.style.left = Math.min(e.clientX, innerWidth - menu.offsetWidth - 12) + 'px';
  menu.style.top = Math.min(e.clientY, innerHeight - menu.offsetHeight - 12) + 'px';
  setTimeout(() => document.addEventListener('click', hideContextMenu, { once: true }), 10);
}
function hideContextMenu() { $('#context-menu')?.classList.remove('show'); }

function showPlaylistPicker(trackId) {
  const menu = $('#context-menu');
  if (!state.playlists.length) { toast('Сначала создай плейлист', 'error'); return; }
  menu.innerHTML = `<div class="context-title">Добавить в плейлист</div>` +
    state.playlists.map(pl =>
      `<div class="context-item" data-act="topl" data-pl="${pl.id}"><svg class="ic" viewBox="0 0 24 24"><use href="#i-folder"/></svg>${escapeHtml(pl.name)}</div>`
    ).join('');
  menu.dataset.trackId = trackId;
  menu.classList.add('show');
  setTimeout(() => document.addEventListener('click', hideContextMenu, { once: true }), 10);
}

function bindContextMenu() {
  const menu = $('#context-menu');
  menu.addEventListener('click', e => {
    const item = e.target.closest('.context-item');
    if (!item) return;
    e.stopPropagation();
    const track = state.trackIndex.get(Number(menu.dataset.trackId));
    hideContextMenu();
    if (!track) return;
    switch (item.dataset.act) {
      case 'play': playTrack(track); break;
      case 'next': playNextInQueue(track); break;
      case 'queue': addToQueue(track); break;
      case 'like': toggleLike(track); break;
      case 'playlist': showPlaylistPicker(track.id); break;
      case 'copy':
        navigator.clipboard?.writeText(track.permalink_url || '')
          .then(() => toast('Ссылка скопирована', 'success'))
          .catch(() => toast('Не удалось скопировать', 'error'));
        break;
      case 'open':
        if (track.permalink_url) {
          if (ipc) ipc.invoke('shell:openExternal', track.permalink_url).catch(() => {});
          else window.open(track.permalink_url, '_blank');
        }
        break;
      case 'topl': addToPlaylist(track.id, Number(item.dataset.pl)); break;
      case 'dislike': addDislike(track); break;
    }
  });
}

/* ---------- кастомный курсор + parallax ---------- */
function initCursor() {
  const ring = $('.cursor-ring'), dot = $('.cursor-dot');
  if (!ring || !dot) return;
  let mx = innerWidth / 2, my = innerHeight / 2, rx = mx, ry = my;
  window.addEventListener('mousemove', e => {
    mx = e.clientX; my = e.clientY;
    if (!document.body.classList.contains('no-cursor')) {
      dot.style.left = mx + 'px'; dot.style.top = my + 'px';
    }
  });
  (function loop() {
    if (!document.body.classList.contains('no-cursor')) {
      rx += (mx - rx) * .18; ry += (my - ry) * .18;
      ring.style.left = rx + 'px'; ring.style.top = ry + 'px';
    }
    requestAnimationFrame(loop);
  })();
  document.addEventListener('mouseover', e => {
    const overText = !!e.target.closest?.('input,textarea,select');
    const hover = !overText && !!e.target.closest(
      'button,.nav-item,.chip,.filter-btn,.toolbar-btn,.track-card,.queue-item,' +
      '.accent-chip,.progress-wrap,.volume-slider,.modal-close,.artist-row,.queue-btn,' +
      '.eq-chip,.lyr-cand,.trend-tab,.palette-item,.context-item,.pbtn'
    );
    ring.classList.toggle('text', overText);
    dot.classList.toggle('text', overText);
    ring.classList.toggle('hover', hover);
    dot.classList.toggle('hover', hover);
  });
  document.addEventListener('mousemove', e => {
    const card = e.target.closest?.('.track-card');
    if (card) {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      card.style.setProperty('--my', (e.clientY - r.top) + 'px');
    }
    const x = (e.clientX / innerWidth - .5) * 40, y = (e.clientY / innerHeight - .5) * 40;
    $$('.blob').forEach((b, i) => { b.style.translate = `${x * (i + 1) * .3}px ${y * (i + 1) * .3}px`; });
  });
}

/* ---------- командная палитра Ctrl+K ---------- */
const PALETTE_CMDS = [
  { t: 'Играть / пауза', k: 'Space', run: () => togglePlay() },
  { t: 'Следующий трек', k: '→', run: () => playNext() },
  { t: 'Предыдущий трек', k: '←', run: () => playPrev() },
  { t: 'Лайкнуть текущий', k: 'L', run: () => likeCurrent() },
  { t: 'Мне повезёт', k: '', run: () => feelingLucky() },
  { t: 'Shuffle', k: '', run: () => toggleShuffle() },
  { t: 'Repeat', k: '', run: () => toggleRepeat() },
  { t: 'Mini player', k: 'M', run: () => toggleMiniPlayer() },
  { t: 'Sleep timer', k: '', run: () => openSleepModal() },
  { t: 'Поиск', k: 'F', run: () => switchView('discover') },
  { t: 'Тренды', k: '2', run: () => switchView('trending') },
  { t: 'Лайки', k: '3', run: () => switchView('favorites') },
  { t: 'Плейлисты', k: '4', run: () => switchView('playlists') },
  { t: 'История', k: '5', run: () => switchView('history') },
  { t: 'Очередь', k: '6', run: () => switchView('queue') },
  { t: 'Статистика', k: '7', run: () => switchView('stats') },
  { t: 'Настройки', k: '8', run: () => switchView('settings') },
  { t: 'Текст песни', k: '', run: () => switchView('lyrics') }
];

let paletteItems = [], paletteIdx = 0, paletteTimer = null;

function togglePalette() {
  $('#palette').classList.contains('show') ? closePalette() : openPalette();
}
function openPalette() {
  $('#palette').classList.add('show');
  const input = $('#palette-input');
  input.value = '';
  renderPalette('');
  setTimeout(() => input.focus(), 40);
}
function closePalette() { $('#palette').classList.remove('show'); }

function bindPalette() {
  const input = $('#palette-input');
  input.addEventListener('input', () => {
    clearTimeout(paletteTimer);
    paletteTimer = setTimeout(() => renderPalette(input.value.trim()), 300);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); paletteIdx = Math.min(paletteIdx + 1, paletteItems.length - 1); paintPalette(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); paletteIdx = Math.max(paletteIdx - 1, 0); paintPalette(); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = paletteItems[paletteIdx]; if (it) { closePalette(); it.run(); } }
  });
  $('#palette').addEventListener('click', e => { if (e.target === $('#palette')) closePalette(); });
  $('#palette-list').addEventListener('click', e => {
    const item = e.target.closest('.palette-item');
    if (!item) return;
    const it = paletteItems[+item.dataset.idx];
    if (it) { closePalette(); it.run(); }
  });
}

async function renderPalette(q) {
  const cmds = PALETTE_CMDS
    .filter(c => !q || c.t.toLowerCase().includes(q.toLowerCase()))
    .map(c => ({ icon: 'i-zap', t: c.t, sub: c.k, run: c.run }));
  let tracks = [];
  if (q.length >= 2) {
    try {
      const cid = await ensureClientId();
      const data = await scJson(`${SC_API2}/search/tracks?q=${encodeURIComponent(q)}&client_id=${cid}&limit=8`);
      tracks = (Array.isArray(data?.collection) ? data.collection : [])
        .map(normalizeTrack).filter(Boolean)
        .map(t => { rememberTrack(t); return { icon: 'i-note', t: t.title, sub: t.user?.username, run: () => playTrack(t) }; });
    } catch (_) {}
  }
  paletteItems = [...cmds, ...tracks];
  paletteIdx = 0;
  paintPalette();
}

function paintPalette() {
  const list = $('#palette-list');
  if (!paletteItems.length) {
    list.innerHTML = `<div class="palette-empty">Ничего не нашлось — попробуй другой запрос</div>`;
    return;
  }
  list.innerHTML = paletteItems.map((it, i) => `
    <div class="palette-item ${i === paletteIdx ? 'active' : ''}" data-idx="${i}">
      <span class="pi-icon"><svg class="ic sm" viewBox="0 0 24 24"><use href="#${it.icon}"/></svg></span>
      <span class="pi-text">${escapeHtml(it.t)}</span>
      ${it.sub ? `<span class="pi-sub">${escapeHtml(it.sub)}</span>` : ''}
    </div>`).join('');
  const active = list.querySelector('.palette-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

/* ---------- клавиатура ---------- */
function onKeydown(e) {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  if (e.key === 'Escape') { $$('.modal.show').forEach(m => m.classList.remove('show')); closePalette(); hideContextMenu(); return; }
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); togglePalette(); return; }
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'q') { e.preventDefault(); if (ipc) ipc.invoke('app:quit').catch(() => {}); return; }
  // масштаб UI: Ctrl+= / Ctrl+- / Ctrl+0
  if (e.ctrlKey && (e.key === '=' || e.key === '+')) { e.preventDefault(); nudgeZoom(.1); return; }
  if (e.ctrlKey && e.key === '-') { e.preventDefault(); nudgeZoom(-.1); return; }
  if (e.ctrlKey && e.key === '0') { e.preventDefault(); setZoom(1); return; }
  if (e.key === 'F1') { e.preventDefault(); openShortcuts(); return; }
  if (e.key === 'F12' || e.key === 'F5') return;

  if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
  if (e.code === 'ArrowRight' && e.shiftKey) { seekBy(5000); return; }
  if (e.code === 'ArrowLeft' && e.shiftKey) { seekBy(-5000); return; }
  if (e.code === 'ArrowRight') { playNext(); return; }
  if (e.code === 'ArrowLeft') { playPrev(); return; }
  if (e.code === 'ArrowUp') { e.preventDefault(); nudgeVolume(.05); return; }
  if (e.code === 'ArrowDown') { e.preventDefault(); nudgeVolume(-.05); return; }

  const k = e.key.toLowerCase();
  if (k === 'f') { switchView('discover'); const i = $('#search-input'); i.focus(); i.select(); return; }
  if (k === 'l') { likeCurrent(); return; }
  if (k === 'm') { toggleMiniPlayer(); return; }

  const views = { '1': 'discover', '2': 'trending', '3': 'favorites', '4': 'playlists', '5': 'history', '6': 'queue', '7': 'stats', '8': 'settings' };
  if (views[e.key]) switchView(views[e.key]);
}

/* ---------- каркас страницы ---------- */
function bindChrome() {
  $$('.nav-item[data-view]').forEach(n => n.addEventListener('click', () => switchView(n.dataset.view)));
  $$('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.classList.remove('show'); }));
  document.addEventListener('keydown', onKeydown);
  bindContextMenu();
  bindPalette();
  bindCopyGuard();
}

/* копировать можно только названия треков, артистов и подписи */
const COPY_ALLOWED = '.track-title,.track-artist,.queue-item-title,.queue-item-artist,' +
  '.player-title,.player-artist,.palette-item,.artist-name,.sidebar-footer,input,textarea';

function bindCopyGuard() {
  document.addEventListener('copy', e => {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed) return;
    const node = sel.anchorNode;
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    if (el && el.closest(COPY_ALLOWED)) return;
    e.preventDefault();
  });
  document.addEventListener('dragstart', e => {
    if (!e.target.closest?.('a,[draggable="true"]')) e.preventDefault();
  });
}

/* ---------- карточка трека (общая для всех списков) ---------- */
function trackCardHTML(track, idx, listKey) {
  const isFav = state.favorites.some(f => f.id === track.id);
  const dur = formatTime((track.duration || 0) / 1000);
  const plays = track.playback_count != null ? fmtCount(track.playback_count) : '';
  const img = artwork(track);
  return `<div class="track-card" data-idx="${idx}" data-list="${listKey}" data-id="${track.id}"
    onclick="playFromCard(this)" oncontextmenu="showTrackMenu(event,${track.id})">
    <div class="track-art">
      <img src="${escapeHtml(img)}" alt="" loading="lazy" onerror="this.style.opacity=0">
      <div class="play-ov"><div class="play-disk"><svg class="ic fill" viewBox="0 0 24 24"><use href="#i-play"/></svg></div></div>
      <div class="eq-bars"><span></span><span></span><span></span><span></span></div>
      ${plays ? `<div class="play-count"><svg class="ic tiny fill" viewBox="0 0 24 24"><use href="#i-play"/></svg><span>${plays}</span></div>` : ''}
      <div class="now-badge">▶ Играет</div>
    </div>
    <div class="track-info">
      <div class="track-title" title="${escapeHtml(track.title)}">${escapeHtml(track.title)}</div>
      <div class="track-artist" title="${escapeHtml(track.user?.username || '')}">${escapeHtml(track.user?.username || '—')}</div>
      <div class="track-meta">
        <span class="track-duration">${dur}</span>
        ${listKey === 'pl' ? `<button class="like-btn" title="Убрать из плейлиста"
          onclick="event.stopPropagation();removeFromPlaylist(${idx})"><svg class="ic" viewBox="0 0 24 24"><use href="#i-close"/></svg></button>` : ''}
        <button class="like-btn ${isFav ? 'liked' : ''}" data-id="${track.id}" title="Лайк"
          onclick="event.stopPropagation();toggleLikeById(${track.id})"><svg class="ic" viewBox="0 0 24 24"><use href="#i-heart"/></svg></button>
      </div>
    </div>
  </div>`;
}

/* ---------- init ---------- */
async function init() {
  await loadAllData();      // library.js
  applySettings();          // library.js
  initCursor();
  bindChrome();
  bindSearchUI();           // search.js
  initPlayer();             // player.js
  bindLibraryUI();          // library.js
  startWaves();             // динамичные волны
  applyWallpaper();         // свои обои (если заданы)
  updateBadges();
  renderChips();            // search.js
  bindMediaKeys();          // player.js
  defaultSearch();          // search.js
}

/* ---------- динамичные волны (canvas внизу экрана) ---------- */
function startWaves() {
  const c = $('#waves');
  if (!c) return;
  const ctx = c.getContext('2d');
  let amp = 0.3, t = Math.random() * 100;
  const resize = () => { c.width = innerWidth; c.height = Math.max(200, Math.round(innerHeight * .42)); };
  resize();
  addEventListener('resize', resize);
  const layers = [
    { sp: 1.0, amp: .17, y: .40, alpha: .16, varName: '--neon' },
    { sp: 0.7, amp: .12, y: .55, alpha: .22, varName: '--acid' },
    { sp: 0.5, amp: .09, y: .70, alpha: .18, varName: '--hot' }
  ];
  (function frame() {
    if (document.body.classList.contains('waves-off') || document.body.classList.contains('wallpaper-on')) {
      requestAnimationFrame(frame);
      return;
    }
    t += state.isPlaying ? 0.022 : 0.008;
    const target = state.isPlaying ? 1 : 0.3;
    amp += (target - amp) * 0.02;
    const W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    layers.forEach((L, i) => {
      const base = H * L.y, A = H * L.amp * (0.45 + amp);
      ctx.beginPath();
      for (let x = 0; x <= W; x += 8) {
        const y = base
          + Math.sin(x * .006 + t * L.sp * 2 + i * 1.7) * A
          + Math.sin(x * .013 - t * L.sp * 1.3 + i) * A * .4;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
      let col = getComputedStyle(document.body).getPropertyValue(L.varName).trim() || '#b14aff';
      if (/^#[0-9a-f]{6}$/i.test(col)) col += Math.round(L.alpha * 255).toString(16).padStart(2, '0');
      const g = ctx.createLinearGradient(0, base - A, 0, H);
      g.addColorStop(0, col);
      g.addColorStop(1, 'rgba(7,7,13,0)');
      ctx.fillStyle = g;
      ctx.fill();
    });
    requestAnimationFrame(frame);
  })();
}

/* ---------- свои обои ---------- */
function applyWallpaper() {
  const el = $('#wallpaper');
  if (!el) return;
  const wp = localStorage.getItem('ga:wallpaper');
  const dim = (+localStorage.getItem('ga:wallpaperDim') || 55) / 100;
  if (wp) {
    el.style.backgroundImage = `url(${wp})`;
    el.classList.add('on');
    document.body.classList.add('wallpaper-on');
    el.style.boxShadow = `inset 0 0 0 9999px rgba(7,7,13,${(0.3 + dim * 0.55).toFixed(2)})`;
  } else {
    el.classList.remove('on');
    document.body.classList.remove('wallpaper-on');
    el.style.backgroundImage = '';
  }
}

function clearWallpaper() {
  localStorage.removeItem('ga:wallpaper');
  applyWallpaper();
  toast('Обои убраны — снова аврора и волны');
}

/* ---------- масштаб UI ---------- */
function setZoom(v, silent) {
  const z = Math.min(1.5, Math.max(.8, v));
  document.body.style.zoom = z === 1 ? '' : z;
  state.zoom = z;
  if (typeof saveSetting === 'function') saveSetting('uiScale', z);
  if (!silent) toast('🔍 Масштаб: ' + Math.round(z * 100) + '%');
}
function nudgeZoom(d) { setZoom((state.zoom || 1) + d); }
