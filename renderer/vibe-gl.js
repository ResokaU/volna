/* VOLNA · vibe-gl.js — шейдерный движок визуала (WebGL, без библиотек)
   Читает FFT из state.analyser (нативный движок) или синтезирует вайб на паузе. */
window.VibeGL = (function () {
  let canvas = null, gl = null, prog = null, u = {}, raf = 0;
  let preset = 'neon', bands = new Float32Array(8), cur = { bass: 0, mid: 0, high: 0, vol: 0, beat: 0 };
  const VS = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}';
  const HDR = 'precision highp float;uniform vec2 u_res;uniform float u_time,u_bass,u_mid,u_high,u_vol,u_beat;uniform vec3 u_accent;uniform float u_bands[8];';

  function compile(fragSrc) {
    const mk = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.warn('[GL]', gl.getShaderInfoLog(sh));
        return null;
      }
      return sh;
    };
    const vs = mk(gl.VERTEX_SHADER, VS);
    const fs = mk(gl.FRAGMENT_SHADER, HDR + '\n' + fragSrc);
    if (!vs || !fs) return null;
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.warn('[GL] link:', gl.getProgramInfoLog(p));
      return null;
    }
    return p;
  }

  function setupBuffer() {
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  function usePreset(name) {
    preset = name;
    if (!canvas || !ensureContext()) return;
    const lib = window.VIBE_SHADERS || {};
    const src = (lib[name] || lib.neon).frag;
    let p = compile(src);
    if (!p) p = compile(HDR + '\n' + lib.neon.frag);
    prog = p;
    if (!prog) return;
    gl.useProgram(prog);
    setupBuffer();
    u = {
      res: gl.getUniformLocation(prog, 'u_res'),
      time: gl.getUniformLocation(prog, 'u_time'),
      bass: gl.getUniformLocation(prog, 'u_bass'),
      mid: gl.getUniformLocation(prog, 'u_mid'),
      high: gl.getUniformLocation(prog, 'u_high'),
      vol: gl.getUniformLocation(prog, 'u_vol'),
      beat: gl.getUniformLocation(prog, 'u_beat'),
      accent: gl.getUniformLocation(prog, 'u_accent'),
      bands: gl.getUniformLocation(prog, 'u_bands')
    };
  }

  function ensureContext() {
    if (gl) return true;
    gl = canvas.getContext('webgl', { antialias: false, alpha: false }) || canvas.getContext('experimental-webgl');
    return !!gl;
  }

  function readAudio() {
    const st = window.state;
    const a = st && st.analyser;
    if (a && st.isPlaying) {
      if (!VibeGL._d || VibeGL._d.length !== a.frequencyBinCount) VibeGL._d = new Uint8Array(a.frequencyBinCount);
      a.getByteFrequencyData(VibeGL._d);
      const d = VibeGL._d, seg = Math.max(1, Math.floor(d.length / 8));
      for (let i = 0; i < 8; i++) {
        let sum = 0;
        for (let j = i * seg; j < (i + 1) * seg; j++) sum += d[j];
        bands[i] = sum / seg / 255;
      }
    } else {
      const t = performance.now() / 1000;
      bands[0] = 0.30 + 0.28 * Math.abs(Math.sin(t * 1.6));
      bands[1] = 0.26 + 0.22 * Math.abs(Math.sin(t * 1.1 + 1));
      bands[2] = 0.20 + 0.18 * Math.abs(Math.sin(t * 0.9 + 2));
      bands[3] = 0.16 + 0.14 * Math.abs(Math.sin(t * 0.7 + 3));
      for (let i = 4; i < 8; i++) bands[i] = 0.14 - i * 0.008;
    }
    cur.bass = (bands[0] + bands[1]) / 2;
    cur.mid = (bands[3] + bands[4]) / 2;
    cur.high = (bands[6] + bands[7]) / 2;
    let v = 0;
    for (let i = 0; i < 8; i++) v += bands[i];
    cur.vol = v / 8;
    cur.beat = cur.bass > (VibeGL._lastBass || 0) + 0.06 ? 1 : Math.max(0, (cur.beat || 0) - 0.06);
    VibeGL._lastBass = cur.bass;
  }

  function frame() {
    raf = requestAnimationFrame(frame);
    if (!gl || !canvas.isConnected) return;
    if (preset === 'off') { return; }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(2, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(2, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    readAudio();
    const t = performance.now() / 1000;
    const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#b14aff';
    const ar = parseInt(accent.slice(1, 3), 16) / 255 || 0.7;
    const ag = parseInt(accent.slice(3, 5), 16) / 255 || 0.3;
    const ab = parseInt(accent.slice(5, 7), 16) / 255 || 1;
    gl.useProgram(prog);
    gl.uniform2f(u.res, w, h);
    gl.uniform1f(u.time, t);
    gl.uniform1f(u.bass, cur.bass);
    gl.uniform1f(u.mid, cur.mid);
    gl.uniform1f(u.high, cur.high);
    gl.uniform1f(u.vol, cur.vol);
    gl.uniform1f(u.beat, cur.beat);
    gl.uniform3f(u.accent, ar, ag, ab);
    gl.uniform1fv(u.bands, bands);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  return {
    start(c, name) {
      canvas = c;
      if (!ensureContext()) return;
      usePreset(name || 'neon');
      if (!raf) frame();
    },
    setPreset(name) { usePreset(name); },
    stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }
  };
})();
