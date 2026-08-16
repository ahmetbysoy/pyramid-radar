import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { fetchExchangeInfo, getMeta } from '../utils/exchangeInfo';
import { formatPrice, formatPct, formatCompact } from '../utils/format';
import { BinanceFuturesAdapter } from '../core/ws/BinanceFuturesAdapter';
import { FlowEngine } from '../core/flow-engine-v2';
import { PyramidVisual, type UIPyramid } from '../ui/components/PyramidVisual';
import { usePyramidManager } from './usePyramidManager';
import { useStore, SYMBOL } from '../store';
import { setSoundEnabled, playTick, tone } from '../utils/sound';
import { TIERS } from '../core/tiers';
import { pyramidVWAP, pyramidPnLPct } from '../core/pyramid/real-flow-engine';
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
  const smartImbRef = useRef(0);
  const lastTradeRef = useRef<Trade | null>(null);
  const pendingFillsRef = useRef<Array<{side:'BUY'|'SELL';price:number;qty:number;notional:number;tier:import('../core/tiers').TierId;ts:number}>>([]);
  const rafRef = useRef<number>(0);

  // Store
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

  // WS + ana tick döngüsü
  useEffect(() => {
    const engine = engineRef.current;
    const adapter = new BinanceFuturesAdapter([SYMBOL], {
      onTrade: (t: Trade) => {
        engine.pushTrade(t.ts, t.price, t.qty, t.side);
        priceRef.current = t.price;
        lastTradeRef.current = t;
        setPrice(SYMBOL, t.price);
        setLastTrade(SYMBOL, t);
        const notional = t.price * t.qty;
        // Sadece akıllı para seviyesi üstündekiler için tık sesi
        if (notional > 10_000) {
          const tierIdx = notional > 1_000_000 ? 5 : notional > 100_000 ? 4 : 3;
          playTick(t.side, tierIdx);
        }
      },
      onDepth: (d: Depth) => {
        const allQtys = [...d.bids, ...d.asks].map(([, q]) => q);
        const maxQty = Math.max(0.0001, ...allQtys);
        lastDepthRef.current = { bids: d.bids, asks: d.asks, maxQty };
      },
      onMark: (_m: MarkPrice) => { /* yedek */ },
      onStatus: (s: WsStatus) => setStatus(s),
    });
    adapter.connect();

    // 10 Hz render döngüsü
    let lastStoreScore = 0;
    let lastDrainTs = 0;
    const tick = () => {
      const s = engine.compute(Date.now());
      setSnap(s);
      smartImbRef.current = s.smartImbalance;

      // Smart-money dolgularını piramit yöneticisine her tick ilet (100ms'de bir)
      const now = Date.now();
      if (now - lastDrainTs > 100) {
        const fills = engine.drainFills();
        for (const f of fills) pendingFillsRef.current.push(f);
        lastDrainTs = now;
      }

      // signed skor (UI sinyalinden)
      const signedScore = (() => {
        if (s.signal === 'STRONG_BUY') return s.confidence;
        if (s.signal === 'BUY') return Math.max(20, s.confidence * 0.6);
        if (s.signal === 'STRONG_SELL') return -s.confidence;
        if (s.signal === 'SELL') return -Math.max(20, s.confidence * 0.6);
        return 0;
      })();
      if (Math.abs(signedScore - lastStoreScore) > 5) {
        setScore(SYMBOL, signedScore);
        lastStoreScore = signedScore;
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

  // Piramit yöneticisi (yeni v2: gerçek dolgular + VWAP)
  usePyramidManager(priceRef, smartImbRef, lastTradeRef, pendingFillsRef);

  const price = snap?.price ?? 0;
  const priceChange = snap?.priceChange1mPct ?? 0;
  const signal = snap?.signal ?? 'WAIT';
  const confidence = snap?.confidence ?? 0;
  const regime = snap?.regime ?? 'QUIET';
  const reasons = snap?.reasons ?? ['Bağlantı bekleniyor…'];
  const stats = snap?.stats;
  const thresholds = snap?.thresholds;

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

  // iOS ses unlock
  useEffect(() => {
    const unlock = () => tone(800, 1, 'sine', 0.001);
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    window.addEventListener('touchstart', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchstart', unlock);
    };
  }, []);

  // Order book (150ms throttle)
  const depthVersion = useRef(0);
  const [depthTick, setDepthTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      depthVersion.current++;
      setDepthTick(depthVersion.current);
    }, 150);
    return () => clearInterval(id);
  }, []);
  void depthTick;

  const depthView = lastDepthRef.current;
  const topAsks = useMemo(() => (depthView ? [...depthView.asks.slice(0, 8)].reverse() : []), [depthView?.maxQty, depthTick]);
  const topBids = useMemo(() => (depthView ? depthView.bids.slice(0, 8) : []), [depthView?.maxQty, depthTick]);

  // UI için gerçek piramit dönüşümü
  const uiPyramids: UIPyramid[] = useMemo(() => {
    return activePyramids.map((raw) => {
      // RealPyramid ile aynı shape
      const p = raw as unknown as import('../core/pyramid/real-flow-engine').RealPyramid;
      return {
        id: p.id,
        side: p.side,
        entryPrice: p.entryPrice,
        layers: p.layers.map((l) => ({
          level: l.level,
          dominantTier: l.dominantTier,
          anchorPrice: l.anchorPrice,
          vwap: l.vwap,
          notional: l.notional,
          invalidatePrice: l.invalidatePrice,
        })),
        totalNotional: p.totalNotional,
        vwap: pyramidVWAP(p),
        pnlPct: pyramidPnLPct(p, price),
        status: p.status,
        peakLayers: p.peakLayers,
        peakNotional: p.peakNotional,
      };
    });
  }, [activePyramids, price]);

  return (
    <div className="app app--full">
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
        <div className="hdr-right">
          <button className={`sound-btn ${soundOn ? 'on' : ''}`} onClick={toggleSound} title={soundOn ? 'Sesi kapat' : 'Sesi aç'}>
            {soundOn ? '🔊' : '🔇'}
          </button>
          <span className="vol-tag">{stats ? formatCompact(stats.totalVolume) : '—'}</span>
        </div>
      </header>

      <main className="main-panel">
        {/* SİNYAL */}
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

        {/* PİRAMİT — GERÇEK PARANIN NEREDE BİRİKTİĞİ */}
        <section className="pyramid-panel">
          <h3 className="section-title">PİRAMİT — BALİNA VWAP HARİTASI</h3>
          <PyramidVisual
            pyramids={uiPyramids}
            wreckedCount={wreckedPyramids.length}
            lastWreckReason={lastWreck?.wreckReason ?? null}
            price={price}
            thresholds={thresholds}
            meta={meta ?? undefined}
          />
        </section>

        {/* TİER KATMANLARI */}
        <section className="tiers-panel">
          <h3 className="section-title">OYUNCU KATMANLARI — son 60 saniye</h3>
          <div className="tiers-grid">
            {[...TIERS].reverse().map((t) => {
              const tm = snap?.tiers?.[t.id];
              const total = tm ? tm.buyVol + tm.sellVol : 0;
              const buyPct = total > 0 && tm ? (tm.buyVol / total) * 100 : 50;
              const imb = tm?.imbalance ?? 0;
              const active = total > 0;
              const isWhale = t.id === 'WHALE' || t.id === 'MEGA' || t.id === 'LARGE';
              const th = thresholds;
              const tierMin =
                t.id === 'MEGA' ? (th?.MEGA ?? 1_000_000)
                : t.id === 'WHALE' ? (th?.WHALE ?? 100_000)
                : t.id === 'LARGE' ? (th?.LARGE ?? 10_000)
                : t.minNotional;
              return (
                <div key={t.id} className={`tier-row ${active ? 'active' : ''} ${isWhale ? 'tier--whale' : ''}`}>
                  <div className="tier-label">
                    <span className="tier-emoji">{t.emoji}</span>
                    <span className="tier-name">{t.label}</span>
                    <span className="tier-range">
                      {t.id === 'MICRO' ? '<' + formatCompact(th?.LARGE ? 0 : 100) : formatCompact(tierMin) + '+'}
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

        {/* EMİR DEFTERİ */}
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

        {/* NEDEN? */}
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
              {activePyramids.length > 0 && <span>Piramit: <b>{activePyramids.length}</b></span>}
            </div>
          )}
          <div className="stats-row" style={{ borderTop: 'none', paddingTop: 0, marginTop: 6 }}>
            <small style={{ color: 'var(--muted)', fontFamily: 'var(--font-mono)', fontSize: '0.65rem' }}>
              💡 Her katmandaki <b>VWAP</b> = balinaların o seviyedeki GERÇEK ortalama maliyeti. Fiyat alt VWAP'ı kırarsa stop.
            </small>
          </div>
        </section>
      </main>

      <footer className="ftr">
        ⚠️ EĞİTİM AMAÇLIDIR · YATIRIM TAVSİYESİ DEĞİLDİR · Canlı Binance Futures · Adaptif tier'lar
      </footer>
    </div>
  );
}
