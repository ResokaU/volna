/* ============================================================
   VOLNA · search.js — расширенный поиск (треки/артисты/
   плейлисты, сортировки, фильтры), русские тренды, недавние
   Работает через api-v2.soundcloud.com: client_id динамически
   извлекается из JS-бандлов, запросы идут через IPC-прокси.
   ============================================================ */
'use strict';

const SC_API2 = 'https://api-v2.soundcloud.com';

let SC_CID = null;

/* ---------- транспорт ---------- */
async function scRaw(url, opts = {}) {
  if (ipc) {
    const r = await ipc.invoke('sc:fetch', url, opts);
    if (!r || !r.ok) throw new Error(r?.error || ('HTTP ' + (r?.status ?? '?')));
    return r.text;
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), ...opts });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}
function scJson(url, opts) { return scRaw(url, opts).then(t => JSON.parse(t)); }

/* client_id живёт в бандлах сайта — достаём и кэшируем */
async function ensureClientId(force) {
  if (!force) {
    if (SC_CID) return SC_CID;
    SC_CID = lsGet('scCid', null);
    if (SC_CID) return SC_CID;
  }
  SC_CID = null;
  const html = await scRaw('https://soundcloud.com/');
  const assets = [...new Set(
    [...html.matchAll(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^"']+\.js/g)].map(m => m[0])
  )].slice(0, 14);
  for (const u of assets) {
    try {
      const js = await scRaw(u);
      const m = js.match(/client_id\s*:\s*"([a-zA-Z0-9]{24,50})"/);
      if (m) { SC_CID = m[1]; lsSet('scCid', SC_CID); console.info('[SC] client_id: OK'); return SC_CID; }
    } catch (_) {}
  }
  throw new Error('Не удалось получить SoundCloud client_id');
}

/* ---------- нормализация ---------- */
function normalizeTrack(item) {
  const t = item?.track || item;
  if (!t || !t.permalink_url || t.streamable === false) return null;
  return {
    id: t.id,
    title: t.title,
    duration: t.duration,
    permalink_url: t.permalink_url,
    artwork_url: t.artwork_url,
    playback_count: t.playback_count,
    kind: t.kind || 'track',
    user: { username: t.user?.username || '—', avatar_url: t.user?.avatar_url }
  };
}

const byPopular = (a, b) => (b.playback_count || 0) - (a.playback_count || 0);
const byNew = (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0);

/* ---------- UI: чипы, сегменты, недавние ---------- */
const CHIPS = [
  { label: 'lofi', q: 'lofi hip hop' },
  { label: 'phonk', q: 'phonk' },
  { label: 'techno', q: 'techno berlin' },
  { label: 'synthwave', q: 'synthwave' },
  { label: 'dnb', q: 'drum and bass' },
  { label: 'jazz', q: 'jazz' },
  { label: 'hip hop', q: 'hip hop underground' },
  { label: 'ambient', q: 'ambient' },
  { label: 'cyberpunk', q: 'cyberpunk' }
];

function bindSearchUI() {
  const input = $('#search-input');
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  input.addEventListener('focus', showRecent);
  input.addEventListener('blur', () => setTimeout(hideRecent, 150));

  // режимы поиска
  $('#mode-seg').addEventListener('click', e => {
    const b = e.target.closest('.seg-btn');
    if (!b || b.classList.contains('active')) return;
    $$('#mode-seg .seg-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.searchMode = b.dataset.mode;
    const trackOnly = state.searchMode === 'tracks';
    $('#sort-seg').style.display = trackOnly ? 'flex' : 'none';
    $('#dur-seg').style.display = trackOnly ? 'flex' : 'none';
    doSearch();
  });
  $('#sort-seg').addEventListener('click', e => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    $$('#sort-seg .seg-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.searchSort = b.dataset.sort;
    if (state.searchMode === 'tracks') { if (state.tracks.length) renderTracks(); }
  });
  $('#dur-seg').addEventListener('click', e => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    $$('#dur-seg .seg-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.searchDur = b.dataset.dur;
    if (state.searchMode === 'tracks') { if (state.tracks.length) renderTracks(); }
  });

  // недавние запросы — клик по чипу (mousedown, чтобы не потерять фокус)
  const box = $('#recent-searches');
  box.addEventListener('mousedown', e => {
    e.preventDefault();
    const chip = e.target.closest('.recent-chip');
    if (chip) { input.value = chip.textContent; doSearch(chip.textContent); hideRecent(); }
  });

  renderTrendTabs();

  (async () => {
    if (ipc) { try { state.recentCache = (await ipc.invoke('recentSearches:get')) || []; return; } catch (_) {} }
    state.recentCache = lsGet('recentSearches', []);
  })();
}

function renderChips() {
  $('#chips').innerHTML = CHIPS.map(c =>
    `<button class="chip" data-q="${escapeHtml(c.q)}">${escapeHtml(c.label)}</button>`
  ).join('');
  $('#chips').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    $$('#chips .chip').forEach(x => x.classList.remove('active'));
    chip.classList.add('active');
    $('#search-input').value = chip.dataset.q;
    setMode('tracks');
    doSearch(chip.dataset.q);
  });
}

function setMode(mode) {
  if (state.searchMode === mode) return;
  state.searchMode = mode;
  $$('#mode-seg .seg-btn').forEach(x => x.classList.toggle('active', x.dataset.mode === mode));
  const trackOnly = mode === 'tracks';
  $('#sort-seg').style.display = trackOnly ? 'flex' : 'none';
  $('#dur-seg').style.display = trackOnly ? 'flex' : 'none';
}

function defaultSearch() {
  const q = 'lofi hip hop';
  $('#search-input').value = q;
  $$('#chips .chip').forEach(x => x.classList.toggle('active', x.dataset.q === q));
  doSearch(q);
}

/* ---------- поиск ---------- */
const SC_URL_RE = /^https?:\/\/(www\.)?(soundcloud\.com|snd\.sc)\/\S+/i;

/* вставка ссылки: resolve трека/плейлиста/артиста через api-v2 */
async function resolveUrl(q) {
  if (!SC_URL_RE.test(q)) return false;
  toast('🔗 Открываю ссылку…');
  try {
    const cid = await ensureClientId();
    const data = await scJson(`${SC_API2}/resolve?url=${encodeURIComponent(q)}&client_id=${cid}`);
    if (!data || !data.kind) throw new Error('пустой ответ');
    if (data.kind === 'track') {
      const t = normalizeTrack(data);
      if (!t) { toast('Трек недоступен', 'error'); return true; }
      rememberTrack(t);
      $('#search-input').value = t.title;
      playTrack(t, 'single');
      toast('▶ ' + t.title, 'success');
    } else if (data.kind === 'playlist') {
      await openPlaylistFromSearch(data.id);
    } else if (data.kind === 'user') {
      toast('👤 ' + (data.username || 'артист'));
      setMode('tracks');
      $('#search-input').value = data.username;
      await doSearch(data.username);
    } else {
      toast('Тип ссылки не поддерживается: ' + data.kind, 'error');
    }
  } catch (e) {
    toast('Не удалось открыть ссылку: ' + (e?.message || 'ошибка сети'), 'error');
  }
  return true;
}

async function doSearch(query, append = false) {
  const q = String(query ?? $('#search-input').value).trim();
  if (!q) { toast('Введи запрос', 'error'); return; }
  if (query === undefined || query === null) $('#search-input').value = q;

  if (!append && SC_URL_RE.test(q)) { await resolveUrl(q); return; }

  const grid = $('#tracks');
  if (!append) {
    grid.innerHTML = Array(8).fill('<div class="skeleton"></div>').join('');
    $('#toolbar').style.display = 'none';
  }

  try {
    await runSearch(q, append);
  } catch (err1) {
    if (!append) {
      // вторая попытка со свежим client_id (он периодически ротируется)
      try { await ensureClientId(true); await runSearch(q, append); return; } catch (_) {}
      grid.innerHTML = emptyHTML('i-alert', 'Ошибка поиска',
        escapeHtml(err1.message) + '. Проверь интернет и попробуй ещё раз.');
      $('#toolbar').style.display = 'none';
    } else {
      toast('Не удалось подгрузить ещё', 'error');
    }
  }
}

async function runSearch(q, append) {
  const cid = await ensureClientId();
  const offset = append ? state.tracks.length : 0;
  const endpoint = state.searchMode === 'artists' ? 'users'
    : state.searchMode === 'playlists' ? 'playlists' : 'tracks';
  const data = await scJson(
    `${SC_API2}/search/${endpoint}?q=${encodeURIComponent(q)}&client_id=${cid}&limit=30&offset=${offset}`
  );
  const raw = Array.isArray(data?.collection) ? data.collection : [];

  if (state.searchMode === 'artists') {
    state.artists = raw;
    state.searchSource = 'search';
    pushRecent(q);
    renderArtists();
    $('#toolbar').style.display = state.artists.length ? 'flex' : 'none';
    $('#result-count').textContent = state.artists.length;
    if (!state.artists.length) $('#tracks').innerHTML = emptyHTML('i-search', 'Артистов нет', 'Попробуй другой запрос');
    return;
  }
  if (state.searchMode === 'playlists') {
    state.playlistsFound = raw;
    state.searchSource = 'search';
    pushRecent(q);
    renderFoundPlaylists();
    $('#toolbar').style.display = state.playlistsFound.length ? 'flex' : 'none';
    $('#result-count').textContent = state.playlistsFound.length;
    if (!state.playlistsFound.length) $('#tracks').innerHTML = emptyHTML('i-search', 'Плейлистов нет', 'Попробуй другой запрос');
    return;
  }

  const items = raw.map(normalizeTrack).filter(Boolean);
  console.info('[SC] search:', q, '→', items.length, 'tracks');
  items.forEach(rememberTrack);
  state.tracks = append ? state.tracks.concat(items) : items;
  state.searchSource = 'search';
  pushRecent(q);

  renderTracks();
  const grid = $('#tracks');
  if (!state.visibleTracks.length) {
    grid.innerHTML = emptyHTML('i-volume-off', 'Ничего не найдено', 'Попробуй другой запрос или жанр');
    $('#toolbar').style.display = 'none';
  } else {
    $('#toolbar').style.display = 'flex';
  }
}

function loadMore() {
  if (state.searchSource !== 'search') { toast('Это открытый плейлист — тут всё сразу'); return; }
  doSearch($('#search-input').value, true);
}

/* ---------- фильтры/сортировки треков ---------- */
function applyFilter(list) {
  let out = list;
  if (state.searchDur === 'short') out = out.filter(t => (t.duration || 0) < 180000);
  if (state.searchDur === 'mid') out = out.filter(t => (t.duration || 0) >= 180000 && (t.duration || 0) <= 360000);
  if (state.searchDur === 'long') out = out.filter(t => (t.duration || 0) > 360000);
  if (state.searchSort === 'popular') out = [...out].sort(byPopular);
  if (state.searchSort === 'new') out = [...out].sort(byNew);
  return out;
}

function renderTracks() {
  state.visibleTracks = applyFilter(state.tracks);
  $('#tracks').innerHTML = state.visibleTracks.map((t, i) => trackCardHTML(t, i, 'search')).join('');
  $('#result-count').textContent = state.visibleTracks.length;
  highlightPlaying();
}

/* ---------- карточки артистов и плейлистов ---------- */
function renderArtists() {
  const grid = $('#tracks');
  grid.innerHTML = state.artists.map((u, i) => {
    const followers = u.followers_count != null ? fmtCount(u.followers_count) + ' подписчиков' : '';
    const tc = u.track_count != null ? fmtCount(u.track_count) + ' треков' : '';
    const meta = [followers, tc].filter(Boolean).join(' · ') || 'артист';
    return `<div class="track-card" data-name="${escapeHtml(u.username)}" onclick="searchArtistByName(this.dataset.name)">
      <div class="track-art">
        <img src="${escapeHtml(u.avatar_url || '')}" alt="" loading="lazy" onerror="this.style.opacity=0">
        <div class="play-ov"><div class="play-disk"><svg class="ic fill" viewBox="0 0 24 24"><use href="#i-search"/></svg></div></div>
      </div>
      <div class="track-info">
        <div class="track-title" title="${escapeHtml(u.username)}">${escapeHtml(u.username)}</div>
        <div class="track-artist">${meta}</div>
        <div class="artist-card-meta">Клик — искать треки ↗</div>
      </div>
    </div>`;
  }).join('');
  highlightPlaying();
}

function searchArtistByName(name) {
  setMode('tracks');
  $('#search-input').value = name;
  doSearch(name);
}

function renderFoundPlaylists() {
  const grid = $('#tracks');
  grid.innerHTML = state.playlistsFound.map(p => `
    <div class="track-card" onclick="openPlaylistFromSearch(${p.id})">
      <div class="track-art">
        <img src="${escapeHtml((p.artwork_url || '').replace('large', 't500x500'))}" alt="" loading="lazy" onerror="this.style.opacity=0">
        <div class="play-ov"><div class="play-disk"><svg class="ic fill" viewBox="0 0 24 24"><use href="#i-play"/></svg></div></div>
        <div class="play-count"><svg class="ic tiny fill" viewBox="0 0 24 24"><use href="#i-folder"/></svg><span>${p.track_count ?? 0}</span></div>
      </div>
      <div class="track-info">
        <div class="track-title" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</div>
        <div class="track-artist">${escapeHtml(p.user?.username || '—')}</div>
        <div class="artist-card-meta">Клик — открыть плейлист ↗</div>
      </div>
    </div>`).join('');
}

async function openPlaylistFromSearch(id) {
  toast('Открываю плейлист…');
  try {
    const cid = await ensureClientId();
    const data = await scJson(`${SC_API2}/playlists/${id}?client_id=${cid}`);
    const inline = Array.isArray(data?.tracks) ? data.tracks : [];
    const total = data?.track_count || inline.length;

    // api-v2 отдаёт inline только первые ~5 полных треков, остальные — заглушки
    // {id, kind, monetization_model, policy}. Догружаем полные объекты по ID пачками.
    const full = [];
    const partialIds = [];
    inline.forEach(t => {
      if (t && t.permalink_url && t.streamable !== false) full.push(t);
      else if (t && t.id != null) partialIds.push(t.id);
    });

    if (partialIds.length) {
      toast(`📁 Догружаю ${partialIds.length} треков…`);
      const byId = new Map();
      const BATCH = 50;
      for (let i = 0; i < partialIds.length && i < BATCH * 40; i += BATCH) {
        const chunk = partialIds.slice(i, i + BATCH);
        try {
          const resp = await scJson(`${SC_API2}/tracks?ids=${chunk.join(',')}&client_id=${cid}`);
          (Array.isArray(resp) ? resp : []).forEach(t => { if (t && t.id != null) byId.set(t.id, t); });
        } catch (_) {}
      }
      // собираем финальный список в оригинальном порядке плейлиста
      inline.forEach(t => {
        if (t && t.permalink_url && t.streamable !== false) return; // уже в full
        const fixed = t && t.id != null ? byId.get(t.id) : null;
        if (fixed && fixed.permalink_url) full.push(fixed);
      });
    }

    const items = full.map(normalizeTrack).filter(Boolean);
    if (!items.length) { toast('Плейлист пуст', 'error'); return; }
    items.forEach(rememberTrack);
    state.tracks = items;
    state.searchSource = 'playlist';
    state.visibleTracks = items;
    $('#search-input').value = data.title || 'Плейлист';
    renderTracks();
    $('#toolbar').style.display = 'flex';
    toast(`📁 «${data.title}»: ${items.length} из ${total} треков`, 'success');
  } catch (_) { toast('Не удалось открыть плейлист', 'error'); }
}

/* ---------- «Мне повезёт» ---------- */
const LUCKY = ['русский рэп', 'phonk 2026', 'lofi hip hop', 'synthwave', 'русский фонк',
  'drum and bass', 'techno berlin', 'русский рок', 'jazz funk', 'русский поп хит',
  'русские хиты 2000', 'ambient chill', 'русский lofi'];
async function feelingLucky() {
  const q = LUCKY[Math.floor(Math.random() * LUCKY.length)];
  toast('🎲 ' + q);
  switchView('discover');
  setMode('tracks');
  $('#search-input').value = q;
  await doSearch(q);
  const list = state.visibleTracks;
  if (list.length) playTrack(list[Math.floor(Math.random() * list.length)], 'search');
}

/* ---------- недавние запросы ---------- */
async function pushRecent(q) {
  if (ipc) { try { state.recentCache = (await ipc.invoke('recentSearches:push', q)) || []; return; } catch (_) {} }
  state.recentCache = [q, ...state.recentCache.filter(x => x !== q)].slice(0, 20);
  lsSet('recentSearches', state.recentCache);
}

function showRecent() {
  const box = $('#recent-searches');
  const arr = state.recentCache || [];
  if (!arr.length) return;
  box.innerHTML = arr.slice(0, 8).map(q => `<button class="chip recent-chip">${escapeHtml(q)}</button>`).join('');
  box.style.display = 'flex';
}
function hideRecent() { const b = $('#recent-searches'); if (b) b.style.display = 'none'; }

/* ---------- тренды: мировые чарты + русские табы ---------- */
const TRENDS = [
  { id: 'world', label: '🌍 Мировое' },
  { id: 'ru-rap', label: 'Русский рэп', q: 'русский рэп' },
  { id: 'ru-pop', label: 'Русский поп', q: 'русский поп' },
  { id: 'ru-rock', label: 'Русский рок', q: 'русский рок' },
  { id: 'ru-phonk', label: 'Русский фонк', q: 'русский фонк' },
  { id: 'ru-lofi', label: 'Русский lofi', q: 'русский lofi' },
  { id: 'ru-covers', label: 'Каверы', q: 'русские каверы' },
  { id: 'ru-2000', label: 'Хиты 2000-х', q: 'русские хиты 2000' }
];

function renderTrendTabs() {
  $('#trend-tabs').innerHTML = TRENDS.map(t =>
    `<button class="trend-tab ${t.id === state.trendTab ? 'active' : ''}" data-trend="${t.id}">${t.label}</button>`
  ).join('');
  $('#trend-tabs').onclick = e => {
    const b = e.target.closest('.trend-tab');
    if (!b || b.dataset.trend === state.trendTab) return;
    state.trendTab = b.dataset.trend;
    renderTrendTabs();
    loadTrending(true);
  };
}

/* ---------- «Для вас»: персональный поток аккаунта ---------- */
async function loadForyou(force) {
  if (!state.scAuth?.token) {
    $('#foryou-tracks').innerHTML = emptyHTML('i-user', 'Нужен аккаунт',
      'Войди через SoundCloud — плашка «Аккаунт» слева внизу, и поток соберётся под твой профиль');
    return;
  }
  if (state.foryouTracks.length && !force) { renderForyou(); return; }
  const grid = $('#foryou-tracks');
  grid.innerHTML = Array(8).fill('<div class="skeleton"></div>').join('');
  try {
    await runForyou();
  } catch (err) {
    const msg = String(err?.message || '');
    try { await ensureClientId(true); await runForyou(); return; } catch (_) {}
    if (msg.includes('401')) {
      grid.innerHTML = emptyHTML('i-alert', 'Нужен повторный вход', 'Токен аккаунта устарел — войди заново через плашку «Аккаунт»');
    } else {
      grid.innerHTML = emptyHTML('i-alert', 'Поток недоступен', escapeHtml(msg) + ' — проверь сеть и Антиблок');
    }
  }
}

async function runForyou() {
  const cid = await ensureClientId();
  const data = await scJson(
    `${SC_API2}/me/stream?client_id=${cid}&limit=40`, { auth: true }
  );
  const items = (Array.isArray(data?.collection) ? data.collection : [])
    .map(normalizeTrack).filter(Boolean);
  items.forEach(rememberTrack);
  state.foryouTracks = items;
  $('#foryou-tracks').innerHTML = items.length
    ? items.map((t, i) => trackCardHTML(t, i, 'foryou')).join('')
    : emptyHTML('i-spark', 'Поток пуст', 'Подпишись на артистов на SoundCloud — их новинки появятся здесь');
  highlightPlaying();
}

function renderForyou() {
  $('#foryou-tracks').innerHTML = state.foryouTracks.map((t, i) => trackCardHTML(t, i, 'foryou')).join('');
  highlightPlaying();
}

async function loadTrending(force) {
  if (state.trending.length && !force && state.trendTabId === state.trendTab) { renderTrending(); return; }
  const grid = $('#trending-tracks');
  grid.innerHTML = Array(8).fill('<div class="skeleton"></div>').join('');
  try {
    await runTrending();
  } catch (_) {
    try { await ensureClientId(true); await runTrending(); return; } catch (_) {}
    grid.innerHTML = emptyHTML('i-alert', 'Тренды недоступны', 'SoundCloud не ответил — попробуй обновить позже');
  }
}

async function runTrending() {
  const cid = await ensureClientId();
  const trend = TRENDS.find(t => t.id === state.trendTab) || TRENDS[0];
  let items = [];
  if (!trend.q) {
    const data = await scJson(
      `${SC_API2}/charts?kind=trending&genre=soundcloud%3Agenres%3Aall-music&client_id=${cid}&limit=30`
    );
    items = (Array.isArray(data?.collection) ? data.collection : []).map(normalizeTrack).filter(Boolean);
  } else {
    const data = await scJson(
      `${SC_API2}/search/tracks?q=${encodeURIComponent(trend.q)}&client_id=${cid}&limit=50`
    );
    items = (Array.isArray(data?.collection) ? data.collection : [])
      .map(normalizeTrack).filter(Boolean).sort(byPopular).slice(0, 30);
  }
  console.info('[SC] trending:', trend.id, '→', items.length);
  items.forEach(rememberTrack);
  state.trending = items;
  state.trendTabId = state.trendTab;
  renderTrending();
}

function renderTrending() {
  $('#trending-tracks').innerHTML = state.trending.map((t, i) => trackCardHTML(t, i, 'trending')).join('');
  highlightPlaying();
}
