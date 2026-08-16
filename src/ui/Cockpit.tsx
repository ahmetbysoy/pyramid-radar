import { memo, useMemo, useRef, useEffect } from 'react';
import type { KernelSnapshot } from '../core/kernel';
import type { SymbolMeta, WsStatus } from '../types';
import { TIER_CONFIGS } from '../core/adaptive-tiers';


interface Formatters {
  formatPrice(p: number): string;
  formatPct(p: number, sign?: boolean): string;
  formatCompact(n: number): string;
}

interface Props extends Formatters {
  snap: KernelSnapshot | null;
  meta: SymbolMeta | null;
  status: WsStatus;
  soundOn: boolean;
  onToggleSound(): void;
}

const REGIME_LABEL: Record<KernelSnapshot['regime'], { text: string; color: string }> = {
  ACCUMULATION:        { text: 'AKUMULASYON (dip toplama)', color: '#34D399' },
  DISTRIBUTION:        { text: 'DISTRIBUSYON (tepe dagitim)', color: '#F87171' },
  SMART_FOLLOWS_PRICE: { text: 'Akilli para fiyati takip ediyor', color: '#22D3EE' },
  RETAIL_DRIVEN:       { text: 'Perakende surukluyor (zayif)', color: '#A78BFA' },
  QUIET:               { text: 'Sessiz (hacim dusuk)', color: '#7C8DB0' },
};



