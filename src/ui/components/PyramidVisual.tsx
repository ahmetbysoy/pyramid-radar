import type { ReactNode } from 'react';
import { useMemo, useRef, useEffect } from 'react';
import type { TierId } from '../../core/tiers';
import { formatPrice, formatCompact, formatPct } from '../../utils/format';
import type { SymbolMeta } from '../../types';
import { TIER_CONFIGS } from '../../core/adaptive-tiers';

export interface UIPyramid {
  id: string;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  layers: Array<{
    level: number;
    dominantTier: TierId;
    anchorPrice: number;
    vwap: number;
    notional: number;
    invalidatePrice: number;
  }>;
  totalNotional: number;
  vwap: number;
  pnlPct: number;
  status: 'GROWING' | 'PEAKED' | 'COLLAPSING' | 'WRECKED';
  peakLayers: number;
  peakNotional: number;
}

interface Props {
  pyramids: UIPyramid[];
  wreckedCount: number;
  lastWreckReason?: 'REVERSAL' | 'TIMEOUT' | 'VWAP_BREACH' | null;
  price: number;
  thresholds?: { LARGE: number; WHALE: number; MEGA: number; sampleSize: number };
  meta?: SymbolMeta;
}

const DEFAULT_GROWTH = 1.618;

const EMOJI: Record<TierId, string> = {
  MICRO: '[MICRO]', SMALL: '[SMALL]', MEDIUM: '[MED]', LARGE: '[LARGE]', WHALE: '[WHALE]', MEGA: '[MEGA]',
};
const LABEL: Record<TierId, string> = {
  MICRO: 'Micro', SMALL: 'Kucuk', MEDIUM: 'Orta', LARGE: 'Buyuk', WHALE: 'Balina', MEGA: 'Mega',
};

export function PyramidVisual({ pyramids, wreckedCount, lastWreckReason, price, thresholds, meta }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const buys = useMemo(() => pyramids.filter((p) => p.side === 'BUY'), [pyramids]);
  const sells = useMemo(() => pyramids.filter((p) => p.side === 'SELL'), [pyramids]);

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

      ctx.strokeStyle = 'rgba(124, 141, 176, 0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(w / 2, 10);
      ctx.lineTo(w / 2, h - 10);
      ctx.stroke();

      const cx = w / 2;
      const cy = h / 2;
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

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  const reasonText = (() => {
    if (!lastWreckReason) return '';
    if (lastWreckReason === 'REVERSAL') return 'ters yon';
    if (lastWreckReason === 'VWAP_BREACH') return 'VWAP kirildi';
    return 'zamanaşımı';
  })();

  return (
    <div className="pyramid-wrap" ref={wrapRef}>
      <canvas ref={canvasRef} className="pyramid-canvas" />

      <div className="pyr-side pyr-buy">
        {buys.length === 0 && <div className="pyr-empty">[YUKARI] AL piramidi bekleniyor</div>}
        {buys.map((p) => (
          <PyramidStack key={p.id} p={p} side="BUY" price={price} meta={meta} />
        ))}
      </div>

      <div className="pyr-side pyr-sell">
        {sells.length === 0 && <div className="pyr-empty">[ASAGI] SAT piramidi bekleniyor</div>}
        {sells.map((p) => (
          <PyramidStack key={p.id} p={p} side="SELL" price={price} meta={meta} />
        ))}
      </div>

      <div className="pyr-footer">
        {wreckedCount > 0 && (
          <span>
            [W] Yikilan: <b>{wreckedCount}</b>
            {lastWreckReason ? <span className="pyr-wreck-reason"> - son: {reasonText}</span> : null}
            {thresholds ? ' - ' : ''}
          </span>
        )}
        {thresholds && (thresholds.sampleSize >= 30
          ? <span className="pyr-thresh">
              Balina esigi <b>{formatCompact(thresholds.WHALE)}</b> / Mega <b>{formatCompact(thresholds.MEGA)}</b> (adaptif)
            </span>
          : <span className="pyr-thresh muted">Adaptif esik toplaniyor... ({thresholds.sampleSize}/30)</span>
        )}
      </div>
    </div>
  );
}

