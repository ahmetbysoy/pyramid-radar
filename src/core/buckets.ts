/**
 * Saniyelik kova (bucket) sistemi.
 *
 * Her saniye bir kovada toplanır:
 *   - Tier-bazli alis/satis hacmi (USDT)
 *   - O saniyenin OHLC'si
 *   - Σ(P*Q) ve Σ(Q) → pencere VWAP'ı
 *   - Akıllı para / retail için ayrı Σ(P*Q) ve Σ(Q)
 *   - İşlem, balina, mega sayıları
 *
 * Ring buffer olarak tutulur (sabit MAX_BUCKETS boyut).
 * Pencere istendiğinde sadece ilgili kovalar toplanır.
 *
 * MAX_BUCKETS = 3600 (1 saat) → 3600 obje × ~200 byte = ~720 KB. Hiç.
 * 5000 event/sn'de bile saniyede 1 defa bucket'a yazılır (O(1)),
 * aggregation 30 Hz'de 1/60/300/900/3600 kova üzerinden yapılır.
 * 3600 kova × 5 pencere = 18K iter/sn → işlemciyi uyutur.
 */

import type { TierId } from './tiers';

export const MAX_BUCKETS = 3600; // 1 saat
export const TIER_IDS: TierId[] = ['MICRO', 'SMALL', 'MEDIUM', 'LARGE', 'WHALE', 'MEGA'];

export interface SecondBucket {
  sec: number;
  tierBuy: Record<TierId, number>;
  tierSell: Record<TierId, number>;
  tradeCount: number;
  whaleCount: number;
  megaCount: number;
  o: number; h: number; l: number; c: number;
  /** Σ(P*Q) genel VWAP için */
  pq: number;
  qty: number;
  /** akıllı para VWAP'ı (LARGE+WHALE+MEGA) */
  smartPq: number;
  smartQty: number;
  /** retail VWAP (MICRO+SMALL+MEDIUM) */
  retailPq: number;
  retailQty: number;
}

export type WindowMs = 60_000 | 300_000 | 900_000 | 3_600_000;

export const WINDOWS: { ms: WindowMs; label: string }[] = [
  { ms: 60_000,    label: '1dk' },
  { ms: 300_000,   label: '5dk' },
  { ms: 900_000,   label: '15dk' },
  { ms: 3_600_000, label: '1sa' },
];

export interface Aggregate {
  windowMs: number;
  windowLabel: string;
  bucketCount: number;
  tiers: Record<TierId, { buyVol: number; sellVol: number; delta: number; imbalance: number }>;
  totalVol: number;
  tradeCount: number;
  whaleCount: number;
  megaCount: number;
  firstPrice: number;
  lastPrice: number;
  highPrice: number;
  lowPrice: number;
  priceChangePct: number;
  vwap: number;
  smartVwap: number;
  retailVwap: number;
  smartImb: number;
  retailImb: number;
  smartBuy: number; smartSell: number;
  retailBuy: number; retailSell: number;
  /** son 5 sn momentum */
  recentImb: number;
}

function newTierCounts(): Record<TierId, number> {
  return { MICRO: 0, SMALL: 0, MEDIUM: 0, LARGE: 0, WHALE: 0, MEGA: 0 };
}
function newTierVol(): Record<TierId, { buyVol: number; sellVol: number; delta: number; imbalance: number }> {
  const out = {} as Record<TierId, { buyVol: number; sellVol: number; delta: number; imbalance: number }>;
  for (const id of TIER_IDS) out[id] = { buyVol: 0, sellVol: 0, delta: 0, imbalance: 0 };
  return out;
}

function emptyBucket(sec: number): SecondBucket {
  return {
    sec,
    tierBuy: newTierCounts(),
    tierSell: newTierCounts(),
    tradeCount: 0, whaleCount: 0, megaCount: 0,
    o: 0, h: 0, l: 0, c: 0,
    pq: 0, qty: 0,
    smartPq: 0, smartQty: 0,
    retailPq: 0, retailQty: 0,
  };
}

