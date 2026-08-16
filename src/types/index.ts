// ─── Piyasa Tipleri ──────────────────────────────────────────────

export type Side = 'BUY' | 'SELL';

/** Bir aggTrade olayının normalize hali */
export interface Trade {
  ts: number;
  symbol: string;
  price: number;
  qty: number;
  side: Side;      // m=false → alıcı aktif (BUY); m=true → satıcı aktif (SELL)
}

/** Order book derinlik (depth) */
export interface Depth {
  ts: number;
  symbol: string;
  bids: [number, number][];  // [fiyat, miktar]
  asks: [number, number][];
}

/** Mark fiyat */
export interface MarkPrice {
  ts: number;
  symbol: string;
  price: number;
}

export type WsEvent =
  | { type: 'trade'; data: Trade }
  | { type: 'depth'; data: Depth }
  | { type: 'mark'; data: MarkPrice };

// ─── WSS Durumu ─────────────────────────────────────────────────

export type WsStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

// ─── Exchange Info (fiyat/miktar hassasiyeti) ───────────────────

export interface SymbolFilter {
  tickSize: string;
  stepSize: string;
  minPrice: string;
  minQty: string;
  minNotional: string;
}

export interface SymbolMeta {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  priceDecimals: number;
  qtyDecimals: number;
  filters: SymbolFilter;
}

// ─── Piramit Tipleri ────────────────────────────────────────────
// (core/pyramid/types.ts içinden re-export)
export type { PyramidState } from '../core/pyramid/types';
export { DEFAULT_PYRAMID_CONFIG } from '../core/pyramid/types';

export type PyramidStatus = 'GROWING' | 'PEAKED' | 'COLLAPSING' | 'WRECKED';

export interface PyramidLayer {
  level: number;
  addPrice: number;
  addTs: number;
  notional: number;
}

export interface Pyramid {
  id: string;
  symbol: string;
  side: Side;
  entryPrice: number;
  entryTs: number;
  layers: PyramidLayer[];
  baseSize: number;
  totalNotional: number;
  peakNotional: number;
  status: PyramidStatus;
  currentPnLPct: number;
  maxPnLPct: number;
}

export interface WreckedPyramid extends Pyramid {
  status: 'WRECKED';
  wreckedAt: number;
  wreckReason: 'REVERSAL' | 'TIMEOUT';
  maxLayers: number;
  lifetimeMs: number;
}

// ─── Skorlar ────────────────────────────────────────────────────

export interface IndicatorValues {
  cvdNorm: number;
  obi: number;
  velocityZ: number;
  compositeScore: number;
  confidence: number;
  ts: number;
}
