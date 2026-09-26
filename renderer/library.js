/* ============================================================
   VOLNA · library.js — данные, лайки, плейлисты, история,
   статистика, настройки, backup
   ============================================================ */
'use strict';

/* ---------- загрузка/сохранение данных ---------- */
async function loadAllData() {
  const g = async (channel, lsKey, def) => {
    if (ipc) { try { const v = await ipc.invoke(channel); return v === null || v === undefined ? def : v; } catch (_) {} }
    return lsGet(lsKey, def);
  };
  state.favorites = await g('favorites:get', 'favorites', []);
  state.history = await g('history:get', 'history', []);
  state.playlists = await g('playlists:get', 'playlists', []);
  state.stats = await g('stats:get', 'stats', { totalPlayed: 0, totalTime: 0, sessionStart: Date.now() });
  if (ipc) { try { state.lastTrack = await ipc.invoke('lastTrack:get'); } catch (_) {} }
  else state.lastTrack = lsGet('lastTrack', null);

  if (ipc) {
    try { state.settings = { ...state.settings, ...(await ipc.invoke('settings:get') || {}) }; }
    catch (_) {}
  } else {
    state.settings = { ...state.settings, ...lsGet('settings', {}) };
  }
  state.scAuth = state.settings.scAuth || null;
  state.dislikes = Array.isArray(state.settings.dislikes) ? state.settings.dislikes : [];
  [...state.favorites, ...state.history].forEach(rememberTrack);
}

async function persistFavorites() {
  if (ipc) { try { await ipc.invoke('favorites:save', state.favorites); return; } catch (_) {} }
  lsSet('favorites', state.favorites);
}
async function persistHistory() {
  if (ipc) { try { await ipc.invoke('history:save', state.history); return; } catch (_) {} }
  lsSet('history', state.history);
}
async function persistPlaylists() {
  if (ipc) { try { await ipc.invoke('playlists:save', state.playlists); return; } catch (_) {} }
  lsSet('playlists', state.playlists);
}

async function saveSetting(key, val) {
  state.settings[key] = val;
  if (ipc) { try { await ipc.invoke('settings:set', key, val); return; } catch (_) {} }
  lsSet('settings', state.settings);
}

