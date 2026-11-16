/**
 * Picks the port implementations for a config. `fake` works today; `core` is where @sigsig/core's
 * VaultReader and tx builders get plugged in once they land (see README "Wiring @sigsig/core").
 */
import type { VaultReader } from '@sigsig/core';
import type { KeeperConfig } from './config.js';
import { ElectrumKeeperChain } from './electrum.js';
import { createFakePorts, type FakeWorld } from './fake.js';
import type { KeeperWallet } from './keeper.js';
import type { KeeperBuilders, KeeperChain } from './ports.js';
import { walletFromWif } from './wallet.js';

export interface Runtime {
  config: KeeperConfig;
  reader: VaultReader;
  builders: KeeperBuilders;
  chain: KeeperChain;
  wallet: KeeperWallet | null;
  world?: FakeWorld;
}

/** Implementations from @sigsig/core. Fill in when core exports them. */
export interface CorePorts {
  reader: VaultReader;
  builders: KeeperBuilders;
}

export async function createRuntime(
  config: KeeperConfig,
  loadCore: (config: KeeperConfig) => Promise<CorePorts> = defaultLoadCore,
): Promise<Runtime> {
  if (config.backend === 'fake') {
    const ports = createFakePorts();
    const vaults = config.vaults.length ? config.vaults : ports.world.entries();
    return { config: { ...config, vaults }, reader: ports.reader, builders: ports.builders, chain: ports.chain, wallet: ports.wallet, world: ports.world };
  }
  const { reader, builders } = await loadCore(config);
  const chain = new ElectrumKeeperChain(config.network, config.electrumHost);
  const wallet = config.wif ? walletFromWif(config.wif, config.network) : null;
  return { config, reader, builders, chain, wallet };
}

async function defaultLoadCore(_config: KeeperConfig): Promise<CorePorts> {
  // TODO(wiring): e.g.
  //   const core = await import('@sigsig/core');
  //   const provider = new ElectrumNetworkProvider(config.network, ...);
  //   return { reader: core.createVaultReader(provider, deployment), builders: adaptCoreBuilders(core, provider) };
  throw new Error('KEEPER_BACKEND=core is not wired yet: @sigsig/core does not export VaultReader/buildDefend/buildSkim. Use KEEPER_BACKEND=fake.');
}
