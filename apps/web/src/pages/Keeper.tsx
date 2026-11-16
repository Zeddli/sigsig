import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BuiltTx } from '@sigsig/core';
import { useVaults } from '../data/queries';
import { getSource, type KeeperAction, type VaultSummary } from '../data/source';
import { PageHead, Skeleton, ErrorLine } from '../components/AppShell';
import { Sheet } from '../components/Sheet';
import { DecodedTxView } from '../components/DecodedTxView';
import { Addr } from '../components/Copy';
import { STATUS_WORD, pct, pusd, bch, tone } from '../data/format';
import { EXPLORER } from '../config/app';
import { useWallet } from '../wallet';

function actionFor(v: VaultSummary): { action: KeeperAction | null; reason: string } {
  const { crBps } = v.health;
  const p = v.policy;
  if (crBps < p.defendCrBps) return { action: 'defend', reason: `CR ${pct(crBps)} is under defend ${pct(p.defendCrBps)}` };
  if (crBps > p.skimCrBps) return { action: 'skim', reason: `CR ${pct(crBps)} is over skim ${pct(p.skimCrBps)}` };
  return { action: null, reason: `CR ${pct(crBps)} is inside ${p.defendCrBps / 100}–${p.skimCrBps / 100}%` };
}

interface Preview { vault: VaultSummary; action: KeeperAction; tx?: BuiltTx; error?: string }

export function Keeper() {
  const { network, wallet } = useWallet();
  const q = useVaults(network);
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const focus = params.get('vault');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [sent, setSent] = useState<Record<string, { txid: string; title: string }>>({});

  const open = async (vault: VaultSummary, action: KeeperAction) => {
    setPreview({ vault, action });
    try {
      const tx = await (await getSource()).buildKeeperTx(vault.id, action);
      setPreview({ vault, action, tx });
    } catch (e) {
      setPreview({ vault, action, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const send = useMutation({
    mutationFn: async (p: Preview) => {
      const s = await getSource();
      let hex = p.tx!.txHex;
      if (wallet?.available) hex = (await wallet.signTransaction(p.tx!)).signedTxHex;
      else if (s.kind !== 'mock') throw new Error('Connect a wallet to pay the keeper fee');
      return { ...(await s.broadcast(hex)), vaultId: p.vault.id, title: p.tx!.decoded.title };
    },
    onSuccess: (r) => {
      setSent((m) => ({ ...m, [r.vaultId]: { txid: r.txid, title: r.title } }));
      setPreview(null);
      void qc.invalidateQueries({ queryKey: ['vaults'] });
      void qc.invalidateQueries({ queryKey: ['vault', r.vaultId] });
    },
  });

  return (
    <div className="wrap s-page">
      <PageHead
        title="Keeper"
        sub={<p className="measure">Any wallet can defend or skim a vault. The covenant accepts a keeper transaction only when it makes the loan safer, and refunds its fee up to the vault's cap.</p>}
      />
      <ErrorLine error={q.error} />
      {q.isSuccess && q.data.length === 0 ? (
        <div className="s-empty">
          <p>No vaults on {network === 'mainnet' ? 'Mainnet' : 'Chipnet'} yet. Open one.</p>
          <Link className="btn btn--primary" to="/new">Open a vault</Link>
        </div>
      ) : (
        <table className="s-table s-table--keeper">
          <thead><tr><th scope="col">Vault</th><th scope="col">CR</th><th scope="col">Status</th><th scope="col">Debt · collateral</th><th scope="col">Action</th></tr></thead>
          <tbody>
            {!q.data ? [0, 1, 2].map((i) => <tr key={i}><td colSpan={5}><Skeleton h={44} /></td></tr>) : q.data.map((v) => {
              const a = actionFor(v);
              const t = tone(v.health.status);
              const s = sent[v.id];
              return (
                <tr key={v.id} className={focus === v.id ? 'is-focus' : ''}>
                  <td data-label="Vault"><Link className="link" to={`/vaults/${v.id}`}>{v.name}</Link></td>
                  <td data-label="CR" className="mono">{pct(v.health.crBps)}</td>
                  <td data-label="Status"><span className={`s-chip s-chip--${t}`}>{STATUS_WORD[v.health.status]}</span></td>
                  <td data-label="Debt · collateral" className="mono">{pusd(v.debtCents)} PUSD · {bch(v.collateralSats)} BCH</td>
                  <td data-label="Action">
                    {s ? (
                      <span className="s-sent" role="status">Sent · In mempool · <Addr value={s.txid} href={EXPLORER[v.network].tx + s.txid} head={6} tail={4} copy={false} /></span>
                    ) : a.action ? (
                      <button type="button" className="btn btn--secondary btn--sm" onClick={() => void open(v, a.action!)}>
                        Run {a.action}
                      </button>
                    ) : (
                      <span className="s-disabled-wrap">
                        <button type="button" className="btn btn--secondary btn--sm" disabled aria-describedby={`why-${v.id}`}>Run defend</button>
                        <span id={`why-${v.id}`} className="t-small muted">{a.reason}</span>
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <Sheet open={!!preview} onClose={() => setPreview(null)} wide
        title={preview ? `${preview.action === 'defend' ? 'Defend' : 'Skim'} ${preview.vault.name}` : ''}
        footer={preview?.tx ? (
          <div className="s-sheet__actions">
            <p className="t-small">You pay ~600 sats; the vault repays up to {preview.vault.policy.keeperFeeMaxSats.toLocaleString('en').replace(/,/g, ' ')} sats.</p>
            <ErrorLine error={send.error} />
            <div className="btn-row">
              <button type="button" className="btn btn--primary" disabled={send.isPending} onClick={() => send.mutate(preview)}>
                {send.isPending ? 'Broadcasting…' : `Broadcast ${preview.action}`}
              </button>
              <button type="button" className="btn btn--secondary" onClick={() => setPreview(null)}>Cancel</button>
            </div>
          </div>
        ) : undefined}>
        {preview && !preview.tx && !preview.error && <div className="s-stack"><Skeleton h={28} /><Skeleton h={200} /></div>}
        {preview?.error && <p className="s-error" role="alert">{preview.error}</p>}
        {preview?.tx && (
          <div className="s-stack">
            <p className="s-lead">{preview.tx.decoded.title}</p>
            <DecodedTxView tx={preview.tx} />
          </div>
        )}
      </Sheet>
    </div>
  );
}