/* ---------- эквалайзер ---------- */
const EQ_PRESETS = {
  flat:       [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  bass:       [8, 7, 5, 3, 1, 0, 0, 0, 0, 0],
  vocal:      [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1],
  rock:       [5, 4, 2, 0, -1, -1, 0, 2, 3, 4],
  electronic: [6, 5, 1, 0, -2, 1, 1, 3, 4, 5]
};

async function saveEq(preset) {
  await saveSetting('eq', { gains: state.eqGains, preset: preset || 'custom' });
  state.eqPreset = preset || 'custom';
  $$('.eq-chip').forEach(c => c.classList.toggle('active', c.dataset.eq === state.eqPreset));
}

function applyEqPreset(name) {
  const g = EQ_PRESETS[name];
  if (!g) return;
  state.eqGains = [...g];
  g.forEach((v, i) => { const el = $('#eq-' + i); if (el) el.value = v; });
  applyEqGains(); // из player.js: действует при нативном движке
  saveEq(name);
  toast(name === 'flat' ? '🎚 Эквалайзер: ровный' : '🎚 Эквалайзер: ' + name, 'success');
}

function bindEq() {
  for (let i = 0; i < 10; i++) {
    const el = $('#eq-' + i);
    if (!el) continue;
    el.addEventListener('input', () => {
      state.eqGains[i] = +el.value;
      applyEqGains();
      saveEq();
    });
  }
  $$('.eq-chip').forEach(c => c.addEventListener('click', () => applyEqPreset(c.dataset.eq)));
}

function restoreEqUI() {
  const eq = state.settings.eq;
  if (eq && Array.isArray(eq.gains) && eq.gains.length === 10) {
    state.eqGains = [...eq.gains];
    state.eqPreset = eq.preset || 'custom';
  }
  state.eqGains.forEach((v, i) => { const el = $('#eq-' + i); if (el) el.value = v; });
  $$('.eq-chip').forEach(c => c.classList.toggle('active', c.dataset.eq === state.eqPreset));
  applyEqGains();
}

/* ---------- скрытые артисты (Radio их вырезает) ---------- */
async function addDislike(track) {
  const n = track.user?.username;
  if (!n) return;
  if (state.dislikes.includes(n)) { toast('Уже скрыт'); return; }
  state.dislikes.push(n);
  await saveSetting('dislikes', state.dislikes);
  const before = state.queue.length;
  state.queue = state.queue.filter(t => t.user?.username !== n);
  if (state.queue.length !== before) { updateBadges(); renderQueue(); highlightPlaying(); }
  updateDislikeCount();
  toast(`🚫 «${n}» скрыт из Radio`);
}

async function resetDislikes() {
  if (!state.dislikes.length) { toast('Список скрытых пуст'); return; }
  if (!confirm(`Показать снова всех скрытых артистов (${state.dislikes.length})?`)) return;
  state.dislikes = [];
  await saveSetting('dislikes', []);
  updateDislikeCount();
  toast('Список скрытых очищен');
}

function updateDislikeCount() {
  const el = $('#dislike-count');
  if (el) el.textContent = state.dislikes.length;
}

/* ---------- применение настроек ---------- */
function applySettings() {
  document.body.dataset.accent = state.settings.accent || 'neon';
  const vol = Math.min(1, Math.max(0, state.settings.volume ?? 1));
  state.volume = vol;
  $('#vol-fill').style.width = vol * 100 + '%';
  updateVolumeIcon();
  const dv = $('#default-volume');
  if (dv) { dv.value = vol; $('#default-volume-val').textContent = Math.round(vol * 100) + '%'; }
  $('#set-notify').checked = !!state.settings.notifyOnLike;
  $('#set-savewin').checked = state.settings.saveWindowState !== false;
  $('#set-minimize').checked = !!state.settings.startMinimized;
  const ab = state.settings.antiblock || {};
  $('#set-doh').checked = ab.doh !== false;
  $('#set-proxy').value = ab.proxy || '';
  renderAuthStatus();
  $('#set-autoload').checked = state.settings.autoLyrics !== false;
  $('#set-awake').checked = state.settings.keepAwake !== false;
  $('#set-discord').checked = state.settings.discordRpc !== false;
  const dt = $('#set-discord-token');
  if (dt) dt.value = state.settings.discordBotToken || '';
  const nightcomp = $('#set-nightcomp');
  if (nightcomp) nightcomp.checked = state.settings.nightCompressor === true;
  const fadeT = $('#set-fade');
  if (fadeT) fadeT.checked = state.settings.fade !== false;
  const ambT = $('#set-ambient');
  if (ambT) ambT.checked = state.settings.ambient !== false;
  $('#set-waves').checked = state.settings.waves !== false;
  document.body.classList.toggle('waves-off', state.settings.waves === false);
  $('#set-mascot').checked = state.settings.mascot !== false;
  const usv = $('#ui-scale-val');
  if (usv) usv.textContent = Math.round((state.settings.uiScale || 1) * 100) + '%';
  setZoom(state.settings.uiScale || 1, true);
  restoreEqUI();
  updateDislikeCount();
  state.visualMode = state.settings.visualMode !== false;
  $$('.bit-chip').forEach(x => x.classList.toggle('active', x.dataset.bit === (state.settings.bitrate || 'best')));
  renderVcatChips();
  const vs = $('#set-vsession');
  if (vs) vs.checked = state.settings.vibeSession === true;
  const su = $('#set-updates');
  if (su) su.checked = state.settings.checkUpdates !== false;
  $$('.accent-chip').forEach(c => c.classList.toggle('active', c.dataset.accent === (state.settings.accent || 'neon')));
}

function bindLibraryUI() {
  $$('.accent-chip').forEach(chip => chip.addEventListener('click', async () => {
    await saveSetting('accent', chip.dataset.accent);
    applySettings();
    toast('🎨 Акцент: ' + chip.dataset.accent, 'success');
  }));

  const dv = $('#default-volume');
  dv.addEventListener('input', () => { $('#default-volume-val').textContent = Math.round(dv.value * 100) + '%'; });
  dv.addEventListener('change', () => saveSetting('volume', parseFloat(dv.value)));

  $('#set-notify').addEventListener('change', e => saveSetting('notifyOnLike', e.target.checked));
  $('#set-savewin').addEventListener('change', e => saveSetting('saveWindowState', e.target.checked));
  $('#set-minimize').addEventListener('change', e => saveSetting('startMinimized', e.target.checked));

  $('#set-doh').addEventListener('change', async e => {
    state.settings.antiblock = { ...(state.settings.antiblock || {}), doh: e.target.checked };
    if (ipc) { try { await ipc.invoke('antiblock:doh', e.target.checked); } catch (_) {} }
    toast(e.target.checked ? '🛡 DoH включён — перезапусти приложение' : 'DoH выключен — перезапусти приложение');
  });

  $('#file-input').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try { await mergeFavs(JSON.parse(await f.text())); }
    catch (_) { toast('Ошибка импорта', 'error'); }
    e.target.value = '';
  });

  $('#set-autoload').addEventListener('change', e => saveSetting('autoLyrics', e.target.checked));
  $('#set-awake').addEventListener('change', e => saveSetting('keepAwake', e.target.checked));
  $('#set-discord').addEventListener('change', e => {
    saveSetting('discordRpc', e.target.checked);
    if (ipc) ipc.invoke(e.target.checked ? 'rpc:enable' : 'rpc:disable').catch(() => {});
    toast(e.target.checked ? '🎮 Discord RPC включён — перезапусти трек для статуса' : 'Discord RPC выключен');
  });
  const nightcomp = $('#set-nightcomp');
  if (nightcomp) nightcomp.addEventListener('change', e => {
    saveSetting('nightCompressor', e.target.checked);
    if (typeof applyNightCompressor === 'function') applyNightCompressor();
    toast(e.target.checked ? '🔇 Ночной компрессор включён' : 'Ночной компрессор выключен');
  });
  const fadeT = $('#set-fade');
  if (fadeT) fadeT.addEventListener('change', e => {
    saveSetting('fade', e.target.checked);
    if (!e.target.checked) { state.fadeFactor = 1; if (typeof applyVolume === 'function') applyVolume(); }
    toast(e.target.checked ? '🎚 Плавные переходы включены' : 'Плавные переходы выключены');
  });
  const ambT = $('#set-ambient');
  if (ambT) ambT.addEventListener('change', e => {
    saveSetting('ambient', e.target.checked);
    if (typeof applyAmbient === 'function') applyAmbient(state.currentTrack);
    toast(e.target.checked ? '🎨 Амбиент по обложке включён' : 'Амбиент по обложке выключен');
  });

  $('#set-scproxy').addEventListener('change', async e => {
    if (ipc) {
      const ab = { ...(state.settings.antiblock || {}), proxyScOnly: e.target.checked };
      state.settings.antiblock = ab;
      try { await ipc.invoke('antiblock:proxy', $('#set-proxy').value.trim(), { scOnly: e.target.checked }); } catch (_) {}
    }
    toast(e.target.checked ? '🛡 Прокси только для SoundCloud' : 'Прокси на весь трафик приложения');
    testNetwork();
  });
  $('#set-cursor').addEventListener('change', e => {
    saveSetting('cursor', e.target.checked);
    document.body.classList.toggle('no-cursor', !e.target.checked);
    toast(e.target.checked ? '🖱 Кастомный курсор включён' : 'Обычный системный курсор');
  });
  $('#set-updates').addEventListener('change', e => saveSetting('checkUpdates', e.target.checked));

  bindEq();
  bindVcatChips();
  const vsb = $('#set-vsession');
  if (vsb) vsb.addEventListener('change', e => saveSetting('vibeSession', e.target.checked));
  bindPlaylistDnD();
  $$('.bit-chip[data-bit]').forEach(ch => ch.addEventListener('click', async () => {
    await saveSetting('bitrate', ch.dataset.bit);
    $$('.bit-chip[data-bit]').forEach(x => x.classList.toggle('active', x.dataset.bit === ch.dataset.bit));
    toast(ch.dataset.bit === 'best' ? '🎚 Качество: лучшее' : '🎚 Качество: экономия трафика (перезапусти трек)', 'success');
  }));
  $$('.bit-chip[data-vcat]').forEach(ch => ch.addEventListener('click', async () => {
    await saveSetting('vibeCat', ch.dataset.vcat);
    state.visual = null; // сбросить фон — новая категория
    if ($('#view-vibe')?.classList.contains('active')) renderVibe();
    toast('🖼 Стиль фонов: ' + ch.textContent.trim(), 'success');
  }));
  $('#fav-filter').addEventListener('input', e => {
    state.favFilter = e.target.value;
    if ($('#view-favorites')?.classList.contains('active')) renderFavorites();
  });

  $('#set-waves').addEventListener('change', e => {
    saveSetting('waves', e.target.checked);
    document.body.classList.toggle('waves-off', !e.target.checked);
    toast(e.target.checked ? '🌊 Волны включены' : 'Волны выключены');
  });

  $('#set-mascot').addEventListener('change', e => {
    saveSetting('mascot', e.target.checked);
    if (typeof updateMascot === 'function') updateMascot();
    toast(e.target.checked ? '🎭 Маскот включён' : 'Маскот выключен');
  });

  $('#wallpaper-input').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    if (!f.type.startsWith('image/')) { toast('Это не картинка', 'error'); return; }
    const img = new Image();
    img.onload = () => {
      // даунскейл до 1600px по ширине, JPEG — чтобы влезло в localStorage
      const maxW = 1600;
      const scale = Math.min(1, maxW / img.naturalWidth);
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      try {
        localStorage.setItem('ga:wallpaper', c.toDataURL('image/jpeg', 0.82));
        saveSetting('wallpaperData', c.toDataURL('image/jpeg', 0.82));
        applyWallpaper();
        toast('🖼 Обои установлены', 'success');
      } catch (_) { toast('Картинка слишком большая', 'error'); }
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => toast('Не удалось прочитать картинку', 'error');
    img.src = URL.createObjectURL(f);
    e.target.value = '';
  });

  $('#wallpaper-dim').addEventListener('input', e => {
    localStorage.setItem('ga:wallpaperDim', e.target.value);
    applyWallpaper();
  });
}

