import { useEffect, useRef } from 'react';
import { useStore, SYMBOL } from '../store';
import { spawnPyramid, updatePyramid, type PyramidEvent, type PyramidState } from '../core/pyramid/engine';
import { DEFAULT_PYRAMID_CONFIG } from '../core/pyramid/types';
import { playLayerAdded, playLayerRemoved, playWreck, playWhaleAlert } from '../utils/sound';
import { fireConfetti } from '../utils/confetti';
import type { Trade } from '../types';

/**
 * Flow-engine skoruna ve son fiyata göre piramitleri yöneten köprü hook.
 *
 * Mantık:
 *  - Skor +70'in üstüne çıkınca ve aktif BUY piramit yoksa yeni BUY piramit doğar.
 *  - Skor -70'in altına düşünce ve aktif SELL piramit yoksa yeni SELL piramit doğar.
 *  - Her tick'te aktif piramitler updatePyramid ile güncellenir, event'lere göre ses/konfeti/ses efektleri çalışır.
 *  - Bir tarafın piramidi varken ters taraftan yeni piramit açılmaz.
 */
export function usePyramidManager(
  priceRef: React.MutableRefObject<number>,
  scoreRef: React.MutableRefObject<number>,
  lastTradeRef: React.MutableRefObject<Trade | null>,
) {
  const addPyramid = useStore((s) => s.addPyramid);
  const updatePyramidStore = useStore((s) => s.updatePyramid);
  const wreckPyramid = useStore((s) => s.wreckPyramid);
  const activePyramids = useStore((s) => s.markets[SYMBOL]?.activePyramids ?? []);

  // Aktif piramitleri ref'te tut (render dönmeden erişmek için)
  const activeRef = useRef<PyramidState[]>([]);
  activeRef.current = activePyramids;

  const lastSpawnSideRef = useRef<'BUY' | 'SELL' | null>(null);
  const lastWhaleAlertRef = useRef<{ side: 'BUY' | 'SELL'; ts: number } | null>(null);

  useEffect(() => {
    let raf = 0;
    let mounted = true;

    const loop = () => {
      if (!mounted) return;
      const ts = Date.now();
      const price = priceRef.current;
      const score = scoreRef.current;
      const lt = lastTradeRef.current;

      if (price > 0) {
        // 1. Mega/whale trade sesli uyarı (throttle 2sn)
        if (lt && (lt.price * lt.qty) > 100_000) {
          const last = lastWhaleAlertRef.current;
          if (!last || last.ts < ts - 2000 || last.side !== lt.side) {
            playWhaleAlert(lt.side);
            lastWhaleAlertRef.current = { side: lt.side, ts };
          }
        }

        // 2. Yeni piramit tetikleme
        const actives = activeRef.current;
        const hasBuy = actives.some((p) => p.side === 'BUY');
        const hasSell = actives.some((p) => p.side === 'SELL');

        const normalizedScore = score; // -100..+100
        const triggerScore = DEFAULT_PYRAMID_CONFIG.triggerThreshold * 100; // 70

        if (normalizedScore >= triggerScore && !hasBuy) {
          const p = spawnPyramid(SYMBOL, 'BUY', price, DEFAULT_PYRAMID_CONFIG, ts);
          addPyramid(SYMBOL, p);
          activeRef.current = [...activeRef.current, p];
          lastSpawnSideRef.current = 'BUY';
          playLayerAdded(1);
          fireConfetti('BUY', 0.5, 0.5, 60);
        } else if (normalizedScore <= -triggerScore && !hasSell) {
          const p = spawnPyramid(SYMBOL, 'SELL', price, DEFAULT_PYRAMID_CONFIG, ts);
          addPyramid(SYMBOL, p);
          activeRef.current = [...activeRef.current, p];
          lastSpawnSideRef.current = 'SELL';
          playLayerAdded(1);
          fireConfetti('SELL', 0.5, 0.5, 60);
        }

        // 3. Aktif piramitleri güncelle
        const indicatorNorm = score / 100; // engine -1..+1 arasında bekliyor
        for (const p of [...activeRef.current]) {
          if (p.status === 'WRECKED') continue;
          const events: PyramidEvent[] = updatePyramid(p, price, indicatorNorm, ts, DEFAULT_PYRAMID_CONFIG);
          for (const ev of events) {
            if (ev.type === 'LAYER_ADDED') {
              playLayerAdded(ev.level);
              fireConfetti(p.side, 0.5, 0.4, 30 + ev.level * 8);
              updatePyramidStore(SYMBOL, p);
            } else if (ev.type === 'LAYER_REMOVED') {
              playLayerRemoved(ev.level);
              updatePyramidStore(SYMBOL, p);
            } else if (ev.type === 'PEAKED') {
              updatePyramidStore(SYMBOL, p);
            } else if (ev.type === 'COLLAPSING') {
              updatePyramidStore(SYMBOL, p);
            } else if (ev.type === 'WRECKED') {
              playWreck(p.side);
              fireConfetti(p.side, 0.5, 0.4, 150);
              wreckPyramid(SYMBOL, p, ev.reason);
            }
          }
          // Katman eklenme/silinme dışı durum değişikliklerini de store'a yansıt (status vs.)
          if (events.length === 0) {
            // Zirve veya sakin durumda her 1 saniyede bir store'u güncelle (peakNotional vb.)
            // Sürekli güncelleme yapma — gereksiz render
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
