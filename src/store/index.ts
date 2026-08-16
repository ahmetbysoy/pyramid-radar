import { create } from 'zustand';
import type { SymbolMeta, WsStatus, PyramidState, WreckedPyramid, Trade } from '../types';
import { pyramidNotional } from '../core/pyramid/engine';

interface MarketEntry {
  price: number;
  priceDir: 'up' | 'down' | 'same';
  meta?: SymbolMeta;
  lastTrade?: Trade;
  activePyramids: PyramidState[];
  wreckedPyramids: WreckedPyramid[];
  /** Anlık composite skoru */
  score: number;
}

interface Store {
  status: WsStatus;
  markets: Record<string, MarketEntry>;
  selectedSymbols: string[];
  setStatus(s: WsStatus): void;
  initSymbol(symbol: string, meta?: SymbolMeta): void;
  setPrice(symbol: string, price: number): void;
  setMeta(symbol: string, meta: SymbolMeta): void;
  addPyramid(symbol: string, p: PyramidState): void;
  updatePyramid(symbol: string, p: PyramidState): void;
  wreckPyramid(symbol: string, p: PyramidState, reason: 'REVERSAL' | 'TIMEOUT'): void;
  setScore(symbol: string, score: number): void;
}

const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

function emptyMarket(): MarketEntry {
  return {
    price: 0,
    priceDir: 'same',
    activePyramids: [],
    wreckedPyramids: [],
    score: 0,
  };
}

export const useStore = create<Store>((set) => ({
  status: 'connecting',
  markets: Object.fromEntries(DEFAULT_SYMBOLS.map((s) => [s, emptyMarket()])),
  selectedSymbols: DEFAULT_SYMBOLS,

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
        [symbol]: { ...st.markets[symbol] ?? emptyMarket(), meta },
      },
    })),

  setPrice: (symbol, price) =>
    set((st) => {
      const prev = st.markets[symbol] ?? emptyMarket();
      const dir = price > prev.price ? 'up' : price < prev.price ? 'down' : prev.priceDir;
      return {
        markets: {
          ...st.markets,
          [symbol]: { ...prev, price, priceDir: prev.price === 0 ? 'same' : dir },
        },
      };
    }),

  addPyramid: (symbol, p) =>
    set((st) => {
      const m = st.markets[symbol] ?? emptyMarket();
      return {
        markets: {
          ...st.markets,
          [symbol]: { ...m, activePyramids: [...m.activePyramids, p] },
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
          },
        },
      };
    }),

  wreckPyramid: (symbol, p, reason) =>
    set((st) => {
      const m = st.markets[symbol] ?? emptyMarket();
      const totalNotional = pyramidNotional(p);
      const wrecked: WreckedPyramid = {
        ...p,
        status: 'WRECKED',
        wreckedAt: Date.now(),
        wreckReason: reason,
        maxLayers: p.peakLayers,
        lifetimeMs: Date.now() - p.entryTs,
        // type uyumu için
        layers: p.layers,
        baseSize: p.baseSize,
        totalNotional,
        peakNotional: Math.max(totalNotional, ...m.wreckedPyramids.map((w) => w.peakNotional)),
        currentPnLPct: 0,
        maxPnLPct: 0,
      };
      return {
        markets: {
          ...st.markets,
          [symbol]: {
            ...m,
            activePyramids: m.activePyramids.filter((x) => x.id !== p.id),
            wreckedPyramids: [...m.wreckedPyramids, wrecked].slice(-50), // son 50 ölü piramit
          },
        },
      };
    }),

  setScore: (symbol, score) =>
    set((st) => {
      const m = st.markets[symbol] ?? emptyMarket();
      return { markets: { ...st.markets, [symbol]: { ...m, score } } };
    }),
}));

export { DEFAULT_SYMBOLS };
