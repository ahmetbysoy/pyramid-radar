import type { Side } from './types';
import {
  DEFAULT_PYRAMID_CONFIG,
  type PyramidConfig,
  type PyramidState,
} from './types';

let _idCounter = 0;
function newId(): string {
  _idCounter += 1;
  return `pyr-${Date.now().toString(36)}-${_idCounter}`;
}

/**
 * Yeni bir piramit oluştur (tohum).
 */
export function spawnPyramid(
  symbol: string,
  side: Side,
  price: number,
  config: PyramidConfig = DEFAULT_PYRAMID_CONFIG,
  ts: number = Date.now(),
): PyramidState {
  const baseLayer = {
    level: 1,
    addPrice: price,
    addTs: ts,
    notional: config.baseNotional,
  };

  return {
    id: newId(),
    symbol,
    side,
    entryPrice: price,
    entryTs: ts,
    layers: [baseLayer],
    baseSize: config.baseNotional,
    nextLayerThreshold: computeNextThreshold(price, side, config.layerAddPct),
    lastLayerInvalidatePrice: computeLayerInvalidatePrice(
      price,
      side,
      config.layerRemovePct,
    ),
    status: 'GROWING',
    peakLayers: 1,
  };
}

/**
 * Bir sonraki katman eşiğini hesapla:
 * BUY'da entry'nin %0.2 üstü, SELL'de %0.2 altı
 */
function computeNextThreshold(price: number, side: Side, pct: number): number {
  return side === 'BUY' ? price * (1 + pct) : price * (1 - pct);
}

/**
 * Son katman kırılma fiyatı:
 * BUY'da son katmanın %0.15 altı, SELL'de %0.15 üstü
 */
function computeLayerInvalidatePrice(price: number, side: Side, pct: number): number {
  return side === 'BUY' ? price * (1 - pct) : price * (1 + pct);
}

function totalNotional(layers: Array<{ notional: number }>): number {
  return layers.reduce((s, l) => s + l.notional, 0);
}

/** Ortalama giriş (ağırlıklı) */
export function avgEntry(p: PyramidState): number {
  const total = p.layers.reduce((s, l) => s + l.notional, 0);
  if (total === 0) return p.entryPrice;
  const weighted = p.layers.reduce((s, l) => s + l.notional * l.addPrice, 0);
  return weighted / total;
}

/** Anlık PnL % (her katman ayrı weighted) */
export function currentPnLPct(p: PyramidState, lastPrice: number): number {
  const avg = avgEntry(p);
  return p.side === 'BUY'
    ? (lastPrice - avg) / avg
    : (avg - lastPrice) / avg;
}

/**
 * Tick: gelen fiyat ve skor ile piramidi güncelle.
 * Yeni katman eklendi, katman silindi veya yıkıldıysa event döner.
 */
export type PyramidEvent =
  | { type: 'LAYER_ADDED'; pyramid: PyramidState; level: number }
  | { type: 'LAYER_REMOVED'; pyramid: PyramidState; level: number }
  | { type: 'WRECKED'; pyramid: PyramidState; reason: 'REVERSAL' | 'TIMEOUT' };

export function updatePyramid(
  p: PyramidState,
  lastPrice: number,
  indicatorScore: number,
  ts: number,
  config: PyramidConfig = DEFAULT_PYRAMID_CONFIG,
): PyramidEvent[] {
  const events: PyramidEvent[] = [];

  if (p.status === 'WRECKED') return events;

  // Zaman aşımı
  if (ts - p.entryTs > config.timeoutMs) {
    p.status = 'WRECKED';
    events.push({ type: 'WRECKED', pyramid: p, reason: 'TIMEOUT' });
    return events;
  }

  const sideAligns =
    (p.side === 'BUY' && indicatorScore > 0.3) ||
    (p.side === 'SELL' && indicatorScore < -0.3);

  // ─── Katman ekleme ─────────────────────────────────────
  if (sideAligns) {
    const hitThreshold =
      p.side === 'BUY'
        ? lastPrice >= p.nextLayerThreshold
        : lastPrice <= p.nextLayerThreshold;

    if (hitThreshold) {
      const newLevel = p.layers.length + 1;
      // Fibonacci büyüme: her katman bir öncekinden growthMultiplier katı büyük
      const lastNotional = p.layers[p.layers.length - 1].notional;
      const newNotional = lastNotional * config.growthMultiplier;
      p.layers.push({
        level: newLevel,
        addPrice: lastPrice,
        addTs: ts,
        notional: newNotional,
      });
      p.peakLayers = Math.max(p.peakLayers, newLevel);
      p.nextLayerThreshold = computeNextThreshold(
        lastPrice,
        p.side,
        config.layerAddPct,
      );
      p.lastLayerInvalidatePrice = computeLayerInvalidatePrice(
        lastPrice,
        p.side,
        config.layerRemovePct,
      );
      events.push({ type: 'LAYER_ADDED', pyramid: p, level: newLevel });
    }
  }

  // ─── Katman silme ────────────────────────────────────────
  const lastLayer = p.layers[p.layers.length - 1];
  if (lastLayer && p.layers.length > 1) {
    const breached =
      p.side === 'BUY'
        ? lastPrice <= p.lastLayerInvalidatePrice
        : lastPrice >= p.lastLayerInvalidatePrice;

    if (breached) {
      const removed = p.layers.pop()!;
      const newLast = p.layers[p.layers.length - 1];
      // Eşikleri son kalan katmana göre güncelle
      p.nextLayerThreshold = computeNextThreshold(
        newLast.addPrice,
        p.side,
        config.layerAddPct,
      );
      p.lastLayerInvalidatePrice = computeLayerInvalidatePrice(
        newLast.addPrice,
        p.side,
        config.layerRemovePct,
      );
      events.push({ type: 'LAYER_REMOVED', pyramid: p, level: removed.level });
    }
  }

  // ─── Piramit yıkılması ──────────────────────────────────
  if (p.layers.length === 0) {
    p.status = 'WRECKED';
    events.push({ type: 'WRECKED', pyramid: p, reason: 'REVERSAL' });
    return events;
  }

  // Son katman = tek baz katman kaldıysa ve skor ters yönde ise → yık
  if (p.layers.length === 1) {
    const opposite =
      (p.side === 'BUY' && indicatorScore < -config.triggerThreshold) ||
      (p.side === 'SELL' && indicatorScore > config.triggerThreshold);
    if (opposite) {
      p.layers.pop();
      p.status = 'WRECKED';
      events.push({ type: 'WRECKED', pyramid: p, reason: 'REVERSAL' });
    }
  }

  return events;
}

/** Anlık toplam hayali notional */
export function pyramidNotional(p: PyramidState): number {
  return totalNotional(p.layers);
}
