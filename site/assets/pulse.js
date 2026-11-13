/* Lastword: the pulse motif.
 * Shared module for the site and the dashboard. Plain script, no dependencies; exposes window.DMWPulse.
 * design/build_site.py copies this file to site/assets/pulse.js; edit it here, not there.
 *
 *   DMWPulse.complex(x, y, scale)  -> SVG path data for one ECG complex (P, QRS, T), 100 units wide at scale 1
 *   DMWPulse.stripMarkup(opts)     -> the full-width strip <svg> (also pre-rendered into index.html)
 *   DMWPulse.watchStrip(el, opts)  -> flatline the strip when it scrolls into view (one way, like the product)
 *   DMWPulse.beat(sealEl)          -> restart the seal's beat now, e.g. on a real heartbeat event
 *   DMWPulse.setState(el, state)   -> 'alive' | 'warn' | 'dead' | 'still' recolours a seal or strip
 */
(function (root) {
  'use strict';

  var STATE_COLOR = { alive: '#3DDC84', warn: '#F5B942', dead: '#FF4D4D', still: '#7A7F87' };

  function n(v) { return Math.round(v * 100) / 100; }

  function complex(x, y, s) {
    s = s || 1;
    function p(dx, dy) { return n(x + dx * s) + ',' + n(y + dy * s); }
    return 'M' + p(0, 0) +
      'C' + p(4, 0) + ' ' + p(6, -6) + ' ' + p(10, -6) +
      'C' + p(14, -6) + ' ' + p(16, 0) + ' ' + p(20, 0) +
      'L' + p(30, 0) + 'L' + p(34, 5) + 'L' + p(40, -46) + 'L' + p(46, 16) + 'L' + p(50, 0) +
      'L' + p(60, 0) +
      'C' + p(66, 0) + ' ' + p(70, -12) + ' ' + p(78, -12) +
      'C' + p(86, -12) + ' ' + p(90, 0) + ' ' + p(96, 0) +
      'L' + p(100, 0);
  }

  // viewBox is wider than any screen; preserveAspectRatio="xMidYMid slice" keeps beats undistorted and centred.
  function stripMarkup(opts) {
    opts = opts || {};
    var W = opts.width || 2400, H = opts.height || 140, Y = H / 2, pitch = opts.pitch || 200, start = opts.start || 50;
    var out = [];
    out.push('<svg class="strip-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">');
    out.push('<defs><filter id="strip-bloom" x="-20%" y="-80%" width="140%" height="260%"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>');
    out.push('<path class="strip-base" d="M0,' + Y + 'H' + W + '"/>');
    var i = 0;
    for (var x = start; x + 100 <= W; x += pitch, i++) {
      var d = complex(x, Y, 1);
      out.push('<g class="beat" style="--i:' + i + '"><path class="beat-base" d="' + d + '"/><path class="beat-hi" pathLength="100" filter="url(#strip-bloom)" d="' + d + '"/></g>');
    }
    out.push('</svg>');
    return out.join('');
  }

  function reducedMotion() {
    return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function watchStrip(el, opts) {
    if (!el) return;
    opts = opts || {};
    var flat = function () { el.classList.add('is-flat'); if (opts.onFlat) opts.onFlat(el); };
    el.classList.add('is-armed');
    if (!('IntersectionObserver' in root)) { flat(); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { flat(); io.disconnect(); }
      });
    }, { rootMargin: opts.rootMargin || '0px 0px -40% 0px', threshold: 0 });
    io.observe(opts.target || el);
  }

  function beat(seal) {
    if (!seal || reducedMotion()) return;
    var parts = seal.querySelectorAll('.trace-hi, .glow');
    Array.prototype.forEach.call(parts, function (p) {
      p.style.animation = 'none';
      void p.getBoundingClientRect();
      p.style.animation = '';
    });
  }

  function setState(el, state) {
    if (!el || !STATE_COLOR[state]) return;
    el.style.setProperty('--state', STATE_COLOR[state]);
    el.setAttribute('data-state', state);
  }

  root.DMWPulse = { complex: complex, stripMarkup: stripMarkup, watchStrip: watchStrip, beat: beat, setState: setState, STATE_COLOR: STATE_COLOR };
  if (typeof module === 'object' && module.exports) module.exports = root.DMWPulse;
})(typeof window !== 'undefined' ? window : globalThis);