export class BucketStore {
  private buckets: SecondBucket[] = new Array(MAX_BUCKETS);
  private head = 0;
  private len = 0;
  private lastSec = -1;

  /** Oturum (uygulama açıldığından beri) */
  readonly session = {
    startTs: 0,
    startPrice: 0,
    lastPrice: 0,
    highPrice: 0,
    lowPrice: 0,
    tiers: newTierVol(),
    totalVol: 0,
    tradeCount: 0,
    whaleCount: 0,
    megaCount: 0,
    pq: 0, qty: 0,
    smartPq: 0, smartQty: 0,
    retailPq: 0, retailQty: 0,
  };

  reset() {
    this.buckets = new Array(MAX_BUCKETS);
    this.head = 0; this.len = 0; this.lastSec = -1;
    this.session.startTs = 0; this.session.startPrice = 0;
    this.session.lastPrice = 0; this.session.highPrice = 0; this.session.lowPrice = 0;
    this.session.tiers = newTierVol();
    this.session.totalVol = 0; this.session.tradeCount = 0;
    this.session.whaleCount = 0; this.session.megaCount = 0;
    this.session.pq = 0; this.session.qty = 0;
    this.session.smartPq = 0; this.session.smartQty = 0;
    this.session.retailPq = 0; this.session.retailQty = 0;
  }

  addTrade(ts: number, price: number, qty: number, side: 'BUY' | 'SELL', tier: TierId) {
    const notional = price * qty;
    const sec = Math.floor(ts / 1000);
    const isSmart = tier === 'LARGE' || tier === 'WHALE' || tier === 'MEGA';

    // Session
    if (this.session.startTs === 0) {
      this.session.startTs = ts;
      this.session.startPrice = price;
      this.session.highPrice = price;
      this.session.lowPrice = price;
    }
    this.session.totalVol += notional;
    this.session.tradeCount++;
    if (tier === 'WHALE') this.session.whaleCount++;
    if (tier === 'MEGA') this.session.megaCount++;
    if (side === 'BUY') this.session.tiers[tier].buyVol += notional;
    else this.session.tiers[tier].sellVol += notional;
    this.session.pq += price * qty;
    this.session.qty += qty;
    if (isSmart) { this.session.smartPq += price * qty; this.session.smartQty += qty; }
    else { this.session.retailPq += price * qty; this.session.retailQty += qty; }
    if (price > this.session.highPrice) this.session.highPrice = price;
    if (price < this.session.lowPrice) this.session.lowPrice = price;
    this.session.lastPrice = price;

    // Bucket
    let b: SecondBucket;
    if (this.lastSec !== sec || this.len === 0) {
      b = emptyBucket(sec);
      b.o = price; b.h = price; b.l = price; b.c = price;
      this.buckets[this.head] = b;
      this.head = (this.head + 1) % MAX_BUCKETS;
      if (this.len < MAX_BUCKETS) this.len++;
      this.lastSec = sec;
    } else {
      const idx = (this.head - 1 + MAX_BUCKETS) % MAX_BUCKETS;
      b = this.buckets[idx];
    }
    b.tradeCount++;
    if (tier === 'WHALE') b.whaleCount++;
    if (tier === 'MEGA') b.megaCount++;
    if (side === 'BUY') b.tierBuy[tier] += notional;
    else b.tierSell[tier] += notional;
    b.pq += price * qty;
    b.qty += qty;
    if (isSmart) { b.smartPq += price * qty; b.smartQty += qty; }
    else { b.retailPq += price * qty; b.retailQty += qty; }
    if (price > b.h) b.h = price;
    if (price < b.l) b.l = price;
    b.c = price;
  }

