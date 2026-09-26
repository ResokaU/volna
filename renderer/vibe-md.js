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
  let names = [], curName = '', autoTimer = 0, onPresetCb = null;

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
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
    vis.setRendererSize(Math.max(2, canvas.clientWidth * dpr), Math.max(2, canvas.clientHeight * dpr));
  }

  function frame() {
    raf = requestAnimationFrame(frame);
    if (document.hidden || !canvas || canvas.offsetParent === null) return;
    vis.render();
  }

  function pickRandom() { return names[Math.floor(Math.random() * names.length)] || ''; }

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
        vis = window._BC_LIB.createVisualizer(window.state.audioCtx || new AudioContext(), canvas, {
          width: Math.max(2, canvas.clientWidth * dpr),
          height: Math.max(2, canvas.clientHeight * dpr),
          pixelRatio: dpr
        });
      }
      if (window.state.analyser) {
        try { vis.connectAudio(window.state.analyser); } catch (_) {}
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
    resize: applySize,
    random() { if (ready && vis) load(pickRandom(), 2.7); },
    next() { this.random(); },
    getName() { return curName; },
    setAuto(on) {
      if (autoTimer) { clearInterval(autoTimer); autoTimer = 0; }
      if (on) autoTimer = setInterval(() => { if (ready && vis) load(pickRandom(), 2.7); }, 30000);
    },
    onPreset(cb) { onPresetCb = cb; },
    count() { return names.length; }
  };
})();
