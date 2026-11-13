// Lastword — the will seal as a WebGL brass medallion.
//
//   import { createSeal3D, supportsWebGL } from './seal3d.bundle.js';
//   if (supportsWebGL()) { const seal = createSeal3D(canvas, { state: 'alive', vaultNo: '0042' }); await seal.ready; }
//
// Scene budget (asserted by the demo check): six draw calls (body, face + inscription, trace, trace glow,
// halo), under 30k triangles, no postprocessing. Lighting is a procedural PMREM room plus one point light.
import {
  WebGLRenderer, Scene, PerspectiveCamera, Group, Mesh, Color, Vector2,
  LatheGeometry, CircleGeometry, RingGeometry, PlaneGeometry, BufferGeometry, BufferAttribute, SphereGeometry,
  MeshStandardMaterial, MeshBasicMaterial, ShaderMaterial, CanvasTexture, PMREMGenerator, PointLight,
  SRGBColorSpace, NeutralToneMapping, RepeatWrapping, LinearMipmapLinearFilter, AdditiveBlending, BackSide, DoubleSide,
} from 'three';
import { normState, stateWord, inscriptionText, inscriptionRing, vaultLabel, heirLabel } from './inscription.js';

export { inscriptionText, inscriptionRing, stateWord, normState, vaultLabel };

const HEX = { alive: 0x3ddc84, warning: 0xf5b942, triggered: 0xff4d4d, settled: 0x7a7f87 };
// BRASS is the in-scene albedo: lighter and less saturated than the #C8A96A token, because metal reflection
// multiplies the albedo into the environment and would otherwise render olive; on screen it reads as the token.
const BRASS = 0xd8c194, BRASS_GREY = 0xa09d97, INK = '#0B0C0F', BONE = '#EDE7DC', BONE2 = '#A9A399';

// Per-state targets for the tweened parameters.
const LOOK = {
  alive:     { glow: 1.0,  light: 0.7, amp: 1.0, flat: 0, sparse: 0, drift: 1.0,  desat: 0,   trace: 1.0 },
  warning:   { glow: 0.62, light: 0.45, amp: 0.82, flat: 0, sparse: 1, drift: 0.8,  desat: 0.1, trace: 0.8 },
  triggered: { glow: 0.85, light: 0.65, amp: 1.0, flat: 1, sparse: 0, drift: 0.6,  desat: 0.15, trace: 1.0 },
  settled:   { glow: 0.0,  light: 0.0, amp: 1.0, flat: 1, sparse: 0, drift: 0.22, desat: 0.75, trace: 0.6 },
};

const S = 1.3 / 200;                 // SVG seal units (400 box) -> world units; disc radius 1.3
const FIELD_R = 0.926, FACE_Z = 0.036, TRACE_Z = 0.05;
const RING_IN = 0.958, RING_OUT = 1.19, INSCR_Z = 0.0565;
const TILT = (14 * Math.PI) / 180;

const easeOutQuint = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 5);

export function supportsWebGL() {
  try {
    if (typeof document === 'undefined' || typeof window === 'undefined' || !window.WebGLRenderingContext) return false;
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    const ok = !!gl;
    if (gl && gl.getExtension('WEBGL_lose_context')) gl.getExtension('WEBGL_lose_context').loseContext();
    return ok;
  } catch (e) {
    return false;
  }
}

// ---------- geometry ----------

// Medallion body: one lathe — back, chamfered edge, bevel, outer double ring, inscription band, inner ring, field.
function bodyGeometry() {
  const p = [
    [0, -0.07], [1.22, -0.07], [1.268, -0.064], [1.292, -0.048], [1.3, -0.028],
    [1.3, 0.014], [1.296, 0.03], [1.284, 0.044], [1.266, 0.054], [1.252, 0.058],
    // outer ring (r190)
    [1.248, 0.063], [1.243, 0.079], [1.235, 0.086], [1.227, 0.079], [1.222, 0.063],
    [1.216, 0.059], [1.209, 0.06],
    // inner ring of the double (r184.5)
    [1.205, 0.065], [1.2, 0.074], [1.195, 0.065], [1.19, 0.058],
    // inscription band, very slightly dished
    [1.17, 0.056], [1.07, 0.054], [0.975, 0.056],
    // inner ring (r145)
    [0.962, 0.061], [0.955, 0.074], [0.946, 0.079], [0.937, 0.074], [0.931, 0.058],
    [0.929, 0.044], [0.924, 0.036], [0.8, 0.034], [0, 0.034],
  ].map(([r, z]) => new Vector2(r, z));
  // Lathe runs bottom -> top so normals face outward.
  const g = new LatheGeometry(p, 160);
  g.rotateX(Math.PI / 2);
  return g;
}

