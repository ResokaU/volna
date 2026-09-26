/* VOLNA · vibe.js — вайб-вью: рендер, шейдер-чипы, поиск фона, пылинки.
   Вынесено из app.js (v6.3.0). Все функции глобальные — onclick из index.html работает как раньше. */

function vibeToggle(which) {
  const fx = $('#vibe-fx-panel'), se = $('#vibe-search-panel');
  const open = which === 'fx' ? fx : se;
  const other = which === 'fx' ? se : fx;
  other.classList.remove('open');
  open.classList.toggle('open');
  if (which === 'fx' && fx.classList.contains('open') && state.vibeShader && state.vibeShader !== 'off') {
    VibeGL.start($('#vibe-gl'), state.vibeShader); // перезапуск, если canvas пересобран
  }
}

function rerollVibe() {
  const t = state.currentTrack;
  if (!t) { toast('Сначала включи трек', 'error'); return; }
  state._vibeAttempt = (state._vibeAttempt || 0) + 1;
  state.visual = null;
  renderVibe();
  toast('🔄 Ищу другой фон…');
}

/* ---------- 🌴 Вайб: тикток-вкладка ---------- */
function renderVibe() {
  const t = state.currentTrack;
  const bg = $('#vibe-bg'), txt = $('#vibe-text');
  if (!bg || !txt) return;
  if (!t) {
    txt.textContent = 'включи трек — и тут станет красиво';
    bg.classList.remove('loading');
    return;
  }
  renderVShaderChips();
  if (typeof updateVibeUI === 'function') updateVibeUI(state._lastPosMs, state._lastDurMs); // хотбар сразу с актуальными данными
  const glCanvas = $('#vibe-gl'), bcCanvas = $('#vibe-bc'), view = $('#view-vibe');
  view?.classList.remove('md-on');
  if (state.vibeShader === 'milkdrop') {
    // 🌀 настоящий MilkDrop: butterchurn рисует в свой канвас, GL-шейдеры спят
    if (glCanvas) glCanvas.style.display = 'none';
    VibeGL.stop();
    if (bcCanvas) bcCanvas.style.display = ''; // показывает класс .md-on
    view?.classList.add('md-on');
    MilkdropGL.start(bcCanvas).then(ok => { if (!ok) { state.vibeShader = 'off'; renderVibe(); } });
    renderMdCtl(true);
  } else {
    renderMdCtl(false);
    view?.classList.remove('md-on'); // bc-канвас прячется классом, инлайн не трогаем
    if (state.vibeShader && state.vibeShader !== 'off') {
      VibeGL.start(glCanvas, state.vibeShader);
      if (glCanvas) glCanvas.style.display = 'block';
    }
  }
  const cat = state.settings.vibeCat || 'anime';
  const glOn = state.vibeShader && state.vibeShader !== 'off';
  $('#view-vibe')?.classList.toggle('gl-on', glOn);
  if (cat === 'neon') {
    bg.classList.add('vibe-neon');
    bg.classList.remove('loading');
    bg.style.backgroundImage = '';
  } else {
    bg.classList.remove('vibe-neon');
    const ready = state.visual && state.visual.trackId === t.id && state.visual.img;
    bg.style.backgroundImage = ready ? 'url(' + state.visual.img + ')' : '';
    bg.classList.toggle('loading', !ready);
    if (state.visualMode) ensureVisual(t);
  }
  txt.textContent = (t.title || '').toUpperCase();
  state._vibeRt = t.id;
  startVibeParticles();
}

