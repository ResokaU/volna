/* ============================================================
   VOLNA · lyrics.js — караоке-текст через LRCLIB
   (синхронизированные LRC-тексты), подсветка по таймингам,
   клик по строке = seek, ручная подгонка ±0.5с
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

/* «Артист - Песня» в заголовке — частый формат у репостов от случайных людей */
function splitDash(raw) {
  const m = (raw || '').match(/^(.{2,60}?)\s+[-–—|]\s+(.+)$/);
  if (!m) return null;
  const artist = cleanTitleForLyrics(m[1].trim());
  const title = cleanTitleForLyrics(m[2].trim());
  if (!artist || !title) return null;
  return { artist, title };
}

/* набор вариантов «исполнитель/название» для поиска текста:
   1) из заголовка «X - Y» (репосты: загрузчик ≠ исполнитель)
   2) от имени загрузчика с очищенным названием */
function lyricsVariants(track) {
  const uploader = (track?.user?.username || '').trim();
  const dash = splitDash(track?.title);
  const clean = cleanTitleForLyrics(track?.title || '');
  const variants = [];
  if (dash) variants.push(dash);
  if (uploader && clean) {
    const dup = dash && dash.artist.toLowerCase() === uploader.toLowerCase()
      && dash.title.toLowerCase() === clean.toLowerCase();
    if (!dup) variants.push({ artist: uploader, title: clean });
  }
  const seen = new Set();
  return variants.filter(v => {
    const k = (v.artist + '|' + v.title).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* выбор лучшей записи: синхронизация ценнее, длительность ближе — лучше */
function pickLyricsRecord(list, dur) {
  const arr = Array.isArray(list) ? list : [];
  let best = null, bestScore = -Infinity;
  for (const r of arr) {
    if (!r) continue;
    const score = (r.syncedLyrics ? 100 : 0) + (r.plainLyrics ? 10 : 0)
      - Math.min(50, Math.abs((r.duration || 0) - dur) / 10);
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return best;
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

  state.lyrics = { status: 'loading', lines: [], plain: '', trackId: track.id, offset: 0, lastIdx: null };
  renderLyrics();

  const dur = Math.round((track.duration || 0) / 1000);
  const variants = lyricsVariants(track);

  try {
    // параллельно: точные запросы по каждому варианту + общий поиск по q
    const requests = variants.map(v =>
      scJson(`${LRCLIB}/api/get?artist_name=${encodeURIComponent(v.artist)}&track_name=${encodeURIComponent(v.title)}&album_name=&duration=${dur}`)
    );
    const raw = (track?.title || '').trim();
    if (raw) requests.push(scJson(`${LRCLIB}/api/search?q=${encodeURIComponent(raw)}`));
    const results = await Promise.allSettled(requests);
    const pool = [];
    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      if (Array.isArray(r.value)) pool.push(...r.value.slice(0, 20));
      else pool.push(r.value);
    }
    const rec = pickLyricsRecord(pool, dur);
    if (rec) {
      state.lyricsCache[track.id] = rec;
      const keys = Object.keys(state.lyricsCache);
      if (keys.length > 40) delete state.lyricsCache[keys[0]]; // не раздуваем память
      applyRecord(rec, track);
    } else {
      state.lyrics.status = 'none';
      state.lyrics.query = variants[0] || { artist: track?.user?.username || '', title: cleanTitleForLyrics(track?.title || '') };
      renderLyrics();
      resetLyricsScroll();
    }
  } catch (_) {
    state.lyrics.status = 'none';
    state.lyrics.query = variants[0] || { artist: track?.user?.username || '', title: cleanTitleForLyrics(track?.title || '') };
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
      `${escapeHtml(q.artist || '')} — ${escapeHtml(q.title || '')}<br>Попробуй найти вручную или через Genius`) +
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
}

/* ручной поиск: произвольный запрос к LRCLIB */
async function lyricsManualSearch() {
  const q = $('#lyrics-manual-input')?.value.trim();
  if (!q || !state.currentTrack) return;
  state.lyrics.status = 'loading';
  renderLyrics();
  try {
    const data = await scJson(`${LRCLIB}/api/search?q=${encodeURIComponent(q)}`);
    const rec = pickLyricsRecord(data, Math.round((state.currentTrack.duration || 0) / 1000));
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

/* ---------- действия ---------- */
function seekLyric(t) {
  if (!state.widget || !state.currentTrack) return;
  state.widget.seekTo(Math.max(0, (t - (state.lyrics.offset || 0)) * 1000));
  state.widget.play();
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

/* ---------- маскот: танцующая тянка / герои доты рядом с караоке ---------- */
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
