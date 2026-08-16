import { create } from 'zustand';
import type { SymbolMeta, WsStatus, PyramidState, WreckedPyramid, Trade } from '../types';
import { pyramidNotional, pyramidPeakNotional } from '../core/pyramid/engine';

// TEK COIN: BTC/USDT — şimdilik mimariyi sadeleştiriyoruz, sonra çoklu coin ekleriz.
export const SYMBOL = 'BTCUSDT';

interface MarketEntry {
  price: number;
  priceDir: 'up' | 'down' | 'same';
  meta?: SymbolMeta;
  lastTrade?: Trade;
  activePyramids: PyramidState[];
  wreckedPyramids: WreckedPyramid[];
  /** Anlık composite skoru (-100 → +100) */
  score: number;
  /** Son güncelleme zamanı */
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
  addPyramid(symbol: string, p: PyramidState): void;
  updatePyramid(symbol: string, p: PyramidState): void;
  wreckPyramid(symbol: string, p: PyramidState, reason: 'REVERSAL' | 'TIMEOUT'): void;
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
      const totalNotional = pyramidNotional(p);
      const peak = pyramidPeakNotional(p); // DÜZELTME: kendi ömür zirvesi
      const wrecked: WreckedPyramid = {
        id: p.id,
        symbol: p.symbol,
        side: p.side,
        entryPrice: p.entryPrice,
        entryTs: p.entryTs,
        layers: p.layers,
        baseSize: p.baseSize,
        totalNotional,
        peakNotional: peak,
        status: 'WRECKED' as const,
        wreckedAt: Date.now(),
        wreckReason: reason,
        maxLayers: p.peakLayers,
        lifetimeMs: Date.now() - p.entryTs,
        currentPnLPct: 0, // avgEntry(p) baz alınır ama zaten yıkıldı
        maxPnLPct: 0,
      };
      return {
        markets: {
          ...st.markets,
          [symbol]: {
            ...m,
            activePyramids: m.activePyramids.filter((x) => x.id !== p.id),
            wreckedPyramids: [...m.wreckedPyramids, wrecked].slice(-50), // son 50 ölü piramit
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