function renderVShaderChips() {
  const box = $('#vshader-chips');
  if (!box) return;
  const items = [{ id: 'off', label: '<svg class="ic" viewBox="0 0 24 24" style="width:13px;height:13px;vertical-align:-2px"><use href="#i-image"/></svg> Выкл' }].concat(
    Object.keys(window.VIBE_SHADERS || {}).map(k => ({ id: k, label: (window.VIBE_SHADERS[k].name || k) })),
    [{ id: 'milkdrop', label: '🌀 Милкдроп' }]
  );
  box.innerHTML = items.map(it =>
    '<button class="bit-chip' + (state.vibeShader === it.id ? ' active' : '') + '" data-shader="' + it.id + '">' + it.label + '</button>'
  ).join('');
  box.querySelectorAll('.bit-chip').forEach(ch => ch.addEventListener('click', () => {
    state.vibeShader = ch.dataset.shader;
    renderVShaderChips();
    const canvas = $('#vibe-gl');
    if (!canvas) return;
    if (state.vibeShader === 'off') {
      canvas.style.display = 'none'; VibeGL.stop(); MilkdropGL.stop(); renderVibe();
    } else if (state.vibeShader === 'milkdrop') {
      renderVibe(); // md-ветка сама переключит канвасы и покажет контролы
    } else {
      MilkdropGL.stop();
      renderVibe();
    }
    saveSetting('vibeShader', state.vibeShader);
  }));
}

/* 🌀 контролы милкдропа внутри fx-панели */
function renderMdCtl(show) {
  const ctl = $('#vibe-md-ctl');
  if (!ctl) return;
  ctl.classList.toggle('show', show);
  if (!show) return;
  const nameEl = $('#vibe-md-name');
  if (nameEl && typeof MilkdropGL !== 'undefined' && MilkdropGL.getName()) {
    nameEl.textContent = MilkdropGL.getName();
  }
  if (renderMdCtl._bound) return;
  renderMdCtl._bound = true;
  MilkdropGL.onPreset(name => { const el = $('#vibe-md-name'); if (el) el.textContent = name; });
  $('#vibe-md-rand').addEventListener('click', () => MilkdropGL.random());
  $('#vibe-md-next').addEventListener('click', () => MilkdropGL.next());
  // 🔍 зум: ±0.15 за клик, сброс 1:1
  const zbtn = [$('#vibe-md-zout'), $('#vibe-md-zin'), $('#vibe-md-zreset')];
  const applyZoom = (s) => { MilkdropGL.setScale(s); saveSetting('vibeMdScale', s); };
  if (zbtn[0]) zbtn[0].addEventListener('click', () => applyZoom(Math.round((MilkdropGL.getScale() - 0.15) * 100) / 100));
  if (zbtn[1]) zbtn[1].addEventListener('click', () => applyZoom(Math.round((MilkdropGL.getScale() + 0.15) * 100) / 100));
  if (zbtn[2]) zbtn[2].addEventListener('click', () => applyZoom(1));
  MilkdropGL.setScale(state.settings.vibeMdScale || 1);
  const autoBtn = $('#vibe-md-auto');
  autoBtn.classList.toggle('active', state.settings.vibeMdAuto === true);
  autoBtn.addEventListener('click', async () => {
    const on = !(state.settings.vibeMdAuto === true);
    state.settings.vibeMdAuto = on;
    autoBtn.classList.toggle('active', on);
    MilkdropGL.setAuto(on);
    await saveSetting('vibeMdAuto', on);
  });
  if (state.settings.vibeMdAuto === true) MilkdropGL.setAuto(true);
}

/* 🔎 поиск картинок на фон (многоисточниковый) */
async function doVibeSearch() {
  const q = $('#vibe-q')?.value.trim();
  const src = $('#vibe-src')?.value || 'wallhaven';
  if (!q) { toast('Введи, что искать', 'error'); return; }
  const box = $('#vibe-results');
  if (box) box.innerHTML = '<div class="vibe-res-hint">Ищу…</div>';
  const imgs = await ipc.invoke('img:query', { source: src, q, seed: String(Date.now() % 9999) }).catch(() => []);
  if (!imgs || !imgs.length) { if (box) box.innerHTML = '<div class="vibe-res-hint">Ничего не нашлось для «' + escapeHtml(q) + '»</div>'; return; }
  state.vibeResults = imgs;
  if (box) box.innerHTML = imgs.slice(0, 12).map((im, i) =>
    '<img class="vibe-thumb" data-i="' + i + '" src="' + escapeHtml(im.thumb || im.full) + '" loading="lazy" title="Поставить фоном">').join('');
  box.querySelectorAll('.vibe-thumb').forEach(th => th.addEventListener('click', () => {
    const im = imgs[+th.dataset.i];
    const t = state.currentTrack;
    state.visual = { trackId: t ? t.id : 0, img: im.full };
    const bg = $('#vibe-bg');
    if (bg) { bg.style.backgroundImage = 'url(' + im.full + ')'; bg.classList.remove('loading', 'vibe-neon'); }
    toast('🖼 Фон установлен', 'success');
  }));
}

