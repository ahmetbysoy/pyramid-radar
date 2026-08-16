import { useEffect, useRef } from 'react';
import { useStore, SYMBOL } from '../store';
import {
  spawnRealPyramid,
  updateRealPyramid,
  pyramidVWAP,
  pyramidPnLPct,
  type RealPyramid,
  type RealPyramidEvent,
  type Fill,
} from '../core/pyramid/real-flow-engine';
import { DEFAULT_PYRAMID_CONFIG } from '../core/pyramid/types';
import { playLayerAdded, playLayerRemoved, playWreck, playWhaleAlert } from '../utils/sound';
import { fireConfetti } from '../utils/confetti';
import type { Trade } from '../types';
import type { TierId } from '../core/tiers';

/**
 * Yeni (v2) piramit yöneticisi:
 *
 *  - Her katman GERÇEK akıllı para dolgularından beslenir (hayali çarpan yok).
 *  - Yeni katman sadece yeterli gerçek dolgu biriktiğinde açılır.
 *  - Katman VWAP'ı balinaların o seviyedeki ortalama maliyetidir.
 *  - Fiyat katman VWAP'ının altına/üstüne kırılırsa katman silinir.
 *  - Ses ve konfeti efektleri korunur.
 */

export interface UIPyramid {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  entryTs: number;
  layers: {
    level: number;
    dominantTier: TierId;
    anchorPrice: number;
    vwap: number;
    notional: number;
    invalidatePrice: number;
    addTs: number;
    lastFillTs: number;
  }[];
  nextLayerPrice: number;
  totalNotional: number;
  vwap: number;
  pnlPct: number;
  status: 'GROWING' | 'PEAKED' | 'COLLAPSING' | 'WRECKED';
  peakLayers: number;
  peakNotional: number;
}

