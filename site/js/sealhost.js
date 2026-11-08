// The hero seal: the SVG seal always, and the WebGL seal from js/seal3d.bundle.js on top of it when that is
// switched on (<html data-seal3d="on">) and the browser supports WebGL. The SVG stays in the DOM as the
// accessible image and the fallback. Pointer tilt on desktop, DeviceOrientation on phones after a tap.
import { setSeal, setSealHeir, reducedMotion } from './seal.js';

let loading = null;

const TO3D = { alive: 'alive', warn: 'warning', dead: 'triggered', still: 'settled' };
const clamp = (v) => Math.max(-1, Math.min(1, v));

export function createHeroSeal(wrap, vaultNo) {
  const svg = wrap.querySelector('.seal');
  const tilt = wrap.querySelector('.seal-tilt');
  let s3 = null;
  let state = 'alive';
  let heir = 'Sarah';

  const api = {
    svg,
    get is3D() { return !!s3; },
    setState(st, word) {
      state = st;
      setSeal(svg, st, word);
      if (s3) s3.setState(TO3D[st]);
    },
    beat() { if (s3) s3.beat(); },
    setHeir(name) {
      heir = name;
      setSealHeir(svg, name);
      if (s3) s3.setHeir(name);
    },
    setPointer(nx, ny) {
      nx = clamp(nx); ny = clamp(ny);
      if (s3) s3.setPointer(nx, ny);
      else if (tilt) { tilt.style.setProperty('--ry', (nx * 14).toFixed(2) + 'deg'); tilt.style.setProperty('--rx', (-ny * 11).toFixed(2) + 'deg'); }
    },
  };

  // Integration hook for the WebGL seal (design/seal3d builds site/js/seal3d.bundle.js).
  api.load3D = () => (loading = loading || load3D());
  async function load3D() {
    if (document.documentElement.dataset.seal3d !== 'on') return false;
    try {
      const m = await import('./seal3d.bundle.js');
      if (!m.supportsWebGL || !m.supportsWebGL()) return false;
      const canvas = document.createElement('canvas');
      canvas.className = 'seal3d-canvas';
      canvas.setAttribute('aria-hidden', 'true');
      wrap.insertBefore(canvas, wrap.firstChild);
      // autoBeat 0: the page drives each beat (from the SVG seal's beat loop), so sound and seal stay in step.
      const inst = m.createSeal3D(canvas, { state: TO3D[state], heir, vaultNo, autoBeat: 0 });
      await Promise.resolve(inst.ready);
      s3 = inst;
      s3.setVaultNo(vaultNo);
      s3.setHeir(heir);
      s3.setState(TO3D[state]);
      wrap.classList.add('is-3d');
      return true;
    } catch (e) {
      console.warn('3D seal unavailable, keeping the SVG seal', e);
      return false;
    }
  }

  if (!reducedMotion()) {
    // Desktop: tilt toward the pointer while it is over the hero.
    const hero = wrap.closest('.hero');
    if (hero && matchMedia('(hover: hover) and (pointer: fine)').matches) {
      let raf = 0, px = 0, py = 0;
      hero.addEventListener('pointermove', (e) => {
        const r = wrap.getBoundingClientRect();
        px = (e.clientX - (r.left + r.width / 2)) / (r.width * 0.9);
        py = (e.clientY - (r.top + r.height / 2)) / (r.height * 0.9);
        wrap.classList.add('is-tracking');
        if (!raf) raf = requestAnimationFrame(() => { raf = 0; api.setPointer(px, py); });
      });
      hero.addEventListener('pointerleave', () => { wrap.classList.remove('is-tracking'); api.setPointer(0, 0); });
    }
    // Phones: DeviceOrientation, only after the visitor taps to turn it on (iOS asks for permission).
    const btn = document.getElementById('tilt');
    if (btn && 'DeviceOrientationEvent' in window && matchMedia('(pointer: coarse)').matches) {
      btn.hidden = false;
      btn.setAttribute('aria-pressed', 'false');
      let on = false;
      const onTilt = (e) => {
        if (e.gamma == null) return;
        api.setPointer(e.gamma / 28, (e.beta - 40) / 28);
      };
      btn.addEventListener('click', async () => {
        if (!on) {
          try {
            const D = window.DeviceOrientationEvent;
            if (typeof D.requestPermission === 'function' && (await D.requestPermission()) !== 'granted') return;
          } catch (_) { return; }
          window.addEventListener('deviceorientation', onTilt);
          wrap.classList.add('is-tracking');
        } else {
          window.removeEventListener('deviceorientation', onTilt);
          wrap.classList.remove('is-tracking');
          api.setPointer(0, 0);
        }
        on = !on;
        btn.setAttribute('aria-pressed', String(on));
        btn.textContent = on ? 'Stop tilting the seal' : 'Tilt the seal with your phone';
      });
    }
  }
  return api;
}
