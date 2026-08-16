import { useEffect, useRef, useState, useCallback } from 'react';
import { fetchExchangeInfo, getMeta } from '../utils/exchangeInfo';
import { formatPrice, formatPct, formatCompact } from '../utils/format';
import { EngineKernel, type WindowMs } from '../core/kernel';
import { Cockpit } from '../ui/Cockpit';
import { playLayerAdded, playLayerRemoved, playWreck, playWhaleAlert, tone, playRegimeChange } from '../utils/sound';
import { fireConfetti } from '../utils/confetti';
import type { SymbolMeta, WsStatus } from '../types';
import '../styles/global.css';

function mapStatus(s: string): WsStatus {
  if (s === 'live') return 'live';
  if (s === 'offline') return 'offline';
  if (s === 'reconnecting') return 'reconnecting';
  return 'connecting';
}

export function App() {
  const [meta, setMeta] = useState<SymbolMeta | null>(null);
  const [snap, setSnap] = useState<ReturnType<EngineKernel['snapshot']>>(null);
  const [soundOn, setSoundOn] = useState(true);

  const kernelRef = useRef<EngineKernel | null>(null);
  const rafRef = useRef<number>(0);
  const soundOnRef = useRef(true);
  soundOnRef.current = soundOn;
  const lastAlertRef = useRef<{ side: 'BUY'|'SELL'; ts: number } | null>(null);

  useEffect(() => {
    let mounted = true;
    fetchExchangeInfo()
      .then(m => mounted && setMeta(getMeta(m, 'BTCUSDT')))
      .catch(() => mounted && setMeta(null));
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    const kernel = new EngineKernel('BTCUSDT');
    kernelRef.current = kernel;

    // Ses/konfeti event'leri
    kernel.onEvent((ev) => {
      if (!soundOnRef.current) return;
      if (ev.type === 'LAYER_ADDED') { playLayerAdded(ev.level); fireConfetti(ev.pyramid.side, 0.5, 0.4, 40+ev.level*8); }
      else if (ev.type === 'LAYER_REMOVED') { playLayerRemoved(ev.level); }
      else if (ev.type === 'WRECKED') { playWreck(ev.pyramid.side); fireConfetti(ev.pyramid.side, 0.5, 0.4, 200); }
      else if (ev.type === 'REGIME_CHANGED') { playRegimeChange(ev.to); }
      else if (ev.type === 'LAYER_FILLED') { /* hafif dolum — şimdilik sessiz */ }
    });

    kernel.connect();

    const tick = () => {
      const s = kernel.snapshot();
      if (s) {
        setSnap(s);
        // Mega alert (throttle 2.5sn)
        const now = Date.now();
        const last = lastAlertRef.current;
        if (s.shortAgg.megaCount > 0 && s.lastTradeTs > now-1500 && (!last || now-last.ts>2500)) {
          const side = s.shortAgg.smartImb > 0 ? 'BUY' : 'SELL';
          playWhaleAlert(side);
          fireConfetti(side, 0.5, 0.3, 60);
          lastAlertRef.current = { side, ts: now };
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    // Visibility: pause/resume (HARD RESET YOK — bucket/session/piramit korunur)
    const onVis = () => {
      if (document.hidden) kernel.pause();
      else kernel.resume();
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      cancelAnimationFrame(rafRef.current);
      document.removeEventListener('visibilitychange', onVis);
      kernel.disconnect();
    };
  }, []);

  const toggleSound = useCallback(() => setSoundOn(v => !v), []);
  const onSelectWindow = useCallback((ms: WindowMs) => {
    kernelRef.current?.setActiveWindow(ms);
  }, []);

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
      onSelectWindow={onSelectWindow}
      formatPrice={(p) => formatPrice(p, meta ?? undefined)}
      formatPct={formatPct}
      formatCompact={formatCompact}
    />
  );
}
