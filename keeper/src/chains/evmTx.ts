// EIP-1559 (type 2) native transfers: build, sign (funder key), decode. The same envelope the contract's MPC
// signature produces (contracts/dmw/src/foreign.rs evm_tx): 0x02 || rlp([chainId, nonce, maxPriorityFeePerGas,
// maxFeePerGas, gasLimit, to, value, data, accessList, yParity, r, s]).
import { secp256k1 } from '@noble/curves/secp256k1';
import { bigToBytes, bytesToBig, evmAddressFromPubkey64, fromHex, keccak256, rlpDecode, rlpEncode, toChecksumAddress, toHex, type RlpItem } from './codec.js';

export interface Eip1559Fields {
  chainId: number;
  nonce: number;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  /** 0x-prefixed 20-byte address */
  to: string;
  value: bigint;
}

export interface DecodedEip1559 extends Eip1559Fields {
  yParity: number;
  r: bigint;
  s: bigint;
  /** sender recovered from the signature (checksummed) */
  from: string;
  /** keccak256 of the raw tx */
  hash: string;
}

function unsignedList(t: Eip1559Fields): RlpItem[] {
  const to = fromHex(t.to);
  if (to.length !== 20) throw new Error(`bad EVM address ${t.to}`);
  return [
    bigToBytes(BigInt(t.chainId)),
    bigToBytes(BigInt(t.nonce)),
    bigToBytes(t.maxPriorityFeePerGas),
    bigToBytes(t.maxFeePerGas),
    bigToBytes(t.gasLimit),
    to,
    bigToBytes(t.value),
    new Uint8Array(), // data
    [], // access list
  ];
}

const typed = (payload: Uint8Array) => Uint8Array.from([0x02, ...payload]);

/** The digest that is signed: keccak256(0x02 || rlp(unsigned fields)). */
export const eip1559SigningHash = (t: Eip1559Fields): Uint8Array => keccak256(typed(rlpEncode(unsignedList(t))));

/** EVM address of a 32-byte secp256k1 private key. */
export function evmAddressOfKey(priv: Uint8Array): string {
  const pub = secp256k1.getPublicKey(priv, false); // 65 bytes, 0x04 || x || y
  return evmAddressFromPubkey64(pub.subarray(1));
}

/** Sign a native transfer; returns the raw tx as 0x hex and its hash. Low-s, RFC 6979 deterministic. */
export function signEip1559(t: Eip1559Fields, priv: Uint8Array): { raw: string; hash: string } {
  if (t.maxPriorityFeePerGas > t.maxFeePerGas) throw new Error('priority fee above max fee');
  const sig = secp256k1.sign(eip1559SigningHash(t), priv, { lowS: true });
  const list = [...unsignedList(t), bigToBytes(BigInt(sig.recovery)), bigToBytes(sig.r), bigToBytes(sig.s)];
  const raw = typed(rlpEncode(list));
  return { raw: '0x' + toHex(raw), hash: '0x' + toHex(keccak256(raw)) };
}

const asBytes = (x: RlpItem | undefined, what: string): Uint8Array => {
  if (!(x instanceof Uint8Array)) throw new Error(`EIP-1559 tx: ${what} is not a byte string`);
  return x;
};
const num = (x: RlpItem | undefined, what: string) => bytesToBig(asBytes(x, what));

/** Decode a signed type-2 tx (0x hex), recover its sender. Throws on anything else (legacy, type 1, calldata). */
export function decodeEip1559(rawHex: string): DecodedEip1559 {
  const raw = fromHex(rawHex);
  if (raw[0] !== 0x02) throw new Error('not an EIP-1559 (type 2) transaction');
  const list = rlpDecode(raw.subarray(1));
  if (!Array.isArray(list) || list.length !== 12) throw new Error('EIP-1559 tx: expected 12 fields');
  const to = asBytes(list[5], 'to');
  if (to.length !== 20) throw new Error('EIP-1559 tx: not a transfer to an address');
  const t: Eip1559Fields = {
    chainId: Number(num(list[0], 'chainId')),
    nonce: Number(num(list[1], 'nonce')),
    maxPriorityFeePerGas: num(list[2], 'maxPriorityFeePerGas'),
    maxFeePerGas: num(list[3], 'maxFeePerGas'),
    gasLimit: num(list[4], 'gasLimit'),
    to: toChecksumAddress('0x' + toHex(to)),
    value: num(list[6], 'value'),
  };
  const yParity = Number(num(list[9], 'yParity'));
  const r = num(list[10], 'r');
  const s = num(list[11], 's');
  if (yParity !== 0 && yParity !== 1) throw new Error('EIP-1559 tx: bad yParity');
  const pub = new secp256k1.Signature(r, s).addRecoveryBit(yParity).recoverPublicKey(eip1559SigningHash(t)).toRawBytes(false);
  return { ...t, yParity, r, s, from: evmAddressFromPubkey64(pub.subarray(1)), hash: '0x' + toHex(keccak256(raw)) };
}

/** Most wei a signed transfer can take from its sender: value + gasLimit x maxFeePerGas (what a node checks). */
export const evmTxMaxCost = (t: Pick<Eip1559Fields, 'value' | 'gasLimit' | 'maxFeePerGas'>) => t.value + t.gasLimit * t.maxFeePerGas;
