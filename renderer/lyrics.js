/* ============================================================
   VOLNA · lyrics.js — караоке-текст через LRCLIB
   (синхронизированные LRC-тексты), подсветка по таймингам,
   клик по строке = seek, ручная подгонка ±0.5с
   Версия логики: олд (v2.4) — простая и проверенная
   ============================================================ */
'use strict';

const LRCLIB = 'https://lrclib.net';

/* ---------- очистка названий ---------- */
function cleanTitleForLyrics(t) {
  return (t || '')
    .replace(/\s*[(\[][^\)\]]*[)\]]/g, ' ')          // (prod. …), [Free], (Remix)
    .replace(/\s*(feat|ft)\.?\s+.*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* «Artist - Title» / «Artist — Title» / «Artist | Title» → пара */
function splitArtistTitle(track) {
  let raw = (track?.title || '').trim();
  let artist = (track?.user?.username || '').trim();
  let title = raw;
  const m = raw.match(/^(.{2,60}?)\s+[-–—|]\s+(.+)$/);
  if (m) {
    const a = m[1].trim(), t = m[2].trim();
    const norm = s => s.toLowerCase().replace(/[^a-zа-яё0-9]/g, '');
    const uname = norm(artist), uname6 = uname.slice(0, 6);
    if (!artist || uname6 && (norm(a).includes(uname6) || uname.includes(norm(a).slice(0, 6)))) {
      artist = a;
      title = t;
    }
  }
  return { title: cleanTitleForLyrics(title) || title, artist };
}

/* ---------- загрузка ---------- */
async function loadLyrics(track, force) {
  if (!track) {
    state.lyrics = { status: 'idle', lines: [], plain: '', trackId: null, offset: 0, lastIdx: null };
    renderLyrics();
    return;
  }
  if (!force && state.lyrics.trackId === track.id) return; // уже загружен
  const cached = state.lyricsCache[track.id];
  if (cached && !force) { applyRecord(cached, track); return; }

  const gen = state.playGen || 0; // токен: если трек сменился — ответ не применяем
  state.lyrics = { status: 'loading', lines: [], plain: '', trackId: track.id, offset: 0, lastIdx: null };
  renderLyrics();

  const { title, artist } = splitArtistTitle(track);
  const dur = Math.round((track.duration || 0) / 1000);

  try {
    // три запроса параллельно — берём лучший: точное совпадение → по имени → общий q=
    const [rExact, rByName, rByQ] = await Promise.allSettled([
      scJson(`${LRCLIB}/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}&album_name=&duration=${dur}`),
      scJson(`${LRCLIB}/api/search?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`, { timeout: 25000 }),
      scJson(`${LRCLIB}/api/search?q=${encodeURIComponent((artist + ' ' + title).trim())}`, { timeout: 25000 })
    ]);
    const val = r => r.status === 'fulfilled' ? r.value : null;
    const pick = list => {
      const arr = (Array.isArray(list) ? list : []).slice(0, 20);
      return arr.filter(r => r.syncedLyrics)
        .sort((a, b) => Math.abs((a.duration || 0) - dur) - Math.abs((b.duration || 0) - dur))[0]
        || arr[0] || null;
    };
    const exact = val(rExact);
    const rec = (exact && (exact.syncedLyrics || exact.plainLyrics)) ? exact
      : pick(val(rByName)) || pick(val(rByQ)) || (exact && (exact.syncedLyrics || exact.plainLyrics) ? exact : null);
    // пока ждали LRCLIB, могли переключить трек — старый ответ не применяем
    if (gen !== (state.playGen || 0) || state.currentTrack?.id !== track.id) return;
    if (rec) {
      state.lyricsCache[track.id] = rec;
      const keys = Object.keys(state.lyricsCache);
      if (keys.length > 40) delete state.lyricsCache[keys[0]]; // не раздуваем память
      applyRecord(rec, track);
    } else {
      state.lyrics.status = 'none';
      state.lyrics.query = { title, artist };
      renderLyrics();
      resetLyricsScroll();
    }
  } catch (_) {
    state.lyrics.status = 'none';
    state.lyrics.query = { title, artist };
    renderLyrics();
    resetLyricsScroll();
  }
}

function applyRecord(rec, track) {
  state.lyrics.trackId = track.id;
  state.lyrics.plain = rec.plainLyrics || '';
  state.lyrics.lines = rec.syncedLyrics ? parseLRC(rec.syncedLyrics) : [];
  state.lyrics.status = state.lyrics.lines.length ? 'synced' : 'plain';
  state.lyrics.lastIdx = null;
  renderLyrics();
  resetLyricsScroll(); // новая песня — текст всегда сверху
  if (state.lyrics.status === 'synced' && state.settings.autoLyrics !== false) switchView('lyrics');
}

function resetLyricsScroll() {
  const w = $('#lyrics-wrap');
  if (w) w.scrollTop = 0;
}

/* ---------- парсер LRC: [mm:ss.xx] строка ---------- */
function parseLRC(lrc) {
  const out = [];
  for (const line of (lrc || '').split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const text = line.replace(/\[[^\]]*\]/g, '').trim();
    for (const st of stamps) {
      const frac = st[3] ? (+st[3]) / Math.pow(10, st[3].length) : 0;
      out.push({ t: +st[1] * 60 + +st[2] + frac, text });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/* ---------- отрисовка ---------- */
function renderLyrics() {
  const box = $('#lyrics-lines');
  if (!box) return;
  const L = state.lyrics;
  $('#lyrics-sub').textContent = state.currentTrack
    ? `${state.currentTrack.user?.username || ''} — ${state.currentTrack.title} · источник LRCLIB`
    : 'Караоке-режим · источник LRCLIB';

  if (L.status === 'idle') {
    box.innerHTML = emptyHTML('i-quote', 'Текст появится здесь', 'Включи любой трек — VOLNA сам найдёт синхронизированный текст');
  } else if (L.status === 'loading') {
    box.innerHTML = '<div class="lyr-skel"></div><div class="lyr-skel" style="width:70%"></div><div class="lyr-skel" style="width:85%"></div><div class="lyr-skel" style="width:55%"></div>';
  } else if (L.status === 'none') {
    const q = L.query || {};
    box.innerHTML = emptyHTML('i-search', 'Текст не нашёлся',
      `${escapeHtml(q.artist || '')} — ${escapeHtml(q.title || '')}<br>Попробуй кнопкой Genius — там почти всё есть`) +
      `<div class="lyr-manual">
        <input type="text" id="lyrics-manual-input" placeholder="исполнитель — название…" value="${escapeHtml([q.artist, q.title].filter(Boolean).join(' '))}">
        <button onclick="lyricsManualSearch()">Найти</button>
      </div>`;
  } else if (L.status === 'plain') {
    box.innerHTML = `<div class="lyr-plain">${escapeHtml(L.plain).replace(/\n/g, '<br>')}</div>`;
  } else {
    box.innerHTML = L.lines.map(l =>
      `<div class="lyr" onclick="seekLyric(${l.t})">${escapeHtml(l.text || '♪')}</div>`
    ).join('');
    L.lastIdx = null;
  }
}

/* ---------- тик из плеера (каждые 250 мс) ---------- */
function updateLyricsSync(posMs) {
  const L = state.lyrics;
  if (!L || L.status !== 'synced' || !L.lines.length) return;
  const p = posMs / 1000 + (L.offset || 0);
  const lines = L.lines;
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t <= p) idx = i;
    else break;
  }
  if (idx === L.lastIdx) return;
  L.lastIdx = idx;
  const els = $('#lyrics-lines')?.children;
  if (!els || !els.length) return;
  for (let i = 0; i < els.length; i++) {
    els[i].classList.toggle('on', i === idx);
    els[i].classList.toggle('past', i < idx);
  }
  const active = els[idx];
  const wrap = $('#lyrics-wrap');
  if (active && wrap) {
    const y = active.offsetTop - wrap.clientHeight / 2 + active.offsetHeight / 2;
    wrap.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
  }
  // зеркало в полноэкранном Now Playing (v3.2), если он открыт
  const npEls = $('#np-lyrics')?.children;
  if (npEls && npEls.length) {
    for (let i = 0; i < npEls.length; i++) {
      npEls[i].classList.toggle('on', i === idx);
      npEls[i].classList.toggle('past', i < idx);
    }
    const nw = $('#np-lyrics-wrap');
    if (nw && npEls[idx]) {
      const ny = npEls[idx].offsetTop - nw.clientHeight / 2 + npEls[idx].offsetHeight / 2;
      nw.scrollTo({ top: Math.max(0, ny), behavior: 'smooth' });
    }
  }
}

/* ---------- действия ---------- */
function seekLyric(t) {
  if (state.lyrics) state.lyrics.lastIdx = null; // подсветка сразу прыгнет на новую позицию
  if (state.engine === 'audio' && state.audio) {
    state.audio.currentTime = Math.max(0, t - (state.lyrics.offset || 0));
    state.audio.play().catch(() => {});
    return;
  }
  state.widget?.seekTo(Math.max(0, (t - (state.lyrics.offset || 0)) * 1000));
  state.widget?.play();
}

function nudgeLyrics(d) {
  if (!state.lyrics) return;
  state.lyrics.offset = Math.round(((state.lyrics.offset || 0) + d) * 2) / 2;
  state.lyrics.lastIdx = null;
  toast(`Синхронизация: ${state.lyrics.offset > 0 ? '+' : ''}${state.lyrics.offset.toFixed(1)}с`);
}

function openGenius() {
  const q = state.lyrics?.query;
  const s = q && (q.artist || q.title) ? `${q.artist || ''} ${q.title || ''}` : (state.currentTrack?.title || '');
  const url = `https://genius.com/search?q=${encodeURIComponent(s.trim())}`;
  if (ipc) ipc.invoke('shell:openExternal', url).catch(() => {});
  else window.open(url, '_blank');
}

/* ручной поиск: произвольный запрос к LRCLIB */
async function lyricsManualSearch() {
  const q = $('#lyrics-manual-input')?.value.trim();
  if (!q || !state.currentTrack) return;
  state.lyrics.status = 'loading';
  renderLyrics();
  try {
    const data = await scJson(`${LRCLIB}/api/search?q=${encodeURIComponent(q)}`, { timeout: 25000 });
    const dur = Math.round((state.currentTrack.duration || 0) / 1000);
    const rec = pickLyricsRecord(data, dur);
    if (rec) {
      state.lyricsCache[state.currentTrack.id] = rec;
      applyRecord(rec, state.currentTrack);
      toast('📝 Текст найден', 'success');
    } else {
      state.lyrics.status = 'none';
      state.lyrics.query = { artist: q, title: '' };
      renderLyrics();
    }
  } catch (_) {
    state.lyrics.status = 'none';
    renderLyrics();
    toast('LRCLIB не ответил', 'error');
  }
}

/* выбор лучшей записи: синхронизированные — приоритет, длительность ближе — лучше */
function pickLyricsRecord(list, dur) {
  const arr = (Array.isArray(list) ? list : []).slice(0, 20);
  return arr.filter(r => r.syncedLyrics)
    .sort((a, b) => Math.abs((a.duration || 0) - dur) - Math.abs((b.duration || 0) - dur))[0]
    || arr[0] || null;
}

/* ---------- маскот: герои доты рядом с караоке ---------- */
const MASCOTS = [
  { src: 'mascot/bocchi.gif', name: 'Bocchi 🎸' },
  { src: 'mascot/dance-window.gif', name: 'Тянка у окна' },
  { src: 'mascot/pink-dance.gif', name: 'Розовая 💗' },
  { src: 'mascot/black-hair.gif', name: 'Кудере' },
  { src: 'mascot/pudge.gif', name: 'Пудж 🥩', png: false },
  { src: 'mascot/juggernaut.gif', name: 'Джаггернаут ⚔️' },
  { src: 'mascot/pudge.png', name: 'Пудж (денс-режим) 🥩', png: true },
  { src: 'mascot/sf.png', name: 'Shadow Fiend (денс-режим) 💀', png: true }
];
function mascotIdx() { return +(localStorage.getItem('ga:mascotIdx') || 0) % MASCOTS.length; }

function updateMascot() {
  const box = $('#mascot');
  if (!box) return;
  const enabled = state.settings.mascot !== false;
  const viewOpen = $('#view-lyrics')?.classList.contains('active');
  const hasTrack = !!state.currentTrack;
  box.classList.toggle('on', enabled && viewOpen && hasTrack);
  box.classList.toggle('paused', !state.isPlaying);
  const m = MASCOTS[mascotIdx()];
  box.classList.toggle('png-dance', !!m.png);
  const img = $('#mascot-img');
  if (img && img.dataset.cur !== m.src) { img.src = m.src; img.dataset.cur = m.src; }
}

function cycleMascot() {
  const next = mascotIdx() + 1;
  localStorage.setItem('ga:mascotIdx', next);
  updateMascot();
  toast('🎭 Маскот: ' + MASCOTS[next % MASCOTS.length].name);
}
