// Bundle the seal to one ES module for the site:  node design/seal3d/build.mjs
import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import zlib from 'zlib';
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '..', '..', 'site', 'js', 'seal3d.bundle.js');
await build({
  entryPoints: [path.join(here, 'seal3d.js')],
  bundle: true, format: 'esm', minify: true, target: 'es2020', treeShaking: true,
  outfile: out, legalComments: 'eof', logLevel: 'info',
  banner: { js: '/* Dead Man\'s Wallet seal3d (three.js, MIT) — built from design/seal3d/seal3d.js */' },
});
const buf = fs.readFileSync(out);
console.log(`${path.relative(process.cwd(), out)}: ${(buf.length / 1024).toFixed(1)} KB, ${(zlib.gzipSync(buf, { level: 9 }).length / 1024).toFixed(1)} KB gz`);
