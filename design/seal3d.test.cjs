// Checks the 3D seal bundle: it exists, fits the size budget, exports the API, and builds the rim inscription
// exactly like the 2D seal for every state.   node design/seal3d.test.cjs
// (Rebuild first if seal3d.js changed:  node design/seal3d/build.mjs)
const fs = require('fs'), path = require('path'), zlib = require('zlib'), assert = require('assert');
const { pathToFileURL } = require('url');

const BUNDLE = path.join(__dirname, '..', 'site', 'js', 'seal3d.bundle.js');
const BUDGET_GZ = 450 * 1024;
let pass = 0, fail = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('ok  ', name); }, (e) => { fail++; console.log('FAIL', name, '-', e.message); });

(async () => {
  await check('bundle exists', () => assert(fs.existsSync(BUNDLE), BUNDLE + ' missing'));
  const buf = fs.existsSync(BUNDLE) ? fs.readFileSync(BUNDLE) : Buffer.alloc(0);
  const gz = zlib.gzipSync(buf, { level: 9 }).length;
  await check(`bundle within budget (${(buf.length / 1024).toFixed(1)} KB, ${(gz / 1024).toFixed(1)} KB gz <= 450 KB gz)`, () => assert(gz > 0 && gz <= BUDGET_GZ));
  await check('bundle is self-contained (no CDN / bare imports)', () => {
    const src = buf.toString('utf8');
    assert(!/\bimport\s*[^;]*?from\s*["']/.test(src), 'bundle still imports another module');
    assert(!/https?:\/\/(cdn|unpkg|esm\.sh|cdnjs|jsdelivr)/i.test(src), 'CDN reference');
  });
  await check('bundle has an ES export of the API names', () => {
    const tail = buf.toString('utf8').match(/export\s*\{([^}]*)\}/);
    assert(tail, 'no export statement');
    const names = tail[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop());
    for (const n of ['createSeal3D', 'supportsWebGL', 'inscriptionText']) assert(names.includes(n), n + ' not exported');
  });

  const mod = await import(pathToFileURL(BUNDLE).href);
  const src = await import(pathToFileURL(path.join(__dirname, 'seal3d', 'inscription.js')).href);
  await check('module exports are functions', () => {
    for (const n of ['createSeal3D', 'supportsWebGL', 'inscriptionText', 'stateWord']) assert.strictEqual(typeof mod[n], 'function', n);
    assert.strictEqual(mod.supportsWebGL(), false, 'no WebGL in node: the page keeps the SVG seal');
  });
  await check('createSeal3D source declares the full handle API', () => {
    const js = fs.readFileSync(path.join(__dirname, 'seal3d', 'seal3d.js'), 'utf8');
    for (const m of ['setState(', 'beat(', 'setPointer(', 'setHeir(', 'setVaultNo(', 'destroy(', 'ready:']) assert(js.includes(m), m);
  });

  const expect = {
    alive: 'DEAD MAN’S WALLET · VAULT 0042 · ALIVE',
    warning: 'DEAD MAN’S WALLET · VAULT 0042 · WARNING',
    triggered: 'DEAD MAN’S WALLET · VAULT 0042 · TRIGGERED',
    settled: 'DEAD MAN’S WALLET · VAULT 0042 · SETTLED',
  };
  for (const [state, want] of Object.entries(expect)) {
    await check(`inscription for ${state}`, () => {
      assert.strictEqual(mod.inscriptionText(state, '0042'), want);
      assert.strictEqual(src.inscriptionText(state, '0042'), want);
    });
  }
  await check('site short state names map to the same inscription (warn/dead/still)', () => {
    assert.strictEqual(mod.inscriptionText('warn', '0042'), expect.warning);
    assert.strictEqual(mod.inscriptionText('dead', '0042'), expect.triggered);
    assert.strictEqual(mod.inscriptionText('still', '0042'), expect.settled);
    assert.strictEqual(mod.inscriptionText(undefined), expect.alive, 'default state + vault');
  });
  await check('vault numbers pad to four digits and match the SVG wording', () => {
    assert.strictEqual(mod.inscriptionText('alive', 42), expect.alive);
    assert.strictEqual(mod.inscriptionText('alive', '7'), 'DEAD MAN’S WALLET · VAULT 0007 · ALIVE');
    assert.strictEqual(mod.inscriptionText('alive', '12345'), 'DEAD MAN’S WALLET · VAULT 12345 · ALIVE');
    const svg = fs.readFileSync(path.join(__dirname, 'seal.svg'), 'utf8');
    assert(svg.includes('DEAD MAN&#8217;S WALLET &#183; VAULT 0042 &#183;'), 'seal.svg wording changed');
  });
  await check('rim carries two passes, each closed with a middle dot', () => {
    assert.strictEqual(mod.inscriptionRing('alive', '0042'), `${expect.alive} · ${expect.alive} ·`);
  });
  await check('state words', () => {
    assert.deepStrictEqual(['alive', 'warning', 'triggered', 'settled'].map(mod.stateWord), ['Alive', 'Warning', 'Triggered', 'Settled']);
  });

  console.log(`${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
