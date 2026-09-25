/* ========== CONFIG ========== */
const CLIENT_ID = 'aZ6mnwUlJJ4dHFrYaMG3f5flyhORR3Wy';
const SC_API = 'https://api.soundcloud.com';
const ITUNES = 'https://itunes.apple.com/search';
const DOTA_API = 'https://api.opendota.com/api/heroes';
const STEAM_CDN = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes';

/* ========== DOTA QUOTES ========== */
const HERO_QUOTES = {
  'Invoker': 'I am a beacon of knowledge in a dark world.',
  'Pudge': 'Fresh meat!',
  'Crystal Maiden': 'Ice and wisdom, combined.',
  'Juggernaut': 'No one can challenge the Juggernaut!',
  'Axe': 'Axe has no time for nonsense!',
  'Shadow Fiend': 'Your soul is mine.',
  'Phantom Assassin': 'Only those who know death may know eternity.',
  'Anti-Mage': 'Magic is a disease, and I am the cure.',
  'Sniper': 'I aim, I shoot, I win.',
  'Tidehunter': 'Time and tide wait for no man.',
  'Drow Ranger': 'Silence in the forest.',
  'Techies': 'Boom goes the dynamite!',
  'Bristleback': 'I\'m a walking armory!',
  'Earthshaker': 'Feel the earth tremble.',
  'Mirana': 'Ride with the wind!',
  'Rubick': 'The grandest magic is yet to come.',
  'Shadow Shaman': 'The spirits speak through me.',
  'Lina': 'Fire and fury!',
  'Riki': 'Silent but deadly.',
  'Zeus': 'Thunder is my voice.',
  'Wraith King': 'The king lives!',
  'Lion': 'Fear me.',
  'Windranger': 'The wind is my ally.',
  'Spectre': 'The veil between worlds grows thin.',
  'Huskar': 'Fear my spear.',
  'Tinker': 'Science is my religion.',
  'Silencer': 'Silence... sweet silence.',
  'Ember Spirit': 'I burn bright.'
};
const GENERIC_QUOTES = [
  'Готов к бою за Древних.',
  'Мега-крипы вышли.',
  'GG WP, но мы ещё вернёмся.',
  'Midas в руках — золото поёт.',
  'Roshan ждёт.',
  'Саппорты спасают.',
  'Mid or feed.',
  'Дота — это искусство.',
  'Ancient под атакой!',
  'Rampage incoming.',
  'Пятёрка на вардах.',
  'Добить врага на Fountain.',
  'BKB — наше всё.',
  'Шесть слотов — шесть возможностей.',
  'Отыгрыш за 60k нетворса.'
];

/* ========== STATE ========== */
const state = {
  tracks: [],
  currentIdx: -1,
  isPlaying: false,
  favorites: [],
  history: [],
  mode: 'direct',
  heroes: [],
  currentHero: null,
  audioCtx: null,
  analyser: null,
  srcNode: null,
  vizData: null,
  widget: null,
  widgetTimer: null
};

/* ========== HELPERS ========== */
const $ = s => document.querySelector(s);
const audioEl = document.getElementById('audio');
const vizCanvas = document.getElementById('p-viz');
const vizCtx = vizCanvas.getContext('2d');

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtTime(s) {
  s = Math.floor(s || 0);
  return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
}

/* ========== INIT ========== */
async function init() {
  loadDotaHeroes();
  await loadFavorites();
  await loadHistory();
  updateFavBadge();
  setupListeners();
  setupCursor();
  setupWidget();
  setupVisualizer();
  search('lofi hip hop');
}

/* ========== DOTA ========== */
async function loadDotaHeroes() {
  try {
    const res = await fetch(DOTA_API);
    state.heroes = await res.json();
    pickHero();
  } catch (e) {
    console.warn('Dota failed:', e);
    $('#banner-title').textContent = 'Invoker';
    $('#banner-quote').textContent = '"I am a beacon of knowledge."';
  }
}

