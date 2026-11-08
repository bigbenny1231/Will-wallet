// Would your crypto arrive? Four single-tap questions, scored here in the page. Nothing is sent anywhere.
const SITE = 'https://will-wallet-site.vercel.app/#would-it-arrive';

// How likely heirs are to find and move a wallet, by where its keys live and what they were told.
const FIND = { hardware: 0.25, paper: 0.45, exchange: 0.7, head: 0 };
const TOLD = { written: 0.5, exists: 0.15, none: 0 };

const KEYS_LINE = {
  hardware: 'A hardware wallet keeps thieves out, and heirs too, unless they have its PIN and recovery phrase.',
  paper: 'A seed phrase on paper works if someone finds it and knows what it is.',
  exchange: 'Exchanges have estate processes. Expect paperwork with each one.',
  head: 'Keys that live only in your memory leave with you.',
};
const TOLD_LINE = {
  written: 'Written steps are the single biggest help you can leave.',
  exists: 'Knowing a wallet exists is a start. Knowing where, and how, is what moves it.',
  none: 'If no one knows, no one will look.',
};
const AGENT_LINE = {
  no: '',
  limits: 'An agent with limits keeps paying within them until someone stops it.',
  full: 'An agent holding a full key can keep acting after you, with nothing to stop it.',
};

function score(a) {
  const wallets = Number(a.chains);
  const p = a.keys === 'head' ? 0 : Math.min(1, FIND[a.keys] + TOLD[a.know]);
  const found = Math.max(0, Math.min(wallets, Math.round(wallets * p)));
  return { wallets, found };
}

function headline({ wallets, found }) {
  if (wallets === 1) return found ? 'Your wallet would likely be found.' : 'Your wallet would likely not be found.';
  return found + ' of ' + wallets + ' wallets would likely be found.';
}

export function init() {
  const form = document.getElementById('quiz');
  const wait = document.getElementById('verdict-wait');
  const count = document.getElementById('quiz-count');
  const card = document.getElementById('verdict-card');
  const head = document.getElementById('verdict-head');
  const lines = document.getElementById('verdict-lines');
  const copy = document.getElementById('copy-result');
  const copyStatus = document.getElementById('copy-status');
  const names = ['keys', 'know', 'agent', 'chains'];
  let summary = '';

  function update() {
    const a = {};
    names.forEach((n) => { const c = form.querySelector('input[name="' + n + '"]:checked'); if (c) a[n] = c.value; });
    const done = Object.keys(a).length;
    count.textContent = done + ' of 4 answered.';
    if (done < 4) return;
    const s = score(a);
    head.textContent = headline(s);
    const items = [KEYS_LINE[a.keys], TOLD_LINE[a.know], AGENT_LINE[a.agent]];
    if (s.wallets > 1) items.push('Each chain is a separate search for your heirs.');
    items.push('A vault covers what you move into it. At settlement it pays your heirs on NEAR, has NEAR’s network sign Base, Monad and Solana payouts, and deletes its agent key. Testnet today.');
    lines.textContent = '';
    items.filter(Boolean).forEach((t) => { const li = document.createElement('li'); li.textContent = t; lines.append(li); });
    summary = 'Would my crypto arrive? ' + headline(s) + ' (A four-question check by Dead Man’s Wallet; a rough estimate, not advice.) ' + SITE;
    wait.hidden = true;
    card.hidden = false;
    copyStatus.textContent = '';
  }

  form.addEventListener('change', update);
  form.addEventListener('submit', (e) => e.preventDefault());

  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(summary);
      copyStatus.textContent = 'Copied.';
    } catch (_) {
      const t = document.createElement('textarea');
      t.value = summary; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.append(t); t.select();
      const ok = document.execCommand && document.execCommand('copy');
      t.remove();
      copyStatus.textContent = ok ? 'Copied.' : 'Copy did not work here. Select the result and copy it.';
    }
  });
}
