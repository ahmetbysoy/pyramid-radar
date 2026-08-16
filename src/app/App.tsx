import { useEffect, useRef, useState, useCallback } from 'react';
import { fetchExchangeInfo, getMeta } from '../utils/exchangeInfo';
import { formatPrice, formatPct, formatCompact } from '../utils/format';
import { EngineKernel, type KernelSnapshot } from '../core/kernel';
import { Cockpit } from '../ui/Cockpit';
import { playLayerAdded, playLayerRemoved, playWreck, playWhaleAlert, tone } from '../utils/sound';
import { fireConfetti } from '../utils/confetti';
import type { SymbolMeta, WsStatus } from '../types';
import '../styles/global.css';

// HACK: KernelStatus -> WsStatus eşlemesi
function mapStatus(s: KernelSnapshot['status']): WsStatus {
  if (s === 'live') return 'live';
  if (s === 'offline') return 'offline';
  if (s === 'reconnecting') return 'reconnecting';
  return 'connecting';
}

export function App() {
  const [meta, setMeta] = useState<SymbolMeta | null>(null);
  const [snap, setSnap] = useState<KernelSnapshot | null>(null);
  const [soundOn, setSoundOn] = useState(true);

  const kernelRef = useRef<EngineKernel | null>(null);
  const lastAlertRef = useRef<{ side: 'BUY' | 'SELL'; ts: number; notional: number } | null>(null);
  const rafRef = useRef<number>(0);
  const soundOnRef = useRef(true);
  soundOnRef.current = soundOn;

  // Exchange info
  useEffect(() => {
    let mounted = true;
    fetchExchangeInfo()
      .then((m) => mounted && setMeta(getMeta(m, 'BTCUSDT')))
      .catch(() => mounted && setMeta(null));
    return () => { mounted = false; };
  }, []);

  // Kernel + rAF snapshot loop
  useEffect(() => {
    const kernel = new EngineKernel('BTCUSDT');
    kernelRef.current = kernel;

    // Ses/konfeti event'leri (burada React state yok, direkt kernel event'ine bağlanır)
    kernel.onEvent((ev) => {
      if (!soundOnRef.current) return;
      if (ev.type === 'LAYER_ADDED') {
        playLayerAdded(ev.level);
        fireConfetti(ev.pyramid.side, 0.5, 0.4, 40 + ev.level * 8);
      } else if (ev.type === 'LAYER_REMOVED') {
        playLayerRemoved(ev.level);
      } else if (ev.type === 'WRECKED') {
        playWreck(ev.pyramid.side);
        fireConfetti(ev.pyramid.side, 0.5, 0.4, 180);
      }
    });

    kernel.connect();

    // Büyük whale trade alert (kernel event'inden değil, snapshot'tan bakıyoruz)
    // Bunu ana rAF loop içinde throttle ile yapıyoruz
    const tick = () => {
      const s = kernel.snapshot();
      if (s) {
        setSnap(s);
        // Whale/MEGA alert: son 1sn'de >100K$ whale işlemi oldu mu? stats'tan anlık kontrol yok,
        // bunun için pending trade yok — kernel tick'te stats anlık. En basiti: stats.megaTradeCount artınca.
        // Burada son saniyede megaTrades > 0 ise alert ver
        const now = Date.now();
        const last = lastAlertRef.current;
        if (s.stats.megaTradeCount > 0 && s.lastTradeTs > now - 1500) {
          // En son trade yönü: tier bazlı karmaşık, burada sadece konfeti
          if (!last || now - last.ts > 2500) {
            // Yön bilgisini smartImbalance'dan çıkar
            const side = s.smartImbalance > 0 ? 'BUY' : 'SELL';
            playWhaleAlert(side);
            fireConfetti(side, 0.5, 0.3, 60);
            lastAlertRef.current = { side, ts: now, notional: 0 };
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    // Visibility + online/offline yönetimi kernel içinde yapılıyor mu? Hayır —
    // basit tutalım, burada pause/resume ekleyelim
    const onVis = () => {
      if (document.hidden) kernel.disconnect();
      else { kernel.backoffMs = 1000; kernel.connect(); }
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      cancelAnimationFrame(rafRef.current);
      document.removeEventListener('visibilitychange', onVis);
      kernel.disconnect();
    };
  }, []);

  const toggleSound = useCallback(() => setSoundOn((v) => !v), []);

  // iOS audio unlock
  useEffect(() => {
    const unlock = () => tone(800, 1, 'sine', 0.001);
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  const status: WsStatus = snap ? mapStatus(snap.status) : 'connecting';

  return (
    <Cockpit
      snap={snap}
      meta={meta}
      status={status}
      soundOn={soundOn}
      onToggleSound={toggleSound}
      formatPrice={(p) => formatPrice(p, meta ?? undefined)}
      formatPct={formatPct}
      formatCompact={formatCompact}
    />
  );
}
