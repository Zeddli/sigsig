import type { Health, VaultPolicy } from '@sigsig/core';

const SATS = 100_000_000n;

function group(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 76_000_000n -> "0.7600" (4 decimals; DESIGN §1.2 shows BCH at 4) */
export function bch(sats: bigint, decimals = 4): string {
  const neg = sats < 0n;
  const v = neg ? -sats : sats;
  const whole = v / SATS;
  const frac = (v % SATS).toString().padStart(8, '0').slice(0, decimals);
  return `${neg ? '−' : ''}${group(whole)}${decimals ? '.' + frac : ''}`;
}

/** 25_000n cents -> "250.00" */
export function pusd(cents: bigint): string {
  const neg = cents < 0n;
  const v = neg ? -cents : cents;
  return `${neg ? '−' : ''}${group(v / 100n)}.${(v % 100n).toString().padStart(2, '0')}`;
}

/** cents per BCH -> "$540.12" */
export function usd(cents: bigint): string {
  return `$${pusd(cents)}`;
}

/** 16420 bps -> "164%" (or "164.2%" with one decimal) */
export function pct(bps: number, decimals = 0): string {
  return `${(bps / 100).toFixed(decimals)}%`;
}

export function sats(n: bigint | number): string {
  return `${group(BigInt(n))} sats`;
}

/** middle-truncate an address or txid: "bitcoincash:zq4t…k3qx" */
export function short(value: string, head = 6, tail = 4): string {
  const [prefix, body] = value.includes(':') ? value.split(':') : ['', value];
  if (body.length <= head + tail + 1) return value;
  return `${prefix ? prefix + ':' : ''}${body.slice(0, head)}…${body.slice(-tail)}`;
}

/** Parse "30" / "30.5" / "30.50" into cents; null if not a number. */
export function parsePusd(input: string): bigint | null {
  const t = input.trim().replace(/,/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  return BigInt(w) * 100n + BigInt((f + '00').slice(0, 2));
}

/** Paryon's integer formula (ARCHITECTURE §2.2): CR_bps = coll * price * 10000 / (debt * 1e8) */
export function crBps(collSats: bigint, priceCents: bigint, debtCents: bigint): number {
  if (debtCents === 0n) return 0;
  return Number((collSats * priceCents * 10_000n) / (debtCents * SATS));
}

/** price (cents/BCH) at which CR hits 110% */
export function liquidationPrice(collSats: bigint, debtCents: bigint): bigint {
  if (collSats === 0n) return 0n;
  return (debtCents * 11n * SATS) / (10n * collSats);
}

/** maxDebt = (coll*10/11) * price / 1e8 */
export function maxBorrow(collSats: bigint, priceCents: bigint): bigint {
  return ((collSats * 10n) / 11n) * priceCents / SATS;
}

export function statusFor(cr: number, p: Pick<VaultPolicy, 'defendCrBps' | 'targetCrBps' | 'skimCrBps'>): Health['status'] {
  if (cr < 11_000) return 'liquidatable';
  if (cr < p.defendCrBps) return 'defend';
  if (cr < p.targetCrBps) return 'watch';
  if (cr > p.skimCrBps) return 'skim';
  return 'safe';
}

/** The status word shown next to every health colour (DESIGN §5.2: colour is never the only signal). */
export const STATUS_WORD: Record<Health['status'], string> = {
  safe: 'Safe',
  watch: 'Watch',
  defend: 'Defend now',
  skim: 'Skim ready',
  liquidatable: 'Liquidation risk',
};

/** semantic tone for a status */
export function tone(status: Health['status']): 'safe' | 'watch' | 'danger' {
  if (status === 'defend' || status === 'liquidatable') return 'danger';
  if (status === 'watch') return 'watch';
  return 'safe';
}
