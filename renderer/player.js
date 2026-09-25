/* ============================================================
   VOLNA · player.js — SoundCloud widget, воспроизведение,
   очередь (drag & drop), sleep timer, radio, визуализатор, mini
   ============================================================ */
'use strict';

/* ---------- списки для плеера ---------- */
function resolveList(key) {
  switch (key) {
    case 'search': return state.visibleTracks;
    case 'trending': return state.trending;
    case 'fav': return state.favoritesView || state.favorites;   // рендер-список (сортировка/фильтр)
    case 'hist': return state.history;
    case 'queue': return state.queue;
    case 'pl': return state.currentPlaylistTracks;
    case 'sv': return state.serverLikesView || state.serverLikes;
    case 'foryou': return state.foryouTracks;
    default: return null;
  }
}

function currentTrack() { return state.currentTrack; }

function playFromCard(card) {
  const list = resolveList(card.dataset.list);
  const idx = +card.dataset.idx;
  if (!list || !list[idx]) return;
  playTrack(list[idx], card.dataset.list);
}

/* ---------- widget ---------- */
function initPlayer() {
  initWidget();
  bindPlayerControls();
  bindQueueDnD();
  startVizLoop();
}

let widgetRetries = 0;
function initWidget() {
  if (typeof SC === 'undefined') {
    if (++widgetRetries > 75) { console.warn('SC widget API not loaded'); return; }
    setTimeout(initWidget, 400);
    return;
  }
  try {
    const iframe = $('#sc-widget');
    state.widget = SC.Widget(iframe);
    state.widget.bind(SC.Widget.Events.PLAY, () => { state.isPlaying = true; updatePlayIcon(); setPowerSave(true); updateTitle(); });
    state.widget.bind(SC.Widget.Events.PAUSE, () => { state.isPlaying = false; updatePlayIcon(); setPowerSave(false); updateTitle(); });
    state.widget.bind(SC.Widget.Events.FINISH, () => {
      if (state.repeat) { state.widget.seekTo(0); state.widget.play(); }
      else playNext();
    });
    console.info('[SC] widget: ready');
  } catch (e) {
    // пересоздание iframe может понадобиться, если api.js успел раньше DOM
    console.warn('SC widget init failed, retrying', e);
    if (++widgetRetries <= 75) setTimeout(initWidget, 400);
  }
  if (!initWidget._pollStarted) {
    initWidget._pollStarted = true;
    setInterval(updateProgressUI, 250);
  }
}

function bindMediaKeys() {
  if (!ipc) return;
  try {
    ipc.on('media:toggle', togglePlay);
    ipc.on('media:next', playNext);
    ipc.on('media:prev', playPrev);
    ipc.on('media:stop', () => state.widget?.pause());
  } catch (_) {}
}

function setPowerSave(on) {
  if (!ipc) return;
  if (on && state.settings.keepAwake === false) return; // разрешаем экрану гаснуть
  ipc.invoke(on ? 'powerSave:enable' : 'powerSave:disable').catch(() => {});
}

/* ---------- воспроизведение ---------- */
function playTrack(track, listKey = null) {
  if (!track || !track.permalink_url) { toast('Трек недоступен', 'error'); return; }
  rememberTrack(track);

  const list = listKey ? resolveList(listKey) : null;
  if (list && list.length) state.currentIdx = Math.max(0, list.findIndex(t => t.id === track.id));
  else { state.currentIdx = 0; listKey = 'single'; }
  state.currentListKey = listKey;
  state.currentTrack = track;

  $('#player-title').textContent = track.title;
  $('#player-artist').textContent = track.user?.username || '—';
  $('#mini-title').textContent = track.title;
  const art = artwork(track);
  if (art) $('#player-cover').src = art;
  // ambient: размытая обложка светится фоном за плеером
  $('#player').style.setProperty('--ambient', art ? `url(${art})` : 'none');
  $('#player').classList.toggle('no-ambient', !art);
  $('#time-dur').textContent = formatTime((track.duration || 0) / 1000);
  $('#progress').style.width = '0%';
  $('#time-cur').textContent = '0:00';
  $('#player').classList.add('active');

  if (!state.widget) { toast('Плеер ещё загружается…', 'error'); return; }
  try {
    state.widget.load(track.permalink_url, {
      auto_play: true,
      show_artwork: false,
      callback: () => applyVolume()
    });
  } catch (e) { toast('Не удалось запустить трек', 'error'); return; }

  addHistory(track);
  bumpStats(track);
  highlightPlaying();
  updateTitle();
  loadLyrics(track); // караоке-текст
}

