// Dead Man's Wallet landing page. Vanilla JS, no dependencies besides assets/pulse.js (design/pulse.js).
// No backend: every value here is a plain link. app.js only fills [data-link] anchors.
const CONFIG = {
  DASHBOARD_URL: 'https://app.deadmanswallet.dev',   // the dashboard is deployed separately; see dashboard/README.md
  DOCS_URL: 'https://github.com/bigbenny1231/will-wallet#readme',
  ONE_PAGER_URL: 'assets/attorney-one-pager.pdf',
  GITHUB_URL: 'https://github.com/bigbenny1231/will-wallet',
  CONTACT: 'https://github.com/bigbenny1231/will-wallet/issues'  // no mailbox exists yet; issues are the contact channel
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
})();