/* ---------- лайки ---------- */
async function toggleLike(track) {
  if (!track) return;
  rememberTrack(track);
  const isFav = state.favorites.some(f => f.id === track.id);
  if (isFav) {
    state.favorites = state.favorites.filter(f => f.id !== track.id);
    toast('Убрано из лайков');
  } else {
    state.favorites.unshift({ ...track, likedAt: new Date().toISOString() });
    toast('❤️ Добавлено в лайки', 'success');
    if (state.settings.notifyOnLike && ipc) {
      ipc.invoke('notify', { title: '❤️ Добавлено в лайки', body: track.title }).catch(() => {});
    }
  }
  await persistFavorites();
  updateBadges();
  updateLikeButtons();
  if (state.currentTrack?.id === track.id) updateTitle(); // обновить ❤️ в Discord RPC
  if ($('#view-favorites')?.classList.contains('active')) renderFavorites();
  mirrorLikeToServer(track, !isFav); // двойной лайк: локально + на SoundCloud
}

function toggleLikeById(id) { toggleLike(state.trackIndex.get(id)); }

function likeCurrent() {
  const t = currentTrack();
  if (!t) { toast('Нечего лайкать'); return; }
  toggleLike(t);
}

function updateLikeButtons() {
  $$('.like-btn[data-id]').forEach(btn => {
    const fav = state.favorites.some(f => f.id === +btn.dataset.id);
    btn.classList.toggle('liked', fav);
  });
}

function renderFavorites() {
  const grid = $('#favorites-list');
  const flt = (state.favFilter || '').trim().toLowerCase();
  const match = t => !flt
    || (t.title || '').toLowerCase().includes(flt)
    || (t.user?.username || '').toLowerCase().includes(flt);

  if (state.favSource === 'server') {
    const list = state.serverLikes.filter(match);
    state.serverLikesView = list;
    $('#fav-count').textContent = list.length;
    grid.innerHTML = list.length
      ? list.map((t, i) => trackCardHTML(t, i, 'sv')).join('')
      : (state.serverLikes.length
        ? emptyHTML('i-search', 'Не нашлось', 'Под фильтр «' + escapeHtml(state.favFilter) + '» треков нет')
        : emptyHTML('i-heart', 'На сервере лайков нет', 'Лайкай на SoundCloud — они появятся здесь'));
    highlightPlaying();
    return;
  }

  $('#fav-count').textContent = state.favorites.length;
  if (!state.favorites.length) {
    grid.innerHTML = emptyHTML('i-heart', 'Пока нет лайков', 'Жми сердечко на треке или клавишу L — треки появятся здесь');
    return;
  }
  // рендерим отфильтрованный/отсортированный список и играем строго по нему
  let list = state.sortFavs === 'date'
    ? [...state.favorites]
    : [...state.favorites].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  list = list.filter(match);
  state.favoritesView = list;
  if (!list.length) {
    grid.innerHTML = emptyHTML('i-search', 'Не нашлось', 'Под фильтр «' + escapeHtml(state.favFilter) + '» лайков нет');
    return;
  }
  grid.innerHTML = list.map((t, i) => trackCardHTML(t, i, 'fav')).join('');
  highlightPlaying();
}

/* bot-токен Discord для обложек в статусе (хранится только локально) */
async function saveDiscordToken() {
  const v = $('#set-discord-token').value.trim();
  await saveSetting('discordBotToken', v);
  if (ipc) ipc.invoke('rpc:assets-clear').catch(() => {});
  toast(v ? '🖼 Токен сохранён — включи трек, обложки появятся' : 'Токен стёрт — статус без обложек');
}

/* переименование плейлиста */
function openRenamePlaylist(id) {
  const pl = state.playlists.find(p => p.id === id);
  if (!pl) return;
  state._renameId = id;
  $('#rename-name').value = pl.name;
  $('#rename-desc').value = pl.desc || '';
  openModal('rename_modal');
  setTimeout(() => { $('#rename-name').focus(); $('#rename-name').select(); }, 50);
}

async function saveRename() {
  const pl = state.playlists.find(p => p.id === state._renameId);
  if (!pl) { closeModal('rename_modal'); return; }
  const name = $('#rename-name').value.trim();
  if (!name) { toast('Введи название', 'error'); return; }
  pl.name = name;
  pl.desc = $('#rename-desc').value.trim();
  await persistPlaylists();
  closeModal('rename_modal');
  if ($('#view-playlist-detail')?.classList.contains('active') && state.currentPlaylistId === pl.id) openPlaylist(pl.id);
  if ($('#view-playlists')?.classList.contains('active')) renderPlaylists();
  toast('✏️ Переименовано: ' + pl.name, 'success');
}

/* убрать трек из плейлиста (крестик на карточке в детальном виде) */
async function removeFromPlaylist(idx) {
  const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
  if (!pl || !pl.tracks[idx]) return;
  const [removed] = pl.tracks.splice(idx, 1);
  await persistPlaylists();
  openPlaylist(pl.id); // перерисовка детального вида
  updateBadges();
  highlightPlaying();
  toast('Убрано: ' + (removed.title || ''), '', { label: '↩ Вернуть', fn: async () => {
    const pl2 = state.playlists.find(p => p.id === pl.id);
    if (!pl2) return;
    pl2.tracks.splice(Math.min(idx, pl2.tracks.length), 0, removed);
    await persistPlaylists();
    if ($('#view-playlist-detail')?.classList.contains('active') && state.currentPlaylistId === pl.id) openPlaylist(pl.id);
    updateBadges();
    toast('↩ Вернулось на место', 'success');
  }});
}

/* экспорт/импорт плейлиста файлом (.volna.json) */
async function exportPlaylist() {
  const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
  if (!pl) return;
  if (!pl.tracks.length) { toast('Плейлист пуст', 'error'); return; }
  const r = await ipc.invoke('dialog:exportPlaylistFile', { name: pl.name, tracks: pl.tracks }).catch(() => null);
  if (r?.ok) toast('⤓ Экспортировано: ' + pl.name, 'success');
  else if (r && !r.ok && r.error) toast('Ошибка: ' + r.error, 'error');
}

async function importPlaylistFile() {
  if (!ipc) { toast('Доступно только в приложении', 'error'); return; }
  const r = await ipc.invoke('dialog:importPlaylistFile').catch(() => null);
  if (!r?.ok) { if (r && r.error) toast('Ошибка: ' + r.error, 'error'); return; }
  const tracks = (r.tracks || []).filter(t => t && t.id != null && t.permalink_url && t.title).slice(0, 500);
  if (!tracks.length) { toast('В файле нет валидных треков', 'error'); return; }
  let name = r.name || 'Импорт'; let n = 2;
  while (state.playlists.some(p => p.name === name)) name = (r.name || 'Импорт') + ' (' + n++ + ')';
  tracks.forEach(rememberTrack);
  state.playlists.push({ id: Date.now(), name, desc: 'Импорт из файла · ' + new Date().toLocaleDateString('ru-RU'), tracks, createdAt: new Date().toISOString() });
  await persistPlaylists();
  updateBadges();
  if ($('#view-playlists')?.classList.contains('active')) renderPlaylists();
  toast('⤒ Импортировано «' + name + '» — ' + tracks.length + ' треков', 'success');
}

