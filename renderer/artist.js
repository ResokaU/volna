/* ============================================================
   VOLNA · artist.js — 🎤 страница артиста + отслеживание релизов
   Клик по имени артиста в любой карточке → страница: герой с баннером,
   статистика, «Волна артиста», кнопка следить (⭐). Следуемые артисты
   проверяются на новые треки при запуске и раз в 30 минут — новинки
   появляются полкой на главной.
   ============================================================ */
'use strict';

function followedArtists() {
  if (!Array.isArray(state.settings.followedArtists)) state.settings.followedArtists = [];
  return state.settings.followedArtists;
}
function isFollowingArtist(id) {
  return followedArtists().some(a => String(a.id) === String(id));
}
function slimTrack(t) {
  return { id: t.id, title: t.title, duration: t.duration, permalink_url: t.permalink_url,
    artwork_url: t.artwork_url, playback_count: t.playback_count,
    user: { id: t.user && t.user.id, username: t.user && t.user.username, avatar_url: t.user && t.user.avatar_url } };
}

/* клик по имени артиста в карточке трека */
function openArtistCard(el) {
  const uid = el.dataset.uid, name = (el.dataset.name || '').trim();
  if (uid && /^\d+$/.test(uid)) return openArtistPage(uid, name);
  if (name) return openArtistByName(name);
}

/* страница по имени: ищем пользователя api-v2 и открываем */
async function openArtistByName(name) {
  const q = String(name || '').trim();
  if (!q) return;
  toast('🎤 Открываю артиста…');
  try {
    const cid = await ensureClientId();
    const data = await scJson(`${SC_API2}/users?q=${encodeURIComponent(q)}&client_id=${cid}&limit=8`);
    const users = Array.isArray(data && data.collection) ? data.collection : [];
    const low = q.toLowerCase();
    const best = users.find(u => (u.username || '').toLowerCase() === low)
      || users.find(u => (u.username || '').toLowerCase().startsWith(low))
      || users[0];
    if (!best || best.id == null) { toast('Артист не нашёлся — ищу треки'); searchArtist(q); return; }
    openArtistPage(best.id, best.username);
  } catch (e) {
    toast('Артист недоступен: ' + (e && e.message || 'сеть'), 'error');
    searchArtist(q);
  }
}

async function openArtistPage(id, fallbackName) {
  const body = $('#artist-body');
  if (!body) return;
  body.innerHTML = '<div class="artist-hero"><div class="artist-skel"></div></div>'
    + '<div class="tracks" style="margin-top:18px">' + Array(8).fill('<div class="skeleton"></div>').join('') + '</div>';
  switchView('artist');
  try {
    const cid = await ensureClientId();
    const u = await scJson(`${SC_API2}/users/${id}?client_id=${cid}`);
    let tracks = [];
    const data = await scJson(`${SC_API2}/users/${id}/tracks?client_id=${cid}&limit=50`).catch(() => null);
    tracks = (Array.isArray(data && data.collection) ? data.collection : []).map(normalizeTrack).filter(Boolean);
    if (!tracks.length) {
      const data2 = await scJson(`${SC_API2}/users/${id}/tracks?client_id=${cid}`).catch(() => null);
      tracks = (Array.isArray(data2 && data2.collection) ? data2.collection : []).map(normalizeTrack).filter(Boolean);
    }
    if (!u || u.id == null) throw new Error('артист не найден');
    tracks.forEach(rememberTrack);
    state._artistPage = { user: u, tracks, fallbackName: fallbackName || '' };
    renderArtistPage();
  } catch (e) {
    body.innerHTML = emptyHTML('i-alert', 'Артист не открылся', escapeHtml(String(e && e.message || 'сеть')) + ' — попробуй ещё раз');
  }
}

