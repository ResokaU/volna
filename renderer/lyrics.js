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


/* ---------- постоянный выбор текста (переживает перезапуски) ---------- */
function lyricsChoiceGet(id) { return lsGet('lyricsChoice', {})[id] || null; }
function lyricsChoiceSet(id, v) {
  const m = lsGet('lyricsChoice', {});
  m[id] = v;
  const keys = Object.keys(m);
  if (keys.length > 200) delete m[keys[0]]; // не разрастаемся бесконечно
  lsSet('lyricsChoice', m);
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

  state.lyrics = { status: 'loading', lines: [], plain: '', trackId: track.id, offset: 0, lastIdx: null, candidates: null };
  renderLyrics();

  const dur = Math.round((track.duration || 0) / 1000);

  try {
    // сохранённый выбор (после ручного подбора) — точный запрос, мгновенно
    const choice = !force && lyricsChoiceGet(track.id);
    if (choice) {
      const rec = await scJson(`${LRCLIB}/api/get?artist_name=${encodeURIComponent(choice.artist)}&track_name=${encodeURIComponent(choice.title)}&album_name=&duration=${dur}`).catch(() => null);
      if (rec && (rec.syncedLyrics || rec.plainLyrics)) {
        state.lyricsCache[track.id] = rec;
        applyRecord(rec, track);
        return;
      }
    }

    const variants = lyricsVariants(track);
    // параллельно: точные get по вариантам + нечёткий search по имени + q-поиски.
    // search?track_name=&artist_name= — ключевой: находит при неполном совпадении.
    const requests = [];
    for (const v of variants) {
      requests.push(
        scJson(`${LRCLIB}/api/get?artist_name=${encodeURIComponent(v.artist)}&track_name=${encodeURIComponent(v.title)}&album_name=&duration=${dur}`)
          .then(r => { if (r) r.__exact = true; return r; })
      );
      requests.push(
        scJson(`${LRCLIB}/api/search?track_name=${encodeURIComponent(v.title)}&artist_name=${encodeURIComponent(v.artist)}`)
      );
    }
    const clean = cleanTitleForLyrics(track?.title || '');
    const uploader = (track?.user?.username || '').trim();
    if (uploader && clean) requests.push(scJson(`${LRCLIB}/api/search?q=${encodeURIComponent((uploader + ' ' + clean).trim())}`));
    const raw = (track?.title || '').trim();
    if (raw && raw.toLowerCase() !== (uploader + ' ' + clean).trim().toLowerCase()) {
      requests.push(scJson(`${LRCLIB}/api/search?q=${encodeURIComponent(raw)}`));
    }
    const results = await Promise.allSettled(requests);
    const pool = [];
    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      if (Array.isArray(r.value)) pool.push(...r.value.slice(0, 20));
      else pool.push(r.value);
    }
    const rec = pickLyricsRecord(pool, dur);
    if (isConfidentMatch(rec, dur)) {
      lyricsChoiceSet(track.id, { artist: rec.artist_name || '', title: rec.track_name || '' });
      state.lyricsCache[track.id] = rec;
      const keys = Object.keys(state.lyricsCache);
      if (keys.length > 40) delete state.lyricsCache[keys[0]]; // не раздуваем память
      applyRecord(rec, track);
      return;
    }
    // неуверенный или пустой результат — предлагаем 2-3 кандидата по названию
    let cands = pool.filter(r => r && (r.syncedLyrics || r.plainLyrics));
    if (cands.length < 2) cands = cands.concat(await titleCandidates(track, dur));
    if (cands.length) {
      cands = cands
        .sort((a, b) => matchScore(b, dur) - matchScore(a, dur))
        .filter((r, i, arr) => arr.findIndex(x =>
          (x.artist_name || '').toLowerCase() === (r.artist_name || '').toLowerCase()
          && (x.track_name || '').toLowerCase() === (r.track_name || '').toLowerCase()) === i)
        .slice(0, 3);
      state.lyrics.status = 'pick';
      state.lyrics.candidates = cands;
      state.lyrics.query = variants[0] || { artist: track?.user?.username || '', title: cleanTitleForLyrics(track?.title || '') };
    } else {
      state.lyrics.status = 'none';
      state.lyrics.query = variants[0] || { artist: track?.user?.username || '', title: cleanTitleForLyrics(track?.title || '') };
    }
    renderLyrics();
    resetLyricsScroll();
  } catch (_) {
    state.lyrics.status = 'none';
    state.lyrics.query = { artist: track?.user?.username || '', title: cleanTitleForLyrics(track?.title || '') };
    renderLyrics();
    resetLyricsScroll();
  }
}

