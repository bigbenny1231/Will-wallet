import type { Chains } from '../chainsApi.js';

export async function deriveCommand(chains: Chains, contractId: string, tokenId: string) {
  const a = await chains.deriveAddresses(contractId, tokenId);
  return {
    contract: contractId,
    token_id: tokenId,
    base: { path: `base-${tokenId}`, address: a.base, faucet: 'https://www.alchemy.com/faucets/base-sepolia', explorer: `https://sepolia.basescan.org/address/${a.base}` },
    solana: { path: `sol-${tokenId}`, address: a.solana, faucet: 'https://faucet.solana.com', explorer: `https://explorer.solana.com/address/${a.solana}?cluster=devnet` },
  };
}
