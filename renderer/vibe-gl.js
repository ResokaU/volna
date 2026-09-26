/* VOLNA · vibe-gl.js — шейдерный движок визуала (WebGL, без библиотек)
   v6.3.0: milkdrop-фидбэк — прошлый кадр примешивается с зум-варпом и распадом,
   поэтому все пресеты получают шлейфы и «жидкое» движение. Три pass'а на кадр:
   пресет → фидбэк (main+prev → out) → вывод на экран. */
window.VibeGL = (function () {
  let canvas = null, gl = null, raf = 0;
  let preset = 'neon', bands = new Float32Array(8), cur = { bass: 0, mid: 0, high: 0, vol: 0, beat: 0 };
  const VS = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}';
  const HDR = 'precision highp float;uniform vec2 u_res;uniform float u_time,u_bass,u_mid,u_high,u_vol,u_beat;uniform vec3 u_accent;uniform float u_bands[8];';
  const FB_HDR = 'precision highp float;uniform vec2 u_res;uniform sampler2D u_cur,u_prev;uniform float u_decay;uniform vec2 u_warp;';
  // пинг-понг текстур: main (сырой кадр пресета), prev (накопленный), out (результат фидбэка)
  const rt = { main: null, prev: null, out: null };
  let prog = null, fbProg = null, copyProg = null, u = {}, fbU = {}, copyU = {};

  const FB_FRAG = FB_HDR + `
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 c = uv - 0.5;
  float ca = cos(u_warp.y), sa = sin(u_warp.y);
  c = mat2(ca, -sa, sa, ca) * c / u_warp.x;
  vec3 prev = texture2D(u_prev, c + 0.5).rgb;
  vec3 cur = texture2D(u_cur, uv).rgb;
  gl_FragColor = vec4(max(cur, prev * u_decay), 1.0);
}`;
  const COPY_FRAG = 'precision highp float;uniform vec2 u_res;uniform sampler2D u_tex;\n' +
    'void main(){gl_FragColor=texture2D(u_tex,gl_FragCoord.xy/u_res);}';

  function mkShader(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn('[GL]', gl.getShaderInfoLog(sh));
      return null;
    }
    return sh;
  }

  function mkProgram(fragSrc) {
    const vs = mkShader(gl.VERTEX_SHADER, VS);
    const fs = mkShader(gl.FRAGMENT_SHADER, fragSrc);
    if (!vs || !fs) return null;
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.warn('[GL] link:', gl.getProgramInfoLog(p));
      return null;
    }
    return { p, loc: gl.getAttribLocation(p, 'p') };
  }

  // биндит программу + её атрибут вершины (у каждой свой loc)
  function bindProg(pr) {
    gl.useProgram(pr.p);
    gl.enableVertexAttribArray(pr.loc);
    gl.vertexAttribPointer(pr.loc, 2, gl.FLOAT, false, 0, 0);
  }

  function setupBuffer() {
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  }

  function mkRT(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, w, h };
  }

  function freeRT(r) { if (r) { gl.deleteTexture(r.tex); gl.deleteFramebuffer(r.fbo); } }

  function ensureRTs(w, h) {
    if (rt.main && rt.main.w === w && rt.main.h === h) return;
    freeRT(rt.main); freeRT(rt.prev); freeRT(rt.out);
    rt.main = mkRT(w, h); rt.prev = mkRT(w, h); rt.out = mkRT(w, h);
  }

  function usePreset(name) {
    preset = name;
    if (!canvas || !ensureContext()) return;
    const lib = window.VIBE_SHADERS || {};
    const src = HDR + '\n' + (lib[name] || lib.neon).frag;
    let p = mkProgram(src);
    if (!p) p = mkProgram(HDR + '\n' + lib.neon.frag);
    prog = p;
    if (!prog) return;
    u = {};
    for (const n of ['res', 'time', 'bass', 'mid', 'high', 'vol', 'beat', 'accent', 'bands']) {
      u[n] = gl.getUniformLocation(prog.p, 'u_' + n);
    }
  }

  function ensureContext() {
    if (gl) return true;
    gl = canvas.getContext('webgl', { antialias: false, alpha: false }) || canvas.getContext('experimental-webgl');
    if (!gl) return false;
    setupBuffer();
    fbProg = mkProgram(FB_FRAG);
    copyProg = mkProgram(COPY_FRAG);
    if (!fbProg || !copyProg) { gl = null; return false; }
    for (const n of ['res', 'cur', 'prev', 'decay', 'warp']) fbU[n] = gl.getUniformLocation(fbProg.p, 'u_' + n);
    for (const n of ['res', 'tex']) copyU[n] = gl.getUniformLocation(copyProg.p, 'u_' + n);
    return true;
  }

  function readAudio() {
    const st = state; // lexical-глобал из app.js (window.state не существует!)
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
    if (!gl || !canvas.isConnected || !prog) return;
    if (preset === 'off') return;
    if (document.hidden || canvas.offsetParent === null) return; // вкладка/экран не видны
    // рендер в 0.8x + dpr cap 1.5 (глазу одинаково, GPU в 2 раза легче)
    const dpr = Math.min(1.5, window.devicePixelRatio || 1) * 0.8;
    const w = Math.max(2, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(2, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ensureRTs(w, h);
    readAudio();
    const t = performance.now() / 1000;
    const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#b14aff';
    const ar = parseInt(accent.slice(1, 3), 16) / 255 || 0.7;
    const ag = parseInt(accent.slice(3, 5), 16) / 255 || 0.3;
    const ab = parseInt(accent.slice(5, 7), 16) / 255 || 1;

    // pass 1: пресет → main
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.main.fbo);
    gl.viewport(0, 0, w, h);
    bindProg(prog);
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

    // pass 2: фидбэк (main + prev → out) — зум наружу от баса, лёгкое вращение
    const zoom = 1.003 + cur.bass * 0.012 + cur.beat * 0.006;
    const rot = 0.0013 * Math.sin(t * 0.21) + 0.0022 * cur.beat * Math.sin(t * 1.7);
    const decay = Math.min(0.95, Math.max(0.78, 0.935 - cur.bass * 0.22));
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.out.fbo);
    bindProg(fbProg);
    gl.uniform2f(fbU.res, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, rt.main.tex);
    gl.uniform1i(fbU.cur, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, rt.prev.tex);
    gl.uniform1i(fbU.prev, 1);
    gl.uniform1f(fbU.decay, decay);
    gl.uniform2f(fbU.warp, zoom, rot);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // pass 3: out → экран
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    bindProg(copyProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, rt.out.tex);
    gl.uniform1i(copyU.tex, 0);
    gl.uniform2f(copyU.res, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // ротация: out становится prev, старый prev — под main следующего кадра
    const tmp = rt.prev;
    rt.prev = rt.out;
    rt.out = tmp;
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
