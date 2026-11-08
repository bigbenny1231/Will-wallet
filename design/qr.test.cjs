// Checks design/qr.js against npm `qrcode` (taken from dashboard/node_modules) for every version and mask.
//   node design/qr.test.cjs
const path = require('path');
const ours = require('./qr.js');
const ref = require(path.join(__dirname, '..', 'dashboard', 'node_modules', 'qrcode'));

const texts = ['a', 'https://will-wallet.vercel.app/pulse', 'https://will-wallet-site.vercel.app/#would-it-arrive', 'x'.repeat(60), 'y'.repeat(100)];
let fails = 0, checks = 0;
for (const t of texts) {
  const auto = ours.matrix(t);
  for (let mask = 0; mask < 8; mask++) {
    const a = ours.matrix(t, mask, auto.version);
    const b = ref.create(t, { errorCorrectionLevel: 'M', maskPattern: mask, version: auto.version, toSJISFunc: null });
    const size = b.modules.size;
    let same = size === a.size;
    for (let r = 0; same && r < size; r++) for (let c = 0; c < size; c++) if (!!b.modules.get(r, c) !== a.rows[r][c]) { same = false; break; }
    checks++;
    if (!same) { fails++; console.log('MISMATCH', JSON.stringify(t.slice(0, 20)), 'v' + auto.version, 'mask', mask); }
  }
  const b = ref.create(t, { errorCorrectionLevel: 'M' });
  console.log(JSON.stringify(t.slice(0, 24)), 'v' + auto.version, 'mask', auto.mask, '| qrcode picks v' + b.version, 'mask', b.maskPattern);
}
console.log(checks - fails + '/' + checks + ' matrices identical');
process.exit(fails ? 1 : 0);