/* заголовок окна = now playing */
function updateTitle() {
  const t = state.currentTrack;
  document.title = t ? (state.isPlaying ? '▶ ' : '⏸ ') + t.title + ' — VOLNA' : 'VOLNA';
  // трей: название трека в меню и тултипе
  if (ipc) {
    ipc.invoke('tray:nowplaying', t
      ? { title: t.title, artist: t.user?.username || '', isPlaying: state.isPlaying }
      : null).catch(() => {});
  }
  if (typeof updateMascot === 'function') updateMascot();
}

function togglePlay() {
  if (!state.currentTrack) { toast('Сначала выбери трек'); return; }
  if (!state.widget) return;
  try {
    if (state.isPlaying) state.widget.pause();
    else state.widget.play();
  } catch (_) {}
}

function updatePlayIcon() {
  const ref = state.isPlaying ? '#i-pause' : '#i-play';
  ['#play-icon', '#mini-play-icon'].forEach(id => {
    const u = $(id);
    if (u) u.setAttribute('href', ref);
  });
}

function playNext() {
  let list = resolveList(state.currentListKey);
  if ((!list || !list.length) && state.queue.length) {
    list = state.queue;
    state.currentListKey = 'queue';
  }
  if (!list || !list.length) { toast('Очередь закончилась'); return; }
  if (state.currentListKey !== 'queue' || state.currentIdx < 0 || list[state.currentIdx]?.id !== state.currentTrack?.id) {
    state.currentIdx = Math.max(0, list.findIndex(t => t.id === state.currentTrack?.id));
  }
  let idx;
  if (state.shuffle && list.length > 1) {
    do { idx = Math.floor(Math.random() * list.length); } while (idx === state.currentIdx);
  } else {
    idx = state.currentIdx + 1;
    if (idx >= list.length) idx = 0;
  }
  playTrack(list[idx], state.currentListKey);
}

function playPrev() {
  const list = resolveList(state.currentListKey);
  if (!list || !list.length) { toast('Очередь пуста'); return; }
  let idx = state.currentIdx - 1;
  if (idx < 0) idx = list.length - 1;
  playTrack(list[idx], state.currentListKey);
}

function toggleShuffle() {
  state.shuffle = !state.shuffle;
  $('#btn-shuffle')?.classList.toggle('active', state.shuffle);
  toast(state.shuffle ? '🔀 Shuffle: ON' : 'Shuffle: OFF');
}

function toggleRepeat() {
  state.repeat = !state.repeat;
  $('#btn-repeat')?.classList.toggle('active', state.repeat);
  toast(state.repeat ? '🔁 Repeat: ON' : 'Repeat: OFF');
}

function seekBy(ms) {
  if (!state.widget || !state.currentTrack) return;
  state.widget.getPosition(pos => state.widget.seekTo(Math.max(0, pos + ms)));
}

/* ---------- прогресс и громкость ---------- */
let seekDragging = false;
function updateProgressUI() {
  if (!state.widget || !state.currentTrack) return;
  state.widget.getPosition(pos => {
    state.widget.getDuration(dur => {
      if (!dur) return;
      if (!seekDragging) $('#progress').style.width = (pos / dur * 100) + '%';
      $('#time-cur').textContent = formatTime(pos / 1000);
      const durEl = $('#time-dur');
      if (durEl.textContent === '0:00') durEl.textContent = formatTime(dur / 1000);
      if (typeof updateLyricsSync === 'function') updateLyricsSync(pos);
    });
  });
}

