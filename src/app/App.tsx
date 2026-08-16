import { useEffect, useRef, useState } from 'react';
import { fetchExchangeInfo, getMeta } from '../utils/exchangeInfo';
import { formatPrice, formatPct, formatCompact } from '../utils/format';
import { BinanceFuturesAdapter } from '../core/ws/BinanceFuturesAdapter';
import { FlowEngine } from '../core/flow-engine';
import { TIERS, type TierId } from '../core/tiers';
import type { Trade, Depth, MarkPrice, WsStatus, SymbolMeta } from '../types';
import '../styles/global.css';

const SYMBOL = 'BTCUSDT';

export function App() {
  const [status, setStatus] = useState<WsStatus>('connecting');
  const [meta, setMeta] = useState<SymbolMeta | null>(null);
  const [snap, setSnap] = useState<ReturnType<FlowEngine['compute']> | null>(null);
  const engineRef = useRef(new FlowEngine());
  const lastDepthRef = useRef<{ bids: [number, number][]; asks: [number, number][] } | null>(null);
  const rafRef = useRef<number>(0);

  // Exchange info
  useEffect(() => {
    let mounted = true;
    fetchExchangeInfo()
      .then((m) => mounted && setMeta(getMeta(m, SYMBOL)))
      .catch(() => mounted && setMeta(null));
    return () => { mounted = false; };
  }, []);

  // WebSocket
  useEffect(() => {
    const engine = engineRef.current;
    const adapter = new BinanceFuturesAdapter([SYMBOL], {
      onTrade: (t: Trade) => {
        engine.pushTrade(t.ts, t.price, t.qty, t.side);
      },
      onDepth: (d: Depth) => {
        lastDepthRef.current = { bids: d.bids, asks: d.asks };
      },
      onMark: (_m: MarkPrice) => {
        // aggTrade zaten fiyat veriyor, mark yedek
      },
      onStatus: (s: WsStatus) => setStatus(s),
    });
    adapter.connect();

    // 10 Hz render döngüsü
    const tick = () => {
      const s = engine.compute(Date.now());
      setSnap(s);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
      adapter.disconnect();
    };
  }, []);

  const price = snap?.price ?? 0;
  const priceChange = snap?.priceChange1mPct ?? 0;
  const signal = snap?.signal ?? 'WAIT';
  const confidence = snap?.confidence ?? 0;
  const regime = snap?.regime ?? 'QUIET';
  const reasons = snap?.reasons ?? ['Bağlantı bekleniyor…'];
  const tiers = snap?.tiers;
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
    SMART_FOLLOWS:   { text: 'Akıllı para fiyatı takip ediyor', color: '#22D3EE', emoji: '🎯' },
    SMART_FOLLOWS_PRICE: { text: 'Akıllı para fiyatı takip ediyor', color: '#22D3EE', emoji: '🎯' },
    RETAIL_DRIVEN:   { text: 'Perakende sürüklüyor (zayıf)', color: '#A78BFA', emoji: '🐟' },
    QUIET:           { text: 'Sessiz (hacim düşük)', color: '#7C8DB0', emoji: '🔇' },
  };

  const r = regimeLabel[regime] ?? regimeLabel.QUIET;

  return (
    <div className="app app--full">
      {/* Header */}
      <header className="hdr">
        <div className="hdr-left">
          <span className={`status-dot ${status}`} />
          <span className="hdr-sym">BTC/USDT PERP</span>
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

        {/* Tier katmanları */}
        <section className="tiers-panel">
          <h3 className="section-title">OYUNCU KATMANLARI — son 60 saniye</h3>
          <div className="tiers-grid">
            {[...TIERS].reverse().map((t) => {
              const id = t.id as TierId;
              const tm = tiers?.[id];
              const total = tm ? tm.buyVol + tm.sellVol : 0;
              const buyPct = total > 0 && tm ? (tm.buyVol / total) * 100 : 50;
              const imb = tm?.imbalance ?? 0;
              const active = total > 0;
              const isWhale = id === 'WHALE' || id === 'MEGA';
              return (
                <div key={id} className={`tier-row ${active ? 'active' : ''} ${isWhale ? 'tier--whale' : ''}`}>
                  <div className="tier-label">
                    <span className="tier-emoji">{t.emoji}</span>
                    <span className="tier-name">{t.label}</span>
                    <span className="tier-range">
                      {t.id === 'MEGA' ? '>1M$' : t.id === 'MICRO' ? '<100$' : `${formatCompact(t.minNotional)}+`}
                    </span>
                  </div>
                  <div className="tier-bar-wrap">
                    <div className="tier-bar">
                      <div
                        className="tier-buy"
                        style={{ width: `${buyPct}%` }}
                      />
                      <div
                        className="tier-sell"
                        style={{ width: `${100 - buyPct}%` }}
                      />
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

        {/* Emir deteri */}
        {lastDepthRef.current && (
          <section className="book-panel">
            <h3 className="section-title">EMİR DEFTERİ (20 seviye)</h3>
            <div className="book-rows">
              {lastDepthRef.current.asks.slice(0, 8).reverse().map(([p, q], i) => (
                <div key={'a' + i} className="book-row book-ask">
                  <span className="book-pct">{formatPrice(p, meta ?? undefined)}</span>
                  <span className="book-bar"><span className="book-bar-fill ask-fill" style={{ width: `${Math.min(100, q * 10)}%` }} /></span>
                  <span className="book-qty">{q.toFixed(3)}</span>
                </div>
              ))}
              <div className="book-spread">
                <span className={priceChange >= 0 ? 'up' : 'down'}>
                  {formatPrice(price, meta ?? undefined)}
                </span>
              </div>
              {lastDepthRef.current.bids.slice(0, 8).map(([p, q], i) => (
                <div key={'b' + i} className="book-row book-bid">
                  <span className="book-pct">{formatPrice(p, meta ?? undefined)}</span>
                  <span className="book-bar"><span className="book-bar-fill bid-fill" style={{ width: `${Math.min(100, q * 10)}%` }} /></span>
                  <span className="book-qty">{q.toFixed(3)}</span>
                </div>
              ))}
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
