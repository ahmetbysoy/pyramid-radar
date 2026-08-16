import { describe, it, expect } from 'vitest';
import {
  spawnPyramid,
  updatePyramid,
  avgEntry,
  pyramidNotional,
} from './engine';
import { DEFAULT_PYRAMID_CONFIG } from './types';

describe('Piramit Motoru', () => {
  it('tohum piramit 1 katmanlı olur', () => {
    const p = spawnPyramid('BTCUSDT', 'BUY', 1000);
    expect(p.layers).toHaveLength(1);
    expect(p.status).toBe('GROWING');
    expect(pyramidNotional(p)).toBeCloseTo(100);
  });

  it('fiyat yeterince yükselirse yeni katman eklenir', () => {
    const p = spawnPyramid('BTCUSDT', 'BUY', 1000);
    // %0.2 yukarı (eşik)
    const events = updatePyramid(p, 1000 * 1.0025, 1, Date.now() + 1000, DEFAULT_PYRAMID_CONFIG);
    expect(p.layers.length).toBe(2);
    expect(events.some((e) => e.type === 'LAYER_ADDED' && e.level === 2)).toBe(true);
    // 2. katman büyüklüğü 100 * 1.618
    expect(p.layers[1].notional).toBeCloseTo(161.8, 0);
  });

  it('fiyat düşerse son katman silinir (LIFO)', () => {
    const p = spawnPyramid('BTCUSDT', 'BUY', 1000);
    // Önce 2. katman ekle
    updatePyramid(p, 1000 * 1.003, 1, Date.now() + 1000);
    expect(p.layers.length).toBe(2);
    // Sonra düşür
    const events = updatePyramid(p, 1000, -0.2, Date.now() + 2000);
    expect(p.layers.length).toBe(1);
    expect(events.some((e) => e.type === 'LAYER_REMOVED' && e.level === 2)).toBe(true);
  });

  it('tek katman kalır ve ters yönlü kuvvetli sinyal gelirse yıkılır', () => {
    const p = spawnPyramid('BTCUSDT', 'BUY', 1000);
    expect(p.layers.length).toBe(1);
    const events = updatePyramid(p, 1000, -0.9, Date.now() + 1000);
    expect(p.status).toBe('WRECKED');
    expect(events.some((e) => e.type === 'WRECKED' && e.reason === 'REVERSAL')).toBe(true);
  });

  it('SELL piramidi için fiyat düşünce katman eklenir', () => {
    const p = spawnPyramid('BTCUSDT', 'SELL', 1000);
    const events = updatePyramid(p, 1000 * 0.9975, -1, Date.now() + 1000);
    expect(p.layers.length).toBe(2);
    expect(events[0].type).toBe('LAYER_ADDED');
  });

  it('katman ekledikçe ortalama giriş fiyatı güncellenir', () => {
    const p = spawnPyramid('BTCUSDT', 'BUY', 1000);
    updatePyramid(p, 1002, 1, Date.now() + 1000);
    const avg = avgEntry(p);
    // 1000*100 + 1002*161.8 / 261.8 ≈ 1001.24
    expect(avg).toBeGreaterThan(1000);
    expect(avg).toBeLessThan(1002);
  });

  it('zaman aşımında WRECKED olur', () => {
    const p = spawnPyramid('BTCUSDT', 'BUY', 1000);
    const events = updatePyramid(
      p,
      1000,
      0,
      Date.now() + DEFAULT_PYRAMID_CONFIG.timeoutMs + 1000,
    );
    expect(p.status).toBe('WRECKED');
    expect(events[0].type).toBe('WRECKED');
  });

  it('katman büyüklüğü fibonacci gibi artıyor', () => {
    const p = spawnPyramid('BTCUSDT', 'BUY', 1000);
    let price = 1000;
    let ts = Date.now();
    for (let i = 0; i < 4; i++) {
      price *= 1.003;
      ts += 1000;
      updatePyramid(p, price, 1, ts);
    }
    // Katmanlar: 100, 161.8, 261.8, 423.6, 685.4
    expect(p.layers).toHaveLength(5);
    expect(p.layers[4].notional).toBeGreaterThan(p.layers[3].notional);
    expect(p.layers[3].notional / p.layers[2].notional).toBeCloseTo(1.618, 1);
  });
});