/* drag&drop порядок треков в плейлисте */
function bindPlaylistDnD() {
  const listEl = $('#pl-detail-tracks');
  if (!listEl) return;
  let dragIdx = -1;
  listEl.addEventListener('dragstart', e => {
    const card = e.target.closest('.track-card');
    if (!card) return;
    dragIdx = +card.dataset.idx;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(dragIdx)); } catch (_) {}
  });
  listEl.addEventListener('dragover', e => {
    if (dragIdx < 0) return;
    e.preventDefault();
    const card = e.target.closest('.track-card');
    if (card) {
      $$('#pl-detail-tracks .track-card').forEach(x => x.classList.remove('drop-target'));
      card.classList.add('drop-target');
    }
  });
  listEl.addEventListener('drop', e => {
    e.preventDefault();
    const card = e.target.closest('.track-card');
    if (!card || dragIdx < 0) { dragIdx = -1; return; }
    const to = +card.dataset.idx;
    const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
    if (pl && to !== dragIdx && pl.tracks[dragIdx]) {
      const [moved] = pl.tracks.splice(dragIdx, 1);
      pl.tracks.splice(to, 0, moved);
      persistPlaylists();
      openPlaylist(pl.id);
      highlightPlaying();
    }
    dragIdx = -1;
  });
  listEl.addEventListener('dragend', () => {
    dragIdx = -1;
    $$('#pl-detail-tracks .track-card').forEach(x => x.classList.remove('dragging', 'drop-target'));
  });
}

function toggleSort() {
  state.sortFavs = state.sortFavs === 'date' ? 'name' : 'date';
  const label = $('#sort-label');
  if (label) label.textContent = state.sortFavs === 'date' ? 'По дате' : 'По имени';
  renderFavorites();
}

function playAllFavorites() {
  if (!state.favorites.length) { toast('Нет треков', 'error'); return; }
  playTrack(state.favorites[0], 'fav');
}

async function clearFavs() {
  if (!state.favorites.length) return;
  if (!confirm('Удалить все лайки?')) return;
  state.favorites = [];
  await persistFavorites();
  updateBadges(); updateLikeButtons(); renderFavorites();
  toast('Лайки очищены');
}

async function mergeFavs(data) {
  if (!Array.isArray(data)) { toast('Файл не содержит список треков', 'error'); return; }
  let added = 0;
  data.forEach(t => {
    if (t && t.id != null && t.permalink_url && !state.favorites.some(f => f.id === t.id)) {
      state.favorites.unshift({ ...t, likedAt: t.likedAt || new Date().toISOString() });
      rememberTrack(t);
      added++;
    }
  });
  await persistFavorites();
  updateBadges(); updateLikeButtons();
  if ($('#view-favorites')?.classList.contains('active')) renderFavorites();
  toast(`Импортировано: ${added}`, 'success');
}

