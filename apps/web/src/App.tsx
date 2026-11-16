import { useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeQueryClient } from './data/queries';
import { WalletProvider } from './wallet';
import { ConnectSheet } from './components/ConnectSheet';
import { AppShell } from './components/AppShell';
import { Landing } from './pages/Landing';
import { VaultDetail } from './pages/VaultDetail';
import { Pay } from './pages/Pay';
import { Sign } from './pages/Sign';
import { Keeper } from './pages/Keeper';
import { NewVault } from './pages/NewVault';
import { NotFound } from './pages/NotFound';

export function App() {
  const [qc] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={qc}>
      <WalletProvider>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/index.html" element={<Landing />} />
          <Route path="/vaults/:id" element={<AppShell><VaultDetail /></AppShell>} />
          <Route path="/vaults/:id/pay" element={<AppShell><Pay /></AppShell>} />
          <Route path="/sign/:requestId" element={<AppShell><Sign /></AppShell>} />
          <Route path="/keeper" element={<AppShell><Keeper /></AppShell>} />
          <Route path="/new" element={<AppShell><NewVault /></AppShell>} />
          <Route path="*" element={<AppShell><NotFound /></AppShell>} />
        </Routes>
        <ConnectSheet />
      </WalletProvider>
    </QueryClientProvider>
  );
}
