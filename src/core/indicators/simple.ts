/**
 * Hafif composite skor:
 *   - CVD-like: son 1 saniye alış/satış hacmi farkı
 *   - OBI-like: depth imbalance
 *   Hızlı, ring buffer yerine kısa array ile.
 */

interface TradeBuf {
  trades: Array<{ ts: number; qty: number; side: 'BUY' | 'SELL' }>;
  lastDepth: { bids: [number, number][]; asks: [number, number][] } | null;
  cumBuy: number;
  cumSell: number;
}

const perSymbol = new Map<string, TradeBuf>();

function buf(sym: string): TradeBuf {
  let b = perSymbol.get(sym);
  if (!b) {
    b = { trades: [], lastDepth: null, cumBuy: 0, cumSell: 0 };
    perSymbol.set(sym, b);
  }
  return b;
}

const WINDOW_MS = 2000; // son 2 saniye

export function pushTrade(sym: string, ts: number, qty: number, side: 'BUY' | 'SELL'): void {
  const b = buf(sym);
  b.trades.push({ ts, qty, side });
  if (side === 'BUY') b.cumBuy += qty;
  else b.cumSell += qty;
  const cutoff = ts - WINDOW_MS;
  while (b.trades.length && b.trades[0].ts < cutoff) {
    const old = b.trades.shift()!;
    if (old.side === 'BUY') b.cumBuy -= old.qty;
    else b.cumSell -= old.qty;
  }
}

export function pushDepth(sym: string, bids: [number, number][], asks: [number, number][]): void {
  buf(sym).lastDepth = { bids: bids.slice(0, 10), asks: asks.slice(0, 10) };
}

export function computeScore(sym: string, _ts: number): number {
  const b = buf(sym);
  // CVD kısmı
  const totalVol = b.cumBuy + b.cumSell;
  const cvdScore = totalVol > 0 ? (b.cumBuy - b.cumSell) / totalVol : 0;

  // OBI kısmı
  let obiScore = 0;
  if (b.lastDepth) {
    let B = 0, A = 0;
    for (const [, q] of b.lastDepth.bids) B += q;
    for (const [, q] of b.lastDepth.asks) A += q;
    obiScore = (B + A) > 0 ? (B - A) / (B + A) : 0;
  }

  // Composite: 0.6 * CVD + 0.4 * OBI, clamp [-1, 1]
  const raw = 0.6 * cvdScore + 0.4 * obiScore;
  return Math.max(-1, Math.min(1, raw));
}

export function resetSymbol(sym: string): void {
  perSymbol.delete(sym);
}
