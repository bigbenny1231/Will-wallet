// Dead Man's Wallet landing page. Vanilla JS, no dependencies.
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

  var form = document.getElementById('waitlist-form');
  var status = document.getElementById('form-status');
  if (!form) return;
  form.setAttribute('action', CONFIG.WAITLIST_ENDPOINT);

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    status.className = 'status';
    var email = form.elements.email.value.trim();
    if (form.elements._gotcha.value) { status.textContent = 'Thanks, you are on the list.'; form.reset(); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      status.className = 'status err';
      status.textContent = 'Please enter a valid email address.';
      return;
    }
    status.textContent = 'Sending...';
    fetch(CONFIG.WAITLIST_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ email: email })
    }).then(function (r) {
      if (!r.ok) throw new Error('bad status');
      status.textContent = 'Thanks, you are on the list. We will email you when mainnet opens.';
      form.reset();
    }).catch(function () {
      status.className = 'status err';
      status.textContent = 'Something went wrong. Please try again, or email ' + CONFIG.CONTACT.replace('mailto:', '') + '.';
    });
  });
})();
