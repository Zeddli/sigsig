/**
 * The wallet the app talks to, behind one small interface (types.ts): connect(), getAddress(),
 * signTransaction(BuiltTx). React side: a context with the current wallet, its address and the network.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_NETWORK } from '../config/app';
import type { Net } from '../data/source';
import type { Pairing, Wallet, WalletId } from './types';
import { createWizardConnect } from './wizardconnect';
import { createXo } from './xo';

export * from './types';

export function createWallet(id: WalletId, network: Net): Wallet {
  return id === 'wizardconnect' ? createWizardConnect(network) : createXo();
}

interface WalletState {
  network: Net;
  setNetwork(n: Net): void;
  wallet: Wallet | null;
  address: string | null;
  pubkey: string | null;
  pairing: Pairing | null;
  error: string | null;
  connect(id: WalletId): Promise<void>;
  disconnect(): Promise<void>;
  sheetOpen: boolean;
  openSheet(): void;
  closeSheet(): void;
}

const Ctx = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [network, setNetwork] = useState<Net>(DEFAULT_NETWORK);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const connect = useCallback(async (id: WalletId) => {
    setError(null);
    const w = createWallet(id, network);
    try {
      const p = await w.connect();
      setPairing(p);
      await p.ready;
      setWallet(w);
      setAddress(await w.getAddress());
      setPubkey(await w.getPubkey());
      setPairing(null);
      setSheetOpen(false);
    } catch (e) {
      setPairing(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [network]);

  const disconnect = useCallback(async () => {
    await wallet?.disconnect();
    setWallet(null); setAddress(null); setPubkey(null);
  }, [wallet]);

  const value = useMemo<WalletState>(() => ({
    network, setNetwork, wallet, address, pubkey, pairing, error, connect, disconnect,
    sheetOpen, openSheet: () => setSheetOpen(true),
    closeSheet: () => { pairing?.cancel(); setPairing(null); setSheetOpen(false); },
  }), [network, wallet, address, pubkey, pairing, error, connect, disconnect, sheetOpen]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWallet outside WalletProvider');
  return v;
}
