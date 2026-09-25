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
  vec2 uv = (gl_FragCoord.xy * 2.0 - u_res) / min(u_res.x, u_res.y) * 0.5;
  vec3 dir = vec3(uv * 0.8, 1.0);
  float time = u_time * 0.01 + 0.25;
  vec3 from = vec3(1.0, 0.5, 0.5) + vec3(uv, 2.0);
  from.xz += vec2(time * 3.0, time);
  float s = 0.1, fade = 1.0;
  vec3 v = vec3(0.0);
  for (int r = 0; r < 16; r++) {
    vec3 p = from + s * dir * 0.5;
    p = abs(vec3(0.85) - mod(p, vec3(1.7)));
    float pa = 0.0, a = 0.0;
    for (int i = 0; i < 15; i++) {
      p = abs(p) / dot(p, p) - 0.53;
      a += abs(length(p) - pa);
      pa = length(p);
    }
    a *= a * a;
    v += fade * (1.0 + u_bass * 2.0);
    v += vec3(s, s * s, s * s * s * s) * a * 0.0015 * fade * (1.0 + u_bass * 1.5);
    fade *= 0.76;
    s += 0.1;
  }
  v = mix(vec3(length(v)), v, 0.8) * 0.01;
  vec3 col = v * (1.0 + u_bass * 1.5) + u_accent * v * 0.9 + vec3(u_high * 0.15);
  col *= 1.0 - 0.35 * length(uv);
  gl_FragColor = vec4(col, 1.0);
}`
  },  wave: {
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
