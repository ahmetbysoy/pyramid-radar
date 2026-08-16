import { describe, it, expect } from 'vitest';
import { FlowEngine } from './flow-engine';
import { tierFromNotional } from './tiers';

describe('Tier sınıflandırma', () => {
  it('küçük işlem micro tierda', () => {
    expect(tierFromNotional(50)).toBe('MICRO');
    expect(tierFromNotional(150)).toBe('SMALL');
    expect(tierFromNotional(1500)).toBe('MEDIUM');
    expect(tierFromNotional(15000)).toBe('LARGE');
    expect(tierFromNotional(150000)).toBe('WHALE');
    expect(tierFromNotional(1500000)).toBe('MEGA');
  });
});

describe('Flow Engine', () => {
  it('başlangıçta WAIT verir', () => {
    const e = new FlowEngine();
    const snap = e.compute(Date.now());
    expect(snap.signal).toBe('WAIT');
    expect(snap.confidence).toBeLessThan(30);
  });

  it('tek bir micro alım rejimi değiştirmez', () => {
    const e = new FlowEngine();
    const ts = Date.now();
    e.pushTrade(ts, 1000, 0.01, 'BUY'); // 10$
    const snap = e.compute(ts);
    expect(snap.stats.tradeCount).toBe(1);
    expect(snap.signal).toBe('WAIT');
  });

  it('büyük whale alımları STRONG_BUY üretir', () => {
    const e = new FlowEngine();
    const ts = Date.now();
    // 10 adet whale buy (150K$ her biri = 1.5M$ toplam)
    for (let i = 0; i < 10; i++) {
      e.pushTrade(ts - i * 800, 1000, 150, 'BUY');
    }
    const snap = e.compute(ts);
    expect(snap.signal).toBe('STRONG_BUY');
    expect(snap.confidence).toBeGreaterThan(40);
  });

  it('distribütör tespiti: fiyat↑ whale satıyor retail alıyor', () => {
    const e = new FlowEngine();
    let price = 1000;
    const ts = Date.now();
    // 10 whale sell
    for (let i = 0; i < 8; i++) {
      price += 0.5; // fiyat yukarı
      e.pushTrade(ts - i * 500, price, 200, 'SELL'); // 200K each
    }
    // 50 small buy
    for (let i = 0; i < 50; i++) {
      e.pushTrade(ts - i * 80, price, 0.3, 'BUY'); // 300$ each
    }
    const snap = e.compute(ts);
    expect(snap.regime).toBe('DISTRIBUTION');
    // Distribüsyonda fiyat yukarı olsa bile sinyal SELL olmalı
    expect(['SELL', 'STRONG_SELL', 'WAIT']).toContain(snap.signal);
    expect(snap.reasons.some((r) => r.includes('DİSTRİBÜSYON'))).toBe(true);
  });

  it('akümülasyon tespiti: fiyat↓ whale alıyor retail satıyor', () => {
    const e = new FlowEngine();
    let price = 1000;
    const ts = Date.now();
    for (let i = 0; i < 8; i++) {
      price -= 0.5;
      e.pushTrade(ts - i * 500, price, 200, 'BUY');
    }
    for (let i = 0; i < 50; i++) {
      e.pushTrade(ts - i * 80, price, 0.3, 'SELL');
    }
    const snap = e.compute(ts);
    expect(snap.regime).toBe('ACCUMULATION');
    expect(['BUY', 'STRONG_BUY']).toContain(snap.signal);
  });
});
