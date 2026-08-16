import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { KernelSnapshot, WindowMs, PyramidView } from '../core/kernel';
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

const TIER_EMOJI: Record<string, string> = {
  MICRO: '🐟', SMALL: '🐠', MEDIUM: '🐡', LARGE: '🦈', WHALE: '🐋', MEGA: '🐳',
};

export const Cockpit = memo(function Cockpit({
  snap, meta, status, soundOn, onToggleSound, onSelectWindow,
  formatPrice, formatPct, formatCompact,
}: Props) {
  const formatAge = (ms: number): string => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m/60)}sa ${m%60}d`;
  };
  const price = snap?.price ?? 0;
  const priceChange = snap?.priceChangePct ?? 0;
  const signal = snap?.signal ?? 'WAIT';
  const confidence = snap?.confidence ?? 0;
  const regime = snap?.regime ?? 'QUIET';
  const reasons = snap?.reasons ?? ['Bağlantı bekleniyor...'];
  const shortAgg = snap?.shortAgg;
  const longAgg = snap?.longAgg;
  const depth = snap?.depth ?? null;
  const pyramids = snap?.pyramids ?? [];
  const thresholds = snap?.thresholds;
  const divergence = snap?.divergence;
  const session = snap?.session;
  const pressure = snap?.pressure ?? 0;
  const spawnPressure = snap?.spawnPressure ?? 0;
  const vwapBands = snap?.vwapBands;
  const obi = depth?.obi ?? 0;
  const activeWindowMs = snap?.activeWindowMs ?? 300_000;
  const qtyDec = meta?.qtyDecimals ?? 3;

  const signalColor =
    signal === 'STRONG_BUY' || signal === 'BUY' ? '#34D399' :
    signal === 'STRONG_SELL' || signal === 'SELL' ? '#F87171' : '#7C8DB0';

  const [flashRegime, setFlashRegime] = useState<string | null>(null);
  const lastRegimeRef = useRef(regime);
  useEffect(() => {
    if (lastRegimeRef.current !== regime && snap && snap.status === 'live') {
      setFlashRegime(regime);
      const t = setTimeout(() => setFlashRegime(null), 800);
      lastRegimeRef.current = regime;
      return () => clearTimeout(t);
    }
    lastRegimeRef.current = regime;
  }, [regime, snap?.status]);

  const bookKey = depth ? `${depth.ts}-${depth.maxQty.toFixed(2)}` : '';
  const { topAsks, topBids } = useMemo(() => {
    if (!depth) return { topAsks: [] as [number, number][], topBids: [] as [number, number][] };
    return {
      topAsks: [...depth.asks.slice(0,8)].reverse(),
      topBids: depth.bids.slice(0,8),
    };
  }, [bookKey]);
  void bookKey;

  const buyPyramids = pyramids.filter(p => p.side === 'BUY');
  const sellPyramids = pyramids.filter(p => p.side === 'SELL');
  const battleMode = buyPyramids.length > 0 && sellPyramids.length > 0;

  // Compass canvas
  const compassRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = compassRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = 110 * dpr; c.height = 110 * dpr;
    ctx.scale(dpr, dpr);
    const cx = 55, cy = 55, r = 48;

    ctx.clearRect(0,0,110,110);
    // Arka dial
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(30,42,68,0.5)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(124,141,176,0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Yarı kırmızı / yarı yeşil gradient yay
    const grad = ctx.createLinearGradient(0,0,110,0);
    grad.addColorStop(0, 'rgba(248,113,113,0.4)');
    grad.addColorStop(0.5, 'rgba(124,141,176,0.1)');
    grad.addColorStop(1, 'rgba(52,211,153,0.4)');
    ctx.beginPath();
    ctx.arc(cx, cy, r-4, Math.PI*0.75, Math.PI*2.25);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Çeyrek işaretleri
    ctx.strokeStyle = 'rgba(124,141,176,0.5)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 8; i++) {
      const a = Math.PI*0.75 + i/8 * Math.PI*1.5;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a)*(r-8), cy + Math.sin(a)*(r-8));
      ctx.lineTo(cx + Math.cos(a)*(r-12), cy + Math.sin(a)*(r-12));
      ctx.stroke();
    }

    // İbre: shortSmart=X, longSmart=Y → iki boyutlu ama tek ibre olarak basınç yönü
    // Kullanıcı dostu: pressure -1..+1 → açı
    const pressureAngle = Math.PI*0.75 + ((pressure + 1) / 2) * Math.PI*1.5;
    const needleLen = r - 14;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(pressureAngle);
    ctx.beginPath();
    ctx.moveTo(-4, 0);
    ctx.lineTo(0, -needleLen);
    ctx.lineTo(4, 0);
    ctx.closePath();
    ctx.fillStyle = pressure > 0.15 ? '#34D399' : pressure < -0.15 ? '#F87171' : '#7C8DB0';
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();

    // Merkez nokta
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI*2);
    ctx.fillStyle = '#E6EDF7';
    ctx.fill();

    // Etiketler
    ctx.fillStyle = '#F87171';
    ctx.font = '700 9px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('SAT', cx - 28, cy + 38);
    ctx.fillStyle = '#34D399';
    ctx.fillText('AL', cx + 28, cy + 38);
    ctx.fillStyle = '#7C8DB0';
    ctx.fillText('NÖTR', cx, cy - r + 2);
  }, [pressure]);

  // VWAP şeridi için min/max
  const vwapView = useMemo(() => {
    if (!vwapBands || !price) return null;
    const prices = [price, vwapBands.session, vwapBands.smart, vwapBands.retail, vwapBands.short, vwapBands.long].filter(p => p > 0);
    const lo = Math.min(...prices) * 0.999;
    const hi = Math.max(...prices) * 1.001;
    const range = hi - lo || 1;
    const pos = (p: number) => ((p - lo) / range) * 100;
    return {
      price: pos(price),
      session: pos(vwapBands.session),
      smart: pos(vwapBands.smart),
      retail: pos(vwapBands.retail),
      short: pos(vwapBands.short),
      long: pos(vwapBands.long),
    };
  }, [vwapBands, price]);

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
          <button className={`sound-btn ${soundOn ? 'on' : ''}`} onClick={onToggleSound} title={soundOn?'Sesi kapat':'Sesi aç'}>
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

        {/* SİNYAL */}
        <section
          className={`signal-panel ${flashRegime ? 'regime-flash' : ''}`}
          style={{
            borderColor: signalColor,
            boxShadow: `0 0 40px ${signalColor}22`,
            // @ts-expect-error css var
            '--flash-color': REGIME_COLOR[regime] + 'aa',
          }}
        >
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
          <div className="regime-line" style={{ color: divergence?.color ?? REGIME_COLOR[regime] }}>
            {divergence?.emoji} {divergence?.label ?? regime}
            {battleMode && <span className="battle-indicator" style={{ marginLeft: 8 }}>⚔️ SAVAŞ</span>}
          </div>
        </section>

        {/* DIVERGENCE + COMPRESS/PRESSURE */}
        {shortAgg && longAgg && (
          <section className="divergence-panel" style={{ borderColor: divergence?.color ?? '#7C8DB0' }}>
            <div className="div-grid">
              <div className="div-cell">
                <div className="div-label">Kısa ({shortAgg.windowLabel})</div>
                <div className={`div-val ${shortAgg.smartImb >= 0 ? 'up' : 'down'}`}>
                  {shortAgg.smartImb >= 0 ? 'ALIYOR' : 'SATIYOR'}
                  <small>{(shortAgg.smartImb*100).toFixed(0)}%</small>
                </div>
                <div className="div-sub">VWAP {formatPrice(shortAgg.vwap)}</div>
              </div>
              <div className="div-arrow">
                {shortAgg.smartImb >= 0 && longAgg.smartImb >= 0 && '⇈'}
                {shortAgg.smartImb < 0 && longAgg.smartImb < 0 && '⇊'}
                {(shortAgg.smartImb >= 0) !== (longAgg.smartImb >= 0) && '⇡⇣ DIVERGENCE'}
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
                Oturum: akıllı para <b className={session.smartImb >= 0 ? 'up' : 'down'}>{session.smartImb >= 0 ? 'net alıcı' : 'net satıcı'}</b> ({(session.smartImb*100).toFixed(0)}%) · Balina VWAP {formatPrice(session.smartVwap)} · Retail VWAP {formatPrice(session.retailVwap)}
              </div>
            )}
          </section>
        )}

        {/* COMPASS + PRESSURE */}
        <section className="compass-panel">
          <div className="compass-wrap">
            <canvas ref={compassRef} />
          </div>
          <div className="compass-info">
            <div className="section-title" style={{ marginBottom: 4 }}>BASINÇ PUSULASI</div>
            <div className="compass-row">
              <span>Akıllı para</span>
              <span style={{ color: shortAgg && shortAgg.smartImb >= 0 ? '#34D399' : '#F87171' }}>
                {shortAgg ? (shortAgg.smartImb >= 0 ? '↑' : '↓') + ' ' + Math.abs(shortAgg.smartImb*100).toFixed(0) + '%' : '—'}
              </span>
            </div>
            <div className="compass-row">
              <span>Son 5sn</span>
              <span style={{ color: shortAgg && shortAgg.recentImb >= 0 ? '#34D399' : '#F87171' }}>
                {shortAgg ? (shortAgg.recentImb >= 0 ? '↑' : '↓') + ' ' + Math.abs(shortAgg.recentImb*100).toFixed(0) + '%' : '—'}
              </span>
            </div>
            <div className="compass-row">
              <span>Order book</span>
              <span style={{ color: obi >= 0 ? '#34D399' : '#F87171' }}>
                {Math.abs(obi*100).toFixed(0)}% {obi >= 0 ? 'alıcı' : 'satıcı'}
              </span>
            </div>
            <div style={{ marginTop: 4 }}>
              <div className="compass-row">
                <span>Piramit eşiği</span>
                <span style={{ color: spawnPressure >= 1 ? '#FBBF24' : '#7C8DB0' }}>
                  {Math.round(spawnPressure*100)}%
                </span>
              </div>
              <div className="pressure-gauge">
                <div className="pressure-mid" />
                <div
                  className="pressure-fill"
                  style={{
                    width: `${Math.abs(pressure)*50}%`,
                    right: pressure >= 0 ? 'auto' : '50%',
                    left: pressure >= 0 ? '50%' : 'auto',
                    background: pressure >= 0 ? 'linear-gradient(90deg, rgba(52,211,153,0.3), #34D399)' : 'linear-gradient(270deg, rgba(248,113,113,0.3), #F87171)',
                  }}
                />
                {/* Tetik eşiği işareti */}
                <div className="pressure-thresh" style={{ [pressure >= 0 ? 'left' : 'right']: `${0.7*50}%` }} />
              </div>
            </div>
          </div>
        </section>

        {/* VWAP BANDS */}
        {vwapView && price > 0 && (
          <section className="vwap-panel">
            <h3 className="section-title" style={{ marginBottom: 0 }}>VWAP BANTLARI — FİYAT NEREDE?</h3>
            <div className="vwap-strip">
              {/* Tüm bantlar */}
              <div className="vwap-line" style={{ left: `${vwapView.smart}%`, color: '#34D399' }} title="Smart VWAP">
                <span className="vwap-label" style={{ color: '#34D399' }}>SMART {formatPrice(vwapBands!.smart)}</span>
              </div>
              <div className="vwap-line" style={{ left: `${vwapView.session}%`, color: '#22D3EE' }} title="Session VWAP">
                <span className="vwap-label" style={{ color: '#22D3EE' }}>SESSION</span>
              </div>
              <div className="vwap-line" style={{ left: `${vwapView.retail}%`, color: '#A78BFA' }} title="Retail VWAP">
                <span className="vwap-label" style={{ color: '#A78BFA' }}>RETAIL {formatPrice(vwapBands!.retail)}</span>
              </div>
              <div className="vwap-price-marker" style={{ left: `${vwapView.price}%`, color: priceChange >= 0 ? '#34D399' : '#F87171' }} />
            </div>
          </section>
        )}

        {/* PİRAMİTLER */}
        <section className="pyramid-panel">
          <h3 className="section-title">
            PİRAMİT — BALİNA VWAP HARİTASI
            {battleMode && <span className="battle-indicator" style={{ marginLeft: 8 }}>⚔️ ÇARPışMA</span>}
          </h3>
          <div className="pyramid-wrap">
            <div className="pyr-side pyr-buy">
              <div className="pyr-side-title buy">
                <span>🟢 AL {buyPyramids.length > 0 ? `(${buyPyramids.length})` : ''}</span>
                <span style={{ opacity: 0.7, fontWeight: 400 }}>
                  {buyPyramids.reduce((s,p)=>s+p.totalNotional,0) > 0 && formatCompact(buyPyramids.reduce((s,p)=>s+p.totalNotional,0))}
                </span>
              </div>
              {buyPyramids.length === 0 ? (
                <div className="pyr-empty">Aktif AL piramidi yok — balina alımı bekleniyor 🧘</div>
              ) : buyPyramids.map(renderPyr)}
            </div>
            <div className="pyr-side pyr-sell">
              <div className="pyr-side-title sell">
                <span style={{ opacity: 0.7, fontWeight: 400 }}>
                  {sellPyramids.reduce((s,p)=>s+p.totalNotional,0) > 0 && formatCompact(sellPyramids.reduce((s,p)=>s+p.totalNotional,0))}
                </span>
                <span>🔴 SAT {sellPyramids.length > 0 ? `(${sellPyramids.length})` : ''}</span>
              </div>
              {sellPyramids.length === 0 ? (
                <div className="pyr-empty">Aktif SAT piramidi yok</div>
              ) : sellPyramids.map(renderPyr)}
            </div>
          </div>
          {snap && snap.wreckedCount > 0 && (
            <div className="pyr-footer">
              Yıkılan: <b className="pyr-wreck-reason">{snap.wreckedCount}</b>
              {snap.lastWreckReason && <> · son: {snap.lastWreckReason.replace('_', ' ')}</>}
            </div>
          )}
        </section>

        {/* ADAPTİF TIERS (canlı eşikler) */}
        {shortAgg && thresholds && (
          <section className="tiers-panel">
            <h3 className="section-title">
              OYUNCU KATMANLARI — son {shortAgg.windowLabel}
              <span style={{ float: 'right', fontWeight: 400, color: '#FBBF24' }}>adaptif</span>
            </h3>
            <div className="thresh-grid">
              {['MICRO','SMALL','MEDIUM','LARGE','WHALE','MEGA'].slice(1).map(id => {
                const isSmart = id === 'LARGE' || id === 'WHALE' || id === 'MEGA';
                const val = thresholds[id as keyof typeof thresholds] as number;
                return (
                  <div key={id} className={`thresh-pill ${isSmart ? 'thresh-smart' : ''}`}>
                    <span className="thresh-emoji">{TIER_EMOJI[id]}</span>
                    <span className="thresh-name">{id}</span>
                    <span className="thresh-val">{formatCompact(val)}+</span>
                  </div>
                );
              })}
            </div>
            <div className="tiers-grid" style={{ marginTop: 10 }}>
              {[...TIER_CONFIGS].reverse().map(t => {
                const tm = shortAgg.tiers[t.id];
                const total = tm.buyVol + tm.sellVol;
                const buyPct = total > 0 ? (tm.buyVol/total)*100 : 50;
                const active = total > 0;
                const isSmart = t.id === 'LARGE' || t.id === 'WHALE' || t.id === 'MEGA';
                const minN =
                  t.id === 'MEGA' ? thresholds.MEGA :
                  t.id === 'WHALE' ? thresholds.WHALE :
                  t.id === 'LARGE' ? thresholds.LARGE :
                  t.id === 'MEDIUM' ? thresholds.MEDIUM :
                  t.id === 'SMALL' ? thresholds.SMALL : 0;
                return (
                  <div key={t.id} className={`tier-row ${active?'active':''} ${isSmart?'tier--whale':''}`}>
                    <div className="tier-label">
                      <span className="tier-emoji">{t.emoji}</span>
                      <span className="tier-name">{t.label}</span>
                      <span className="tier-range">{thresholds ? `${formatCompact(minN)}+` : ''}</span>
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
              <span className="lg-sell">Satış</span>
              <span className="lg-mid">Denge</span>
              <span className="lg-buy">Alış</span>
            </div>
          </section>
        )}

        {/* ORDER BOOK */}
        {depth && (
          <section className="book-panel">
            <h3 className="section-title">
              EMİR DEFTERİ
              <span style={{ float: 'right', fontWeight: 400, color: obi >= 0 ? '#34D399' : '#F87171' }}>
                OBI {(obi*100).toFixed(0)}% {obi >= 0 ? 'ALIC' : 'SATIC'}
              </span>
            </h3>
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
          <div className="stats-row">
            {shortAgg && <span>İşlem: <b>{shortAgg.tradeCount.toLocaleString()}</b></span>}
            {shortAgg && <span>Balina: <b>{shortAgg.whaleCount}</b></span>}
            {shortAgg && <span>Mega: <b>{shortAgg.megaCount}</b></span>}
            {pyramids.length>0 && <span>Piramit: <b>{pyramids.filter(p=>p.status!=='WRECKED').length}</b></span>}
            {session && <span>Oturum: <b>{formatAge(Date.now()-session.startTs)}</b></span>}
          </div>
        </section>
      </main>

      <footer className="ftr">
        EĞİTİM AMAÇLIDIR · YATIRIM TAVSİYESİ DEĞİLDİR · Canlı Binance · Çift pencere + VWAP
      </footer>
    </div>
  );

  /* ── iç helper: piramit yığını ── */
  function statusColor(s: string): string {
    switch (s) {
      case 'GROWING': return '#34D399';
      case 'PEAKED': return '#FBBF24';
      case 'COLLAPSING': return '#F87171';
      case 'WRECKED': return '#F87171';
      default: return '#7C8DB0';
    }
  }

  function renderPyr(p: PyramidView) {
    const statusClass = `pyr-status--${p.status.toLowerCase()}`;
    const sideColor = p.side === 'BUY' ? '#34D399' : '#F87171';
    const total = p.totalNotional;
    const pnlColor = p.pnlPct >= 0 ? '#34D399' : '#F87171';
    return (
      <div key={p.id} className={`pyr-stack ${statusClass}`} style={{ borderColor: p.status === 'WRECKED' ? '#F87171' : sideColor }}>
        <div className="pyr-stack-head">
          <span className="pyr-stack-title" style={{ color: sideColor }}>
            {p.side === 'BUY' ? '▲ AL' : '▼ SAT'} · {p.nLayers} kat · {TIER_EMOJI[p.layers[p.layers.length-1]?.tier] ?? ''}
          </span>
          <span className="pyr-stack-meta">
            Entry {formatPrice(p.entryPrice)} · VWAP {formatPrice(p.vwap)} · {formatAge(p.ageMs)}
          </span>
        </div>
        <div className="pyr-layers">
          {[...p.layers].reverse().map((layer, idxFromTop) => {
            const isTop = idxFromTop === 0;
            const widthPct = Math.min(95, Math.max(25, layer.widthPct));
            const fillEmoji = TIER_EMOJI[layer.tier] || '•';
            return (
              <div
                key={layer.level}
                className={`pyr-layer ${layer.breached ? 'pyr-layer--breached' : ''}`}
                style={{
                  width: `${widthPct}%`,
                  background: layer.breached
                    ? 'linear-gradient(90deg, rgba(248,113,113,0.7), rgba(248,113,113,0.4))'
                    : `linear-gradient(90deg, ${layer.color}aa, ${layer.color}66)`,
                  boxShadow: isTop && !layer.breached ? `0 0 10px ${layer.color}88` : 'none',
                }}
                title={`L${layer.level} VWAP ${formatPrice(layer.vwap)} invalid ${formatPrice(layer.invalidatePrice)} · ${layer.fillCount} fills`}
              >
                <span className="pyr-lvl">L{layer.level}{fillEmoji}{layer.fillCount > 1 ? `·${layer.fillCount}` : ''}</span>
                <span className="pyr-notional">{formatCompact(layer.notional)}</span>
              </div>
            );
          })}
        </div>
        <div className="pyr-stack-foot">
          <span>Top <b>{formatCompact(total)}</b></span>
          <span style={{ color: pnlColor }}>{p.pnlPct >= 0 ? '+' : ''}{(p.pnlPct*100).toFixed(2)}%</span>
          <span className="pyr-status-tag" style={{ color: statusColor(p.status) }}>{p.status}</span>
        </div>
      </div>
    );
  }
});
