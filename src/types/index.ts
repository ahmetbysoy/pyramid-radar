// Paylasilan temel tipler

export type Side = 'BUY' | 'SELL';

export interface Trade {
  ts: number;
  symbol: string;
  price: number;
  qty: number;
  side: Side;
}

export interface Depth {
  ts: number;
  symbol: string;
  bids: [number, number][];
  asks: [number, number][];
}

export interface MarkPrice {
  ts: number;
  symbol: string;
  price: number;
}

export type WsStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

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
