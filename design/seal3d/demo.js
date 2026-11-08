import { createSeal3D, supportsWebGL } from '/site/js/seal3d.bundle.js';

const canvas = document.getElementById('seal3d');
const stats = document.getElementById('stats');
const params = new URLSearchParams(location.search);

if (!supportsWebGL()) {
  // the landing page keeps its SVG seal in this case
  const r = await fetch('/design/seal.svg');
  document.getElementById('stage').innerHTML = await r.text();
  stats.textContent = 'WebGL unavailable: SVG seal shown';
} else {
  const seal = createSeal3D(canvas, { state: params.get('state') || 'alive', autoBeat: params.has('nobeat') ? 0 : 3000 });
  window.__seal = seal;
  await seal.ready;
  document.documentElement.dataset.sealReady = '1';

  document.querySelectorAll('[data-state]').forEach((b) => b.addEventListener('click', () => {
    seal.setState(b.dataset.state);
    document.querySelectorAll('button[data-state]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    canvas.setAttribute('aria-label', `Will seal, vault ${document.getElementById('vault').value}: ${b.dataset.state}`);
  }));
  document.getElementById('beat').addEventListener('click', () => seal.beat());
  document.getElementById('heir').addEventListener('input', (e) => seal.setHeir(e.target.value));
  document.getElementById('vault').addEventListener('input', (e) => seal.setVaultNo(e.target.value || '0042'));

  // pointer tilt from anywhere on the page, relative to the seal's centre
  window.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    seal.setPointer(((e.clientX - r.left) / r.width) * 2 - 1, ((e.clientY - r.top) / r.height) * 2 - 1);
  });
  document.addEventListener('pointerleave', () => seal.setPointer(0, 0));

  setInterval(() => {
    const s = seal.stats();
    stats.textContent = `${s.state} · ${s.triangles} tris · ${s.calls} draw calls · ${s.frameMs} ms render · dpr ${s.pixelRatio}`;
  }, 500);
}
