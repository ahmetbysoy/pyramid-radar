import { describe, it, expect } from 'vitest';
import { AdaptiveTierTracker } from './adaptive-tiers';

describe('AdaptiveTierTracker', () => {
  it('30 örnekten azken fallback kullanır', () => {
    const t = new AdaptiveTierTracker();
    for (let i = 0; i < 10; i++) t.push(100 + i);
    const th = t.getThresholds();
    expect(th.WHALE).toBe(100_000);
    expect(th.MEGA).toBe(1_000_000);
    expect(th.sampleSize).toBe(10);
  });

  it('yeterli örnekten sonra percentile eşikleri hesaplar', () => {
    const t = new AdaptiveTierTracker();
    // 1000 adet 100$-10.000$ arası trade
    for (let i = 0; i < 1000; i++) {
      const n = 100 + Math.random() * 9900;
      t.push(n);
    }
    // Zorla recalc
    (t as any).lastRecalc = 0;
    const th = t.getThresholds();
    expect(th.LARGE).toBeGreaterThanOrEqual(1_000);  // floor
    expect(th.LARGE).toBeLessThanOrEqual(500_000);  // ceil
    expect(th.WHALE).toBeGreaterThan(th.LARGE);      // monoton
    expect(th.MEGA).toBeGreaterThan(th.WHALE);
  });

  it('tavan ve taban kelepçesi çalışır', () => {
    const t = new AdaptiveTierTracker();
    // Çok küçük notional'lar (örn. PEPE'ye benzer)
    for (let i = 0; i < 500; i++) t.push(1 + Math.random() * 10);
    (t as any).lastRecalc = 0;
    const th = t.getThresholds();
    expect(th.LARGE).toBeGreaterThanOrEqual(1_000);   // FLAT taban
    expect(th.MEGA).toBeGreaterThanOrEqual(50_000);

    // Çok büyük notional'lar
    const t2 = new AdaptiveTierTracker();
    for (let i = 0; i < 500; i++) t2.push(10_000_000 + Math.random() * 5_000_000);
    (t2 as any).lastRecalc = 0;
    const th2 = t2.getThresholds();
    expect(th2.MEGA).toBeLessThanOrEqual(20_000_000);  // CEILING
  });

  it('isSmartMoney / isRetail', () => {
    const t = new AdaptiveTierTracker();
    expect(t.isRetail('MICRO')).toBe(true);
    expect(t.isSmartMoney('WHALE')).toBe(true);
    expect(t.isSmartMoney('MEGA')).toBe(true);
    expect(t.isSmartMoney('LARGE')).toBe(true);
    expect(t.isRetail('MEDIUM')).toBe(true);
  });
});
