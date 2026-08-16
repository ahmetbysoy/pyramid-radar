import { describe, it, expect } from 'vitest';
import { spawnRealPyramid, updateRealPyramid, pyramidVWAP } from './real-flow-engine';
import { DEFAULT_PYRAMID_CONFIG } from './types';

const BUY = 'BUY' as const;
const SELL = 'SELL' as const;

// Test için çok hassas config: layerAddPct %0.1, layerRemovePct %0.1, trigger 0.3
const TEST_CFG = { ...DEFAULT_PYRAMID_CONFIG, layerAddPct: 0.001, layerRemovePct: 0.001, triggerThreshold: 0.3, timeoutMs: 9999999 };

describe('spawnRealPyramid', () => {
  it('tohum katman verilen notional ile doğar (0-notional değil)', () => {
    const p = spawnRealPyramid('BTCUSDT', BUY, 100, 'WHALE', 50_000, TEST_CFG, 1000);
    expect(p.layers.length).toBe(1);
    expect(p.layers[0].notional).toBe(50_000);
    expect(p.totalNotional).toBe(50_000);
    expect(p.status).toBe('GROWING');
    expect(pyramidVWAP(p)).toBe(100);
  });
});

describe('updateRealPyramid', () => {
  it('aynı yönlü dolgu son katmana eklenir', () => {
    const p = spawnRealPyramid('BTCUSDT', BUY, 100, 'WHALE', 50_000, TEST_CFG);
    updateRealPyramid(p, 100, 0.8, [
      { side: BUY, price: 100.1, qty: 100, notional: 10_010, tier: 'LARGE', ts: Date.now() },
    ], Date.now());
    expect(p.layers[0].notional).toBeCloseTo(60_010, 0);
    expect(p.totalNotional).toBeCloseTo(60_010, 0);
  });

  it('karşı yönlü dolgu katmanı etkilemez', () => {
    const p = spawnRealPyramid('BTCUSDT', BUY, 100, 'WHALE', 50_000, TEST_CFG);
    const before = p.layers[0].notional;
    updateRealPyramid(p, 100, 0.8, [
      { side: SELL, price: 100, qty: 200, notional: 20_000, tier: 'WHALE', ts: Date.now() },
    ], Date.now());
    expect(p.layers[0].notional).toBe(before);
  });

  it('fiyat VWAP invalidate altına inerse tek katman yıkılır', () => {
    const p = spawnRealPyramid('BTCUSDT', BUY, 100, 'WHALE', 50_000, TEST_CFG);
    // layerRemovePct 0.001 → invalidate = 99.9
    const events = updateRealPyramid(p, 99.8, -0.9, [], Date.now());
    const wreck = events.find(e => e.type === 'WRECKED');
    expect(wreck).toBeDefined();
    expect(p.status).toBe('WRECKED');
  });

  it('fiyat threshold aşarsa yeni katman açılır (0-notional değil)', () => {
    const p = spawnRealPyramid('BTCUSDT', BUY, 100, 'WHALE', 50_000, TEST_CFG);
    // Yeni katman eşiği = 100 × 1.001 = 100.1
    // Önce bir sürü dolgu ekle (pendingNotional'ı geçir)
    const ts = Date.now();
    updateRealPyramid(p, 100.15, 0.8, [
      { side: BUY, price: 100.12, qty: 1000, notional: 100_120, tier: 'WHALE', ts },
    ], ts);
    // Yeni katman açılmış olmalı
    expect(p.layers.length).toBeGreaterThanOrEqual(2);
    const newLayer = p.layers[p.layers.length - 1];
    expect(newLayer.notional).toBeGreaterThan(0); // hayalet katman yok
  });
});
