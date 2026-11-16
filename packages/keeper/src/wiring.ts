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

async function defaultLoadCore(config: KeeperConfig): Promise<CorePorts> {
  const core = await import('@sigsig/core');
  const profile = await core.loadNetworkProfile(config.network, process.env.KEEPER_CHIPNET_DEPLOYMENT);
  if (config.electrumHost) profile.electrumServers = [config.electrumHost, ...profile.electrumServers];
  if (!profile.paryon) throw new Error(`No Paryon deployment for ${config.network} (chipnet: run packages/oracle deploy first)`);
  const provider = core.createProvider(profile);
  const ctx = core.createParyonContext(config.network, profile.paryon, provider);
  const reader = new core.ElectrumVaultReader({ network: config.network, deployment: profile.paryon, provider, vault: core.vaultAdapter });
  const builders: KeeperBuilders = {
    async buildDefend(vault, _health, funding, plan) {
      const r = await core.buildDefend(core.createVaultTxContext(ctx, vault), {
        repayCents: plan.repayCents, addCollateralSats: plan.addCollateralSats, feeClaimSats: plan.feeClaimSats, rewardTo: funding.address,
      });
      return r;
    },
    async buildSkim(vault, _health, funding, plan) {
      return core.buildSkim(core.createVaultTxContext(ctx, vault), {
        withdrawSats: plan.withdrawSats, feeClaimSats: plan.feeClaimSats, rewardTo: funding.address,
      });
    },
    async vaultAddresses(vault) {
      const v = core.createVaultTxContext(ctx, vault).vault;
      return [v.address, v.tokenAddress];
    },
  };
  return { reader, builders };
}
