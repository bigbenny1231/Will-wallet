// Dead Man's Wallet landing page. Vanilla JS, no dependencies besides assets/pulse.js (design/pulse.js).
const CONFIG = {
  DASHBOARD_URL: 'https://app.deadmanswallet.dev',   // placeholder
  DOCS_URL: '#docs',                                  // placeholder
  ONE_PAGER_URL: '#',                                 // placeholder
  GITHUB_URL: 'https://github.com/PLACEHOLDER/deadmans-wallet', // placeholder
  CONTACT: 'mailto:hello@deadmanswallet.dev',         // placeholder
  WAITLIST_ENDPOINT: 'https://formspree.io/f/PLACEHOLDER' // Formspree-style endpoint (placeholder)
};

(function () {
  var links = {
    dashboard: CONFIG.DASHBOARD_URL,
    heir: CONFIG.DASHBOARD_URL.replace(/\/$/, '') + '/heir',
    docs: CONFIG.DOCS_URL,
    onepager: CONFIG.ONE_PAGER_URL,
    github: CONFIG.GITHUB_URL,
    contact: CONFIG.CONTACT
  };
  document.querySelectorAll('[data-link]').forEach(function (a) {
    var u = links[a.getAttribute('data-link')];
    if (u) a.setAttribute('href', u);
  });

  // The pulse strip flatlines once "How it works" scrolls into view; the steps appear as ticks on the line.
  if (window.DMWPulse) {
    var strip = document.getElementById('strip');
    window.DMWPulse.watchStrip(strip, { target: strip, rootMargin: '0px 0px -38% 0px' });
  }

  // Demo player: a quiet overlay until the visitor asks for it, then native controls.
  var video = document.getElementById('demo-video');
  var play = document.querySelector('.play');
  if (video && play) {
    var player = video.closest('.player');
    play.addEventListener('click', function () {
      video.controls = true;
      player.classList.add('is-playing');
      var p = video.play();
      if (p && p.catch) p.catch(function () { /* source missing or blocked: controls stay visible */ });
      video.focus();
    });
  }

  var form = document.getElementById('waitlist-form');
  var status = document.getElementById('form-status');
  if (!form) return;
  form.setAttribute('action', CONFIG.WAITLIST_ENDPOINT);

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    status.className = 'status';
    var email = form.elements.email.value.trim();
    if (form.elements._gotcha.value) { status.textContent = 'You are on the list.'; form.reset(); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      status.className = 'status err';
      status.textContent = 'Enter a full email address, like you@example.com.';
      return;
    }
    status.textContent = 'Sending.';
    fetch(CONFIG.WAITLIST_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ email: email })
    }).then(function (r) {
      if (!r.ok) throw new Error('bad status');
      status.textContent = 'You are on the list. One email when mainnet opens.';
      form.reset();
    }).catch(function () {
      status.className = 'status err';
      status.textContent = 'That did not go through. Try again, or email ' + CONFIG.CONTACT.replace('mailto:', '') + '.';
    });
  });
})();