function renderArtistPage(gridList) {
  const body = $('#artist-body');
  const p = state._artistPage;
  if (!body || !p) return;
  const u = p.user;
  const tracks = gridList || (p.sort === 'pop'
    ? [...p.tracks].sort((a, b) => (b.playback_count || 0) - (a.playback_count || 0))
    : p.tracks);
  const name = u.username || p.fallbackName || 'Артист';
  const ava = (u.avatar_url || '').replace('large', 't500x500');
  const plays = tracks.reduce((s, t) => s + (t.playback_count || 0), 0);
  const followers = u.followers_count != null ? fmtCount(u.followers_count) + ' подписчиков' : 'артист SoundCloud';
  const link = u.permalink_url || ('https://soundcloud.com/' + (u.permalink || u.username || ''));
  const following = isFollowingArtist(u.id);
  body.innerHTML = `
    <div class="artist-hero">
      <div class="artist-banner">${ava ? `<img class="artist-banner-img" src="${escapeHtml(ava)}" alt="">` : ''}</div>
      <div class="artist-head">
        <div class="artist-ava">${ava ? `<img src="${escapeHtml(ava)}" alt="" onerror="this.remove()">` : '<div class="ac-ava-ph">♪</div>'}</div>
        <div class="artist-id">
          <h2 class="artist-name-big">${escapeHtml(name)}${u.verified ? ' <span class="artist-verified" title="Подтверждён">✓</span>' : ''}</h2>
          <div class="artist-stats-row">
            <span class="hero-chip"><svg class="ic" viewBox="0 0 24 24"><use href="#i-user"/></svg>${escapeHtml(followers)}</span>
            <span class="hero-chip"><svg class="ic" viewBox="0 0 24 24"><use href="#i-note"/></svg>${u.track_count != null ? fmtCount(u.track_count) : tracks.length} треков</span>
            <span class="hero-chip"><svg class="ic" viewBox="0 0 24 24"><use href="#i-play"/></svg>${fmtCount(plays)} прослушиваний</span>
          </div>
          ${u.description ? `<div class="artist-bio">${escapeHtml(String(u.description).slice(0, 300))}</div>` : ''}
        </div>
        <div class="artist-actions">
          <button class="toolbar-btn primary" onclick="artistWave()"><svg class="ic" viewBox="0 0 24 24"><use href="#i-wave"/></svg>Волна артиста</button>
          <button class="toolbar-btn ${following ? 'active' : ''}" id="artist-follow-btn" onclick="toggleFollowArtist()">
            ${following ? '⭐ Отслеживаю' : '☆ Следить за релизами'}
          </button>
          <button class="toolbar-btn" onclick="copyArtistLink('${escapeHtml(link)}')"><svg class="ic" viewBox="0 0 24 24"><use href="#i-copy"/></svg>Ссылка</button>
          <button class="toolbar-btn" onclick="openExternalArtist('${escapeHtml(link)}')"><svg class="ic" viewBox="0 0 24 24"><use href="#i-external"/></svg>На SoundCloud</button>
        </div>
      </div>
    </div>
    <div class="section-head" style="margin-top:26px">
      <div><h2 class="section-title" style="font-size:22px">Треки</h2>
        <div class="section-sub">Всего ${tracks.length}</div></div>
      <div class="seg">
        <button class="seg-btn${p.sort !== 'pop' ? ' active' : ''}" onclick="setArtistSort('new')">Новые</button>
        <button class="seg-btn${p.sort === 'pop' ? ' active' : ''}" onclick="setArtistSort('pop')">Популярные</button>
      </div>
    </div>
    <div class="tracks">${tracks.length
      ? tracks.map((t, i) => trackCardHTML(t, i, 'artist')).join('')
      : emptyHTML('i-note', 'Треков нет', 'У артиста пока пусто')}</div>`;
}

/* сортировка треков на странице артиста */
function setArtistSort(s) {
  const p = state._artistPage;
  if (!p) return;
  p.sort = s;
  rememberTrack && p.tracks.forEach(rememberTrack);
  renderArtistPage();
}

function copyArtistLink(url) {
  const go = () => toast('🔗 Ссылка скопирована', 'success');
  if (typeof ipc !== 'undefined' && ipc) { ipc.invoke('clipboard:text', url).then(go).catch(() => {}); return; }
  try { navigator.clipboard.writeText(url).then(go).catch(() => {}); } catch (_) {}
}
function openExternalArtist(url) {
  if (window.ipc) ipc.invoke('shell:openExternal', url).catch(() => {});
  else window.open(url, '_blank');
}