function bindPlayerControls() {
  const bar = $('#progress-wrap'), fill = $('#progress');
  let seeking = false;
  const pctOf = e => {
    const r = bar.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  bar.addEventListener('pointerdown', e => {
    if (!state.widget) return;
    seeking = true; seekDragging = true;
    bar.setPointerCapture(e.pointerId);
    fill.style.width = pctOf(e) * 100 + '%';
  });
  bar.addEventListener('pointermove', e => { if (seeking) fill.style.width = pctOf(e) * 100 + '%'; });
  bar.addEventListener('pointerup', e => {
    if (!seeking) return;
    seeking = false; seekDragging = false;
    const pct = pctOf(e);
    state.widget.getDuration(dur => { if (dur) state.widget.seekTo(pct * dur); });
  });

  // тултип с временем при наведении на прогресс-бар
  const tip = $('#seek-tip');
  if (tip) {
    bar.addEventListener('pointermove', e => {
      const r = bar.getBoundingClientRect();
      tip.style.left = Math.min(Math.max(e.clientX - r.left, 26), r.width - 26) + 'px';
      tip.textContent = formatTime(pctOf(e) * (state.currentTrack?.duration || 0) / 1000);
    });
    bar.addEventListener('pointerenter', () => tip.classList.add('show'));
    bar.addEventListener('pointerleave', () => tip.classList.remove('show'));
  }

  const slider = $('#vol-slider'), volFill = $('#vol-fill');
  const volOf = e => {
    const r = slider.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  slider.addEventListener('pointerdown', e => { slider.setPointerCapture(e.pointerId); setVolume(volOf(e)); });
  slider.addEventListener('pointermove', e => { if (e.buttons) setVolume(volOf(e)); });
}

function setVolume(v) {
  state.volume = Math.min(1, Math.max(0, v));
  state.muted = false;
  applyVolume();
}
function nudgeVolume(d) { setVolume(state.volume + d); }

function applyVolume() {
  const v = state.muted ? 0 : state.volume;
  $('#vol-fill').style.width = v * 100 + '%';
  try { state.widget?.setVolume(v * 100); } catch (_) {}
  updateVolumeIcon();
}

function toggleMute() {
  state.muted = !state.muted;
  applyVolume();
}

function updateVolumeIcon() {
  const u = $('#vol-icon');
  if (!u) return;
  u.setAttribute('href', (state.muted || state.volume === 0) ? '#i-volume-off' : '#i-volume');
}

/* ---------- подсветка играющего трека ---------- */
function highlightPlaying() {
  const id = state.currentTrack?.id;
  $$('.track-card').forEach(c => c.classList.toggle('playing', id != null && +c.dataset.id === id));
  $$('.queue-item').forEach(c =>
    c.classList.toggle('current', state.currentListKey === 'queue' && +c.dataset.idx === state.currentIdx));
}

/* ---------- очередь ---------- */
function addToQueue(track) {
  if (!track) return;
  if (state.queue.some(t => t.id === track.id)) { toast('Уже в очереди'); return; }
  state.queue.push(track);
  updateBadges(); renderQueue();
  toast('📋 В очереди', 'success');
}

/* тулбар результатов: добавить всё найденное в очередь */
function addToQueueAll() {
  const list = state.visibleTracks.length ? state.visibleTracks : state.tracks;
  if (!list.length) { toast('Нечего добавлять', 'error'); return; }
  let added = 0;
  for (const t of list) {
    if (state.queue.length >= 200) break;
    if (!state.queue.some(q => q.id === t.id)) { state.queue.push(t); rememberTrack(t); added++; }
  }
  updateBadges(); renderQueue();
  toast(added ? `📋 В очереди: +${added}` : 'Всё уже в очереди', added ? 'success' : '');
}

/* тулбар результатов: играть всё с первого трека */
function playAllResults() {
  const list = state.visibleTracks.length ? state.visibleTracks : state.tracks;
  if (!list.length) { toast('Нечего играть', 'error'); return; }
  playTrack(list[0], state.visibleTracks.length ? 'search' : null);
}

/* «Играть следующим»: сразу после текущего трека */
function playNextInQueue(track) {
  if (!track) return;
  if (state.queue.some(t => t.id === track.id)) { toast('Уже в очереди'); return; }
  if (state.currentListKey === 'queue' && state.currentIdx >= 0) {
    state.queue.splice(state.currentIdx + 1, 0, track);
  } else {
    state.queue.unshift(track);
  }
  updateBadges(); renderQueue(); highlightPlaying();
  toast('▶ Следующим: ' + (track.title || ''), 'success');
}

function playFromQueue(idx) {
  if (!state.queue[idx]) return;
  playTrack(state.queue[idx], 'queue');
}

function removeFromQueue(idx) {
  const wasCurrent = state.currentListKey === 'queue' && state.currentIdx === idx;
  state.queue.splice(idx, 1);
  if (wasCurrent) { state.currentListKey = null; state.currentIdx = -1; }
  else if (state.currentListKey === 'queue' && state.currentIdx > idx) state.currentIdx--;
  updateBadges(); renderQueue(); highlightPlaying();
}

function shuffleQueue() {
  if (state.queue.length < 2) return;
  for (let i = state.queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
  }
  renderQueue(); highlightPlaying();
  toast('🔀 Очередь перемешана');
}

function clearQueue() {
  state.queue = [];
  if (state.currentListKey === 'queue') { state.currentListKey = null; state.currentIdx = -1; }
  updateBadges(); renderQueue(); highlightPlaying();
  toast('Очередь очищена');
}

function renderQueue() {
  const listEl = $('#queue-list');
  if (!listEl) return;
  $('#queue-count').textContent = state.queue.length;
  if (!state.queue.length) {
    listEl.innerHTML = emptyHTML('i-queue', 'Очередь пуста', 'Добавь треки из поиска («В очередь») или включи Radio');
    return;
  }
  listEl.innerHTML = state.queue.map((t, i) => `
    <div class="queue-item ${state.currentListKey === 'queue' && state.currentIdx === i ? 'current' : ''}"
      draggable="true" data-idx="${i}">
      <img src="${escapeHtml(artwork(t))}" alt="" loading="lazy" onerror="this.style.opacity=0">
      <div class="queue-item-info">
        <div class="queue-item-title">${escapeHtml(t.title)}</div>
        <div class="queue-item-artist">${escapeHtml(t.user?.username || '—')}</div>
      </div>
      <div class="queue-item-actions">
        <button class="queue-btn" title="Играть" onclick="playFromQueue(${i})"><svg class="ic sm fill" viewBox="0 0 24 24"><use href="#i-play"/></svg></button>
        <button class="queue-btn" title="Убрать" onclick="removeFromQueue(${i})"><svg class="ic sm" viewBox="0 0 24 24"><use href="#i-close"/></svg></button>
      </div>
    </div>`).join('');
}

function bindQueueDnD() {
  const listEl = $('#queue-list');
  let dragIdx = -1;
  listEl.addEventListener('dragstart', e => {
    const item = e.target.closest('.queue-item');
    if (!item) return;
    dragIdx = +item.dataset.idx;
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(dragIdx)); } catch (_) {}
  });
  listEl.addEventListener('dragend', () => {
    $$('.queue-item').forEach(x => x.classList.remove('dragging', 'drop-target'));
  });
  listEl.addEventListener('dragover', e => {
    e.preventDefault();
    const item = e.target.closest('.queue-item');
    if (!item) return;
    $$('.queue-item').forEach(x => x.classList.remove('drop-target'));
    item.classList.add('drop-target');
  });
  listEl.addEventListener('drop', e => {
    e.preventDefault();
    const item = e.target.closest('.queue-item');
    if (!item || dragIdx < 0) return;
    const to = +item.dataset.idx;
    if (to !== dragIdx) {
      const [moved] = state.queue.splice(dragIdx, 1);
      state.queue.splice(to, 0, moved);
      renderQueue(); highlightPlaying();
    }
    dragIdx = -1;
  });
}