async function exportFavorites() {
  if (ipc) {
    const r = await ipc.invoke('dialog:exportFavs').catch(() => null);
    if (r?.ok) { toast('Экспортировано ✓', 'success'); return; }
    if (r && !r.ok && r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
    return; // отмена диалога
  }
  const blob = new Blob([JSON.stringify(state.favorites, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'volna-favorites.json';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Экспортировано ✓', 'success');
}

function importFavorites() {
  if (ipc) {
    ipc.invoke('dialog:importFavs').then(async r => {
      if (r?.ok) await mergeFavs(r.data);
      else if (r && !r.ok && r.error) toast('Ошибка: ' + r.error, 'error');
    }).catch(() => {});
  } else {
    $('#file-input').click();
  }
}

/* ---------- история ---------- */
async function addHistory(track) {
  state.history = state.history.filter(h => h.id !== track.id);
  state.history.unshift({ ...track, playedAt: new Date().toISOString() });
  state.history = state.history.slice(0, 100);
  rememberTrack(track);
  await persistHistory();
}

function renderHistory() {
  const grid = $('#history-list');
  $('#hist-count').textContent = state.history.length;
  if (!state.history.length) {
    grid.innerHTML = emptyHTML('i-history', 'История пуста', 'Слушай треки — они появятся здесь');
    return;
  }
  grid.innerHTML = state.history.map((t, i) => trackCardHTML(t, i, 'hist')).join('');
  highlightPlaying();
}

async function clearHistory() {
  if (!state.history.length) return;
  if (!confirm('Очистить историю?')) return;
  state.history = [];
  await persistHistory();
  renderHistory();
  toast('История очищена');
}

/* ---------- плейлисты ---------- */
async function createPlaylist() {
  const name = $('#playlist-name').value.trim();
  const desc = $('#playlist-desc').value.trim();
  if (!name) { toast('Введи название', 'error'); return; }
  state.playlists.push({ id: Date.now(), name, desc, tracks: [], createdAt: new Date().toISOString() });
  $('#playlist-name').value = '';
  $('#playlist-desc').value = '';
  await persistPlaylists();
  closeModal('playlist_modal');
  updateBadges();
  if ($('#view-playlists')?.classList.contains('active')) renderPlaylists();
  toast('📁 Плейлист создан', 'success');
}

/* мозаика из обложек первых 4 треков плейлиста */
function mosaicHTML(pl) {
  const covers = (pl.tracks || []).map(t => artwork(t)).filter(Boolean).slice(0, 4);
  if (covers.length < 2) return '<div class="pl-art"><svg class="ic" viewBox="0 0 24 24"><use href="#i-folder"/></svg></div>';
  return '<div class="pl-mosaic">' + covers.map(u => `<img src="${escapeHtml(u)}" alt="" loading="lazy" onerror="this.style.opacity=0">`).join('') + '</div>';
}

function renderPlaylists() {
  const grid = $('#playlists-grid');
  if (!state.playlists.length) {
    grid.innerHTML = emptyHTML('i-folder', 'Нет плейлистов', 'Создай первый — кнопка «+ Новый» сверху');
    return;
  }
  grid.innerHTML = state.playlists.map(pl => `
    <div class="track-card" onclick="openPlaylist(${pl.id})">
      <div class="track-art">${mosaicHTML(pl)}</div>
      <div class="track-info">
        <div class="track-title" title="${escapeHtml(pl.name)}">${escapeHtml(pl.name)}</div>
        <div class="track-artist">${pl.tracks.length} треков</div>
        <div class="track-meta">
          <span class="track-duration" style="overflow:hidden;text-overflow:ellipsis">${escapeHtml(pl.desc || 'Без описания')}</span>
          <button class="like-btn" title="Удалить плейлист"
            onclick="event.stopPropagation();deletePlaylist(${pl.id})"><svg class="ic" viewBox="0 0 24 24"><use href="#i-trash"/></svg></button>
        </div>
      </div>
    </div>`).join('');
}

function openPlaylist(id) {
  const pl = state.playlists.find(p => p.id === id);
  if (!pl) return;
  state.currentPlaylistId = id;
  state.currentPlaylistTracks = pl.tracks;
  $('#pl-detail-name').textContent = pl.name;
  $('#pl-detail-desc').textContent =
    (pl.tracks.length ? `${pl.tracks.length} треков · ` : '') + (pl.desc || 'без описания');
  const grid = $('#pl-detail-tracks');
  grid.innerHTML = pl.tracks.length
    ? pl.tracks.map((t, i) => trackCardHTML(t, i, 'pl')).join('')
    : emptyHTML('i-folder', 'Плейлист пуст', 'ПКМ по любому треку → «В плейлист»');
  switchView('playlist-detail');
}

function playCurrentPlaylist() {
  if (!state.currentPlaylistTracks.length) { toast('Плейлист пуст', 'error'); return; }
  playTrack(state.currentPlaylistTracks[0], 'pl');
}

async function deletePlaylist(id) {
  const pl = state.playlists.find(p => p.id === id);
  if (!pl) return;
  if (!confirm(`Удалить плейлист «${pl.name}»?`)) return;
  state.playlists = state.playlists.filter(p => p.id !== id);
  if (state.currentPlaylistId === id) {
    state.currentPlaylistId = null;
    state.currentPlaylistTracks = [];
  }
  await persistPlaylists();
  updateBadges();
  if ($('#view-playlist-detail')?.classList.contains('active') && !state.playlists.length) switchView('playlists');
  else renderPlaylists();
  toast('Плейлист удалён');
}

function deleteCurrentPlaylist() {
  if (state.currentPlaylistId != null) deletePlaylist(state.currentPlaylistId);
}

async function addToPlaylist(trackId, playlistId) {
  const track = state.trackIndex.get(trackId);
  const pl = state.playlists.find(p => p.id === playlistId);
  if (!track || !pl) return;
  if (pl.tracks.some(t => t.id === trackId)) { toast('Уже в этом плейлисте'); return; }
  pl.tracks.push(track);
  rememberTrack(track);
  await persistPlaylists();
  updateBadges();
  toast(`Добавлено в «${pl.name}»`, 'success');
}

async function saveQueueAsPlaylist() {
  if (!state.queue.length) { toast('Очередь пуста', 'error'); return; }
  const name = 'Очередь · ' + new Date().toLocaleDateString('ru-RU');
  state.playlists.push({ id: Date.now(), name, desc: 'Сохранено из очереди', tracks: [...state.queue], createdAt: new Date().toISOString() });
  await persistPlaylists();
  updateBadges();
  toast(`💾 Сохранено: «${name}»`, 'success');
}

/* ---------- статистика ---------- */
async function bumpStats(track) {
  state.stats.totalPlayed = (state.stats.totalPlayed || 0) + 1;
  state.stats.totalTime = (state.stats.totalTime || 0) + (track.duration || 0);
  if (ipc) { try { await ipc.invoke('stats:update', { played: 1, time: track.duration || 0 }); } catch (_) {} }
}

function topArtists() {
  const counts = new Map();
  state.history.forEach(t => {
    const n = t.user?.username || '—';
    counts.set(n, (counts.get(n) || 0) + 1);
  });
  const arr = [...counts.entries()].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count).slice(0, 8);
  const max = arr[0]?.count || 1;
  arr.forEach(a => { a.pct = Math.round(a.count / max * 100); });
  return arr;
}

function renderStats() {
  const s = state.stats;
  const sessionMin = Math.max(0, Math.round((Date.now() - (s.sessionStart || Date.now())) / 60000));
  const totalH = Math.floor((s.totalTime || 0) / 3600000);
  const totalM = Math.round(((s.totalTime || 0) % 3600000) / 60000);
  const totalLabel = totalH ? `${totalH} ч ${totalM} м` : `${Math.round((s.totalTime || 0) / 60000)} м`;

  const icon = id => `<div class="stat-icon"><svg class="ic" viewBox="0 0 24 24"><use href="#${id}"/></svg></div>`;
  $('#stats-grid').innerHTML = `
    <div class="stat-card wide">${icon('i-note')}<div class="stat-value">${s.totalPlayed || 0}</div><div class="stat-label">Треков прослушано</div></div>
    <div class="stat-card wide">${icon('i-clock')}<div class="stat-value">${totalLabel}</div><div class="stat-label">Общее время</div></div>
    <div class="stat-card">${icon('i-heart')}<div class="stat-value">${state.favorites.length}</div><div class="stat-label">Лайков</div></div>
    <div class="stat-card">${icon('i-folder')}<div class="stat-value">${state.playlists.length}</div><div class="stat-label">Плейлистов</div></div>
    <div class="stat-card">${icon('i-history')}<div class="stat-value">${state.history.length}</div><div class="stat-label">В истории</div></div>
    <div class="stat-card">${icon('i-queue')}<div class="stat-value">${state.queue.length}</div><div class="stat-label">В очереди</div></div>
    <div class="stat-card">${icon('i-flame')}<div class="stat-value">${sessionMin} м</div><div class="stat-label">Сессия</div></div>
    <div class="stat-card">${icon('i-wave')}<div class="stat-value">${state.currentTrack ? 'ON' : 'OFF'}</div><div class="stat-label">Сейчас играет</div></div>`;

  const top = topArtists();
  $('#top-artists').innerHTML = top.length ? top.map((a, i) => `
    <div class="artist-row" data-name="${escapeHtml(a.name)}" onclick="searchArtist(this.dataset.name)">
      <div class="artist-rank">${i + 1}</div>
      <div class="artist-name">${escapeHtml(a.name)}</div>
      <div class="artist-bar"><div class="artist-bar-fill" style="width:${a.pct}%"></div></div>
      <div class="artist-count">${a.count}</div>
    </div>`).join('')
    : `<div class="empty" style="grid-column:1/-1;padding:40px"><h3>Пока нет данных</h3><p>Слушай музыку — топ артистов появится здесь</p></div>`;

  renderHeatmap();
}

/* 🌊 Волна года: кинематографичное слайд-шоу по статистике */
function wrappedData() {
  const s = state.stats;
  const top = topArtists();
  const tc = new Map();
  state.history.forEach(t => { const k = t.title || '—'; tc.set(k, (tc.get(k) || 0) + 1); });
  const topTracks = [...tc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const totalH = Math.floor((s.totalTime || 0) / 3600000);
  const totalM = Math.round(((s.totalTime || 0) % 3600000) / 60000);
  const timeLabel = totalH ? totalH + ' ч ' + totalM + ' м' : Math.round((s.totalTime || 0) / 60000) + ' м';
  return { year: new Date().getFullYear(), played: s.totalPlayed || 0, timeLabel, top, topTracks,
    likes: state.favorites.length, playlists: state.playlists.length };
}

function openWrapped() {
  const d = wrappedData();
  const slides = [
    `<div class="wr-emoji">🌊</div><h1 class="grad-anim" style="font-size:clamp(40px,9vw,96px)">Волна года</h1><p class="wr-sub">${d.year} · VOLNA</p>`,
    `<div class="wr-big">${d.played}</div><p class="wr-sub">треков прослушано</p>`,
    `<div class="wr-big">${d.timeLabel}</div><p class="wr-sub">времени в волнах</p>`,
    d.top.length
      ? `<div class="wr-big grad-anim" style="font-size:clamp(28px,6vw,72px)">${escapeHtml(d.top[0].name)}</div><p class="wr-sub">твой артист года · ${d.top[0].count} проигрываний</p>`
      : `<div class="wr-emoji">🎧</div><p class="wr-sub">Слушай больше — и появится твой артист года</p>`,
    d.topTracks.length
      ? `<div class="wr-list">${d.topTracks.map(([t, c], i) =>
          `<div class="wr-row"><span class="wr-n">${i + 1}</span><span class="wr-t">${escapeHtml(t)}</span><span class="wr-c">×${c}</span></div>`).join('')}</div><p class="wr-sub">топ треков</p>`
      : `<div class="wr-emoji">🎶</div><p class="wr-sub">История пуста — включи первый трек</p>`,
    `<div class="wr-big">${d.likes}</div><p class="wr-sub">лайков · ${d.playlists} плейлистов</p>`,
    `<div class="wr-emoji">🌊</div><h1 class="grad-anim" style="font-size:clamp(40px,9vw,96px)">Слушай волну</h1><p class="wr-sub">VOLNA · с тобой каждый день</p>`
  ];
  window._wrSlides = slides;
  window._wrIdx = 0;
  renderWrapped();
  $('#wrapped').classList.add('show');
}

function renderWrapped() {
  const slides = window._wrSlides, idx = window._wrIdx;
  $('#wr-slide').innerHTML = slides[idx];
  $('#wr-dots').innerHTML = slides.map((_, i) => `<span class="wr-dot${i === idx ? ' on' : ''}"></span>`).join('');
}

function wrappedNav(d) {
  const n = (window._wrIdx + d + window._wrSlides.length) % window._wrSlides.length;
  window._wrIdx = n;
  renderWrapped();
}

function closeWrapped() { $('#wrapped').classList.remove('show'); }

document.addEventListener('keydown', e => {
  const w = $('#wrapped');
  if (!w || !w.classList.contains('show')) return;
  if (e.key === 'ArrowRight') wrappedNav(1);
  else if (e.key === 'ArrowLeft') wrappedNav(-1);
  else if (e.key === 'Escape') closeWrapped();
});

/* 🔗 импорт плейлиста SoundCloud по ссылке */
async function importPlaylistUrl() {
  const el = $('#pl-import-url');
  const url = (el ? el.value : '').trim();
  if (!url || !/soundcloud\.com/i.test(url)) { toast('Вставь ссылку на плейлист или сет SoundCloud', 'error'); return; }
  toast('🔗 Импортирую плейлист…');
  try {
    const cid = await ensureClientId();
    const data = await scJson('https://api-v2.soundcloud.com/resolve?url=' + encodeURIComponent(url) + '&client_id=' + cid);
    let tracks = (data && Array.isArray(data.tracks) ? data.tracks : []).map(normalizeTrack).filter(Boolean);
    // SoundCloud отдаёт в resolve первые ~5 треков — полный список добираем по tracks_uri
    if (data && data.tracks_uri && (data.track_count || tracks.length) > tracks.length) {
      const sep = data.tracks_uri.includes('?') ? '&' : '?';
      const full = await scJson(data.tracks_uri + sep + 'client_id=' + cid);
      const arr = Array.isArray(full) ? full : (Array.isArray(full && full.collection) ? full.collection : null);
      if (arr) tracks = arr.map(normalizeTrack).filter(Boolean);
    }
    if (data && data.kind === 'track' && data.id) tracks = [normalizeTrack(data)].filter(Boolean);
    if (!tracks.length) { toast('По ссылке не нашлось треков', 'error'); return; }
    tracks.forEach(t => rememberTrack(t));
    state.playlists.push({ id: Date.now(), name: data.title || 'Импорт', desc: '', tracks, createdAt: new Date().toISOString() });
    await persistPlaylists();
    updateBadges();
    if (el) el.value = '';
    if ($('#view-playlists')?.classList.contains('active')) renderPlaylists();
    toast('🔗 Импортировано: ' + (data.title || 'плейлист') + ' · ' + tracks.length + ' треков', 'success');
  } catch (e) {
    toast('Не вышло импортировать: ' + (e && e.message || 'сеть'), 'error');
  }
}

/* heatmap активности за 14 недель (по истории) */
function renderHeatmap() {
  const el = $('#heatmap');
  if (!el) return;
  const counts = {};
  state.history.forEach(h => {
    if (!h.playedAt) return;
    const k = new Date(h.playedAt).toLocaleDateString('sv');
    counts[k] = (counts[k] || 0) + 1;
  });
  const cells = [];
  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - 13 * 7 - today.getDay() + 1);
  for (let i = 0; i < 14 * 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const k = d.toLocaleDateString('sv');
    const c = counts[k] || 0;
    const lvl = c === 0 ? 0 : c < 2 ? 1 : c < 4 ? 2 : c < 7 ? 3 : 4;
    cells.push(`<div class="hm-cell lvl${lvl}" title="${k}: ${c} прослушиваний"></div>`);
  }
  el.innerHTML = cells.join('');
}

function searchArtist(name) {
  switchView('discover');
  $('#search-input').value = name;
  doSearch(name);
}

async function resetStats() {
  if (!confirm('Сбросить статистику?')) return;
  if (ipc) { try { state.stats = await ipc.invoke('stats:reset'); } catch (_) {} }
  else state.stats = { totalPlayed: 0, totalTime: 0, sessionStart: Date.now() };
  renderStats();
  toast('Статистика сброшена');
}

/* ---------- backup / wipe ---------- */
async function exportFullBackup() {
  if (!ipc) { toast('Доступно только в приложении', 'error'); return; }
  const r = await ipc.invoke('dialog:exportAll').catch(() => null);
  if (r?.ok) toast('📦 Backup сохранён', 'success');
  else if (r && !r.ok && r.error) toast('Ошибка: ' + r.error, 'error');
}

async function importFullBackup() {
  if (!ipc) { toast('Доступно только в приложении', 'error'); return; }
  const r = await ipc.invoke('dialog:importAll').catch(() => null);
  if (r?.ok) {
    toast('📦 Восстановлено! Перезагрузка…', 'success');
    setTimeout(() => location.reload(), 900);
  } else if (r && !r.ok && r.error) {
    toast('Ошибка: ' + r.error, 'error');
  }
}

async function wipeAll() {
  if (!confirm('Точно стереть ВСЕ данные (лайки, историю, плейлисты, статистику)?')) return;
  if (!confirm('Отменить это будет нельзя. Стираем?')) return;
  if (ipc) {
    try {
      await ipc.invoke('favorites:clear');
      await ipc.invoke('history:clear');
      await ipc.invoke('playlists:save', []);
      await ipc.invoke('stats:reset');
      await ipc.invoke('store:set', 'recentSearches', []);
    } catch (_) {}
  } else {
    lsSet('favorites', []); lsSet('history', []); lsSet('playlists', []);
    lsSet('stats', { totalPlayed: 0, totalTime: 0, sessionStart: Date.now() });
    lsSet('recentSearches', []);
  }
  toast('Всё стёрто. Перезагрузка…', 'success');
  setTimeout(() => location.reload(), 900);
}

/* ---------- Антиблок: прокси + диагностика ---------- */
async function applyProxySetting() {
  const v = $('#set-proxy').value.trim();
  if (!ipc) { toast('Доступно только в приложении', 'error'); return; }
  const scOnly = $('#set-scproxy') ? $('#set-scproxy').checked : true;
  const r = await ipc.invoke('antiblock:proxy', v, { scOnly }).catch(e => ({ ok: false, error: e.message }));
  if (r?.ok) {
    state.settings.antiblock = { ...(state.settings.antiblock || {}), proxy: v };
    toast(v ? '🛡 Прокси применён' : 'Прокси выключен — трафик напрямую', 'success');
    testNetwork();
  } else {
    toast('Ошибка: ' + (r?.error || 'не удалось применить'), 'error');
  }
}

async function testNetwork() {
  const box = $('#net-diagnostics');
  if (!box) return;
  if (!ipc) { toast('Доступно только в приложении', 'error'); return; }
  box.innerHTML = '<div style="color:var(--dim);font-size:13px;padding:6px 0">Проверяем…</div>';
  const r = await ipc.invoke('antiblock:nettest').catch(() => null);
  if (!r) { box.innerHTML = '<div class="diag-row diag-bad"><span>Диагностика не удалась</span></div>'; return; }
  const bypassRow = (r.bypass && r.bypass.length)
    ? '<div class="diag-row"><span style="flex:1">🛡 Системный обход: ' + r.bypass.map(escapeHtml).join(', ') + '</span><span class="diag-ok">встроенные средства не конфликтуют</span></div>'
    : '';
  box.innerHTML = r.results.map(x => `
    <div class="diag-row">
      <span class="${x.ok ? 'diag-ok' : 'diag-bad'}">${x.ok ? '●' : '⛔'}</span>
      <span style="flex:1">${escapeHtml(x.host)}</span>
      <span style="color:var(--muted)">${x.ok ? x.ms + ' мс' : 'блок / таймаут'}</span>
    </div>`).join('') +
    bypassRow +
    `<div class="diag-row" style="margin-top:6px"><span style="flex:1;color:var(--dim)">Итог</span>
     <span class="${r.allOk ? 'diag-ok' : 'diag-bad'}">${r.allOk ? 'всё доступно напрямую ✓' : 'есть блокировки — нужен прокси или Запрет2'}</span></div>`;
}

/* ---------- Аккаунт SoundCloud ---------- */
function scLogout() {
  state.scAuth = null;
  saveSetting('scAuth', null);
  state.favSource = 'local';
  renderAuthStatus();
  if ($('#view-favorites')?.classList.contains('active')) renderFavorites();
  toast('Вышел из аккаунта SoundCloud');
}

function renderAuthStatus() {
  const box = $('#sc-auth-status');
  if (!box) return;
  const a = state.scAuth;
  if (a?.user) {
    const name = a.user.username || 'Профиль SoundCloud';
    const ava = a.user.avatar_url || '';
    const sub = a.user.followers != null ? fmtCount(a.user.followers) + ' подписчиков' : 'вход выполнен ✓';
    box.innerHTML = `
      <div class="ac-user">
        ${ava ? `<img src="${escapeHtml(ava)}" alt="" onerror="this.style.display='none'">` : '<div class="ac-ava-ph">♪</div>'}
        <div class="ac-name"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(sub)}</span></div>
      </div>
      <div class="ac-actions">
        <button class="ac-btn ${state.favSource === 'server' ? 'active' : ''}" onclick="serverLikesToggle()" id="btn-server-likes">☁ ${state.favSource === 'server' ? 'Локальные лайки' : 'Лайки с сервера'}</button>
        <button class="ac-btn ghost" onclick="scRefresh()">⟳ Профиль</button>
        <button class="ac-btn ghost" onclick="scImportPlaylists()">⤵ Импорт плейлистов</button>
        <button class="ac-btn ghost" onclick="scLogout()">Выйти</button>
      </div>`;
  } else if (tokenPasteMode) {
    box.innerHTML = `
      <div class="ac-hint">
        <strong>Как достать токен:</strong> зайди на soundcloud.com в обычном браузере (при блокировках — VPN на время входа), войди, затем
        <strong>F12 → Хранилище → Куки → soundcloud.com</strong> и скопируй значение куки <strong>oauth_token</strong>. Вставь сюда — VPN больше не нужен.
      </div>
      <input type="text" id="paste-token" placeholder="oauth_token с сайта…" class="ac-token-input">
      <div class="ac-actions">
        <button class="ac-btn primary" onclick="scTokenSave()">Проверить и войти</button>
        <button class="ac-btn ghost" onclick="tokenPasteMode = false; renderAuthStatus();">Отмена</button>
      </div>`;
  } else {
    box.innerHTML = `
      <button class="ac-btn primary ac-full" onclick="tokenPasteMode = true; renderAuthStatus();" title="Надёжно из РФ: oauth_token из браузера">
        <svg class="ic" viewBox="0 0 24 24"><use href="#i-user"/></svg>Войти по токену
      </button>
      <button class="ac-btn ghost ac-full" onclick="scLogin()" title="Вход через окно SoundCloud — из РФ может зациклиться на проверке устройства">
        <svg class="ic" viewBox="0 0 24 24"><use href="#i-external"/></svg>Через окно сайта
      </button>`;
  }
}

let tokenPasteMode = false;

async function scTokenSave() {
  const t = $('#paste-token')?.value.trim();
  if (!t) { toast('Вставь токен', 'error'); return; }
  const cid = await ensureClientId().catch(() => null);
  if (!cid) { toast('Нет client_id', 'error'); return; }
  toast('Проверяю токен…');
  try {
    const me = JSON.parse(await scRaw(`${SC_API2}/me?client_id=${cid}`, { auth: true, token: t }));
    if (!me?.username) throw new Error('пустой профиль');
    state.scAuth = { mode: 'token', token: t, user: { username: me.username, avatar_url: me.avatar_url, followers: me.followers_count } };
    await saveSetting('scAuth', state.scAuth);
    renderAuthStatus();
    toast('👋 Привет, ' + (me.username || 'музыкант'), 'success');
    loadServerLikes(true);
  } catch (_) {
    toast('Токен не подошёл — проверь, что скопировал значение oauth_token целиком', 'error');
  }
}

/* вход: окно с сайтом, куки сессии авторизуют все запросы */
async function scLogin() {
  if (!ipc) { toast('Доступно только в приложении', 'error'); return; }
  toast('Открываю окно входа…');
  let cid;
  try { cid = await ensureClientId(); } catch (_) { toast('Нет client_id — проверь сеть', 'error'); return; }
  const r = await ipc.invoke('auth:login', cid).catch(e => ({ ok: false, error: e.message }));
  if (!r) return;
  if (!r.ok) { toast('Вход не завершён: ' + (r.error || 'неизвестно')); return; }
  state.scAuth = { user: { username: r.me.username, avatar_url: r.me.avatar_url, followers: r.me.followers_count } };
  await saveSetting('scAuth', state.scAuth);
  renderAuthStatus();
  toast('👋 Привет, ' + (r.me.username || 'музыкант'), 'success');
  loadServerLikes(true);
}

/* обновить профиль (имя/аватарка/подписчики) */
async function scRefresh() {
  if (!state.scAuth) return;
  toast('⟳ Обновляю профиль…');
  try {
    const me = JSON.parse(await scRaw(`${SC_API2}/me?client_id=${await ensureClientId()}`, { auth: true }));
    if (!me?.username) throw new Error('пустой профиль');
    state.scAuth.user = { username: me.username, avatar_url: me.avatar_url, followers: me.followers_count };
    await saveSetting('scAuth', state.scAuth);
    renderAuthStatus();
    toast('👋 ' + me.username, 'success');
  } catch (e) {
    const msg = String(e?.message || '');
    toast(msg.includes('401') ? 'Токен устарел — войди заново' : 'Не удалось обновить профиль', 'error');
  }
}

/* импорт плейлистов SoundCloud в локальные (с догрузкой полных треков) */
async function scImportPlaylists() {
  if (!state.scAuth) { toast('Сначала войди', 'error'); return; }
  toast('⤵ Загружаю плейлисты…');
  try {
    const cid = await ensureClientId();
    const data = await scJson(`${SC_API2}/me/playlists?client_id=${cid}&limit=50`, { auth: true });
    const pls = Array.isArray(data?.collection) ? data.collection : [];
    let imported = 0;
    for (const pl of pls) {
      if (!pl || !pl.title || state.playlists.some(p => p.name === pl.title)) continue;
      try {
        const full = await scJson(`${SC_API2}/playlists/${pl.id}?client_id=${cid}`, { auth: true });
        const inline = Array.isArray(full?.tracks) ? full.tracks : [];
        const fullTracks = inline.filter(t => t && t.permalink_url && t.streamable !== false);
        const stubIds = inline.filter(t => t && !t.permalink_url && t.id != null).map(t => t.id);
        for (let i = 0; i < stubIds.length; i += 50) {
          try {
            const resp = await scJson(`${SC_API2}/tracks?ids=${stubIds.slice(i, i + 50).join(',')}&client_id=${cid}`);
            (Array.isArray(resp) ? resp : []).forEach(t => { if (t) fullTracks.push(t); });
          } catch (_) {}
        }
        const items = fullTracks.map(normalizeTrack).filter(Boolean);
        items.forEach(rememberTrack);
        state.playlists.push({
          id: Date.now() + imported, name: full?.title || pl.title,
          desc: 'Импорт из SoundCloud · ' + new Date().toLocaleDateString('ru-RU'),
          tracks: items, createdAt: new Date().toISOString()
        });
        imported++;
      } catch (_) {}
    }
    await persistPlaylists();
    updateBadges();
    if ($('#view-playlists')?.classList.contains('active')) renderPlaylists();
    toast(imported ? `☁️ Импортировано плейлистов: ${imported}` : 'Новых плейлистов нет (или уже импортированы)', imported ? 'success' : '');
  } catch (e) {
    const msg = String(e?.message || '');
    toast(msg.includes('401') ? 'Токен устарел — войди заново' : 'Импорт не удался — проверь сеть', 'error');
  }
}

/* лайк-зеркало: ставим/снимаем лайк и на SoundCloud */
async function mirrorLikeToServer(track, liked) {
  if (!state.scAuth || !track?.id) return;
  try {
    const cid = await ensureClientId();
    const method = liked ? 'PUT' : 'DELETE';
    await scRaw(`${SC_API2}/me/likes/${track.id}?client_id=${cid}`, { method, auth: true });
    toast(liked ? '☁️ Лайк ушёл на SoundCloud' : '☁️ Лайк снят на SoundCloud');
  } catch (_) {
    toast('⚠️ Не удалось синхронизировать лайк с SoundCloud', 'error');
  }
}

/* серверные лайки */
async function loadServerLikes(silent) {
  if (!state.scAuth) { toast('Сначала войди в аккаунт', 'error'); return; }
  if (!silent) { switchView('favorites'); updateFavSourceBtn(); }
  state.favSource = 'server';
  const grid = $('#favorites-list');
  if (!silent) grid.innerHTML = Array(8).fill('<div class="skeleton"></div>').join('');
  try {
    const cid = await ensureClientId();
    state.serverLikes = [];
    let url = `${SC_API2}/me/likes/tracks?client_id=${cid}&limit=50`;
    for (let page = 0; page < 30 && url; page++) {
      const data = await scJson(url, { auth: true });
      (Array.isArray(data?.collection) ? data.collection : []).forEach(item => {
        const t = normalizeTrack(item);
        if (t) { rememberTrack(t); state.serverLikes.push(t); }
      });
      url = data?.next_href || null;
    }
    renderFavorites();
    if (!silent) toast('☁️ Загружено: ' + state.serverLikes.length, 'success');
  } catch (err) {
    const msg = String(err?.message || '');
    if (msg.includes('401')) {
      state.scAuth = null; saveSetting('scAuth', null); renderAuthStatus();
      if (!silent) grid.innerHTML = emptyHTML('i-alert', 'Токен устарел', 'Войди заново — «Войти по токену» в плашке Аккаунт');
      else toast('Токен устарел — войди заново', 'error');
    } else if (!silent) {
      grid.innerHTML = emptyHTML('i-alert', 'Не удалось загрузить', escapeHtml(msg) + ' — проверь сеть и Антиблок');
    }
  }
}

function serverLikesToggle() {
  if (!state.scAuth) { toast('Сначала войди в аккаунт', 'error'); return; }
  if (state.favSource === 'server') { state.favSource = 'local'; updateFavSourceBtn(); renderFavorites(); return; }
  loadServerLikes();
}

function toggleFavSource() {
  state.favSource = state.favSource === 'local' ? 'server' : 'local';
  updateFavSourceBtn();
  renderFavorites();
}

function updateFavSourceBtn() {
  renderAuthStatus(); // кнопка живёт в плашке аккаунта
}

/* ---------- проверка обновлений (GitHub Releases) ---------- */
function compareSemver(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

async function checkUpdate(manual) {
  if (!ipc) return;
  try {
    const r = await ipc.invoke('app:check-update');
    if (!r.ok) { if (manual) toast('Не удалось проверить обновления', 'error'); return; }
    if (compareSemver(r.latest, r.current) > 0) {
      toast(`📦 Доступна VOLNA v${r.latest} (у тебя v${r.current}) — открываю релиз`, 'success');
      await ipc.invoke('shell:openExternal', r.assetUrl || r.url).catch(() => {});
    } else if (manual) {
      toast(`✓ У тебя последняя версия v${r.current}`, 'success');
    }
  } catch (_) { if (manual) toast('Не удалось проверить обновления', 'error'); }
}

/* ---------- о приложении ---------- */
async function fillAbout() {
  let v = { version: '7.4.3', electron: '—', chrome: '—', node: '—', platform: 'browser' };
  if (ipc) { try { v = { ...v, ...(await ipc.invoke('app:version')) }; } catch (_) {} }
  $('#about-info').innerHTML = `
    <strong>VOLNA</strong> v${escapeHtml(String(v.version))}<br>
    Electron ${escapeHtml(String(v.electron))} · Chromium ${escapeHtml(String(v.chrome))} · Node ${escapeHtml(String(v.node))}<br>
    Платформа: ${escapeHtml(String(v.platform))}<br><br>
    Музыка: <strong>SoundCloud API + Widget</strong><br>
    Волны, темы и караоке — сделано с любовью к звуку<br><br>
    <span style="opacity:.6">Сделано с ❤️ и 🎧</span>`;
}