// SVG pulse path (design/seal.svg), sampled densely, trimmed to the field.
function ecgPoints(n) {
  const raw = [];
  const line = (x0, y0, x1, y1) => { const k = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0))); for (let i = 1; i <= k; i++) raw.push([x0 + ((x1 - x0) * i) / k, y0 + ((y1 - y0) * i) / k]); };
  const cubic = (x0, y0, x1, y1, x2, y2, x3, y3) => { for (let i = 1; i <= 28; i++) { const t = i / 28, u = 1 - t; raw.push([u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3]); } };
  raw.push([60, 196]);
  line(60, 196, 118, 196);
  cubic(118, 196, 122, 196, 125, 187, 130, 187);
  cubic(130, 187, 135, 187, 138, 196, 142, 196);
  line(142, 196, 156, 196); line(156, 196, 161, 204); line(161, 204, 171, 124); line(171, 124, 181, 226); line(181, 226, 187, 196);
  line(187, 196, 203, 196);
  cubic(203, 196, 211, 196, 215, 179, 226, 179);
  cubic(226, 179, 237, 179, 241, 196, 249, 196);
  line(249, 196, 340, 196);
  // resample by arc length
  const L = [0];
  for (let i = 1; i < raw.length; i++) L.push(L[i - 1] + Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1]));
  const total = L[L.length - 1], out = [];
  let j = 0;
  for (let i = 0; i <= n; i++) {
    const s = (total * i) / n;
    while (j < L.length - 2 && L[j + 1] < s) j++;
    const t = (s - L[j]) / (L[j + 1] - L[j] || 1);
    out.push([raw[j][0] + (raw[j + 1][0] - raw[j][0]) * t, raw[j][1] + (raw[j + 1][1] - raw[j][1]) * t]);
  }
  return out;
}