export function usePyramidManager(
  priceRef: React.MutableRefObject<number>,
  smartImbRef: React.MutableRefObject<number>,
  lastTradeRef: React.MutableRefObject<Trade | null>,
  pendingFillsRef: React.MutableRefObject<Fill[]>,
) {
  const addPyramid = useStore((s) => s.addPyramid);
  const updatePyramidStore = useStore((s) => s.updatePyramid);
  const wreckPyramid = useStore((s) => s.wreckPyramid);
  const activePyramids = useStore((s) => s.markets[SYMBOL]?.activePyramids ?? []);
  const activesRef = useRef<RealPyramid[]>([]);
  activesRef.current = activePyramids as unknown as RealPyramid[];

  const lastWhaleAlertRef = useRef<{ side: 'BUY' | 'SELL'; ts: number } | null>(null);

  useEffect(() => {
    let raf = 0;
    let mounted = true;

    const loop = () => {
      if (!mounted) return;
      const ts = Date.now();
      const price = priceRef.current;
      const imb = smartImbRef.current;
      const lt = lastTradeRef.current;

      if (price > 0) {
        // 1. Mega/whale alert (throttle 2sn)
        if (lt && (lt.price * lt.qty) > 100_000) {
          const last = lastWhaleAlertRef.current;
          if (!last || last.ts < ts - 2000 || last.side !== lt.side) {
            playWhaleAlert(lt.side);
            lastWhaleAlertRef.current = { side: lt.side, ts };
          }
        }

        // 2. Bu tick'in dolgularını al
        const fills = pendingFillsRef.current;
        pendingFillsRef.current = [];

        // 3. Yeni piramit tetikleme
        const actives = activesRef.current;
        const hasBuy = actives.some((p) => p.side === 'BUY');
        const hasSell = actives.some((p) => p.side === 'SELL');

        const trigger = DEFAULT_PYRAMID_CONFIG.triggerThreshold; // 0.7
        if (imb >= trigger && !hasBuy && fills.some((f) => f.side === 'BUY')) {
          // İlk dolguyu kullanarak tohum piramit oluştur
          const seed = fills.filter((f) => f.side === 'BUY').sort((a, b) => b.notional - a.notional)[0];
          if (seed && seed.notional > 1000) {
            const p = spawnRealPyramid(SYMBOL, 'BUY', seed.price, seed.tier, seed.notional, DEFAULT_PYRAMID_CONFIG, ts);
            // İlk dolgu haricindeki aynı yönlü dolguları da ekle
            const remainingFills = fills.filter((f) => f.side === 'BUY' && f !== seed);
            applyFillsToTop(p, remainingFills);
            addPyramid(SYMBOL, p as unknown as import('../types').PyramidState);
            activesRef.current = [...activesRef.current, p];
            playLayerAdded(1);
            fireConfetti('BUY', 0.5, 0.5, 80);
          }
        } else if (imb <= -trigger && !hasSell && fills.some((f) => f.side === 'SELL')) {
          const seed = fills.filter((f) => f.side === 'SELL').sort((a, b) => b.notional - a.notional)[0];
          if (seed && seed.notional > 1000) {
            const p = spawnRealPyramid(SYMBOL, 'SELL', seed.price, seed.tier, seed.notional, DEFAULT_PYRAMID_CONFIG, ts);
            const remainingFills = fills.filter((f) => f.side === 'SELL' && f !== seed);
            applyFillsToTop(p, remainingFills);
            addPyramid(SYMBOL, p as unknown as import('../types').PyramidState);
            activesRef.current = [...activesRef.current, p];
            playLayerAdded(1);
            fireConfetti('SELL', 0.5, 0.5, 80);
          }
        }

        // 4. Aktif piramitleri güncelle
        for (const p of [...activesRef.current]) {
          if (p.status === 'WRECKED') continue;
          const events: RealPyramidEvent[] = updateRealPyramid(p, price, imb, fills, ts);
          for (const ev of events) {
            if (ev.type === 'LAYER_ADDED') {
              playLayerAdded(ev.level);
              fireConfetti(p.side, 0.5, 0.4, 40 + ev.level * 8);
              updatePyramidStore(SYMBOL, p as unknown as import('../types').PyramidState);
            } else if (ev.type === 'LAYER_REMOVED') {
              playLayerRemoved(ev.level);
              updatePyramidStore(SYMBOL, p as unknown as import('../types').PyramidState);
            } else if (ev.type === 'LAYER_FILLED') {
              // sessiz tick — periyodik store güncellemesi ile hallediyoruz
            } else if (ev.type === 'PEAKED' || ev.type === 'COLLAPSING') {
              updatePyramidStore(SYMBOL, p as unknown as import('../types').PyramidState);
            } else if (ev.type === 'WRECKED') {
              playWreck(p.side);
              fireConfetti(p.side, 0.5, 0.4, 180);
              wreckPyramid(SYMBOL, p as unknown as import('../types').PyramidState, ev.reason === 'TIMEOUT' ? 'TIMEOUT' : 'REVERSAL');
            }
          }
          // Katman dolguları sonrası VWAP/notional değiştiyse periyodik yansıt (her ~1 saniyede)
          if (events.length === 0 && p.layers.length > 0) {
            // store spam'i yapma, zaten raf 60fps, 1sn throtle
            if (!('_lastUiPush' in p) || (ts - (p as unknown as { _lastUiPush: number })._lastUiPush) > 1000) {
              (p as unknown as { _lastUiPush: number })._lastUiPush = ts;
              updatePyramidStore(SYMBOL, p as unknown as import('../types').PyramidState);
            }
          }
        }
      }

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      mounted = false;
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

/** Piramidin en üst katmanına dolguları ekle (VWAP günceller) */
function applyFillsToTop(p: RealPyramid, fills: Fill[]) {
  if (p.layers.length === 0) return;
  const top = p.layers[p.layers.length - 1];
  for (const f of fills) {
    if (f.side !== p.side) continue;
    if (f.tier === 'MICRO' || f.tier === 'SMALL' || f.tier === 'MEDIUM') continue;
    top.notional += f.notional;
    top.qtyBase += f.qty;
    top.vwap = top.notional / top.qtyBase;
    top.lastFillTs = f.ts;
    p.totalNotional += f.notional;
    p.totalQtyBase += f.qty;
    p.pendingNotional += f.notional;
    p.peakNotional = Math.max(p.peakNotional, p.totalNotional);
  }
  if (top.qtyBase > 0) {
    const cfg = p.config;
    top.invalidatePrice = top.vwap * (p.side === 'BUY' ? (1 - cfg.layerRemovePct) : (1 + cfg.layerRemovePct));
  }
}

export { pyramidVWAP, pyramidPnLPct };
