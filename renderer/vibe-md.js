/* VOLNA · vibe-md.js — MilkDrop-движок (butterchurn, MIT) в вайбе.
   Настоящие .milk-пресеты комьюнити: base + Extra + Extra2 + MD1 (~1000 штук).
   Скрипты грузятся лениво при первом включении. Аудио — state.analyser (нативный движок). */
window.MilkdropGL = (function () {
  const SCRIPTS = [
    'vendor/butterchurn.min.js',
    'vendor/butterchurnPresets.min.js',
    'vendor/butterchurnPresetsExtra.min.js',
    'vendor/butterchurnPresetsExtra2.min.js',
    'vendor/butterchurnPresetsMD1.min.js'
  ];
  let canvas = null, vis = null, raf = 0, ready = false, loading = null;
  let names = [], curated = [], curName = '', autoTimer = 0, onPresetCb = null;
  let scale = 1;

  // зрелищные классики для рандома (в пачках их сотни, но не все одинаково красивы;
  // список пересекается с реально загруженными — имена взяты из самих паков)
  const CURATED = [
    'Flexi, martin + geiss - dedicated to the sherwin maxawow',
    'Flexi + Martin - astral projection',
    'Flexi + Martin - dive',
    'Flexi + Martin - cascading decay swing',
    'Flexi + Martin - tunnel of supraschismatika',
    'Flexi + Rovastar - Fractopia [lovecraft]',
    'Flexi + Geiss - Tokamak mindblob 2.0',
    'Flexi + Geiss - pogo-cubes on tokamak matter (Jelly 5.55)',
    'Flexi - mindblob [shiny mix]',
    'Flexi - smashing fractals 2.0',
    'Flexi - predator-prey-spirals',
    'Flexi - infused with the spiral',
    'Flexi - alien fish pond',
    'Flexi - reality tunnel',
    'Flexi - psychenapping',
    'Flexi - wild at range',
    'Flexi + stahlregen - jelly showoff parade',
    'Flexi + fiShbRaiN - operation fatcap II',
    'Eo.S. + Phat - cubetrace - v2',
    'Eo.S. - multisphere 01 B_Phat_Ra_mix',
    'Eo.S. + Geiss - glowsticks v2 02 (Relief Mix)',
    'Eo.S. + Zylot - skylight (Stained Glass Majesty mix)',
    'Eo.S. - spark C_Phat_Jester_Mix_v2',
    'Flexi, Geiss and Rovastar - chaos layered tokamak',
    'Flexi, martin + geiss - painterly rogue wave strike',
    'Flexi, fishbrain + Martin - witchery',
    'Flexi, Rovastar + Geiss - Fractopia vs bas relief',
    'Geiss + Rovastar - Notions Of Tonality 2',
    'Geiss + Flexi + Martin - disconnected',
    'Geiss - Bipolar 2 Enhanced',
    'Geiss - Brain Zoom 4',
    'Geiss - 3 layers (Tunnel Mix)',
    'Fumbling_Foo & Flexi, Martin, Orb, Unchained - Star Nova v7b',
    'Martin - journey into space',
    'Martin - liquid arrows',
    'Martin - Diabolo',
    'Unchained & Rovastar - Wormhole Pillars (Hall of Shadows mix)',
    'Unchained - Rewop',
    'Unchained - All You Can Eat',
    'EVET + Flexi - Rainbox Splash Poolz'
  ];

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src + '?v=' + Date.now(); // cache-bust: дисковый кэш Chromium держит старые app://-ответы
      s.onload = res;
      s.onerror = () => rej(new Error('Не загрузился ' + src));
      document.head.appendChild(s);
    });
  }

  async function ensureLibs() {
    if (ready) return;
    if (!loading) {
      loading = (async () => {
        for (const src of SCRIPTS) await loadScript(src);
        const map = Object.assign({},
          butterchurnPresets.getPresets(),
          butterchurnPresetsExtra.getPresets(),
          butterchurnPresetsExtra2.getPresets(),
          butterchurnPresetsMD1.getPresets());
        names = Object.keys(map);
        curated = CURATED.filter(n => map[n]); // живут только реально существующие
        window._BC_PRESETS = map;
        // UMD-сборка кладёт класс в .default
        window._BC_LIB = window.butterchurn.createVisualizer ? window.butterchurn : window.butterchurn.default;
        ready = true;
      })();
    }
    await loading;
  }

  function isSupported() {
    try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2')); }
    catch (_) { return false; }
  }

  function applySize() {
    if (!vis) return;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const w = Math.max(2, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(2, Math.round(canvas.clientHeight * dpr));
    canvas.width = w; canvas.height = h; // буфер канваса = размер рендера
    vis.setRendererSize(w, h);
  }

  function frame() {
    raf = requestAnimationFrame(frame);
    if (document.hidden || !canvas || canvas.offsetParent === null) return;
    vis.render();
  }

  function pickRandom() {
    // 75% — из кураторских красавцев, 25% — вся пачка (пусть и удивляет)
    const pool = (curated.length && Math.random() < 0.75) ? curated : names;
    return pool[Math.floor(Math.random() * pool.length)] || '';
  }

  function applyScale() {
    if (!canvas) return;
    canvas.style.transform = 'scale(' + scale + ')';
    canvas.style.transformOrigin = 'center center';
  }

  function load(name, blend) {
    curName = name;
    vis.loadPreset(window._BC_PRESETS[name], blend);
    if (onPresetCb) onPresetCb(name);
  }

  function start(c) {
    canvas = c;
    if (!isSupported()) { toast('WebGL2 недоступен — Милкдроп не заведётся', 'error'); return Promise.resolve(false); }
    return ensureLibs().then(() => {
      if (!vis) {
        const dpr = Math.min(1.5, window.devicePixelRatio || 1);
        const w = Math.max(2, Math.round(canvas.clientWidth * dpr));
        const h = Math.max(2, Math.round(canvas.clientHeight * dpr));
        canvas.width = w; canvas.height = h;
        vis = window._BC_LIB.createVisualizer(state.audioCtx || new AudioContext(), canvas, {
          width: w,
          height: h,
          pixelRatio: dpr
        });
      }
      if (state.analyser) {
        try { vis.connectAudio(state.analyser); } catch (_) {}
      } else {
        toast('🎧 Милкдропу нужен нативный движок (без виджета) — звук может не влиять', 'error');
      }
      if (!names.length) return false;
      if (!curName) load(pickRandom(), 0);
      else load(curName, 0); // возврат в вайб — продолжаем с того же пресета
      applySize();
      if (!MilkdropGL._resBound) {
        MilkdropGL._resBound = true;
        window.addEventListener('resize', applySize);
      }
      if (!raf) frame();
      return true;
    }).catch(e => {
      console.warn('[MD]', e && e.message);
      toast('Милкдроп не запустился: ' + (e && e.message || '?'), 'error');
      return false;
    });
  }

  return {
    start,
    stop() { if (raf) cancelAnimationFrame(raf); raf = 0; if (autoTimer) { clearInterval(autoTimer); autoTimer = 0; } },
    resize() { applySize(); applyScale(); },
    random() { if (ready && vis) load(pickRandom(), 2.7); },
    next() { this.random(); },
    getName() { return curName; },
    // 🔍 ручной зум картинки (некоторые пресеты рисуют гигантские формы)
    setScale(s) {
      scale = Math.min(1.6, Math.max(0.4, s));
      applyScale();
    },
    getScale() { return scale; },
    setAuto(on) {
      if (autoTimer) { clearInterval(autoTimer); autoTimer = 0; }
      if (on) autoTimer = setInterval(() => { if (ready && vis) load(pickRandom(), 2.7); }, 30000);
    },
    onPreset(cb) { onPresetCb = cb; },
    count() { return names.length; }
  };
})();