/* уверенный автосоответ: длительность в допуске + либо синхронизация,
   либо точное совпадение исполнителя/названия (get-эндпоинт) */
function isConfidentMatch(rec, dur) {
  if (!rec || (!rec.syncedLyrics && !rec.plainLyrics)) return false;
  const d = rec.duration || 0;
  const durationOk = !d || Math.abs(d - dur) <= Math.max(10, dur * 0.25);
  if (rec.syncedLyrics && durationOk) return true;   // карaoke с похожим таймингом
  if (rec.__exact && durationOk) return true;        // точный get — доверяем и plain
  return false;
}
function matchScore(rec, dur) {
  if (!rec) return -Infinity;
  return (rec.syncedLyrics ? 100 : 0) + (rec.plainLyrics ? 10 : 0) + (rec.__exact ? 30 : 0)
    - Math.min(50, Math.abs((rec.duration || 0) - dur) / 10);
}
function pickLyricsRecord(list, dur) {
  const arr = Array.isArray(list) ? list : [];
  let best = null, bestScore = -Infinity;
  for (const r of arr) {
    if (!r) continue;
    const s = matchScore(r, dur);
    if (s > bestScore) { bestScore = s; best = r; }
  }
  return best;
}

/* запасной поиск кандидатов только по названию трека */
async function titleCandidates(track, dur) {
  const raw = (track?.title || '').trim();
  if (!raw) return [];
  try {
    const res = await scJson(`${LRCLIB}/api/search?q=${encodeURIComponent(raw)}`);
    return Array.isArray(res) ? res.slice(0, 10) : [];
  } catch (_) {
    return [];
  }
}

/* клик по кандидату: применяем и запоминаем навсегда */
function applyLyricsCandidate(i) {
  const rec = state.lyrics?.candidates?.[i];
  const t = state.currentTrack;
  if (!rec || !t) return;
  lyricsChoiceSet(t.id, { artist: rec.artist_name || '', title: rec.track_name || '' });
  state.lyricsCache[t.id] = rec;
  applyRecord(rec, t);
  toast('📝 Текст сохранён для этого трека', 'success');
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
  } else if (L.status === 'pick') {
    const cands = L.candidates || [];
    box.innerHTML = '<div class="lyr-pick-title">Точный текст не нашёлся — выбери свою версию:</div>' +
      cands.map((c, i) =>
        `<div class="lyr-cand" onclick="applyLyricsCandidate(${i})">
          <div class="lyr-cand-txt"><strong>${escapeHtml(c.artist_name || '—')}</strong> — ${escapeHtml(c.track_name || '—')}</div>
          <div class="lyr-cand-meta">${c.duration ? formatTime(c.duration) : '?'}${c.syncedLyrics ? ' · ⏱ синхронизирован' : ' · без таймингов'}</div>
        </div>`).join('') +
      `<div class="lyr-manual">
        <input type="text" id="lyrics-manual-input" placeholder="исполнитель — название…">
        <button onclick="lyricsManualSearch()">Найти</button>
      </div>`;
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
  const npEls = $('#np-lyrics')?.children;
  if (npEls && npEls.length) {
    for (let i = 0; i < npEls.length; i++) {
      npEls[i].classList.toggle('on', i === idx);
      npEls[i].classList.toggle('past', i < idx);
    }
    const nw = $('#np-lyrics-wrap');
    if (nw && npEls[idx]) {
      const y = npEls[idx].offsetTop - nw.clientHeight / 2 + npEls[idx].offsetHeight / 2;
      nw.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    }
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
      lyricsChoiceSet(state.currentTrack.id, { artist: rec.artist_name || '', title: rec.track_name || '' });
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