// A planar tube with a fixed frame (binormal = +Z) so the ECG and its flatline have matching vertices and can morph.
// uv.x runs along the trace, uv.y = across (0..1, 0.5 at the centre line seen face-on).
function traceGeometry(seg, radial, rw, rz) {
  const pts = ecgPoints(seg).map(([x, y]) => [(x - 200) * S, -(y - 200) * S]);
  const flatY = -(196 - 200) * S;
  const nv = (seg + 1) * (radial + 1);
  const pos = new Float32Array(nv * 3), flat = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), nor = new Float32Array(nv * 3);
  let v = 0;
  for (let i = 0; i <= seg; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(seg, i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1]; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    const nx = -ty, ny = tx;
    for (let k = 0; k <= radial; k++) {
      const ang = (k / radial) * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang);
      pos[v * 3] = pts[i][0] + nx * rw * c; pos[v * 3 + 1] = pts[i][1] + ny * rw * c; pos[v * 3 + 2] = TRACE_Z + rz * s;
      flat[v * 3] = pts[i][0]; flat[v * 3 + 1] = flatY + rw * c; flat[v * 3 + 2] = TRACE_Z + rz * s;
      nor[v * 3] = nx * c; nor[v * 3 + 1] = ny * c; nor[v * 3 + 2] = s;
      uv[v * 2] = i / seg; uv[v * 2 + 1] = c * 0.5 + 0.5;
      v++;
    }
  }
  const idx = [];
  for (let i = 0; i < seg; i++) for (let k = 0; k < radial; k++) {
    const a = i * (radial + 1) + k, b = (i + 1) * (radial + 1) + k;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('flatPosition', new BufferAttribute(flat, 3));
  g.setAttribute('normal', new BufferAttribute(nor, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

const TRACE_VS = /* glsl */`
attribute vec3 flatPosition;
uniform float uMix;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec3 p = mix(flatPosition, position, uMix);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const TRACE_FS = /* glsl */`
uniform vec3 uColor;
uniform float uIntensity, uSweep, uSweepAmt, uSparse, uOpacity, uGlow;
varying vec2 vUv;
void main() {
  float ends = smoothstep(0.0, 0.05, vUv.x) * smoothstep(1.0, 0.95, vUv.x);
  // warning: the line stutters — irregular dropouts, not an even dash
  float cell = floor(vUv.x * 17.0 + 0.37), f = fract(vUv.x * 17.0 + 0.37);
  float h = fract(sin(cell * 91.7 + 3.1) * 43758.5453);
  float keep = h < 0.24 ? 0.0 : step(f, 0.62 + 0.36 * h);
  float dash = mix(1.0, keep, uSparse);
  float sw = exp(-pow((vUv.x - uSweep) / 0.045, 2.0)) * uSweepAmt;
  float across = abs(vUv.y * 2.0 - 1.0);
  float a;
  vec3 c;
  if (uGlow > 0.5) {
    a = pow(1.0 - across, 2.2) * (0.55 + 1.4 * sw) * uOpacity * ends * dash;
    c = uColor;
  } else {
    if (dash < 0.5) discard;
    a = uOpacity * ends;
    c = uColor * (uIntensity + 1.6 * sw) + vec3(0.55 * sw);
  }
  gl_FragColor = vec4(c, a);
  #include <colorspace_fragment>
}`;

// ---------- textures ----------

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

// Draw a string with manual letter-spacing, centred on (x, y).
function spacedText(ctx, str, x, y, spacingPx) {
  const chars = [...str];
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacingPx * (chars.length - 1);
  let cx = x - total / 2;
  ctx.textAlign = 'left';
  chars.forEach((ch, i) => { ctx.fillText(ch, cx, y); cx += widths[i] + spacingPx; });
}

// Rim inscription: letters around a circle, reading clockwise from nine o'clock, tops outward, spacing
// stretched so two passes exactly fill the ring (like the SVG textLength). Returns colour + emissive canvases.
function drawInscription(cMap, cEm, state, vaultNo) {
  const N = cMap.width, mid = N / 2, ppu = N / (2 * RING_OUT);
  const text = inscriptionRing(state, vaultNo);
  const word = stateWord(state).toUpperCase();
  const r = 1.042 * ppu;                      // baseline radius (SVG r160.5)
  const fontPx = Math.round(0.0835 * ppu);    // SVG 13px
  const font = `500 ${fontPx}px "Inter Tight", "Inter", system-ui, sans-serif`;
  const chars = [...text];
  // mark which characters belong to the state word
  const isWord = new Array(chars.length).fill(false);
  let from = 0;
  for (;;) { const i = text.indexOf(word, from); if (i < 0) break; for (let k = 0; k < word.length; k++) isWord[[...text.slice(0, i)].length + k] = true; from = i + word.length; }
  for (const [c, emissive] of [[cMap, false], [cEm, true]]) {
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, N, N);
    if (emissive) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, N, N); }
    ctx.font = font;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'center';
    const widths = chars.map((ch) => ctx.measureText(ch).width);
    const natural = widths.reduce((a, b) => a + b, 0);
    const gap = (2 * Math.PI * r - natural) / chars.length;
    let s = 0;
    chars.forEach((ch, i) => {
      const theta = Math.PI + (s + widths[i] / 2) / r;
      s += widths[i] + gap;
      if (ch === ' ') return;
      if (emissive && !isWord[i]) return;
      ctx.save();
      ctx.translate(mid + r * Math.cos(theta), mid + r * Math.sin(theta));
      ctx.rotate(theta + Math.PI / 2);
      if (emissive) { ctx.fillStyle = '#fff'; ctx.fillText(ch, 0, 0); }
      else {
        // engraved: a dark cut with a faint brass catch-light on the lower lip
        ctx.fillStyle = 'rgba(255,236,190,0.35)';
        ctx.fillText(ch, 0, fontPx * 0.035);
        ctx.fillStyle = isWord[i] ? '#141108' : '#2a2012';
        ctx.fillText(ch, 0, 0);
      }
      ctx.restore();
    });
  }
}

// Inner face: ink, faint brass grid, the state word (Instrument Serif italic), vault number and heir.
function drawFace(cMap, cEm, state, vaultNo, heir) {
  const N = cMap.width, mid = N / 2, ppu = N / (2 * FIELD_R);
  const W = (x) => mid + (x - 200) * S * ppu;    // SVG x -> canvas px
  const word = stateWord(state);
  const heirTxt = heirLabel(heir);
  for (const [c, emissive] of [[cMap, false], [cEm, true]]) {
    const ctx = c.getContext('2d');
    ctx.fillStyle = emissive ? '#000' : INK;
    ctx.fillRect(0, 0, N, N);
    if (!emissive) {
      // a whisper of radial falloff so the enamel is not perfectly flat
      const g = ctx.createRadialGradient(mid, mid * 0.86, 0, mid, mid, mid);
      g.addColorStop(0, 'rgba(40,42,50,0.55)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, N, N);
      ctx.strokeStyle = 'rgba(200,169,106,0.11)';
      ctx.lineWidth = Math.max(1, 0.75 * S * ppu);
      ctx.beginPath();
      for (let v = 100; v <= 300; v += 20) { ctx.moveTo(W(v), 0); ctx.lineTo(W(v), N); }
      for (let v = 120; v <= 280; v += 20) { ctx.moveTo(0, W(v)); ctx.lineTo(N, W(v)); }
      ctx.stroke();
    }
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'center';
    ctx.fillStyle = emissive ? 'rgb(150,145,136)' : '#5a564f';
    ctx.font = `italic 400 ${Math.round(34 * S * ppu)}px "Instrument Serif", Georgia, serif`;
    ctx.fillText(word, mid, W(272));
    ctx.fillStyle = emissive ? 'rgb(84,80,74)' : '#3a3833';
    const small = Math.round(10 * S * ppu);
    ctx.font = `500 ${small}px "Inter Tight", "Inter", system-ui, sans-serif`;
    spacedText(ctx, `NO. ${vaultLabel(vaultNo)}`, mid, W(296), small * 0.2);
    if (heirTxt) {
      ctx.fillStyle = emissive ? 'rgb(120,104,70)' : '#4a3f2a';
      spacedText(ctx, (normState(state) === 'settled' ? 'LEFT TO ' : 'HEIR · ') + heirTxt, mid, W(316), small * 0.2);
    }
  }
}

// Concentric brushing for the brass: random fine rows along the lathe profile (v), constant around (u).
// Used as roughness and bump map, so the metal breaks highlights into fine rings like turned brass.
function brushedTexture() {
  const H = 2048, c = document.createElement('canvas');
  c.width = 4; c.height = H;
  const ctx = c.getContext('2d'), img = ctx.createImageData(4, H);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let lo = 0.5;
  for (let y = 0; y < H; y++) {
    lo = lo * 0.6 + rnd() * 0.4;
    const v = Math.round(255 * (0.42 + 0.34 * lo + 0.12 * (rnd() - 0.5)));
    for (let x = 0; x < 4; x++) { const i = (y * 4 + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
  }
  ctx.putImageData(img, 0, 0);
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.minFilter = LinearMipmapLinearFilter;
  return t;
}

function radialTexture(size, stops) {
  const c = makeCanvas(size), ctx = c.getContext('2d'), m = size / 2;
  const g = ctx.createRadialGradient(m, m, 0, m, m, m);
  stops.forEach(([o, a]) => g.addColorStop(o, `rgba(255,255,255,${a})`));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

// Procedural studio for reflections: gradient dome + three soft boxes, prefiltered once with PMREM.
function studioEnvironment(renderer) {
  const scene = new Scene();
  const dome = new Mesh(new SphereGeometry(20, 32, 16), new ShaderMaterial({
    side: BackSide, depthWrite: false,
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: 'varying vec3 vP; void main(){ float h = vP.y; vec3 top = vec3(0.30,0.29,0.27); vec3 mid = vec3(0.02,0.02,0.021); vec3 low = vec3(0.012,0.012,0.014); vec3 c = h > 0.0 ? mix(mid, top, pow(h, 0.8)) : mix(mid, low, pow(-h, 0.5)); gl_FragColor = vec4(c, 1.); }',
  }));
  scene.add(dome);
  const box = (w, h, intensity, tint, x, y, z) => {
    const m = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ color: new Color(tint).multiplyScalar(intensity), side: DoubleSide }));
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    scene.add(m);
    return m;
  };
  box(12, 5, 1.5, 0xfff6ea, -2, 7, 13);    // broad front softbox above the lens: top-lit band, dark lower lip
  box(5, 4, 9.0, 0xffffff, -9, 8, 5);      // hard key, upper left: the bright catch on the rings
  box(1.6, 12, 4.0, 0xffeedd, 11, 0, 4);   // strip, right: edge light when tilted
  box(10, 1.2, 0.6, 0xffffff, 0, -7, 9);   // faint floor bounce
  box(6, 6, 1.0, 0xd8e2ff, 4, 6, -10);     // cool back light
  const pmrem = new PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0.035, 0.1, 100);
  pmrem.dispose();
  scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  return rt;
}

// ---------- component ----------

export function createSeal3D(canvas, opts = {}) {
  const o = Object.assign({ state: 'alive', vaultNo: '0042', heir: '', autoBeat: 3000, background: null }, opts);
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: o.background == null, powerPreference: 'low-power', premultipliedAlpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NeutralToneMapping;
  renderer.toneMappingExposure = 1.2;
  if (o.background != null) renderer.setClearColor(o.background, 1); else renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  const env = studioEnvironment(renderer);
  scene.environment = env.texture;

  const camera = new PerspectiveCamera(28, 1, 0.1, 50);
  camera.position.set(0, 0, 1.62 / Math.tan((14 * Math.PI) / 180));
  camera.lookAt(0, 0, 0);

  const seal = new Group();
  scene.add(seal);

  // body (base draw call 1)
  const brassColor = new Color(BRASS);
  const brushed = brushedTexture();
  const bodyMat = new MeshStandardMaterial({ color: brassColor.clone(), metalness: 0.86, roughness: 0.62, roughnessMap: brushed, bumpMap: brushed, bumpScale: 0.2, envMapIntensity: 1.15 });
  const body = new Mesh(bodyGeometry(), bodyMat);
  seal.add(body);

  // face (base draw call 2): ink enamel; glow injected into the emissive term
  const faceMapC = makeCanvas(1024), faceEmC = makeCanvas(1024);
  const faceMap = new CanvasTexture(faceMapC), faceEm = new CanvasTexture(faceEmC);
  faceMap.colorSpace = faceEm.colorSpace = SRGBColorSpace;
  faceMap.anisotropy = faceEm.anisotropy = 4;
  const glowU = { uGlowColor: { value: new Color(HEX[normState(o.state)]) }, uGlow: { value: 0.3 } };
  const faceMat = new MeshStandardMaterial({ map: faceMap, emissiveMap: faceEm, emissive: 0xffffff, metalness: 0.25, roughness: 0.42, envMapIntensity: 0.55 });
  faceMat.onBeforeCompile = (sh) => {
    sh.uniforms.uGlowColor = glowU.uGlowColor;
    sh.uniforms.uGlow = glowU.uGlow;
    sh.fragmentShader = 'uniform vec3 uGlowColor;\nuniform float uGlow;\n' + sh.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n{ vec2 q = vEmissiveMapUv * 2.0 - 1.0; q.y -= 0.03; float d = length(q * vec2(0.62, 1.7)); totalEmissiveRadiance += uGlowColor * uGlow * exp(-d * d * 4.5); }');
  };
  const face = new Mesh(new CircleGeometry(FIELD_R, 96), faceMat);
  face.position.z = FACE_Z;
  seal.add(face);

  // inscription ring (extra 1)
  const insMapC = makeCanvas(2048), insEmC = makeCanvas(2048);
  const insMap = new CanvasTexture(insMapC), insEm = new CanvasTexture(insEmC);
  insMap.colorSpace = insEm.colorSpace = SRGBColorSpace;
  insMap.anisotropy = insEm.anisotropy = 8;
  const insMat = new MeshStandardMaterial({ map: insMap, emissiveMap: insEm, emissive: new Color(HEX[normState(o.state)]), emissiveIntensity: 1.2, transparent: true, metalness: 0.55, roughness: 0.62, envMapIntensity: 0.7, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const ins = new Mesh(new RingGeometry(RING_IN, RING_OUT, 160, 1), insMat);
  ins.position.z = INSCR_Z;
  seal.add(ins);

  // trace + glow (extras 2, 3)
  const traceU = {
    uColor: { value: new Color(HEX[normState(o.state)]) }, uIntensity: { value: 1.0 }, uSweep: { value: -1 }, uSweepAmt: { value: 0 },
    uSparse: { value: 0 }, uOpacity: { value: 1 }, uMix: { value: 1 }, uGlow: { value: 0 },
  };
  const traceMat = new ShaderMaterial({ uniforms: traceU, vertexShader: TRACE_VS, fragmentShader: TRACE_FS, transparent: true, toneMapped: false });
  const trace = new Mesh(traceGeometry(560, 8, 0.0085, 0.0085), traceMat);
  trace.renderOrder = 2;
  seal.add(trace);
  const glowTU = Object.assign({}, traceU, { uGlow: { value: 1 }, uOpacity: { value: 0.5 } });
  const traceGlowMat = new ShaderMaterial({ uniforms: glowTU, vertexShader: TRACE_VS, fragmentShader: TRACE_FS, transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false });
  const traceGlow = new Mesh(traceGeometry(560, 6, 0.042, 0.004), traceGlowMat);
  traceGlow.position.z = 0.002;
  traceGlow.renderOrder = 3;
  seal.add(traceGlow);

  // halo behind the disc (extra 4)
  const haloTex = radialTexture(256, [[0, 0.0], [0.62, 0.0], [0.72, 0.5], [0.8, 0.22], [1, 0]]);
  const haloMat = new MeshBasicMaterial({ map: haloTex, color: new Color(HEX[normState(o.state)]), transparent: true, opacity: 0.3, blending: AdditiveBlending, depthWrite: false, toneMapped: false });
  const halo = new Mesh(new PlaneGeometry(3.3, 3.3), haloMat);
  halo.position.z = -0.12;
  halo.renderOrder = -1;
  seal.add(halo);

  // soft state light just in front of the face; tints the inner bevel and band
  const light = new PointLight(HEX[normState(o.state)], 0.7, 2.6, 2);
  light.position.set(0, 0.03, 0.3);
  seal.add(light);

  // ---------- state ----------
  let state = normState(o.state), vaultNo = o.vaultNo, heir = o.heir;
  const P = {};   // tweened scalars
  const tweens = {};
  const look = LOOK[state];
  for (const k of Object.keys(look)) P[k] = look[k];
  const color = new Color(HEX[state]), colorFrom = color.clone(), colorTo = color.clone();
  let colorT0 = -1, colorDur = 700;
  const tween = (k, to, dur, now) => { tweens[k] = { from: P[k], to, t0: now, dur }; };

  const redraw = () => {
    drawInscription(insMapC, insEmC, state, vaultNo);
    insMap.needsUpdate = insEm.needsUpdate = true;
    drawFace(faceMapC, faceEmC, state, vaultNo, heir);
    faceMap.needsUpdate = faceEm.needsUpdate = true;
  };
  redraw();

  // ---------- motion ----------
  const tilt = { x: 0, y: 0, tx: 0, ty: 0 };
  let beatT0 = -1e9, sweepT0 = -1e9, nextAuto = 0, beatN = 0;
  let running = false, raf = 0, last = 0, t = 0, onScreen = true, frameMs = 0, destroyed = false;
  let firstFrame;
  const firstFramePromise = new Promise((r) => { firstFrame = r; });

  function resize() {
    const w = canvas.clientWidth || canvas.width || 1, h = canvas.clientHeight || canvas.height || 1;
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // keep the whole medallion (plus tilt margin) in view on narrow canvases
    const halfFov = (14 * Math.PI) / 180;
    const need = 1.62 / Math.min(1, camera.aspect);
    camera.position.z = need / Math.tan(halfFov);
    camera.updateProjectionMatrix();
    if (!running) renderOnce();
  }

  function step(now) {
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0.016;
    last = now;
    t += dt;
    // tweens
    for (const k of Object.keys(tweens)) {
      const tw = tweens[k], u = (now - tw.t0) / tw.dur;
      P[k] = tw.from + (tw.to - tw.from) * easeOutQuint(u);
      if (u >= 1) delete tweens[k];
    }
    if (colorT0 >= 0) {
      const u = (now - colorT0) / colorDur;
      color.copy(colorFrom).lerp(colorTo, easeOutQuint(u));
      if (u >= 1) colorT0 = -1;
    }
    // auto beat
    if (o.autoBeat > 0 && !reduce && (state === 'alive' || state === 'warning') && now >= nextAuto) {
      beatN++;
      const skip = state === 'warning' && beatN % 3 === 0;   // warning: a missed beat
      if (!skip) api.beat();
      nextAuto = now + (state === 'warning' ? o.autoBeat * (1.25 + 0.35 * Math.sin(beatN * 1.7)) : o.autoBeat);
    }
    // beat envelope: 90 ms rise, ~1 s ease-out-quint fall
    const bt = (now - beatT0) / 1000;
    const env = bt < 0 ? 0 : bt < 0.09 ? easeOutQuint(bt / 0.09) : 1 - easeOutQuint((bt - 0.09) / 1.1);
    const st = (now - sweepT0) / 1300;
    const sweep = st >= 0 && st <= 1 ? -0.08 + 1.16 * easeOutQuint(st) : -1;

    // breathing and drift
    const breath = reduce ? 0 : 0.5 - 0.5 * Math.cos((t * 2 * Math.PI) / 3);
    const drift = reduce ? 0 : P.drift;
    const dX = drift * 0.045 * Math.sin(t * 0.37), dY = drift * 0.06 * Math.sin(t * 0.23 + 1.1);
    const k = 1 - Math.exp(-dt * (reduce ? 1.4 : 4.2));
    tilt.x += (tilt.tx - tilt.x) * k;
    tilt.y += (tilt.ty - tilt.y) * k;
    seal.rotation.set(tilt.x + dX, tilt.y + dY, 0);
    seal.scale.setScalar(1 + 0.015 * breath + (reduce ? 0 : 0.02 * env));

    // colour + light
    const glowLevel = P.glow * (0.72 + 0.28 * breath + 0.9 * env);
    glowU.uGlowColor.value.copy(color);
    glowU.uGlow.value = 0.075 * glowLevel;
    traceU.uColor.value.copy(color);
    traceU.uIntensity.value = P.trace * (0.95 + 0.6 * env);
    traceU.uOpacity.value = 0.55 + 0.45 * P.trace;
    traceU.uSweep.value = sweep;
    traceU.uSweepAmt.value = sweep < -0.5 ? 0 : P.glow * (1 - st * 0.4);
    traceU.uSparse.value = P.sparse;
    traceU.uMix.value = P.amp * (1 - P.flat);
    glowTU.uOpacity.value = 0.42 * P.glow * (0.8 + 0.2 * breath) + 0.6 * env * P.glow + 0.05 * P.trace;
    insMat.emissive.copy(color);
    insMat.emissiveIntensity = 0.5 + 0.9 * P.glow * (0.8 + 0.4 * env);
    haloMat.color.copy(color);
    haloMat.opacity = P.glow * (0.16 + 0.08 * breath + 0.28 * env);
    light.color.copy(color);
    light.intensity = P.light * (0.85 + 0.15 * breath + 1.2 * env);
    bodyMat.color.copy(brassColor).lerp(new Color(BRASS_GREY), P.desat);
    bodyMat.envMapIntensity = 1.15 - 0.3 * P.desat;
  }

  function renderOnce() {
    const t0 = performance.now();
    renderer.render(scene, camera);
    frameMs = frameMs ? frameMs * 0.9 + (performance.now() - t0) * 0.1 : performance.now() - t0;
  }

  function loop(now) {
    raf = 0;
    if (!running || destroyed) return;
    step(now);
    renderOnce();
    firstFrame();
    raf = requestAnimationFrame(loop);
  }

  function updateRunning() {
    const should = !destroyed && onScreen && !document.hidden;
    if (should && !running) { running = true; last = 0; if (!raf) raf = requestAnimationFrame(loop); }
    else if (!should && running) { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
  }

  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((es) => { onScreen = es[es.length - 1].isIntersecting; updateRunning(); }, { rootMargin: '64px' }) : null;
  if (io) io.observe(canvas);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null;
  if (ro) ro.observe(canvas); else window.addEventListener('resize', resize);
  const onVis = () => updateRunning();
  document.addEventListener('visibilitychange', onVis);
  const onLost = (e) => { e.preventDefault(); };
  canvas.addEventListener('webglcontextlost', onLost);

  const api = {
    setState(next) {
      const s = normState(next);
      if (s === state) return;
      const now = performance.now();
      state = s;
      const L = LOOK[s];
      const dur = s === 'triggered' ? 600 : 800;
      for (const k of Object.keys(L)) tween(k, L[k], k === 'flat' ? 600 : dur, now);
      colorFrom.copy(color); colorTo.setHex(HEX[s]); colorT0 = now; colorDur = dur;
      redraw();
      canvas.setAttribute('data-state', s);
      if (!running) { step(now + dur); renderOnce(); }
    },
    beat() {
      const now = performance.now();
      if (state === 'triggered' || state === 'settled') return;
      beatT0 = now;
      sweepT0 = now;
    },
    setPointer(nx, ny) {
      const cx = Math.max(-1, Math.min(1, +nx || 0)), cy = Math.max(-1, Math.min(1, +ny || 0));
      tilt.ty = cx * TILT;     // pointer right -> face turns right
      tilt.tx = cy * TILT;     // pointer down (ny > 0) -> face tips down toward it
    },
    setHeir(name) { heir = name || ''; redraw(); if (!running) renderOnce(); },
    setVaultNo(str) { vaultNo = str; redraw(); if (!running) renderOnce(); },
    stats() {
      const r = renderer.info.render;
      return { triangles: r.triangles, calls: r.calls, frameMs: +frameMs.toFixed(2), programs: renderer.info.programs ? renderer.info.programs.length : 0, state, pixelRatio: renderer.getPixelRatio(), postprocessing: 0 };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      running = false;
      if (raf) cancelAnimationFrame(raf);
      if (io) io.disconnect();
      if (ro) ro.disconnect(); else window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVis);
      canvas.removeEventListener('webglcontextlost', onLost);
      scene.traverse((ob) => { if (ob.geometry) ob.geometry.dispose(); if (ob.material) ob.material.dispose(); });
      [faceMap, faceEm, insMap, insEm, haloTex, brushed].forEach((x) => x.dispose());
      env.dispose();
      renderer.dispose();
    },
    ready: null,
  };

  canvas.setAttribute('data-state', state);
  resize();

  // Fonts: the texture canvases use the page's @font-face fonts, which load lazily — ask for them explicitly.
  const fontLoads = typeof document !== 'undefined' && document.fonts
    ? Promise.race([
      Promise.all([
        document.fonts.load('italic 400 64px "Instrument Serif"'),
        document.fonts.load('500 64px "Inter Tight"'),
      ]).then(() => document.fonts.ready),
      new Promise((r) => setTimeout(r, 2500)),
    ]).catch(() => {})
    : Promise.resolve();
  api.ready = fontLoads.then(() => {
    if (destroyed) return api;
    redraw();
    updateRunning();
    if (!running) { renderOnce(); return api; }
    return Promise.race([firstFramePromise, new Promise((r) => setTimeout(r, 1500))]).then(() => api);
  });
  return api;
}
