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

/* «Artist - Title» / «Artist — Title» / «Artist | Title» → пара.
   Формат «Артист - Песня» верим ВСЕГДА (репосты: ник загрузчика ≠ исполнитель),
   ник загрузчика используем только если в заголовке нет разделителя. */
function splitArtistTitle(track) {
  const raw = (track?.title || '').trim();
  const uploader = (track?.user?.username || '').trim();
  const m = raw.match(/^(.{2,60}?)\s+[-–—|]\s+(.+)$/);
  if (m) {
    const a = m[1].trim(), t = m[2].trim();
    if (a && t) return { artist: a, title: cleanTitleForLyrics(t) || t };
  }
  return { title: cleanTitleForLyrics(raw) || raw, artist: uploader };
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

  // свой текст (тап-синхрон) важнее LRCLIB
  const custom = (state.settings.customLyrics || {})[track.id];
  if (custom && !force) {
    applyRecord({ syncedLyrics: custom, artist_name: track.user?.username || '', track_name: track.title || '', duration: Math.round((track.duration || 0) / 1000) }, track);
    return;
  }

  const gen = state.playGen || 0; // токен: если трек сменился — ответ не применяем
  state.lyrics = { status: 'loading', lines: [], plain: '', trackId: track.id, offset: (state.settings.lyrOffsets || {})[track.id] || 0, lastIdx: null };
  renderLyrics();

  const { title, artist } = splitArtistTitle(track);
  const dur = Math.round((track.duration || 0) / 1000);
  // коллабы: «Kai Angel & 9mice» — LRCLIB может знать каждого по отдельности
  const artistList = [artist];
  for (const p of artist.split(/\s*&\s*|\s*,\s*|\s+и\s+|\s+[x×]\s+|\s+feat\.?\s*|\s+ft\.?\s*/i)) {
    const a = p.trim();
    if (a && a !== artist && !artistList.includes(a)) artistList.push(a);
  }

  try {
    // параллельно: точные + нечёткие по каждому артисту, общие q и «только название»
    const gReqs = artistList.map(a =>
      scJson(`${LRCLIB}/api/get?artist_name=${encodeURIComponent(a)}&track_name=${encodeURIComponent(title)}&album_name=&duration=${dur}`)
        .then(r => { if (r) r.__exact = true; return r; })
    );
    const nReqs = artistList.map(a =>
      scJson(`${LRCLIB}/api/search?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(a)}`, { timeout: 25000 })
    );
    const qSet = new Set();
    qSet.add((artist + ' ' + title).trim());
    if (artistList[1]) qSet.add((artistList[1] + ' ' + title).trim());
    if (title) qSet.add(title);
    const qReqs = [...qSet].map(q => scJson(`${LRCLIB}/api/search?q=${encodeURIComponent(q)}`, { timeout: 25000 }));
    const results = await Promise.allSettled([...gReqs, ...nReqs, ...qReqs]);
    const exacts = [], byName = [], byQ = [];
    results.forEach((r, i) => {
      const v = val(r);
      if (!v) return;
      if (i < artistList.length) { if (v.syncedLyrics || v.plainLyrics) exacts.push(v); }
      else if (i < artistList.length + nReqs.length) { if (Array.isArray(v)) byName.push(...v.slice(0, 20)); }
      else if (Array.isArray(v)) byQ.push(...v.slice(0, 20));
    });
    const pick = list => {
      const arr = (Array.isArray(list) ? list : []).slice(0, 20);
      return arr.filter(r => r.syncedLyrics)
        .sort((a, b) => Math.abs((a.duration || 0) - dur) - Math.abs((b.duration || 0) - dur))[0]
        || arr[0] || null;
    };
    const rec = exacts.find(r => r.syncedLyrics)
      || pick(byName) || pick(byQ)
      || exacts[0] || null;
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
  if ($('#view-nowplaying')?.classList.contains('active')) renderNp(); // текст доехал — обновить полноэкранку
  else if (state.lyrics.status === 'synced' && state.settings.autoLyrics !== false) switchView('lyrics');
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
  const st = state.currentTrack ? splitArtistTitle(state.currentTrack) : null;
  $('#lyrics-sub').textContent = st
    ? `${st.artist} — ${st.title} · источник LRCLIB`
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
  const t = state.currentTrack;
  if (t) {
    const map = state.settings.lyrOffsets || {};
    map[t.id] = state.lyrics.offset;
    saveSetting('lyrOffsets', map); // подгонка помнится для этого трека навсегда
  }
  toast(`Синхронизация: ${state.lyrics.offset > 0 ? '+' : ''}${state.lyrics.offset.toFixed(1)}с`);
}

/* ---------- ✍️ свой текст: тап-синхрон ---------- */
function openTapEditor() {
  const t = state.currentTrack;
  if (!t) { toast('Сначала включи трек', 'error'); return; }
  renderTapIntro();
  openModal('taplyrics_modal');
}
function renderTapIntro() {
  const body = $('#taplyrics-body');
  if (!body) return;
  body.innerHTML = `
    <button class="modal-close" onclick="closeModal('taplyrics_modal')">×</button>
    <h2>✍️ Свой текст: тап-синхрон</h2>
    <div class="tap-hint">Вставь строки текста песни (просто текст, без таймингов). Затем запусти тап-режим и жми <strong>ПРОБЕЛ</strong> в такт каждой строке, пока играет трек. Получится собственное караоке — сохранится навсегда, LRCLIB не нужен.</div>
    <textarea id="tap-lines" placeholder="строка 1&#10;строка 2&#10;строка 3…" spellcheck="false"></textarea>
    <div class="ac-actions">
      <button class="ac-btn primary" onclick="tapStart()">▶ Начать тап</button>
      <button class="ac-btn ghost" onclick="closeModal('taplyrics_modal')">Отмена</button>
    </div>`;
}
function tapStart() {
  const lines = ($('#tap-lines')?.value || '').split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean);
  if (lines.length < 2) { toast('Нужно минимум 2 строки', 'error'); return; }
  state.tapLyrics = { lines, times: [], i: 0 };
  if (state.engine === 'audio' && state.audio) {
    state.audio.currentTime = 0;
    state.audio.play().catch(() => {});
  } else if (state.widget) {
    try { state.widget.seekTo(0); state.widget.play(); } catch (_) {}
  }
  renderTapUI();
}
function renderTapUI() {
  const T = state.tapLyrics;
  const body = $('#taplyrics-body');
  if (!T || !body) return;
  body.innerHTML = `
    <button class="modal-close" onclick="tapCancel()">×</button>
    <h2>Тап-синхрон · строка ${T.i + 1} из ${T.lines.length}</h2>
    <div class="tap-current">${escapeHtml(T.lines[T.i] || '(конец)')}</div>
    <div class="tap-next">${escapeHtml(T.lines[T.i + 1] || '')}</div>
    <div class="ac-actions">
      ${T.i < T.lines.length
        ? '<button class="ac-btn primary" onclick="tapLog()">ПРОБЕЛ — строка прозвучала</button>'
        : '<button class="ac-btn primary" onclick="tapSave()">💾 Сохранить караоке</button>'}
      <button class="ac-btn ghost" onclick="tapUndo()">← Назад</button>
    </div>
    <div class="tap-hint">Пробел на клавиатуре тоже работает · Backspace — шаг назад · Esc — отмена</div>`;
}
function tapLog() {
  const T = state.tapLyrics;
  if (!T || T.i >= T.lines.length) return;
  T.times.push(Math.round((state._lastPosMs || 0) / 10) / 100);
  T.i++;
  renderTapUI();
}
function tapUndo() {
  const T = state.tapLyrics;
  if (!T || T.i <= 0) return;
  T.times.pop(); T.i--;
  renderTapUI();
}
function tapCancel() { state.tapLyrics = null; closeModal('taplyrics_modal'); }
function tapSave() {
  const T = state.tapLyrics, t = state.currentTrack;
  if (!T || !t) return;
  const fmt = sec => {
    const m = Math.floor(sec / 60), ss = (sec % 60).toFixed(2).padStart(5, '0');
    return String(m).padStart(2, '0') + ':' + ss;
  };
  const lrc = T.lines.map((line, i) => '[' + fmt(T.times[i] || 0) + ']' + line).join(String.fromCharCode(10));
  const rec = { syncedLyrics: lrc, artist_name: t.user?.username || '', track_name: t.title || '', duration: Math.round((t.duration || 0) / 1000) };
  const map = state.settings.customLyrics || {};
  map[t.id] = lrc;
  saveSetting('customLyrics', map);
  state.lyricsCache[t.id] = rec;
  state.tapLyrics = null;
  closeModal('taplyrics_modal');
  applyRecord(rec, t);
  toast('✍️ Твоё караоке сохранено навсегда', 'success');
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