  /** Verilen pencere için aggregate hesapla. O(kovaSayısı) */
  aggregate(windowMs: WindowMs, windowLabel: string, nowTs: number): Aggregate {
    const tiers = newTierVol();
    let totalVol = 0, tradeCount = 0, whaleCount = 0, megaCount = 0;
    let firstPrice = 0, lastPrice = 0, highPrice = 0, lowPrice = 0;
    let pq = 0, qty = 0, smartPq = 0, smartQty = 0, retailPq = 0, retailQty = 0;
    let smartB = 0, smartS = 0, retB = 0, retS = 0;
    let bucketCount = 0;

    const cutoffSec = Math.floor((nowTs - windowMs) / 1000);

    if (this.len > 0) {
      for (let i = 0; i < this.len; i++) {
        const idx = (this.head - 1 - i + MAX_BUCKETS) % MAX_BUCKETS;
        const b = this.buckets[idx];
        if (!b || b.sec < cutoffSec) break;
        bucketCount++;
        tradeCount += b.tradeCount;
        whaleCount += b.whaleCount;
        megaCount += b.megaCount;
        pq += b.pq; qty += b.qty;
        smartPq += b.smartPq; smartQty += b.smartQty;
        retailPq += b.retailPq; retailQty += b.retailQty;
        for (const tid of TIER_IDS) {
          tiers[tid].buyVol += b.tierBuy[tid];
          tiers[tid].sellVol += b.tierSell[tid];
          const tot = b.tierBuy[tid] + b.tierSell[tid];
          totalVol += tot;
          if (tid === 'LARGE' || tid === 'WHALE' || tid === 'MEGA') {
            smartB += b.tierBuy[tid]; smartS += b.tierSell[tid];
          } else {
            retB += b.tierBuy[tid]; retS += b.tierSell[tid];
          }
        }
        if (i === 0) lastPrice = b.c; // en yeni close
        if (!highPrice || b.h > highPrice) highPrice = b.h;
        if (!lowPrice || b.l < lowPrice) lowPrice = b.l;
        firstPrice = b.o; // en eski'ye ulaşana kadar ezilecek
      }
    }

    // delta/imbalance
    for (const tid of TIER_IDS) {
      const t = tiers[tid];
      t.delta = t.buyVol - t.sellVol;
      const tot = t.buyVol + t.sellVol;
      t.imbalance = tot > 0 ? t.delta / tot : 0;
    }
    const smartVol = smartB + smartS;
    const retVol = retB + retS;
    const smartImb = smartVol > 0 ? (smartB - smartS) / smartVol : 0;
    const retailImb = retVol > 0 ? (retB - retS) / retVol : 0;

    const vwap = qty > 0 ? pq / qty : lastPrice;
    const smartVwap = smartQty > 0 ? smartPq / smartQty : vwap;
    const retailVwap = retailQty > 0 ? retailPq / retailQty : vwap;
    const priceChangePct = firstPrice > 0 && lastPrice > 0 ? (lastPrice - firstPrice) / firstPrice : 0;

    // Son 5 sn momentum: aggregate 5dk içindeyse ayrı hesapla, yoksa son 5sn bucket'larını hızlıca topla
    let recentImb = 0;
    const recentCutoff = Math.floor((nowTs - 5000) / 1000);
    let rB = 0, rS = 0;
    for (let i = 0; i < Math.min(this.len, 10); i++) {
      const idx = (this.head - 1 - i + MAX_BUCKETS) % MAX_BUCKETS;
      const b = this.buckets[idx];
      if (!b || b.sec < recentCutoff) break;
      for (const tid of TIER_IDS) {
        rB += b.tierBuy[tid]; rS += b.tierSell[tid];
      }
    }
    const rTot = rB + rS;
    recentImb = rTot > 0 ? (rB - rS) / rTot : 0;

    return {
      windowMs, windowLabel: windowLabel, bucketCount,
      tiers, totalVol, tradeCount, whaleCount, megaCount,
      firstPrice, lastPrice, highPrice, lowPrice, priceChangePct,
      vwap, smartVwap, retailVwap,
      smartImb, retailImb,
      smartBuy: smartB, smartSell: smartS,
      retailBuy: retB, retailSell: retS,
      recentImb,
    };
  }

  /** Tüm pencereler için aggregate (tek geçişte) */
  aggregateAll(nowTs: number): Record<WindowMs, Aggregate> {
    const out = {} as Record<WindowMs, Aggregate>;
    for (const w of WINDOWS) out[w.ms] = this.aggregate(w.ms, w.label, nowTs);
    return out;
  }
}
