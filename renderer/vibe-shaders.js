/* VOLNA · vibe-shaders.js — GLSL-пресеты для шейдерного визуала
   Движок (vibe-gl.js) подставляет общий заголовок с uniform'ами:
   u_res, u_time, u_bass, u_mid, u_high, u_vol, u_beat, u_accent (vec3), u_bands[8] */
window.VIBE_SHADERS = {
  tunnel: {
    name: 'Туннель',
    frag: `
void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - u_res) / min(u_res.x, u_res.y);
  float r = length(uv) + 1e-4;
  float a = atan(uv.y, uv.x);
  float d = 0.35 / r + u_time * 0.9;
  vec3 col = u_accent * (0.35 + 0.65 * sin(d * 6.0 + a * 4.0 + u_bass * 4.0));
  col += vec3(0.9, 0.95, 1.0) * u_high * pow(max(0.0, 1.0 - r), 4.0);
  float rings = smoothstep(0.9, 1.0, sin(r * 14.0 - u_time * 5.0 + u_bass * 8.0));
  col += u_accent * rings * u_bass * 0.9;
  col *= smoothstep(1.8, 0.55, r);
  gl_FragColor = vec4(col * 1.1, 1.0);
}`
  },
  neon: {
    name: 'Неон',
    frag: `
void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - u_res) / min(u_res.x, u_res.y);
  float t = u_time * 0.6;
  float v = sin(uv.x * 3.0 + t)
          + sin(uv.y * 3.5 - t * 1.2)
          + sin((uv.x + uv.y) * 2.2 + t * 0.8)
          + sin(length(uv + vec2(sin(t * 0.3))) * 3.0 - t * 0.5);
  float m = 0.5 + 0.5 * sin(v * 1.8 + u_time);
  vec3 col = mix(vec3(0.03, 0.02, 0.10), u_accent * 1.35, m);
  col += u_accent * u_bass * 0.55 * smoothstep(0.2, 1.4, length(uv));
  col += vec3(1.0) * u_high * 0.25 * m;
  gl_FragColor = vec4(col, 1.0);
}`
  },
  space: {
    name: 'Космос',
    frag: `
void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - u_res) / min(u_res.x, u_res.y);
  vec3 col = vec3(0.02, 0.02, 0.05);
  float t = u_time * 0.35;
  for (float i = 1.0; i < 4.0; i++) {
    float sc = i * 2.2 + u_vol * 1.5;
    vec2 p = uv * sc + vec2(t * (2.0 + i * 0.7), t * 0.4 * (i + 1.0));
    vec2 id = floor(p), f = fract(p) - 0.5;
    float h = fract(sin(dot(id, vec2(127.1, 311.7))) * 43758.5453);
    vec2 off = (vec2(h, fract(h * 7.13)) - 0.5) * 0.6;
    float star = smoothstep(0.28, 0.0, length(f - off));
    col += mix(u_accent, vec3(1.0), h * 0.6) * star * (0.4 + u_high * 1.4) * smoothstep(0.0, 0.15, fract(h * 9.0 + t));
  }
  col += u_accent * u_bass * 0.35;
  gl_FragColor = vec4(col, 1.0);
}`
  },
  wave: {
    name: 'Волна',
    frag: `
float band(float i) {
  float s = 0.0;
  for (int k = 0; k < 8; k++) {
    s += u_bands[k] * clamp(1.0 - abs(i - float(k)), 0.0, 1.0);
  }
  return s;
}
void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - u_res) / min(u_res.x, u_res.y);
  vec3 col = vec3(0.02, 0.02, 0.06);
  for (float i = 0.0; i < 6.0; i++) {
    float y = -0.55 + i * 0.22;
    float amp = 0.05 + band(i) * 0.22;
    float line = y + sin(uv.x * (2.0 + i) * 0.9 + u_time * (0.6 + i * 0.13)) * amp;
    float fill = smoothstep(0.02, 0.0, uv.y - line);
    col = mix(col, mix(vec3(0.02), u_accent, 0.15 + i * 0.12), fill * 0.55);
    col += u_accent * smoothstep(0.012, 0.0, abs(uv.y - line)) * (0.35 + band(i));
  }
  gl_FragColor = vec4(col, 1.0);
}`
  }
};
