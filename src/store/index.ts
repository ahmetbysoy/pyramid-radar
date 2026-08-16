import { create } from 'zustand';
import type { SymbolMeta, WsStatus, WreckedPyramid, Trade } from '../types';

// TEK COIN: BTC/USDT
export const SYMBOL = 'BTCUSDT';

interface MarketEntry {
  price: number;
  priceDir: 'up' | 'down' | 'same';
  meta?: SymbolMeta;
  lastTrade?: Trade;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  activePyramids: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wreckedPyramids: any[];
  score: number;
  lastUpdate: number;
}

interface Store {
  status: WsStatus;
  markets: Record<string, MarketEntry>;
  setStatus(s: WsStatus): void;
  initSymbol(symbol: string, meta?: SymbolMeta): void;
  setPrice(symbol: string, price: number): void;
  setLastTrade(symbol: string, t: Trade): void;
  setMeta(symbol: string, meta: SymbolMeta): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addPyramid(symbol: string, p: any): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updatePyramid(symbol: string, p: any): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wreckPyramid(symbol: string, p: any, reason: 'REVERSAL' | 'TIMEOUT'): void;
  setScore(symbol: string, score: number): void;
}

function emptyMarket(): MarketEntry {
  return {
    price: 0,
    priceDir: 'same',
    activePyramids: [],
    wreckedPyramids: [],
    score: 0,
    lastUpdate: Date.now(),
  };
}

export const useStore = create<Store>((set) => ({
  status: 'connecting',
  markets: { [SYMBOL]: emptyMarket() },

  setStatus: (s) => set({ status: s }),

  initSymbol: (symbol, meta) =>
    set((st) => ({
      markets: {
        ...st.markets,
        [symbol]: { ...emptyMarket(), ...st.markets[symbol], meta },
      },
    })),

  setMeta: (symbol, meta) =>
    set((st) => ({
      markets: {
        ...st.markets,
        [symbol]: { ...(st.markets[symbol] ?? emptyMarket()), meta },
      },
    })),

  setPrice: (symbol, price) =>
    set((st) => {
      const prev = st.markets[symbol] ?? emptyMarket();
      const dir = price > prev.price ? 'up' : price < prev.price ? 'down' : prev.priceDir;
      return {
        markets: {
          ...st.markets,
          [symbol]: { ...prev, price, priceDir: prev.price === 0 ? 'same' : dir, lastUpdate: Date.now() },
        },
      };
    }),

  setLastTrade: (symbol, t) =>
    set((st) => ({
      markets: {
        ...st.markets,
        [symbol]: { ...(st.markets[symbol] ?? emptyMarket()), lastTrade: t, lastUpdate: Date.now() },
      },
    })),

  addPyramid: (symbol, p) =>
    set((st) => {
      const m = st.markets[symbol] ?? emptyMarket();
      return {
        markets: {
          ...st.markets,
          [symbol]: { ...m, activePyramids: [...m.activePyramids, p], lastUpdate: Date.now() },
        },
      };
    }),

  updatePyramid: (symbol, p) =>
    set((st) => {
      const m = st.markets[symbol] ?? emptyMarket();
      return {
        markets: {
          ...st.markets,
          [symbol]: {
            ...m,
            activePyramids: m.activePyramids.map((x) => (x.id === p.id ? p : x)),
            lastUpdate: Date.now(),
          },
        },
      };
    }),

  wreckPyramid: (symbol, p, reason) =>
    set((st) => {
      const m = st.markets[symbol] ?? emptyMarket();
      const totalNotional = p.totalNotional ?? 0;
      const wrecked: WreckedPyramid = {
        id: p.id,
        symbol: p.symbol,
        side: p.side,
        entryPrice: p.entryPrice,
        entryTs: p.entryTs,
        layers: p.layers,
        baseSize: p.baseSize ?? 0,
        totalNotional,
        peakNotional: p.peakNotional ?? totalNotional,
        status: 'WRECKED' as const,
        wreckedAt: Date.now(),
        wreckReason: reason,
        maxLayers: p.peakLayers ?? p.layers?.length ?? 1,
        lifetimeMs: Date.now() - p.entryTs,
        currentPnLPct: 0,
        maxPnLPct: 0,
      };
      return {
        markets: {
          ...st.markets,
          [symbol]: {
            ...m,
            activePyramids: m.activePyramids.filter((x) => x.id !== p.id),
            wreckedPyramids: [...m.wreckedPyramids, wrecked].slice(-50),
            lastUpdate: Date.now(),
          },
        },
      };
    }),

  setScore: (symbol, score) =>
    set((st) => {
      const m = st.markets[symbol] ?? emptyMarket();
      return { markets: { ...st.markets, [symbol]: { ...m, score, lastUpdate: Date.now() } } };
    }),
}));

export type { MarketEntry };