function pickHero() {
  if (!state.heroes.length) return;
  const hero = state.heroes[Math.floor(Math.random() * state.heroes.length)];
  const key = hero.name.replace('npc_dota_hero_', '');
  const imgUrl = `${STEAM_CDN}/${key}.png`;
  const quote = HERO_QUOTES[hero.localized_name] || GENERIC_QUOTES[Math.floor(Math.random() * GENERIC_QUOTES.length)];

  state.currentHero = { ...hero, imgUrl, quote, key };
  $('#banner-img').src = imgUrl;
  $('#banner-title').textContent = hero.localized_name;
  $('#banner-quote').textContent = `"${quote}"`;
  $('#sb-hero-img').src = imgUrl;
  $('#sb-hero-name').textContent = hero.localized_name;
  $('#banner-cta').onclick = () => search(`${hero.localized_name} music`);
}

/* ========== SEARCH ========== */
async function search(query) {
  const grid = $('#grid');
  grid.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  $('#res-count').textContent = 'Ищем...';

  let tracks = [];
  let source = 'soundcloud';

  try {
    const res = await fetch(`${SC_API}/tracks?q=${encodeURIComponent(query)}&client_id=${CLIENT_ID}&limit=30`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length) tracks = data;
    }
  } catch (e) { console.warn('SC failed:', e); }

  if (!tracks.length) {
    try {
      const res = await fetch(`${ITUNES}?term=${encodeURIComponent(query)}&media=music&limit=30&entity=song`);
      const data = await res.json();
      if (data.results?.length) {
        tracks = data.results.map(t => ({
          id: t.trackId,
          title: t.trackName,
          user: { username: t.artistName },
          artwork_url: t.artworkUrl100?.replace('100x100', '500x500'),
          permalink_url: t.trackViewUrl,
          stream_url: t.previewUrl,
          duration: t.trackTimeMillis,
          source: 'itunes'
        }));
        source = 'itunes';
      }
    } catch (e) { console.warn('iTunes failed:', e); }
  }

  if (!tracks.length) {
    grid.innerHTML = '<div class="empty"><h3>Ничего не нашли</h3><p>Попробуй другой запрос</p></div>';
    $('#res-count').textContent = '0 треков';
    return;
  }

  state.tracks = tracks;
  renderTracks(tracks, grid);
  $('#res-count').textContent = `${tracks.length} треков · ${source}`;
}

