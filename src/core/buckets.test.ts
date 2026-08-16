import { describe, it, expect } from 'vitest';
import { BucketStore } from './buckets';

const BUY = 'BUY' as const;
const SELL = 'SELL' as const;

describe('BucketStore', () => {
  it('trade ekledikçe session ve son bucket dolar', () => {
    const bs = new BucketStore();
    const now = Date.now();
    const sec = Math.floor(now / 1000) * 1000;
    bs.addTrade(sec, 100, 2, BUY, 'LARGE');   // 200$ alış
    bs.addTrade(sec + 200, 101, 1, SELL, 'MEGA'); // 101$ satış, 101$
    expect(bs.session.tradeCount).toBe(2);
    expect(bs.session.totalVol).toBeCloseTo(200 + 101, 2);
    expect(bs.session.lastPrice).toBe(101);
    expect(bs.session.startPrice).toBe(100);
    expect(bs.session.megaCount).toBe(1);
  });

  it('1dk pencere sadece son 60 saniyeyi sayar', () => {
    const bs = new BucketStore();
    const now = Date.now();
    // 2dk önceki trade
    bs.addTrade(now - 120_000, 100, 10, BUY, 'WHALE'); // 1000$
    // 30sn önceki trade
    bs.addTrade(now - 30_000, 101, 5, SELL, 'LARGE'); // 505$
    const agg = bs.aggregate(60_000 as any, '1dk', now);
    expect(agg.tradeCount).toBe(1);
    expect(agg.totalVol).toBeCloseTo(505, 1);
  });

  it('VWAP = Σ(P*Q)/Σ(Q)', () => {
    const bs = new BucketStore();
    const now = Date.now();
    const sec = Math.floor(now / 1000) * 1000;
    // 100$ × 2 adet = 200$
    bs.addTrade(sec, 100, 2, BUY, 'LARGE');
    // 110$ × 3 adet = 330$
    bs.addTrade(sec + 500, 110, 3, BUY, 'LARGE');
    const agg = bs.aggregate(60_000 as any, '1dk', now + 1000);
    // VWAP = (200 + 330) / (2 + 3) = 106
    expect(agg.vwap).toBeCloseTo(106, 2);
  });

  it('smartImbalance +1 olmalı (tamamen alış)', () => {
    const bs = new BucketStore();
    const now = Date.now();
    const sec = Math.floor(now / 1000) * 1000;
    bs.addTrade(sec, 100, 100, BUY, 'WHALE'); // 10k$ whale alış
    bs.addTrade(sec + 500, 101, 100, BUY, 'MEGA');
    const agg = bs.aggregate(60_000 as any, '1dk', now + 1000);
    expect(agg.smartImb).toBeCloseTo(1, 4);
  });

  it('reset sonrası session temizlenir', () => {
    const bs = new BucketStore();
    const now = Date.now();
    bs.addTrade(now, 100, 1, BUY, 'LARGE');
    bs.reset();
    expect(bs.session.tradeCount).toBe(0);
    expect(bs.session.totalVol).toBe(0);
  });
});
