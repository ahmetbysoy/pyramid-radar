import { useMemo, useRef, useEffect } from 'react';
import type { PyramidState } from '../../core/pyramid/types';
import { avgEntry, currentPnLPct, pyramidNotional, pyramidPeakNotional } from '../../core/pyramid/engine';
import { formatPrice, formatCompact, formatPct } from '../../utils/format';
import type { SymbolMeta } from '../../types';

interface Props {
  pyramids: PyramidState[];
  wreckedCount: number;
  lastWreckReason?: 'REVERSAL' | 'TIMEOUT' | null;
  price: number;
  meta?: SymbolMeta;
}

/**
 * Piramit görseli: katmanlar üst üste yığılarak fib büyümesini gösterir.
 * - BUY piramidi sağa yeşil, SELL piramidi sola kırmızı.
 * - Her katman bir öncekinin ~1.618 katı genişlikte.
 * - Canvas üzerinde hafif glow ve tarama çizgisi efekti var.
 */
export function PyramidVisual({ pyramids, wreckedCount, lastWreckReason, price, meta }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const buys = useMemo(() => pyramids.filter((p) => p.side === 'BUY'), [pyramids]);
  const sells = useMemo(() => pyramids.filter((p) => p.side === 'SELL'), [pyramids]);

  // Canvas arka plan: radar tarama efekti
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
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

      // Merkez çizgi
      ctx.strokeStyle = 'rgba(124, 141, 176, 0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(w / 2, 10);
      ctx.lineTo(w / 2, h - 10);
      ctx.stroke();

      // Tarama çizgisi (conic glow)
      const cx = w / 2;
      const cy = h / 2;
      const angle = t * 0.8;
      const r = Math.max(w, h) * 0.9;
      const grd = ctx.createConicGradient(angle, cx, cy);
      grd.addColorStop(0, 'rgba(52,211,153,0)');
      grd.addColorStop(0.08, 'rgba(52,211,153,0.12)');
      grd.addColorStop(0.16, 'rgba(52,211,153,0)');
      grd.addColorStop(0.5, 'rgba(248,113,113,0)');
      grd.addColorStop(0.58, 'rgba(248,113,113,0.12)');
      grd.addColorStop(0.66, 'rgba(248,113,113,0)');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, w, h);

      raf = requestAnimationFrame(draw);
      void r;
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <div className="pyramid-wrap" ref={wrapRef}>
      <canvas ref={canvasRef} className="pyramid-canvas" />

      <div className="pyr-side pyr-buy">
        {buys.length === 0 && <div className="pyr-empty">⬆ AL piramidi bekleniyor</div>}
        {buys.map((p) => (
          <PyramidStack key={p.id} p={p} side="BUY" price={price} meta={meta} />
        ))}
      </div>

      <div className="pyr-side pyr-sell">
        {sells.length === 0 && <div className="pyr-empty">⬇ SAT piramidi bekleniyor</div>}
        {sells.map((p) => (
          <PyramidStack key={p.id} p={p} side="SELL" price={price} meta={meta} />
        ))}
      </div>

      {wreckedCount > 0 && (
        <div className="pyr-footer">
          💥 Yıkılan piramit: <b>{wreckedCount}</b>
          {lastWreckReason && <span className="pyr-wreck-reason"> · son: {lastWreckReason === 'REVERSAL' ? 'ters yön' : 'zaman aşımı'}</span>}
        </div>
      )}
    </div>
  );
}

function PyramidStack({ p, side, price, meta }: { p: PyramidState; side: 'BUY' | 'SELL'; price: number; meta?: SymbolMeta }) {
  const isBuy = side === 'BUY';
  const color = isBuy ? '#34D399' : '#F87171';
  const glow = isBuy ? 'rgba(52,211,153,0.5)' : 'rgba(248,113,113,0.5)';
  const avg = avgEntry(p);
  const pnl = currentPnLPct(p, price);
  const total = pyramidNotional(p);
  const peak = pyramidPeakNotional(p);
  const maxLayers = Math.max(p.peakLayers, p.layers.length + 2, 6);

  // Status renk/efekt
  const statusClass = `pyr-status--${p.status.toLowerCase()}`;

  return (
    <div className={`pyr-stack ${statusClass}`}>
      <div className="pyr-stack-head" style={{ color }}>
        <span className="pyr-stack-title">
          {isBuy ? '🟢 AL PİRAMİTİ' : '🔴 SAT PİRAMİTİ'} · {p.layers.length} katman
        </span>
        <span className="pyr-stack-meta">
          giriş {formatPrice(p.entryPrice, meta)} · ort {formatPrice(avg, meta)} · PnL <b style={{ color: pnl >= 0 ? '#34D399' : '#F87171' }}>{formatPct(pnl)}</b>
        </span>
      </div>
      <div className="pyr-layers">
        {/* Taban katmanından tepeye doğru ters sırada çiz (CSS taban → yukarı büyüsün) */}
        {[...p.layers].reverse().map((layer, idxFromTop) => {
          const levelFromBase = p.layers.length - idxFromTop;
          // Fib genişlik: baz katman %50, sonraki her katman growthMultiplier ile orantılı
          const growthRatio = Math.pow(DEFAULT_GROWTH, levelFromBase - 1);
          const widthPct = Math.min(92, 30 + growthRatio * 18);
          return (
            <div
              key={layer.level}
              className={`pyr-layer ${isBuy ? 'pyr-layer--buy' : 'pyr-layer--sell'}`}
              style={{
                width: `${widthPct}%`,
                background: `linear-gradient(${isBuy ? '90deg' : '270deg'}, ${color}dd, ${color}44)`,
                boxShadow: p.status === 'COLLAPSING'
                  ? `0 0 20px ${glow}, inset 0 0 12px rgba(255,255,255,0.2)`
                  : `0 0 12px ${glow}`,
                opacity: p.status === 'PEAKED' ? 0.85 : 1,
              }}
            >
              <span className="pyr-lvl">L{layer.level}</span>
              <span className="pyr-notional">{formatCompact(layer.notional)}</span>
            </div>
          );
        })}
        {/* Boş placeholder gelecek katmanlar için (gölge) */}
        {Array.from({ length: Math.max(0, maxLayers - p.layers.length) }).map((_, i) => (
          <div key={`ph${i}`} className="pyr-layer pyr-layer--placeholder" style={{ width: `${Math.min(92, 30 + Math.pow(DEFAULT_GROWTH, p.layers.length + i) * 18)}%` }}>
            <span className="pyr-lvl">+{i + 1}</span>
          </div>
        ))}
      </div>
      <div className="pyr-stack-foot">
        <span>toplam: <b>{formatCompact(total)}</b></span>
        <span>zirve: <b>{formatCompact(peak)}</b></span>
        <span className="pyr-status-tag" style={{ color }}>{statusLabel(p.status)}</span>
      </div>
    </div>
  );
}

const DEFAULT_GROWTH = 1.618;

function statusLabel(s: PyramidState['status']): string {
  switch (s) {
    case 'GROWING': return '🟢 BÜYÜYOR';
    case 'PEAKED': return '🟡 ZİRVEDE';
    case 'COLLAPSING': return '🔴 YIKILIYOR';
    case 'WRECKED': return '💥 YIKILDI';
  }
}
