import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getSource, type Net, type PayDraft, type KeeperAction } from './source';
import { DATA_SOURCE, DEMO_VAULT_ID } from '../config/app';
import { mockSnapshot } from './mock';

export const qk = {
  vaults: (n: Net) => ['vaults', n] as const,
  vault: (id: string) => ['vault', id] as const,
  activity: (id: string) => ['activity', id] as const,
  request: (id: string) => ['request', id] as const,
  checks: (d: PayDraft) => ['checks', d.vaultId, d.payeeIndex, d.amountCents.toString()] as const,
};

export function makeQueryClient() {
  const qc = new QueryClient({
    defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false } },
  });
  // The landing hero is prerendered with the mock snapshot; hydration seeds the same data so the markup matches.
  if (DATA_SOURCE === 'mock') {
    const snap = mockSnapshot();
    qc.setQueryData(qk.vault(DEMO_VAULT_ID), snap.vault);
    qc.setQueryData(qk.activity(DEMO_VAULT_ID), snap.activity);
  }
  return qc;
}

export const useVaults = (n: Net) =>
  useQuery({ queryKey: qk.vaults(n), queryFn: async () => (await getSource()).listVaults(n) });

export const useVault = (id: string) =>
  useQuery({ queryKey: qk.vault(id), queryFn: async () => (await getSource()).getVault(id) });

export const useActivity = (id: string) =>
  useQuery({ queryKey: qk.activity(id), queryFn: async () => (await getSource()).getActivity(id) });

export const useSignRequest = (id: string) =>
  useQuery({ queryKey: qk.request(id), queryFn: async () => (await getSource()).getSignRequest(id) });

export const usePayChecks = (d: PayDraft, enabled: boolean) =>
  useQuery({ queryKey: qk.checks(d), queryFn: async () => (await getSource()).checkPay(d), enabled, placeholderData: (prev) => prev });

export function useKeeperBroadcast() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ vaultId, action }: { vaultId: string; action: KeeperAction }) => {
      const s = await getSource();
      const built = await s.buildKeeperTx(vaultId, action);
      const res = await s.broadcast(built.txHex);
      return { built, ...res };
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['vaults'] });
      qc.invalidateQueries({ queryKey: qk.vault(v.vaultId) });
    },
  });
}
