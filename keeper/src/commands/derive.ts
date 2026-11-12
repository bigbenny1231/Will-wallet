import type { Chains } from '../chainsApi.js';
import { vaultPaths } from '../chains/derive.js';
import type { VaultView } from '../types.js';

/** Source addresses of an existing vault. The paths come from its view (salted per vault since contract v2). */
export async function deriveCommand(chains: Chains, contractId: string, vault: Pick<VaultView, 'token_id' | 'derivation_paths'>) {
  const paths = vaultPaths(vault);
  const a = await chains.deriveAddresses(contractId, paths);
  return {
    contract: contractId,
    token_id: vault.token_id,
    base: { path: paths.base, address: a.base, faucet: 'https://www.alchemy.com/faucets/base-sepolia', explorer: `https://sepolia.basescan.org/address/${a.base}` },
    monad: { path: paths.monad, address: a.monad, faucet: 'https://faucet.monad.xyz', explorer: `https://testnet.monadexplorer.com/address/${a.monad}` },
    solana: { path: paths.solana, address: a.solana, faucet: 'https://faucet.solana.com', explorer: `https://explorer.solana.com/address/${a.solana}?cluster=devnet` },
  };
}