function tierStyle(tier: TierId): { color: string; label: string; emoji: string } {
  const cfg = TIER_CONFIGS.find((c) => c.id === tier);
  return {
    emoji: EMOJI[tier],
    color: cfg?.color ?? '#22D3EE',
    label: LABEL[tier],
  };
}

function PyramidStack({ p, side, price, meta }: { p: UIPyramid; side: 'BUY' | 'SELL'; price: number; meta?: SymbolMeta }) {
  const isBuy = side === 'BUY';
  const color = isBuy ? '#34D399' : '#F87171';
  const glow = isBuy ? 'rgba(52,211,153,0.5)' : 'rgba(248,113,113,0.5)';
  const pnl = p.pnlPct;
  const statusClass = `pyr-status--${p.status.toLowerCase()}`;
  const maxLayers = Math.max(p.peakLayers, p.layers.length + 2, 6);

  return (
    <div className={`pyr-stack ${statusClass}`}>
      <div className="pyr-stack-head" style={{ color }}>
        <span className="pyr-stack-title">
          {isBuy ? '[AL] PIRAMIT' : '[SAT] PIRAMIT'} - {p.layers.length} katman
        </span>
        <span className="pyr-stack-meta">
          giris {formatPrice(p.entryPrice, meta)} - VWAP <b>{formatPrice(p.vwap, meta)}</b> - PnL <b style={{ color: pnl >= 0 ? '#34D399' : '#F87171' }}>{formatPct(pnl)}</b>
        </span>
      </div>
      <div className="pyr-layers">
        {[...p.layers].reverse().map((layer, idxFromTop) => {
          const levelFromBase = p.layers.length - idxFromTop;
          const ratio = p.totalNotional > 0 ? layer.notional / p.totalNotional : 1 / p.layers.length;
          const fibBase = Math.pow(DEFAULT_GROWTH, levelFromBase - 1);
          const widthPct = Math.min(94, 20 + fibBase * 14 + ratio * 40);
          const t = tierStyle(layer.dominantTier);
          const breached = isBuy
            ? price <= layer.invalidatePrice
            : price >= layer.invalidatePrice;
          return (
            <div
              key={layer.level}
              className={`pyr-layer ${isBuy ? 'pyr-layer--buy' : 'pyr-layer--sell'}`}
              style={{
                width: `${widthPct}%`,
                background: `linear-gradient(${isBuy ? '90deg' : '270deg'}, ${t.color}dd, ${t.color}33)`,
                boxShadow: p.status === 'COLLAPSING' || breached
                  ? `0 0 20px ${glow}, inset 0 0 12px rgba(255,100,100,0.35)`
                  : `0 0 10px ${t.color}66`,
                opacity: p.status === 'PEAKED' ? 0.85 : 1,
              }}
              title={`${t.label} - VWAP ${formatPrice(layer.vwap, meta)} - ${formatCompact(layer.notional)}`}
            >
              <span className="pyr-lvl">L{layer.level}</span>
              <span className="pyr-notional">{formatCompact(layer.notional)}</span>
            </div>
          );
        })}
        {Array.from({ length: Math.max(0, maxLayers - p.layers.length) }).map((_, i) => (
          <div key={`ph${i}`} className="pyr-layer pyr-layer--placeholder" style={{ width: `${Math.min(92, 20 + Math.pow(DEFAULT_GROWTH, p.layers.length + i) * 14)}%` }}>
            <span className="pyr-lvl">+{i + 1}</span>
          </div>
        ))}
      </div>
      <div className="pyr-stack-foot">
        <span>dolgu: <b>{formatCompact(p.totalNotional)}</b></span>
        <span>zirve: <b>{formatCompact(p.peakNotional)}</b></span>
        <span className="pyr-status-tag" style={{ color }}>{statusLabel(p.status)}</span>
      </div>
    </div>
  );
}

function statusLabel(s: UIPyramid['status']): string {
  switch (s) {
    case 'GROWING': return 'BUYUYOR';
    case 'PEAKED': return 'ZIRVEDE';
    case 'COLLAPSING': return 'YIKILIYOR';
    case 'WRECKED': return 'YIKILDI';
  }
}

export type { ReactNode };
