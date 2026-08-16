import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { fetchExchangeInfo, getMeta } from '../utils/exchangeInfo';
import { formatPrice, formatPct, formatCompact } from '../utils/format';
import { BinanceFuturesAdapter } from '../core/ws/BinanceFuturesAdapter';
import { FlowEngine } from '../core/flow-engine';
import { TIERS } from '../core/tiers';
import { PyramidVisual } from '../ui/components/PyramidVisual';
import { usePyramidManager } from './usePyramidManager';
import { useStore, SYMBOL } from '../store';
import { setSoundEnabled, playTick, tone } from '../utils/sound';
import type { Trade, Depth, MarkPrice, WsStatus, SymbolMeta } from '../types';
import '../styles/global.css';

export function App() {
  const [status, setStatus] = useState<WsStatus>('connecting');
  const [meta, setMeta] = useState<SymbolMeta | null>(null);
  const [snap, setSnap] = useState<ReturnType<FlowEngine['compute']> | null>(null);
  const [soundOn, setSoundOn] = useState(true);

  const engineRef = useRef(new FlowEngine());
  const lastDepthRef = useRef<{ bids: [number, number][]; asks: [number, number][]; maxQty: number } | null>(null);
  const priceRef = useRef(0);
  const scoreRef = useRef(0);
  const lastTradeRef = useRef<Trade | null>(null);
  const rafRef = useRef<number>(0);

  // Store'dan piramit durumunu al
  const activePyramids = useStore((s) => s.markets[SYMBOL]?.activePyramids ?? []);
  const wreckedPyramids = useStore((s) => s.markets[SYMBOL]?.wreckedPyramids ?? []);
  const setPrice = useStore((s) => s.setPrice);
  const setLastTrade = useStore((s) => s.setLastTrade);
  const setScore = useStore((s) => s.setScore);

  // Exchange info
  useEffect(() => {
    let mounted = true;
    fetchExchangeInfo()
      .then((m) => mounted && setMeta(getMeta(m, SYMBOL)))
      .catch(() => mounted && setMeta(null));
    return () => { mounted = false; };
  }, []);

  // WebSocket + ana tick döngüsü
  useEffect(() => {
    const engine = engineRef.current;
    const adapter = new BinanceFuturesAdapter([SYMBOL], {
      onTrade: (t: Trade) => {
        engine.pushTrade(t.ts, t.price, t.qty, t.side);
        priceRef.current = t.price;
        lastTradeRef.current = t;
        setPrice(SYMBOL, t.price);
        setLastTrade(SYMBOL, t);
        // Hafif tık sesi (sadece büyük tier'lar için)
        const notional = t.price * t.qty;
        const tierIdx = notional > 1_000_000 ? 5 : notional > 100_000 ? 4 : notional > 10_000 ? 3 : -1;
        if (tierIdx >= 0) playTick(t.side, tierIdx);
      },
      onDepth: (d: Depth) => {
        // Emir defteri barları için max qty hesapla (normalize)
        const allQtys = [...d.bids, ...d.asks].map(([, q]) => q);
        const maxQty = Math.max(0.0001, ...allQtys);
        lastDepthRef.current = { bids: d.bids, asks: d.asks, maxQty };
      },
      onMark: (_m: MarkPrice) => {
        // aggTrade zaten fiyat veriyor, mark yedek
      },
      onStatus: (s: WsStatus) => setStatus(s),
    });
    adapter.connect();

    // 10 Hz render döngüsü
    let lastRafScore = 0;
    const tick = () => {
      const s = engine.compute(Date.now());
      setSnap(s);
      const signedScore = (() => {
        if (s.signal === 'STRONG_BUY') return s.confidence;
        if (s.signal === 'BUY') return Math.max(20, s.confidence * 0.6);
        if (s.signal === 'STRONG_SELL') return -s.confidence;
        if (s.signal === 'SELL') return -Math.max(20, s.confidence * 0.6);
        return 0;
      })();
      scoreRef.current = signedScore;
      // sadece skor anlamlı değiştiyse store'a yaz (gereksiz re-render önle)
      if (Math.abs(signedScore - lastRafScore) > 5) {
        setScore(SYMBOL, signedScore);
        lastRafScore = signedScore;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
      adapter.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Piramit yöneticisi (store, spawn/update/wreck, ses/konfeti)
  usePyramidManager(priceRef, scoreRef, lastTradeRef);

  const price = snap?.price ?? 0;
  const priceChange = snap?.priceChange1mPct ?? 0;
  const signal = snap?.signal ?? 'WAIT';
  const confidence = snap?.confidence ?? 0;
  const regime = snap?.regime ?? 'QUIET';
  const reasons = snap?.reasons ?? ['Bağlantı bekleniyor…'];
  const stats = snap?.stats;

  const signalColor =
    signal === 'STRONG_BUY' ? '#34D399'
    : signal === 'BUY' ? '#34D399'
    : signal === 'STRONG_SELL' ? '#F87171'
    : signal === 'SELL' ? '#F87171'
    : '#7C8DB0';

  const regimeLabel: Record<string, { text: string; color: string; emoji: string }> = {
    ACCUMULATION:    { text: 'AKÜMÜLASYON (dip toplama)', color: '#34D399', emoji: '📥' },
    DISTRIBUTION:    { text: 'DİSTRİBÜSYON (tepe dağıtım)', color: '#F87171', emoji: '📤' },
    SMART_FOLLOWS_PRICE: { text: 'Akıllı para fiyatı takip ediyor', color: '#22D3EE', emoji: '🎯' },
    RETAIL_DRIVEN:   { text: 'Perakende sürüklüyor (zayıf)', color: '#A78BFA', emoji: '🐟' },
    QUIET:           { text: 'Sessiz (hacim düşük)', color: '#7C8DB0', emoji: '🔇' },
  };

  const r = regimeLabel[regime] ?? regimeLabel.QUIET;
  const lastWreck = wreckedPyramids[wreckedPyramids.length - 1];

  const toggleSound = useCallback(() => {
    const next = !soundOn;
    setSoundOn(next);
    setSoundEnabled(next);
  }, [soundOn]);
  useEffect(() => { setSoundEnabled(soundOn); }, [soundOn]);

  // İlk kullanıcı hareketinde ses context'ini unlock et (iOS Safari gerektirir)
  useEffect(() => {
    const unlock = () => {
      // Sessiz bir tık ile context'i aktif et (duyulmayacak kadar düşük ses)
      tone(800, 1, 'sine', 0.001);
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    window.addEventListener('touchstart', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchstart', unlock);
    };
  }, []);

  // Emir defteri görseli
  const depthView = lastDepthRef.current;
  const depthVersion = useRef(0);
  const [depthTick, setDepthTick] = useState(0);

  // her ~100ms'de bir order book render et (10Hz çok hızlı, 100ms daha akıcı + daha az render)
  useEffect(() => {
    const id = setInterval(() => {
      depthVersion.current++;
      setDepthTick(depthVersion.current);
    }, 150);
    return () => clearInterval(id);
  }, []);
  void depthTick;

  const topAsks = useMemo(() => (depthView ? [...depthView.asks.slice(0, 8)].reverse() : []), [depthView?.maxQty, depthTick]);
  const topBids = useMemo(() => (depthView ? depthView.bids.slice(0, 8) : []), [depthView?.maxQty, depthTick]);

  return (
    <div className="app app--full">
      {/* Header */}
      <header className="hdr">
        <div className="hdr-left">
          <span className={`status-dot ${status}`} />
          <span className="hdr-sym">BTC/USDT PERP{status === 'offline' ? ' · ÇEVRİMDIŞI' : status === 'reconnecting' ? ' · YENİDEN BAĞLANIYOR' : ''}</span>
        </div>
        <div className="hdr-center">
          <div className={`price-big ${priceChange >= 0 ? 'up' : 'down'}`}>
            {formatPrice(price, meta ?? undefined)}
            <span className="price-quote"> USDT</span>
          </div>
          <div className={`price-chg ${priceChange >= 0 ? 'up' : 'down'}`}>
            {formatPct(priceChange)} · 1dk
          </div>
        </div>
        <div className="hdr-right" style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end' }}>
          <button
            className={`sound-btn ${soundOn ? 'on' : ''}`}
            onClick={toggleSound}
            title={soundOn ? 'Sesi kapat' : 'Sesi aç'}
          >
            {soundOn ? '🔊' : '🔇'}
          </button>
          <span className="vol-tag">{stats ? formatCompact(stats.totalVolume) : '—'}</span>
        </div>
      </header>

      <main className="main-panel">
        {/* Sinyal paneli */}
        <section className="signal-panel" style={{ borderColor: signalColor, boxShadow: `0 0 40px ${signalColor}22` }}>
          <div className="signal-header">
            <span className="signal-label">SİNYAL</span>
            <span className="signal-conf">GÜVEN %{confidence}</span>
          </div>
          <div className="signal-main" style={{ color: signalColor }}>
            {signal === 'STRONG_BUY' && '⬆⬆ GÜÇLÜ AL'}
            {signal === 'BUY' && '⬆ AL'}
            {signal === 'WAIT' && '⏸ BEKLE'}
            {signal === 'SELL' && '⬇ SAT'}
            {signal === 'STRONG_SELL' && '⬇⬇ GÜÇLÜ SAT'}
          </div>
          <div className="regime-line" style={{ color: r.color }}>
            {r.emoji} {r.text}
          </div>
        </section>

        {/* PİRAMİT GÖRSELİ */}
        <section className="pyramid-panel">
          <h3 className="section-title">PİRAMİT — para nerede birikiyor?</h3>
          <PyramidVisual
            pyramids={activePyramids}
            wreckedCount={wreckedPyramids.length}
            lastWreckReason={lastWreck?.wreckReason ?? null}
            price={price}
            meta={meta ?? undefined}
          />
        </section>

        {/* Tier katmanları */}
        <section className="tiers-panel">
          <h3 className="section-title">OYUNCU KATMANLARI — son 60 saniye</h3>
          <div className="tiers-grid">
            {[...TIERS].reverse().map((t) => {
              const tm = snap?.tiers?.[t.id as keyof typeof snap.tiers];
              const total = tm ? (tm as unknown as { buyVol: number; sellVol: number }).buyVol + (tm as unknown as { buyVol: number; sellVol: number }).sellVol : 0;
              const buyPct = total > 0 && tm ? ((tm as unknown as { buyVol: number; sellVol: number }).buyVol / total) * 100 : 50;
              const imb = (tm as unknown as { imbalance?: number })?.imbalance ?? 0;
              const active = total > 0;
              const isWhale = t.id === 'WHALE' || t.id === 'MEGA';
              return (
                <div key={t.id} className={`tier-row ${active ? 'active' : ''} ${isWhale ? 'tier--whale' : ''}`}>
                  <div className="tier-label">
                    <span className="tier-emoji">{t.emoji}</span>
                    <span className="tier-name">{t.label}</span>
                    <span className="tier-range">
                      {t.id === 'MEGA' ? '>1M$' : t.id === 'MICRO' ? '<100$' : `${formatCompact(t.minNotional)}+`}
                    </span>
                  </div>
                  <div className="tier-bar-wrap">
                    <div className="tier-bar">
                      {active ? (
                        <>
                          <div className="tier-buy" style={{ width: `${buyPct}%` }} />
                          <div className="tier-sell" style={{ width: `${100 - buyPct}%` }} />
                        </>
                      ) : (
                        <div className="tier-empty" />
                      )}
                    </div>
                    {active && Math.abs(imb) > 0.15 && (
                      <div className={`tier-arrow ${imb > 0 ? 'up' : 'down'}`}>
                        {imb > 0 ? '▲' : '▼'}
                      </div>
                    )}
                  </div>
                  <div className="tier-vol">
                    {active ? formatCompact(total) : '—'}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="bar-legend">
            <span className="lg-sell">Satış</span>
            <span className="lg-mid">Al/Sat dengesi</span>
            <span className="lg-buy">Alış</span>
          </div>
        </section>

        {/* Emir defteri — normalize edilmiş bar genişliği */}
        {depthView && (
          <section className="book-panel">
            <h3 className="section-title">EMİR DEFTERİ (20 seviye)</h3>
            <div className="book-rows">
              {topAsks.map(([p, q], i) => {
                const widthPct = Math.min(100, (q / depthView.maxQty) * 100);
                return (
                  <div key={'a' + i} className="book-row book-ask">
                    <span className="book-pct">{formatPrice(p, meta ?? undefined)}</span>
                    <span className="book-bar">
                      <span className="book-bar-fill ask-fill" style={{ width: `${widthPct}%` }} />
                    </span>
                    <span className="book-qty">{meta ? q.toFixed(Math.min(6, meta.qtyDecimals)) : q.toFixed(3)}</span>
                  </div>
                );
              })}
              <div className="book-spread">
                <span className={priceChange >= 0 ? 'up' : 'down'}>
                  {formatPrice(price, meta ?? undefined)}
                </span>
              </div>
              {topBids.map(([p, q], i) => {
                const widthPct = Math.min(100, (q / depthView.maxQty) * 100);
                return (
                  <div key={'b' + i} className="book-row book-bid">
                    <span className="book-pct">{formatPrice(p, meta ?? undefined)}</span>
                    <span className="book-bar">
                      <span className="book-bar-fill bid-fill" style={{ width: `${widthPct}%` }} />
                    </span>
                    <span className="book-qty">{meta ? q.toFixed(Math.min(6, meta.qtyDecimals)) : q.toFixed(3)}</span>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Neden? paneli */}
        <section className="reasons-panel">
          <h3 className="section-title">NEDEN?</h3>
          <ul className="reasons-list">
            {reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
          {stats && (
            <div className="stats-row">
              <span>İşlem/sn: <b>{(stats.tradeCount / 60).toFixed(1)}</b></span>
              <span>Balina: <b>{stats.whaleTradeCount}</b></span>
              <span>Mega: <b>{stats.megaTradeCount}</b></span>
              {activePyramids.length > 0 && <span>Aktif piramit: <b>{activePyramids.length}</b></span>}
            </div>
          )}
        </section>
      </main>

      <footer className="ftr">
        ⚠️ EĞİTİM AMAÇLIDIR · YATIRIM TAVSİYESİ DEĞİLDİR · Canlı Binance Futures verisi
      </footer>
    </div>
  );
}
