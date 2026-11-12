// npx tsx src/chains/selfcheck.ts  -- offline vectors + live derivation/RPC checks.
import assert from 'node:assert/strict';
import { keccak256, toHex, toChecksumAddress } from './codec.js';
import { deriveAddresses, derivationPath, legacyPaths, vaultPaths } from './derive.js';
import { chainConfig, evmTxHash, getEvmStepArgs, broadcastEvm } from './evm.js';
import { getSolanaStepArgs, solanaTxSignature, broadcastSolana } from './solana.js';

assert.equal(toHex(keccak256(new Uint8Array())), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
assert.equal(toHex(keccak256(new TextEncoder().encode('a'.repeat(200)))).length, 64); // multi-block
assert.equal(toChecksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'), '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
assert.equal(
  evmTxHash('0x02f87183014a3480830f42408405f5e10082520894000000000000000000000000000000000000dead85e8d4a5100080c001a0488833e3912f3f6a2909811f5e3b98f74392cb9aba5fa927807db6ad9411f87aa069d220b745ac974c6465917e4d7ced686ff7dcee3f8c295c8a4bd9ca6672efc1'),
  '0x2079a032ef5d1cf7abdf5eb25638a3d88421e8ba885b409958bb6b672a3a9ce0',
);
assert.equal(
  solanaTxSignature('ATeKNaZSfowSiNlpVUam/tRbfMiakrXIxZeMPGmkzysh2Q5qn/+y8KoHEk6d8OM3+OZ0FQZ77JwwfJxoD1pR3AABAAED6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iwCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAzEkOkozS44c7s0P8ldozF5ymD02/RsLDbpEpnVXU5rkBAgIAAQwCAAAAQEIPAAAAAAA='),
  '27QTHoE8sRsRtvZRG6RMiLntqG6zh18eCU7DvBghcEbWKNVTgGZVSj4Y1jC87xFUtbydm5tuJFf5QdzJaLaARhYj',
);
assert.equal(chainConfig('monad', {}).chainId, 10143);
assert.equal(chainConfig('monad', {}).rpc, 'https://testnet-rpc.monad.xyz');
assert.equal(chainConfig('monad', {}).explorerTx('0xab'), 'https://testnet.monadexplorer.com/tx/0xab');
assert.equal(chainConfig('base', {}).chainId, 84532);
assert.equal(chainConfig('monad', { MONAD_RPC: 'http://x' }).rpc, 'http://x');
assert.throws(() => chainConfig('solana'));
const salted = { base: 'base-7-00aa', monad: 'monad-7-00aa', solana: 'sol-7-00aa' };
assert.equal(derivationPath('monad', salted), 'monad-7-00aa');
assert.equal(derivationPath('base', salted), 'base-7-00aa');
assert.equal(derivationPath('solana', salted), 'sol-7-00aa');
assert.deepEqual(vaultPaths({ token_id: '7', derivation_paths: salted }), salted);
assert.deepEqual(vaultPaths({ token_id: '7' }), { base: 'base-7', monad: 'monad-7', solana: 'sol-7' });
console.log('offline vectors ok');

if (!process.argv.includes('--offline')) {
  // (signature above cross-checked with the bs58 npm package)
  // chainsig.js deriveAddressAndPublicKey gave these for the probe contract (docs/chainsig-notes.md)
  const d = await deriveAddresses('dmw-sig-4e3b1c65.testnet', legacyPaths(1));
  assert.equal(d.base, '0xcA024adC7cac111339Fe077C739F8085aE705F2F');
  assert.equal(d.solana, 'CFdWXa1ean7bBoewSv2SZESrDpWSxeoN1hfLrqaqZQUr');
  assert.match(d.monad, /^0x[0-9a-fA-F]{40}$/);
  assert.notEqual(d.monad, d.base);
  console.log('derive ok', d);
  console.log('evm args', await getEvmStepArgs(d.base));
  console.log('monad args', await getEvmStepArgs(d.monad, 'monad'));
  console.log('solana args', await getSolanaStepArgs());
  await broadcastEvm('0x02f87183014a3480830f42408405f5e10082520894000000000000000000000000000000000000dead85e8d4a5100080c001a0488833e3912f3f6a2909811f5e3b98f74392cb9aba5fa927807db6ad9411f87aa069d220b745ac974c6465917e4d7ced686ff7dcee3f8c295c8a4bd9ca6672efc1')
    .then(() => console.log('evm broadcast accepted'), (e) => console.log('evm broadcast (expected while unfunded):', e.message));
}
void broadcastSolana;
