import { memo, useEffect, useMemo, useRef } from 'react';
import type { KernelSnapshot, WindowMs } from '../core/kernel';
import { WINDOWS } from '../core/buckets';
import { TIER_CONFIGS } from '../core/adaptive-tiers';
import type { SymbolMeta, WsStatus } from '../types';

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
  onSelectWindow(ms: WindowMs): void;
}

const REGIME_COLOR: Record<string, string> = {
  ACCUMULATION: '#34D399',
  DISTRIBUTION: '#F87171',
  SMART_FOLLOWS_PRICE: '#22D3EE',
  RETAIL_DRIVEN: '#A78BFA',
  QUIET: '#7C8DB0',
};

export const Cockpit = memo(function Cockpit({
  snap, meta, status, soundOn, onToggleSound, onSelectWindow,
  formatPrice, formatPct, formatCompact,
}: Props) {
  const price = snap?.price ?? 0;
  const priceChange = snap?.priceChangePct ?? 0;
  const signal = snap?.signal ?? 'WAIT';
  const confidence = snap?.confidence ?? 0;
  const regime = snap?.regime ?? 'QUIET';
  const reasons = snap?.reasons ?? ['Baglanti bekleniyor...'];
  const shortAgg = snap?.shortAgg;
  const longAgg = snap?.longAgg;
  const depth = snap?.depth ?? null;
  const pyramids = snap?.pyramids ?? [];
  const thresholds = snap?.thresholds;
  const divergence = snap?.divergence;
  const session = snap?.session;
  const activeWindowMs = snap?.activeWindowMs ?? 300_000;
  const qtyDec = meta?.qtyDecimals ?? 3;

  const signalColor =
    signal === 'STRONG_BUY' || signal === 'BUY' ? '#34D399' :
    signal === 'STRONG_SELL' || signal === 'SELL' ? '#F87171' : '#7C8DB0';

  const bookKey = depth ? `${depth.ts}-${depth.maxQty.toFixed(2)}` : '';
  const { topAsks, topBids } = useMemo(() => {
    if (!depth) return { topAsks: [] as [number, number][], topBids: [] as [number, number][] };
    return {
      topAsks: [...depth.asks.slice(0,8)].reverse(),
      topBids: depth.bids.slice(0,8),
    };
  }, [bookKey]);
  void bookKey;

  // Canvas
  const cnv = useRef<HTMLCanvasElement | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const canvas = cnv.current;
    const wEl = wrap.current;
    if (!canvas || !wEl) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let t0 = performance.now();
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = wEl.clientWidth * dpr;
      canvas.height = wEl.clientHeight * dpr;
      canvas.style.width = wEl.clientWidth + 'px';
      canvas.style.height = wEl.clientHeight + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const draw = (now: number) => {
      const t = (now - t0) / 1000;
      const W = wEl.clientWidth, H = wEl.clientHeight;
      ctx.clearRect(0,0,W,H);
      const cx = W/2, cy = H/2;
      const angle = t * 0.8;
      const g = ctx.createConicGradient(angle, cx, cy);
      g.addColorStop(0,'rgba(52,211,153,0)');
      g.addColorStop(0.08,'rgba(52,211,153,0.1)');
      g.addColorStop(0.16,'rgba(52,211,153,0)');
      g.addColorStop(0.5,'rgba(248,113,113,0)');
      g.addColorStop(0.58,'rgba(248,113,113,0.1)');
      g.addColorStop(0.66,'rgba(248,113,113,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0,0,W,H);
      ctx.strokeStyle = 'rgba(124,141,176,0.18)';
      ctx.beginPath(); ctx.moveTo(cx, 8); ctx.lineTo(cx, H-28); ctx.stroke();

      const sideW = W/2;
      const drawPyr = (p: typeof pyramids[0], side: 'BUY'|'SELL', col: 'left'|'right') => {
        const layers = p.layers;
        const totalH = H - 40;
        const perLayer = Math.min(20, totalH/Math.max(layers.length+2, 4));
        const startY = H - 24;
        const baseX = col === 'left' ? sideW - 8 : sideW + 8;
        const alignRight = col === 'left';
        for (let i = 0; i < layers.length; i++) {
          const layer = layers[i];
          const y = startY - (i+1)*perLayer;
          const wPct = layer.widthPct/100*(sideW-20);
          const x1 = alignRight ? baseX - wPct : baseX;
          ctx.fillStyle = layer.breached ? 'rgba(248,113,113,0.85)' : layer.color + 'cc';
          ctx.shadowColor = layer.color + '88';
          ctx.shadowBlur = 10;
          ctx.fillRect(x1, y - perLayer + 2, wPct, perLayer - 3);
          ctx.shadowBlur = 0;
          ctx.fillStyle = '#0a0f1a';
          ctx.font = '600 10px ui-monospace, monospace';
          ctx.textAlign = alignRight ? 'right' : 'left';
          ctx.fillText(`L${layer.level} ${formatCompact(layer.notional)}`,
            alignRight ? x1 + wPct - 4 : x1 + 4, y - 5);
        }
        ctx.fillStyle = side === 'BUY' ? '#34D399' : '#F87171';
        ctx.font = '700 11px ui-monospace, monospace';
        ctx.textAlign = alignRight ? 'right' : 'left';
        ctx.fillText(`${side==='BUY'?'AL':'SAT'} ${p.nLayers} katman - ${formatCompact(p.totalNotional)}`,
          alignRight ? sideW-10 : sideW+10, 16);
        ctx.fillStyle = 'rgba(230,237,247,0.7)';
        ctx.font = '600 10px ui-monospace, monospace';
        ctx.fillText(`VWAP ${formatPrice(p.vwap)}`,
          alignRight ? sideW-10 : sideW+10, 30);
      };
      pyramids.filter(p=>p.side==='BUY').forEach(p => drawPyr(p,'BUY','left'));
      pyramids.filter(p=>p.side==='SELL').forEach(p => drawPyr(p,'SELL','right'));

      // Footer
      ctx.fillStyle = 'rgba(124,141,176,0.8)';
      ctx.font = '600 10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      let foot = '';
      if (snap && snap.wreckedCount>0) foot += `Yikilan: ${snap.wreckedCount}  ·  `;
      if (thresholds && thresholds.sampleSize >= 100) {
        foot += `Balina ${formatCompact(thresholds.WHALE)} / Mega ${formatCompact(thresholds.MEGA)} (adaptif)`;
      } else if (thresholds) {
        foot += `Adaptif esik toplanıyor... (${thresholds.sampleSize}/100)`;
      }
      ctx.fillText(foot, cx, H-8);

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
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
            {formatPct(priceChange)} · {shortAgg?.windowLabel ?? '—'}
          </div>
        </div>
        <div className="hdr-right">
          <button className={`sound-btn ${soundOn ? 'on' : ''}`} onClick={onToggleSound} title={soundOn?'Sesi kapat':'Sesi ac'}>
            {soundOn ? '🔊' : '🔇'}
          </button>
          <span className="vol-tag">{shortAgg ? formatCompact(shortAgg.totalVol) : '—'}</span>
        </div>
      </header>

      <main className="main-panel">
        {/* PENCERE SECICI */}
        <div className="window-selector">
          {WINDOWS.map(w => (
            <button
              key={w.ms}
              className={`win-btn ${activeWindowMs === w.ms ? 'active' : ''}`}
              onClick={() => onSelectWindow(w.ms as WindowMs)}
            >
              {w.label}
            </button>
          ))}
          <span className="win-session">· Oturum VWAP {session ? formatPrice(session.vwap) : '—'}</span>
        </div>

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
          <div className="regime-line" style={{ color: divergence?.color ?? REGIME_COLOR[regime] }}>
            {divergence?.emoji} {divergence?.label ?? regime}
          </div>
        </section>

        {/* DIVERGENCE KUTUSU (CIFT PENCERE) */}
        {shortAgg && longAgg && (
          <section className="divergence-panel" style={{ borderColor: divergence?.color ?? '#7C8DB0' }}>
            <div className="div-grid">
              <div className="div-cell">
                <div className="div-label">Kisa ({shortAgg.windowLabel})</div>
                <div className={`div-val ${shortAgg.smartImb >= 0 ? 'up' : 'down'}`}>
                  {shortAgg.smartImb >= 0 ? 'ALIYOR' : 'SATIYOR'}
                  <small>{(shortAgg.smartImb*100).toFixed(0)}%</small>
                </div>
                <div className="div-sub">VWAP {formatPrice(shortAgg.vwap)}</div>
              </div>
              <div className="div-arrow">
                {shortAgg.smartImb >= 0 && longAgg.smartImb >= 0 && '⇈'}
                {shortAgg.smartImb < 0 && longAgg.smartImb < 0 && '⇊'}
                {shortAgg.smartImb >= 0 && longAgg.smartImb < 0 && '⇡⇣ DIVERGENCE'}
                {shortAgg.smartImb < 0 && longAgg.smartImb >= 0 && '⇣⇡ DIVERGENCE'}
              </div>
              <div className="div-cell">
                <div className="div-label">Uzun ({longAgg.windowLabel})</div>
                <div className={`div-val ${longAgg.smartImb >= 0 ? 'up' : 'down'}`}>
                  {longAgg.smartImb >= 0 ? 'ALIYOR' : 'SATIYOR'}
                  <small>{(longAgg.smartImb*100).toFixed(0)}%</small>
                </div>
                <div className="div-sub">VWAP {formatPrice(longAgg.vwap)}</div>
              </div>
            </div>
            {session && (
              <div className="div-session">
                Oturum: akıllı para <b className={session.smartImb >= 0 ? 'up' : 'down'}>{session.smartImb >= 0 ? 'net alıcı' : 'net satıcı'}</b> ({(session.smartImb*100).toFixed(0)}%) · Oturum VWAP {formatPrice(session.vwap)} · Balina VWAP {formatPrice(session.smartVwap)}
              </div>
            )}
          </section>
        )}

        {/* PIRAMIT CANVAS */}
        <section className="pyramid-panel">
          <h3 className="section-title">PIRAMIT - BALINA VWAP HARITASI</h3>
          <div className="pyramid-wrap" ref={wrap}>
            <canvas ref={cnv} className="pyramid-canvas" />
          </div>
        </section>

        {/* TIER */}
        {shortAgg && (
          <section className="tiers-panel">
            <h3 className="section-title">OYUNCU KATMANLARI - son {shortAgg.windowLabel}</h3>
            <div className="tiers-grid">
              {[...TIER_CONFIGS].reverse().map(t => {
                const tm = shortAgg.tiers[t.id];
                const total = tm.buyVol + tm.sellVol;
                const buyPct = total > 0 ? (tm.buyVol/total)*100 : 50;
                const active = total > 0;
                const isSmart = t.id === 'LARGE' || t.id === 'WHALE' || t.id === 'MEGA';
                const minN =
                  t.id === 'MEGA' ? thresholds?.MEGA ?? 1_000_000 :
                  t.id === 'WHALE' ? thresholds?.WHALE ?? 100_000 :
                  t.id === 'LARGE' ? thresholds?.LARGE ?? 10_000 :
                  t.id === 'MEDIUM' ? (thresholds?.LARGE ?? 10_000)/10 :
                  t.id === 'SMALL' ? (thresholds?.LARGE ?? 10_000)/100 : 0;
                return (
                  <div key={t.id} className={`tier-row ${active?'active':''} ${isSmart?'tier--whale':''}`}>
                    <div className="tier-label">
                      <span className="tier-emoji">{t.emoji}</span>
                      <span className="tier-name">{t.label}</span>
                      <span className="tier-range">{thresholds ? (t.id==='MICRO' ? `<${formatCompact(minN)}` : `${formatCompact(minN)}+`) : ''}</span>
                    </div>
                    <div className="tier-bar-wrap">
                      <div className="tier-bar">
                        {active ? (
                          <>
                            <div className="tier-buy" style={{width:`${buyPct}%`}} />
                            <div className="tier-sell" style={{width:`${100-buyPct}%`}} />
                          </>
                        ) : <div className="tier-empty" />}
                      </div>
                      {active && Math.abs(tm.imbalance) > 0.15 && (
                        <div className={`tier-arrow ${tm.imbalance>0?'up':'down'}`}>{tm.imbalance>0?'▲':'▼'}</div>
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
        )}

        {/* ORDER BOOK */}
        {depth && (
          <section className="book-panel">
            <h3 className="section-title">EMIR DEFTERI</h3>
            <div className="book-rows">
              {topAsks.map(([p,q],i) => {
                const w = Math.min(100, (q/depth.maxQty)*100);
                return (
                  <div key={'a'+i} className="book-row book-ask">
                    <span className="book-pct">{formatPrice(p)}</span>
                    <span className="book-bar"><span className="book-bar-fill ask-fill" style={{width:`${w}%`}} /></span>
                    <span className="book-qty">{q.toFixed(Math.min(6, qtyDec))}</span>
                  </div>
                );
              })}
              <div className="book-spread">
                <span className={priceChange >= 0 ? 'up' : 'down'}>{formatPrice(price)}</span>
              </div>
              {topBids.map(([p,q],i) => {
                const w = Math.min(100, (q/depth.maxQty)*100);
                return (
                  <div key={'b'+i} className="book-row book-bid">
                    <span className="book-pct">{formatPrice(p)}</span>
                    <span className="book-bar"><span className="book-bar-fill bid-fill" style={{width:`${w}%`}} /></span>
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
            {reasons.map((r,i) => <li key={i}>{r}</li>)}
          </ul>
          {shortAgg && (
            <div className="stats-row">
              <span>Islem/sn: <b>{shortAgg.tradeCount}</b></span>
              <span>Balina: <b>{shortAgg.whaleCount}</b></span>
              <span>Mega: <b>{shortAgg.megaCount}</b></span>
              {pyramids.length>0 && <span>Piramit: <b>{pyramids.length}</b></span>}
            </div>
          )}
        </section>
      </main>

      <footer className="ftr">
        EGITIM AMACLIDIR · YATIRIM TAVSIYESI DEGILDIR · Canli Binance · Cift pencere + VWAP
      </footer>
    </div>
  );
});