/* ---------- radio ---------- */
async function enableRadio() {
  const cur = state.currentTrack;
  if (!cur) { toast('Сначала включи трек', 'error'); return; }
  const q = cur.user?.username || cur.genre || 'lofi';
  toast('📻 Ищем похожие треки…');
  try {
    const cid = await ensureClientId();
    const data = await scJson(
      `${SC_API2}/search/tracks?q=${encodeURIComponent(q)}&client_id=${cid}&limit=50`
    );
    const similar = (Array.isArray(data?.collection) ? data.collection : [])
      .map(normalizeTrack)
      .filter(t => t && t.id !== cur.id);
    if (!similar.length) { toast('Похожие треки не найдены', 'error'); return; }
    similar.forEach(rememberTrack);
    state.queue = similar;
    updateBadges(); renderQueue();
    playTrack(similar[0], 'queue');
    toast(`📻 Radio: ${similar.length} треков`, 'success');
  } catch (_) { toast('Radio: ошибка сети', 'error'); }
}

/* ---------- mini player ---------- */
function toggleMiniPlayer() {
  state.mini = !state.mini;
  $('#player').classList.toggle('mini', state.mini);
  toast(state.mini ? '📱 Mini player: ON' : 'Mini player: OFF');
}

/* ---------- sleep timer ---------- */
function setSleepTimer() {
  const mins = parseInt($('#sleep-duration').value, 10);
  if (state.sleepTimer) { clearInterval(state.sleepTimer); state.sleepTimer = null; }
  const chip = $('#sleep-timer');
  if (!mins) {
    state.sleepEnd = 0;
    chip.classList.remove('active');
    toast('Sleep timer выключен');
    closeModal('sleep_modal');
    return;
  }
  state.sleepEnd = Date.now() + mins * 60000;
  chip.classList.add('active');
  state.sleepTimer = setInterval(() => {
    const left = state.sleepEnd - Date.now();
    if (left <= 0) {
      clearInterval(state.sleepTimer);
      state.sleepTimer = null;
      chip.classList.remove('active');
      fadeOutStop();
    } else {
      $('#sleep-countdown').textContent = formatTime(left / 1000);
    }
  }, 1000);
  toast(`😴 Sleep timer: ${mins} мин`, 'success');
  closeModal('sleep_modal');
}