/* вся дискография артиста в очередь и play */
function artistWave() {
  const p = state._artistPage;
  if (!p || !p.tracks.length) { toast('У артиста нет треков', 'error'); return; }
  p.tracks.forEach(rememberTrack);
  state.queue = [...p.tracks];
  persistQueueSoon();
  updateBadges();
  renderQueue();
  playTrack(p.tracks[0], 'queue');
  toast('📻 Волна артиста: ' + p.tracks.length + ' треков', 'success');
}

/* следить / не следить за релизами */
async function toggleFollowArtist() {
  const p = state._artistPage;
  if (!p || !p.user) return;
  const u = p.user;
  const list = followedArtists();
  const i = list.findIndex(a => String(a.id) === String(u.id));
  if (i >= 0) {
    list.splice(i, 1);
    toast('Отслеживание выключено');
  } else {
    const newest = p.tracks[0] || null;
    list.push({ id: u.id, name: u.username, avatar: (u.avatar_url || '').replace('large', 't500x500'),
      lastTrackId: newest ? newest.id : null, lastCheck: Date.now(),
      lastTrack: newest ? slimTrack(newest) : null });
    toast('⭐ Следим за «' + u.username + '» — новинки появятся на главной', 'success');
  }
  await saveSetting('followedArtists', list);
  renderArtistPage();
  if (typeof renderHome === 'function' && $('#view-home')?.classList.contains('active')) renderHome();
}

/* проверка новых релизов у отслеживаемых артистов */
async function checkFollowedReleases() {
  const list = followedArtists();
  if (!list.length || !ipc) return;
  let announced = null;
  for (const f of list) {
    try {
      const cid = await ensureClientId();
      const data = await scJson(`${SC_API2}/users/${f.id}/tracks?client_id=${cid}&limit=5`);
      const col = (Array.isArray(data && data.collection) ? data.collection : []).map(normalizeTrack).filter(Boolean);
      if (!col.length) continue;
      const newest = col[0];
      const firstRun = !f.lastCheck && !f.lastTrackId;
      const isNew = t => f.lastTrackId != null && t.id !== f.lastTrackId
        && (!f.lastCheck || (t.created_at ? Date.parse(t.created_at) > f.lastCheck : true));
      const newTracks = col.filter(isNew);
      if (!firstRun && newTracks.length && !announced) {
        announced = { artist: f, track: newTracks[0] };
        newTracks.forEach(t => rememberTrack(t));
      }
      f.lastCheck = Date.now();
      if (newest && newest.id !== f.lastTrackId) {
        f.lastTrackId = newest.id;
        f.lastTrack = slimTrack(newest);
      }
    } catch (_) {}
  }
  if (list.length) await saveSetting('followedArtists', list);
  if (announced) {
    toast('🆕 Новое от «' + announced.artist.name + '»: ' + String(announced.track.title || '').slice(0, 42), 'success',
      { label: '▶ Играть', fn: () => { rememberTrack(announced.track); playTrack(announced.track, 'single'); } });
    if (typeof renderHome === 'function' && $('#view-home')?.classList.contains('active')) renderHome();
  }
}

/* полка «Отслеживания» на главной: последний трек каждого артиста */
function renderFollowedShelf() {
  const head = $('#home-followed-head'), grid = $('#home-followed');
  if (!head || !grid) return;
  const cards = followedArtists().filter(f => f.lastTrack);
  if (!cards.length) { head.style.display = 'none'; grid.innerHTML = ''; return; }
  head.style.display = '';
  grid.innerHTML = cards.map((f, i) => {
    const t = { ...f.lastTrack, user: { id: f.id, username: f.name, avatar_url: f.avatar } };
    rememberTrack(t);
    return trackCardHTML(t, i, 'followed');
  }).join('');
  highlightPlaying();
}

/* первые 15 секунд после старта + каждые 30 минут */
setTimeout(() => { checkFollowedReleases().catch(() => {}); }, 15000);
setInterval(() => { checkFollowedReleases().catch(() => {}); }, 30 * 60 * 1000);