/* 🌦 вайб по погоде: IP-геолокация → open-meteo (оба без ключей, с CORS) */
async function weatherVibe() {
  toast('🌦 Смотрю за окно…');
  try {
    const geo = await fetch('https://ipapi.co/json/').then(r => r.json());
    if (!geo || !geo.latitude) throw new Error('геолокация не удалась');
    const w = await fetch('https://api.open-meteo.com/v1/forecast?latitude=' + geo.latitude +
      '&longitude=' + geo.longitude + '&current_weather=true').then(r => r.json());
    const cw = w.current_weather || {};
    const code = cw.weathercode;
    let pick;
    if ([95, 96, 99].includes(code)) pick = { cat: 'night', label: '⚡ Гроза — тёмный вайб' };
    else if ([51,53,55,56,57,61,63,65,66,67,80,81,82].includes(code)) pick = { cat: 'city', label: '🌧 Дождь — городской вайб' };
    else if ([71,73,75,77,85,86].includes(code)) pick = { cat: 'nature', label: '❄️ Снег — природа' };
    else if ([45,48].includes(code)) pick = { cat: 'mountains', label: '🌫 Туман — горы' };
    else if ([0,1].includes(code)) pick = cw.is_day ? { cat: 'nature', label: '☀️ Ясно — природа' } : { cat: 'night', label: '🌙 Ясная ночь' };
    else pick = cw.is_day ? { cat: 'forest', label: '⛅ Облачно — лес' } : { cat: 'city', label: '🌙 Облачная ночь — город' };
    state.settings.vibeCat = pick.cat;
    await saveSetting('vibeCat', pick.cat);
    renderVibe();
    toast('🌦 ' + pick.label, 'success');
  } catch (e) {
    toast('Погоду не узнал: ' + (e && e.message || 'сеть'), 'error');
  }
}

function collapseVibe() {
  switchView('home');
}

/* пылинки, дрейфующие вверх (ускоряются от баса) */
let vibeParticles = null;
function startVibeParticles() {
  const c = $('#vibe-particles');
  if (!c || vibeParticles) return;
  const resize = () => { c.width = innerWidth; c.height = innerHeight; };
  resize();
  window.addEventListener('resize', resize);
  const P = Array.from({ length: 45 }, () => ({
    x: Math.random() * innerWidth, y: Math.random() * innerHeight,
    r: .6 + Math.random() * 2.2, vy: .18 + Math.random() * .6, vx: (Math.random() - .5) * .3,
    a: .12 + Math.random() * .4
  }));
  vibeParticles = { c, ctx: c.getContext('2d'), P };
  (function frame() {
    if (!$('#view-vibe')?.classList.contains('active')) { requestAnimationFrame(frame); return; }
    const ctx = vibeParticles.ctx;
    ctx.clearRect(0, 0, c.width, c.height);
    const beat = parseFloat(document.body.style.getPropertyValue('--beat')) || 0;
    for (const p of P) {
      p.y -= p.vy * (1 + beat * 2.2);
      p.x += p.vx;
      if (p.y < -4) { p.y = c.height + 4; p.x = Math.random() * c.width; }
      if (p.x < -4) p.x = c.width + 4;
      if (p.x > c.width + 4) p.x = -4;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(214,255,58,' + (p.a + beat * .3) + ')';
      ctx.fill();
    }
    requestAnimationFrame(frame);
  })();
}
