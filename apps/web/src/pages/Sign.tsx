import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSignRequest, qk } from '../data/queries';
import { getSource, type SignRequest } from '../data/source';
import { Skeleton, ErrorLine } from '../components/AppShell';
import { DecodedTxView, hasUnknownOutput, allChecksPass } from '../components/DecodedTxView';
import { QrCode } from '../components/QrCode';
import { CopyButton, Addr } from '../components/Copy';
import { useWallet } from '../wallet';
import { EXPLORER } from '../config/app';

function Collected({ r }: { r: SignRequest }) {
  const got = r.slots.filter((s) => s.signed);
  return (
    <p className="s-sigcount">
      <b>{r.m} of {r.slots.length}</b> signatures needed · {got.length} collected{got.length ? ` (${got.map((s) => s.signer.label).join(', ')})` : ''}
    </p>
  );
}

/** DESIGN §5.5: the most important screen, a full page, never a modal. Unknown outputs block signing. */
export function Sign() {
  const { requestId = '' } = useParams();
  const q = useSignRequest(requestId);
  const qc = useQueryClient();
  const { wallet, pubkey, openSheet } = useWallet();
  const [sentTxid, setSentTxid] = useState<string | null>(null);
  const r = q.data;

  const mySlot = r && pubkey ? r.slots.findIndex((s) => s.signer.pubkey === pubkey) : -1;
  const firstOpen = r ? r.slots.findIndex((s) => !s.signed) : -1;

  const sign = useMutation({
    mutationFn: async (slot: number) => {
      const s = await getSource();
      let signed = r!.built.txHex;
      if (wallet?.available) signed = (await wallet.signTransaction(r!.built)).signedTxHex;
      return s.addSignature(r!.id, slot, signed);
    },
    onSuccess: (next) => qc.setQueryData(qk.request(requestId), next),
  });
  const reject = useMutation({
    mutationFn: async () => (await getSource()).rejectRequest(r!.id),
    onSuccess: (next) => qc.setQueryData(qk.request(requestId), next),
  });
  const broadcast = useMutation({
    mutationFn: async () => (await getSource()).broadcast(r!.built.txHex),
    onSuccess: (res) => setSentTxid(res.txid),
  });

  if (q.isSuccess && !r) {
    return (
      <div className="wrap s-page">
        <h1 className="s-h1">Signing request not found</h1>
        <p>This link holds no request on this device. Ask the signer who made it to share it again.</p>
      </div>
    );
  }

  const unknown = r ? hasUnknownOutput(r.built) : false;
  const checksOk = r ? allChecksPass(r.built) : false;
  const blocked = unknown || !checksOk;
  const link = typeof location !== 'undefined' ? location.href : `/sign/${requestId}`;

  return (
    <div className="wrap s-page s-sign">
      <div className="s-sign__head">
        <div>
          <p className="t-label muted">You are signing</p>
          <h1 className="s-h1">{r ? r.built.decoded.title : <Skeleton h={40} w="70%" />}</h1>
        </div>
        {r && <Collected r={r} />}
      </div>
      <ErrorLine error={q.error} />

      {unknown && (
        <div className="s-alert s-alert--danger" role="alert">
          <b>Signing is blocked.</b> An output goes to an address that is not the vault, the allowlist or a Paryon contract. Do not sign; tell the other signers.
        </div>
      )}
      {!unknown && r && !checksOk && (
        <div className="s-alert s-alert--danger" role="alert"><b>Signing is blocked.</b> A policy check failed; the covenant would refuse this transaction.</div>
      )}

      {!r ? <Skeleton h={360} /> : <DecodedTxView tx={r.built} />}

      {r && (
        <div className="s-sign__foot">
          <div className="s-sign__act">
            {sentTxid ? (
              <p className="s-sent" role="status">Broadcast accepted · In mempool · <Addr value={sentTxid} href={EXPLORER[r.network].tx + sentTxid} head={8} tail={4} /></p>
            ) : r.status === 'rejected' ? (
              <p className="s-error" role="status">Rejected. Nothing was signed on this device.</p>
            ) : r.status === 'ready' ? (
              <>
                <p>{r.m} signatures collected. Anyone may broadcast it now.</p>
                <ErrorLine error={broadcast.error} />
                <div className="btn-row">
                  <button type="button" className="btn btn--primary" disabled={broadcast.isPending || blocked} onClick={() => broadcast.mutate()}>
                    {broadcast.isPending ? 'Broadcasting…' : 'Broadcast payment'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <ErrorLine error={sign.error} />
                <div className="btn-row">
                  {wallet ? (
                    <button type="button" className="btn btn--primary" disabled={blocked || sign.isPending || mySlot < 0 || r.slots[mySlot]?.signed}
                      onClick={() => sign.mutate(mySlot)}>
                      {sign.isPending ? 'Waiting for the wallet…' : 'Sign with wallet'}
                    </button>
                  ) : (
                    <button type="button" className="btn btn--primary" disabled={blocked} onClick={openSheet}>Sign with wallet</button>
                  )}
                  <button type="button" className="btn btn--secondary" onClick={() => reject.mutate()} disabled={reject.isPending}>Reject</button>
                </div>
                {wallet && mySlot < 0 && <p className="s-error">The connected wallet's key is not one of this vault's signers.</p>}
                {!wallet && !blocked && firstOpen >= 0 && (
                  <button type="button" className="link s-linkbtn t-small" onClick={() => sign.mutate(firstOpen)}>
                    Demo: record a signature for {r.slots[firstOpen].signer.label} without a wallet
                  </button>
                )}
              </>
            )}
          </div>
          <div className="s-share">
            <QrCode value={link} label="QR code of this signing request" size={128} />
            <div className="s-stack">
              <p className="t-small">Share with the other signers</p>
              <CopyButton value={link} label="Copy request link" text />
              <Link className="link t-small" to={`/vaults/${r.vaultId}`}>Back to the vault</Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