export const Cockpit = memo(function Cockpit({
  snap, meta, status, soundOn, onToggleSound,
  formatPrice, formatPct, formatCompact,
}: Props) {
  const price = snap?.price ?? 0;
  const priceChange = snap?.priceChange1mPct ?? 0;
  const signal = snap?.signal ?? 'WAIT';
  const confidence = snap?.confidence ?? 0;
  const regime = snap?.regime ?? 'QUIET';
  const reasons = snap?.reasons ?? ['Baglanti bekleniyor...'];
  const stats = snap?.stats;
  const tiers = snap?.tiers;
  const depth = snap?.depth ?? null;
  const pyramids = snap?.pyramids ?? [];
  const thresholds = snap?.thresholds;
  const th = thresholds;

  const signalColor =
    signal === 'STRONG_BUY' || signal === 'BUY' ? '#34D399' :
    signal === 'STRONG_SELL' || signal === 'SELL' ? '#F87171' : '#7C8DB0';

  const r = REGIME_LABEL[regime];

  // Order book (memoize by tick+maxQty referansı)
  const depthView = depth;
  const bookKey = depth ? `${depth.ts}-${depth.maxQty.toFixed(2)}` : '';
  const { topAsks, topBids } = useMemo(() => {
    if (!depthView) return { topAsks: [] as [number,number][], topBids: [] as [number,number][] };
    return {
      topAsks: [...depthView.asks.slice(0,8)].reverse(),
      topBids: depthView.bids.slice(0,8),
    };
  }, [bookKey]);
  void bookKey;

  // Emir defteri miktar formatı (qtyDecimals'den)
  const qtyDec = meta?.qtyDecimals ?? 3;

  // Piramit Canvas
  const pyramidCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pyramidWrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const canvas = pyramidCanvasRef.current;
    const wrap = pyramidWrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let t0 = performance.now();

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = wrap.clientWidth * dpr;
      canvas.height = wrap.clientHeight * dpr;
      canvas.style.width = wrap.clientWidth + 'px';
      canvas.style.height = wrap.clientHeight + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const draw = (now: number) => {
      const t = (now - t0) / 1000;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      ctx.clearRect(0, 0, w, h);

      // Radar tarama
      const cx = w / 2, cy = h / 2;
      const angle = t * 0.8;
      const grd = ctx.createConicGradient(angle, cx, cy);
      grd.addColorStop(0, 'rgba(52,211,153,0)');
      grd.addColorStop(0.08, 'rgba(52,211,153,0.1)');
      grd.addColorStop(0.16, 'rgba(52,211,153,0)');
      grd.addColorStop(0.5, 'rgba(248,113,113,0)');
      grd.addColorStop(0.58, 'rgba(248,113,113,0.1)');
      grd.addColorStop(0.66, 'rgba(248,113,113,0)');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, w, h);

      // Orta çizgi
      ctx.strokeStyle = 'rgba(124,141,176,0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, 10);
      ctx.lineTo(cx, h - 10);
      ctx.stroke();

      // Piramitleri çiz
      const sideW = w / 2;
      // Sol = AL, Sağ = SAT
      const buyPyrs = pyramids.filter(p => p.side === 'BUY');
      const sellPyrs = pyramids.filter(p => p.side === 'SELL');

      const drawPyramid = (p: typeof pyramids[0], side: 'BUY'|'SELL', col: 'left'|'right') => {
        const layers = p.layers;
        const totalH = h - 40;
        const perLayer = Math.min(22, totalH / Math.max(layers.length + 2, 4));
        const startY = h - 20;
        const baseX = col === 'left' ? sideW - 8 : sideW + 8;
        const alignRight = col === 'left';
        for (let i = 0; i < layers.length; i++) {
          const layer = layers[i];
          const y = startY - (i + 1) * perLayer;
          const wPct = layer.widthPct / 100 * (sideW - 20);
          const x1 = alignRight ? baseX - wPct : baseX;
          ctx.fillStyle = layer.breached ? 'rgba(248,113,113,0.8)' : layer.color + 'cc';
          ctx.shadowColor = layer.color + '88';
          ctx.shadowBlur = 12;
          ctx.fillRect(x1, y - perLayer + 2, wPct, perLayer - 3);
          ctx.shadowBlur = 0;

          // Katman etiketi
          ctx.fillStyle = '#0a0f1a';
          ctx.font = '600 10px ui-monospace, monospace';
          const label = `L${layer.level} ${formatCompact(layer.notional)}`;
          if (alignRight) {
            ctx.textAlign = 'right';
            ctx.fillText(label, x1 + wPct - 4, y - 5);
          } else {
            ctx.textAlign = 'left';
            ctx.fillText(label, x1 + 4, y - 5);
          }
        }
        // Başlık
        ctx.fillStyle = side === 'BUY' ? '#34D399' : '#F87171';
        ctx.font = '700 11px ui-monospace, monospace';
        ctx.textAlign = alignRight ? 'right' : 'left';
        const headX = alignRight ? sideW - 10 : sideW + 10;
        const totalNotional = p.totalNotional;
        ctx.fillText(
          `${side === 'BUY' ? 'AL' : 'SAT'} ${p.nLayers} katman - ${formatCompact(totalNotional)}`,
          headX, 18
        );
        // VWAP
        ctx.fillStyle = 'rgba(230,237,247,0.7)';
        ctx.font = '600 10px ui-monospace, monospace';
        ctx.fillText(`VWAP ${formatPrice(p.vwap)}`, headX, 32);
      };

      buyPyrs.forEach((p) => drawPyramid(p, 'BUY', 'left'));
      sellPyrs.forEach((p) => drawPyramid(p, 'SELL', 'right'));

      // Footer
      ctx.fillStyle = 'rgba(124,141,176,0.8)';
      ctx.font = '600 10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      let footer = '';
      if (snap?.wreckedCount && snap.wreckedCount > 0) footer += `Yikilan: ${snap.wreckedCount}  ·  `;
      if (th && th.sampleSize >= 30) {
        footer += `Balina ${formatCompact(th.WHALE)} / Mega ${formatCompact(th.MEGA)} (adaptif)`;
      } else if (th) {
        footer += `Adaptif esik toplanıyor... (${th.sampleSize}/30)`;
      }
      ctx.fillText(footer, cx, h - 6);

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, [pyramids, snap?.wreckedCount, thresholds, formatPrice, formatCompact]);

  return (
    <div className="app app--full">
      {/* HEADER */}
      <header className="hdr">
        <div className="hdr-left">
          <span className={`status-dot ${status}`} />
          <span className="hdr-sym">BTC/USDT PERP</span>
        </div>
        <div className="hdr-center">
          <div className={`price-big ${priceChange >= 0 ? 'up' : 'down'}`}>
            {formatPrice(price)}<span className="price-quote"> USDT</span>
          </div>
          <div className={`price-chg ${priceChange >= 0 ? 'up' : 'down'}`}>
            {formatPct(priceChange)} · 1dk
          </div>
        </div>
        <div className="hdr-right">
          <button className={`sound-btn ${soundOn ? 'on' : ''}`} onClick={onToggleSound} title={soundOn ? 'Sesi kapat' : 'Sesi ac'}>
            {soundOn ? '🔊' : '🔇'}
          </button>
          <span className="vol-tag">{stats ? formatCompact(stats.totalVolume) : '—'}</span>
        </div>
      </header>

      <main className="main-panel">
        {/* SIGNAL */}
        <section className="signal-panel" style={{ borderColor: signalColor, boxShadow: `0 0 40px ${signalColor}22` }}>
          <div className="signal-header">
            <span className="signal-label">SINYAL</span>
            <span className="signal-conf">GUVEN %{confidence}</span>
          </div>
          <div className="signal-main" style={{ color: signalColor }}>
            {signal === 'STRONG_BUY' && '⬆⬆ GUCLU AL'}
            {signal === 'BUY' && '⬆ AL'}
            {signal === 'WAIT' && '⏸ BEKLE'}
            {signal === 'SELL' && '⬇ SAT'}
            {signal === 'STRONG_SELL' && '⬇⬇ GUCLU SAT'}
          </div>
          <div className="regime-line" style={{ color: r.color }}>{r.text}</div>
        </section>

        {/* PIRAMIT (CANVAS) */}
        <section className="pyramid-panel">
          <h3 className="section-title">PIRAMIT - BALINA VWAP HARITASI</h3>
          <div className="pyramid-wrap" ref={pyramidWrapRef}>
            <canvas ref={pyramidCanvasRef} className="pyramid-canvas" />
          </div>
        </section>

        {/* TIER KATMANLARI */}
        <section className="tiers-panel">
          <h3 className="section-title">OYUNCU KATMANLARI - son 60s</h3>
          <div className="tiers-grid">
            {[...TIER_CONFIGS].reverse().map((t) => {
              const id = t.id;
              const tm = tiers?.[id];
              const total = tm ? tm.buyVol + tm.sellVol : 0;
              const buyPct = total > 0 && tm ? (tm.buyVol / total) * 100 : 50;
              const imb = tm?.imbalance ?? 0;
              const active = total > 0;
              const isWhale = id === 'WHALE' || id === 'MEGA' || id === 'LARGE';
              // Adaptif min notional gosterimi
              let minN = 0;
              if (th) {
                if (id === 'MEGA') minN = th.MEGA;
                else if (id === 'WHALE') minN = th.WHALE;
                else if (id === 'LARGE') minN = th.LARGE;
                else if (id === 'MEDIUM') minN = th.LARGE / 10; // yaklasik
                else if (id === 'SMALL') minN = th.LARGE / 100;
                else minN = 0;
              }
              return (
                <div key={id} className={`tier-row ${active ? 'active' : ''} ${isWhale ? 'tier--whale' : ''}`}>
                  <div className="tier-label">
                    <span className="tier-emoji">{t.emoji}</span>
                    <span className="tier-name">{t.label}</span>
                    <span className="tier-range">
                      {th ? (id === 'MICRO' ? `<${formatCompact(th.LARGE/10)}` : `${formatCompact(minN)}+`) : ''}
                    </span>
                  </div>
                  <div className="tier-bar-wrap">
                    <div className="tier-bar">
                      {active ? (
                        <>
                          <div className="tier-buy" style={{ width: `${buyPct}%` }} />
                          <div className="tier-sell" style={{ width: `${100 - buyPct}%` }} />
                        </>
                      ) : <div className="tier-empty" />}
                    </div>
                    {active && Math.abs(imb) > 0.15 && (
                      <div className={`tier-arrow ${imb > 0 ? 'up' : 'down'}`}>{imb > 0 ? '▲' : '▼'}</div>
                    )}
                  </div>
                  <div className="tier-vol">{active ? formatCompact(total) : '—'}</div>
                </div>
              );
            })}
          </div>
          <div className="bar-legend">
            <span className="lg-sell">Satis</span>
            <span className="lg-mid">Al/Sat dengesi</span>
            <span className="lg-buy">Alis</span>
          </div>
        </section>

        {/* ORDER BOOK */}
        {depthView && (
          <section className="book-panel">
            <h3 className="section-title">EMIR DEFTERI (20 seviye)</h3>
            <div className="book-rows">
              {topAsks.map(([p, q], i) => {
                const w = Math.min(100, (q / depthView.maxQty) * 100);
                return (
                  <div key={'a'+i} className="book-row book-ask">
                    <span className="book-pct">{formatPrice(p)}</span>
                    <span className="book-bar"><span className="book-bar-fill ask-fill" style={{ width: `${w}%` }} /></span>
                    <span className="book-qty">{q.toFixed(Math.min(6, qtyDec))}</span>
                  </div>
                );
              })}
              <div className="book-spread">
                <span className={priceChange >= 0 ? 'up' : 'down'}>{formatPrice(price)}</span>
              </div>
              {topBids.map(([p, q], i) => {
                const w = Math.min(100, (q / depthView.maxQty) * 100);
                return (
                  <div key={'b'+i} className="book-row book-bid">
                    <span className="book-pct">{formatPrice(p)}</span>
                    <span className="book-bar"><span className="book-bar-fill bid-fill" style={{ width: `${w}%` }} /></span>
                    <span className="book-qty">{q.toFixed(Math.min(6, qtyDec))}</span>
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
            {reasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
          {stats && (
            <div className="stats-row">
              <span>Islem/sn: <b>{stats.tradeRate}</b></span>
              <span>Balina: <b>{stats.whaleTradeCount}</b></span>
              <span>Mega: <b>{stats.megaTradeCount}</b></span>
              {pyramids.length > 0 && <span>Piramit: <b>{pyramids.length}</b></span>}
            </div>
          )}
          <div className="stats-row" style={{ borderTop: 'none', paddingTop: 0, marginTop: 6 }}>
            <small style={{ color: 'var(--muted)', fontFamily: 'var(--font-mono)', fontSize: '0.65rem' }}>
              Her katman VWAP'i = balinalarin o seviyedeki GERCEK ortalama maliyeti. Fiyat VWAP'i kirarsa katman silinir.
            </small>
          </div>
        </section>
      </main>

      <footer className="ftr">
        EGITIM AMACLIDIR · YATIRIM TAVSIYESI DEGILDIR · Canli Binance · Saf TS motor + 60fps snapshot
      </footer>
    </div>
  );
});