function renderTracks(tracks, container) {
  container.innerHTML = tracks.map((t, i) => {
    const art = t.artwork_url || t.user?.avatar_url || '';
    const title = t.title || '—';
    const artist = t.user?.username || '—';
    const isFav = state.favorites.some(f => f.id === t.id);
    return `
      <div class="card" data-idx="${i}" style="animation-delay:${i * 0.04}s">
        <div class="card-art">
          <img src="${art}" alt="${escapeHtml(title)}" loading="lazy" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23222%22 width=%22100%22 height=%22100%22/></svg>'">
          <div class="card-play"><div class="card-play-btn"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div></div>
          <button class="card-like ${isFav ? 'liked' : ''}" data-id="${t.id}">
            <svg viewBox="0 0 24 24"><path d="M12 21s-7-4.5-7-10a4 4 0 0 1 7-2.5 4 4 0 0 1 7 2.5c0 5.5-7 10-7 10z"/></svg>
          </button>
          <div class="card-eq"><span></span><span></span><span></span></div>
        </div>
        <div class="card-info">
          <div class="card-title">${escapeHtml(title)}</div>
          <div class="card-artist">${escapeHtml(artist)}</div>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.card').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('.card-like')) return;
      playTrack(parseInt(card.dataset.idx));
    });
    const likeBtn = card.querySelector('.card-like');
    likeBtn.addEventListener('click', e => {
      e.stopPropagation();
      toggleLike(parseInt(likeBtn.dataset.id));
    });
  });
}

/* ========== PLAYER ========== */
async function playTrack(idx) {
  const track = state.tracks[idx];
  if (!track) return;
  state.currentIdx = idx;

  updatePlayerUI(track);
  await addToHistory(track);

  const directUrl = track.source === 'itunes'
    ? track.stream_url
    : track.stream_url + (track.stream_url.includes('?') ? '&' : '?') + `client_id=${CLIENT_ID}`;

  audioEl.src = directUrl;
  try {
    await audioEl.play();
    state.mode = 'direct';
    setupAudioContext();
    toast(`▶ ${track.title}`, 'ok');
  } catch (e) {
    console.warn('Direct failed:', e);
    if (track.permalink_url && state.widget) {
      try {
        state.widget.load(track.permalink_url, { auto_play: true, callback: () => {} });
        state.mode = 'widget';
        startWidgetTimer();
        toast(`▶ ${track.title} (widget)`, 'ok');
      } catch (e2) {
        toast('Не удалось воспроизвести', 'err');
        return;
      }
    } else {
      toast('Не удалось воспроизвести', 'err');
      return;
    }
  }

  state.isPlaying = true;
  updatePlayIcon();
  updatePlayingCard();
}

function updatePlayerUI(track) {
  const art = track.artwork_url || track.user?.avatar_url || '';
  $('#p-cover').src = art;
  $('#p-title').textContent = track.title;
  $('#p-artist').textContent = track.user?.username || '—';
  updateLikeIcon();
}

function togglePlay() {
  if (state.currentIdx < 0) return;
  if (state.isPlaying) {
    if (state.mode === 'direct') audioEl.pause();
    else if (state.widget) state.widget.pause();
    state.isPlaying = false;
  } else {
    if (state.mode === 'direct') audioEl.play();
    else if (state.widget) state.widget.play();
    state.isPlaying = true;
  }
  updatePlayIcon();
  updatePlayingCard();
}

function updatePlayIcon() {
  const ico = $('#play-ico');
  ico.innerHTML = state.isPlaying
    ? '<path d="M6 5h4v14H6zm8 0h4v14h-4z" fill="currentColor"/>'
    : '<path d="M8 5v14l11-7z" fill="currentColor"/>';
}

function playPrev() {
  if (!state.tracks.length) return;
  const idx = state.currentIdx > 0 ? state.currentIdx - 1 : state.tracks.length - 1;
  playTrack(idx);
}

function playNext() {
  if (!state.tracks.length) return;
  const idx = state.currentIdx < state.tracks.length - 1 ? state.currentIdx + 1 : 0;
  playTrack(idx);
}

function updatePlayingCard() {
  document.querySelectorAll('.card.playing').forEach(c => c.classList.remove('playing'));
  if (state.currentIdx >= 0 && state.isPlaying) {
    const card = document.querySelector(`.card[data-idx="${state.currentIdx}"]`);
    if (card) card.classList.add('playing');
  }
}

/* ========== AUDIO CTX ========== */
function setupAudioContext() {
  if (state.audioCtx) return;
  try {
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    state.srcNode = state.audioCtx.createMediaElementSource(audioEl);
    state.analyser = state.audioCtx.createAnalyser();
    state.analyser.fftSize = 128;
    state.srcNode.connect(state.analyser);
    state.analyser.connect(state.audioCtx.destination);
    state.vizData = new Uint8Array(state.analyser.frequencyBinCount);
  } catch (e) { console.warn('AudioCtx failed:', e); }
}

/* ========== VISUALIZER ========== */
function setupVisualizer() { drawViz(); }

function drawViz() {
  const W = vizCanvas.width, H = vizCanvas.height;
  const cx = W/2, cy = H/2;
  vizCtx.clearRect(0, 0, W, H);

  let bars = [];
  let real = false;
  if (state.mode === 'direct' && state.analyser && state.isPlaying) {
    state.analyser.getByteFrequencyData(state.vizData);
    if (Math.max(...state.vizData) > 0) { bars = Array.from(state.vizData); real = true; }
  }
  if (!real) {
    const n = 32;
    bars = Array.from({length: n}, (_, i) => {
      if (!state.isPlaying) return 0;
      return Math.abs(Math.sin(Date.now() * 0.005 + i * 0.3)) * 200 + Math.random() * 50;
    });
  }

  const count = bars.length;
  for (let i = 0; i < count; i++) {
    const v = bars[i] / 255;
    const a = (i / count) * Math.PI * 2;
    const r = 38, r2 = r + v * 22;
    const x1 = cx + Math.cos(a) * r, y1 = cy + Math.sin(a) * r;
    const x2 = cx + Math.cos(a) * r2, y2 = cy + Math.sin(a) * r2;
    const hue = 280 + (i / count) * 60;
    vizCtx.strokeStyle = `hsla(${hue}, 90%, 65%, ${0.3 + v * 0.7})`;
    vizCtx.lineWidth = 2;
    vizCtx.lineCap = 'round';
    vizCtx.beginPath();
    vizCtx.moveTo(x1, y1);
    vizCtx.lineTo(x2, y2);
    vizCtx.stroke();
  }
  requestAnimationFrame(drawViz);
}

/* ========== WIDGET FALLBACK ========== */
function setupWidget() {
  try {
    const iframe = $('#sc-widget');
    state.widget = SC.Widget(iframe);
    state.widget.bind(SC.Widget.Events.PLAY, () => { state.isPlaying = true; updatePlayIcon(); updatePlayingCard(); });
    state.widget.bind(SC.Widget.Events.PAUSE, () => { state.isPlaying = false; updatePlayIcon(); updatePlayingCard(); });
    state.widget.bind(SC.Widget.Events.FINISH, () => playNext());
  } catch (e) { console.warn('Widget failed:', e); }
}

function startWidgetTimer() {
  if (state.widgetTimer) clearInterval(state.widgetTimer);
  state.widgetTimer = setInterval(() => {
    if (state.mode !== 'widget' || !state.widget) return;
    state.widget.getPosition(pos => {
      state.widget.getDuration(dur => {
        if (dur > 0) {
          $('#p-fill').style.width = (pos / dur * 100) + '%';
          $('#p-cur').textContent = fmtTime(pos / 1000);
          $('#p-dur').textContent = fmtTime(dur / 1000);
        }
      });
    });
  }, 300);
}

/* ========== AUDIO EVENTS ========== */
audioEl.addEventListener('timeupdate', () => {
  if (state.mode !== 'direct') return;
  const pct = (audioEl.currentTime / audioEl.duration) * 100 || 0;
  $('#p-fill').style.width = pct + '%';
  $('#p-cur').textContent = fmtTime(audioEl.currentTime);
  $('#p-dur').textContent = fmtTime(audioEl.duration || 0);
});
audioEl.addEventListener('ended', playNext);
audioEl.addEventListener('pause', () => { if (state.mode === 'direct') { state.isPlaying = false; updatePlayIcon(); updatePlayingCard(); } });
audioEl.addEventListener('play', () => { if (state.mode === 'direct') { state.isPlaying = true; updatePlayIcon(); updatePlayingCard(); } });

$('#p-bar').addEventListener('click', e => {
  const rect = e.currentTarget.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  if (state.mode === 'direct' && audioEl.duration) audioEl.currentTime = pct * audioEl.duration;
  else if (state.mode === 'widget' && state.widget) state.widget.getDuration(dur => state.widget.seekTo(pct * dur));
});

/* ========== FAVORITES ========== */
async function loadFavorites() {
  try {
    state.favorites = await window.ipc.invoke('favorites:get');
  } catch {
    state.favorites = JSON.parse(localStorage.getItem('grindo_favs') || '[]');
  }
  updateFavBadge();
}

async function toggleLike(trackId) {
  const track = state.tracks.find(t => t.id === trackId) || state.favorites.find(f => f.id === trackId) || state.history.find(h => h.id === trackId);
  if (!track) return;

  const isFav = state.favorites.some(f => f.id === trackId);
  if (isFav) {
    try { state.favorites = await window.ipc.invoke('favorites:remove', trackId); }
    catch { state.favorites = state.favorites.filter(f => f.id !== trackId); localStorage.setItem('grindo_favs', JSON.stringify(state.favorites)); }
    toast('Убрано из лайков', 'ok');
  } else {
    try { state.favorites = await window.ipc.invoke('favorites:add', track); }
    catch { state.favorites.unshift(track); localStorage.setItem('grindo_favs', JSON.stringify(state.favorites)); }
    toast('❤ Добавлено в лайки', 'ok');
  }
  updateFavBadge();
  updateLikeButtons();
  if (document.querySelector('[data-view="favorites"]') && !document.querySelector('[data-view="favorites"]').hidden) renderFavorites();
}

function updateFavBadge() {
  $('#fav-badge').textContent = state.favorites.length;
  $('#fav-count').textContent = `${state.favorites.length} треков`;
}

function updateLikeButtons() {
  document.querySelectorAll('.card-like').forEach(btn => {
    const id = parseInt(btn.dataset.id);
    btn.classList.toggle('liked', state.favorites.some(f => f.id === id));
  });
  updateLikeIcon();
}

function updateLikeIcon() {
  const btn = $('#like-btn');
  if (state.currentIdx < 0) { btn.classList.remove('liked'); return; }
  const track = state.tracks[state.currentIdx];
  btn.classList.toggle('liked', state.favorites.some(f => f.id === track?.id));
}

/* ========== HISTORY ========== */
async function loadHistory() {
  try { state.history = await window.ipc.invoke('history:get'); }
  catch { state.history = JSON.parse(localStorage.getItem('grindo_hist') || '[]'); }
  $('#hist-count').textContent = `${state.history.length} треков`;
}

async function addToHistory(track) {
  try { state.history = await window.ipc.invoke('history:add', track); }
  catch {
    state.history = [track, ...state.history.filter(t => t.id !== track.id)].slice(0, 100);
    localStorage.setItem('grindo_hist', JSON.stringify(state.history));
  }
  $('#hist-count').textContent = `${state.history.length} треков`;
}

/* ========== VIEWS ========== */
function switchView(name) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach(v => v.hidden = v.dataset.view !== name);
  $('#view-title').textContent = { search: 'Discover', favorites: 'Избранное', history: 'История' }[name];
  if (name === 'favorites') renderFavorites();
  if (name === 'history') renderHistory();
}

function renderFavorites() {
  const grid = $('#fav-grid');
  if (!state.favorites.length) {
    grid.innerHTML = '<div class="empty"><h3>Пока нет лайков</h3><p>Лайкай треки из поиска</p></div>';
    return;
  }
  const savedTracks = state.tracks;
  state.tracks = state.favorites;
  renderTracks(state.favorites, grid);
  state.tracks = savedTracks;
}

function renderHistory() {
  const grid = $('#hist-grid');
  if (!state.history.length) {
    grid.innerHTML = '<div class="empty"><h3>История пуста</h3><p>Слушай треки — они появятся тут</p></div>';
    return;
  }
  const savedTracks = state.tracks;
  state.tracks = state.history;
  renderTracks(state.history, grid);
  state.tracks = savedTracks;
}

/* ========== UI ========== */
function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function setupListeners() {
  $('#search-btn').addEventListener('click', () => search($('#q').value));
  $('#q').addEventListener('keydown', e => { if (e.key === 'Enter') search(e.target.value); });
  document.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => { $('#q').value = c.dataset.q; search(c.dataset.q); }));
  $('#banner-reroll').addEventListener('click', e => { e.stopPropagation(); pickHero(); toast(`🎲 Новый герой: ${state.currentHero?.localized_name}`, 'ok'); });

  $('#prev-btn').addEventListener('click', playPrev);
  $('#play-btn').addEventListener('click', togglePlay);
  $('#next-btn').addEventListener('click', playNext);
  $('#like-btn').addEventListener('click', () => {
    if (state.currentIdx >= 0) toggleLike(state.tracks[state.currentIdx].id);
  });

  document.querySelectorAll('.nav-btn').forEach(b => {
    b.addEventListener('click', () => switchView(b.dataset.view));
  });

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if (e.code === 'ArrowRight') playNext();
    if (e.code === 'ArrowLeft') playPrev();
    if (e.code === 'KeyF') $('#q').focus();
  });

  try {
    window.ipc.on('media:toggle', togglePlay);
    window.ipc.on('media:next', playNext);
    window.ipc.on('media:prev', playPrev);
  } catch {}
}

function setupCursor() {
  const cur = $('.cursor'), dot = $('.cursor-dot');
  let mx = 0, my = 0, cx = 0, cy = 0;
  window.addEventListener('mousemove', e => {
    mx = e.clientX; my = e.clientY;
    dot.style.left = mx + 'px';
    dot.style.top = my + 'px';
  });
  (function loop() {
    cx += (mx - cx) * 0.15;
    cy += (my - cy) * 0.15;
    cur.style.left = cx + 'px';
    cur.style.top = cy + 'px';
    requestAnimationFrame(loop);
  })();
  document.addEventListener('mouseover', e => {
    if (e.target.closest('button, .chip, .card, .player-progress')) cur.classList.add('on');
    else cur.classList.remove('on');
  });
}

/* ========== IPC ADAPTER ========== */
window.ipc = window.ipc || {
  async invoke(channel, ...args) {
    if (typeof require !== 'undefined') {
      try {
        const { ipcRenderer } = require('electron');
        return ipcRenderer.invoke(channel, ...args);
      } catch {}
    }
    throw new Error('No IPC');
  },
  on(channel, cb) {
    if (typeof require !== 'undefined') {
      try {
        const { ipcRenderer } = require('electron');
        ipcRenderer.on(channel, (_, ...args) => cb(...args));
      } catch {}
    }
  }
};

/* ========== START ========== */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