/* мягкое затухание громкости перед паузой */
function fadeOutStop() {
  if (!state.widget) return;
  toast('😴 Мягко гасим волну…');
  const steps = 40;
  let i = 0;
  const startVol = state.muted ? 0 : state.volume;
  const timer = setInterval(() => {
    i++;
    try { state.widget.setVolume(Math.max(0, startVol * (1 - i / steps) * 100)); } catch (_) {}
    if (i >= steps) {
      clearInterval(timer);
      state.widget.pause();
      setPowerSave(false);
      applyVolume();
      toast('😴 Sleep timer: пауза');
    }
  }, 100);
}

/* ---------- визуализатор ---------- */
function hexToRgb(hex) {
  const m = (hex || '').trim().match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 85, 0];
}

function startVizLoop() {
  const canvas = $('#viz');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  setInterval(() => {
    const W = canvas.width, H = canvas.height, cx = W / 2, cy = H / 2;
    ctx.clearRect(0, 0, W, H);
    if (!state.isPlaying) return;
    const [r, g, b] = hexToRgb(getComputedStyle(document.body).getPropertyValue('--accent'));
    const bars = 36;
    for (let i = 0; i < bars; i++) {
      const v = .25 + Math.random() * .75;
      const a = (i / bars) * Math.PI * 2;
      const rad = 38, rad2 = rad + v * 12;
      ctx.strokeStyle = `rgba(${r},${g},${b},${.25 + v * .6})`;
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
      ctx.lineTo(cx + Math.cos(a) * rad2, cy + Math.sin(a) * rad2);
      ctx.stroke();
    }
  }, 80);
}
