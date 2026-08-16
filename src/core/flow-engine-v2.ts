/**
 * Para Akış Motoru v2 — Adaptif Tier'lar
 *
 * v1'den farkı: sabit 100$/1K/... eşikleri yerine AdaptiveTierTracker kullanıyor.
 * Percentile tabanlı eşikler her coin'e otomatik uyum sağlar.
 *
 * Çıktı aynı formatta korunur (UI kırılmaz), fakat tier threshold'ları gerçek zamanlı güncellenir.
 * Akıllı para tanımı da adaptif: WHALE + MEGA + LARGE (P70+) = smart money.
 */

import { AdaptiveTierTracker, TIER_CONFIGS } from './adaptive-tiers';
import { TIER_IDS, type TierId, type TierMetrics, emptyTierMetrics } from './tiers';

const WINDOW_MS = 60_000;
const RECENT_MS = 5_000;
const ALPHA_EMA = 0.02;

interface Trade {
  ts: number;
  price: number;
  qty: number;
  side: 'BUY' | 'SELL';
  notional: number;
  tier: TierId;
}

export interface FlowSnapshot {
  timestamp: number;
  price: number;
  priceChange1mPct: number;
  tiers: TierMetrics;
  smartMoneyDelta: number;
  retailDelta: number;
  signal: 'STRONG_BUY' | 'BUY' | 'WAIT' | 'SELL' | 'STRONG_SELL';
  confidence: number;
  regime: 'ACCUMULATION' | 'DISTRIBUTION' | 'SMART_FOLLOWS_PRICE' | 'RETAIL_DRIVEN' | 'QUIET';
  reasons: string[];
  stats: {
    totalVolume: number;
    tradeCount: number;
    whaleTradeCount: number;
    megaTradeCount: number;
  };
  /** Akıllı para imbalansı (-1..+1) — piramit motorunun kullandığı değer */
  smartImbalance: number;
  /** Mevcut adaptif tier eşikleri (UI'da "Ne kadar balina?" göstergesi için) */
  thresholds: {
    LARGE: number;
    WHALE: number;
    MEGA: number;
    sampleSize: number;
  };
}

export class FlowEngine {
  private trades: Trade[] = [];
  private priceRef: { price: number; ts: number } | null = null;
  private tracker = new AdaptiveTierTracker();

  /** Son tick'te toplanan smart-money dolgular (piramit motoru için) */
  private pendingFills: Array<{
    side: 'BUY' | 'SELL'; price: number; qty: number; notional: number; tier: TierId; ts: number;
  }> = [];

  pushTrade(ts: number, price: number, qty: number, side: 'BUY' | 'SELL'): void {
    const notional = price * qty;
    this.tracker.push(notional);
    const tier = this.tracker.tierFromNotional(notional);
    this.trades.push({ ts, price, qty, side, notional, tier });
    if (!this.priceRef || price > 0) this.priceRef = { price, ts };

    // Akıllı para dolgusuysa piramit için queue'la
    if (this.tracker.isSmartMoney(tier)) {
      this.pendingFills.push({ side, price, qty, notional, tier, ts });
    }

    // Eskileri temizle
    const cutoff = ts - WINDOW_MS * 1.5;
    while (this.trades.length && this.trades[0].ts < cutoff) this.trades.shift();

    // Pending fills temizliği de (son 1 saniyelik)
    while (this.pendingFills.length && this.pendingFills[0].ts < ts - 1500) this.pendingFills.shift();
  }

  /**
   * Bu tick'te birikmiş smart-money dolgularını döndür ve temizle.
   * Piramit motoru tarafından çağrılır.
   */
  drainFills(): FlowSnapshot['stats'] extends infer _ ? Array<{side:'BUY'|'SELL';price:number;qty:number;notional:number;tier:TierId;ts:number}> : never {
    const out = this.pendingFills;
    this.pendingFills = [];
    return out as ReturnType<typeof this.drainFills>;
  }

  compute(ts: number): FlowSnapshot {
    const metrics = emptyTierMetrics();
    const windowStart = ts - WINDOW_MS;
    const recentStart = ts - RECENT_MS;
    let totalVol = 0;
    let count = 0;
    let whaleCount = 0;
    let megaCount = 0;
    let firstPrice = 0;
    let lastPrice = 0;
    const th = this.tracker.getThresholds();

    for (const t of this.trades) {
      if (t.ts >= windowStart) {
        if (firstPrice === 0) firstPrice = t.price;
        lastPrice = t.price;
      }
    }
    const price = this.priceRef?.price ?? lastPrice ?? 0;
    const priceChangePct = firstPrice > 0 ? ((lastPrice - firstPrice) / firstPrice) : 0;

    for (const t of this.trades) {
      if (t.ts < windowStart) continue;
      count++;
      totalVol += t.notional;
      const m = metrics[t.tier];
      if (t.side === 'BUY') m.buyVol += t.notional;
      else m.sellVol += t.notional;
      if (t.tier === 'WHALE') whaleCount++;
      if (t.tier === 'MEGA') megaCount++;
    }

    for (const id of TIER_IDS) {
      const m = metrics[id];
      m.delta = m.buyVol - m.sellVol;
      const total = m.buyVol + m.sellVol;
      m.imbalance = total > 0 ? m.delta / total : 0;
      m.ema = (1 - ALPHA_EMA) * m.ema + ALPHA_EMA * m.imbalance;
      m.sharePct = totalVol > 0 ? total / totalVol : 0;
    }

    // Akıllı para = LARGE+WHALE+MEGA (P70+)
    const smartDelta = metrics.LARGE.delta + metrics.WHALE.delta + metrics.MEGA.delta;
    const smartVol =
      metrics.LARGE.buyVol + metrics.LARGE.sellVol +
      metrics.WHALE.buyVol + metrics.WHALE.sellVol +
      metrics.MEGA.buyVol + metrics.MEGA.sellVol;
    const retailDelta = metrics.MICRO.delta + metrics.SMALL.delta + metrics.MEDIUM.delta;
    const retailVol =
      metrics.MICRO.buyVol + metrics.MICRO.sellVol +
      metrics.SMALL.buyVol + metrics.SMALL.sellVol +
      metrics.MEDIUM.buyVol + metrics.MEDIUM.sellVol;
    const smartImb = smartVol > 0 ? smartDelta / smartVol : 0;
    const retailImb = retailVol > 0 ? retailDelta / retailVol : 0;

    let recentBuy = 0, recentSell = 0;
    for (const t of this.trades) {
      if (t.ts < recentStart) continue;
      if (t.side === 'BUY') recentBuy += t.notional;
      else recentSell += t.notional;
    }
    const recentImb = recentBuy + recentSell > 0 ? (recentBuy - recentSell) / (recentBuy + recentSell) : 0;

    let regime: FlowSnapshot['regime'] = 'QUIET';
    const reasons: string[] = [];

    const strongThresh = 0.25;
    const priceUp = priceChangePct > 0.001;
    const priceDn = priceChangePct < -0.001;
    const smartBuying = smartImb > strongThresh;
    const smartSelling = smartImb < -strongThresh;
    const retailBuying = retailImb > strongThresh;
    const retailSelling = retailImb < -strongThresh;

    if (priceUp && smartSelling && retailBuying && Math.abs(smartImb) > 0.15) {
      regime = 'DISTRIBUTION';
      reasons.push('📤 DİSTRİBÜSYON: Fiyat yükseliyor ama balinalar satıyor, retail alıyor → tepeye mal dağıtımı');
    } else if (priceDn && smartBuying && retailSelling && Math.abs(smartImb) > 0.15) {
      regime = 'ACCUMULATION';
      reasons.push('📥 AKÜMÜLASYON: Fiyat düşüyor ama balinalar alıyor, retail panik satıyor → dip toplama');
    } else if ((priceUp && smartBuying) || (priceDn && smartSelling)) {
      regime = 'SMART_FOLLOWS_PRICE';
      reasons.push(`🎯 Akıllı para fiyatı destekliyor (${priceUp ? 'yukarı' : 'aşağı'} yönlü, balina imbalansı ${(smartImb * 100).toFixed(0)}%)`);
    } else if (retailBuying || retailSelling) {
      regime = 'RETAIL_DRIVEN';
      reasons.push(`🐟 Hareket perakende kaynaklı (balina yok, retail imbalansı ${(retailImb * 100).toFixed(0)}%)`);
    } else if (totalVol < 100_000) {
      reasons.push('🔇 Düşük hacim — beklemede');
    }

    // En güçlü tier
    const strongest = TIER_CONFIGS
      .map((c) => ({ c, m: metrics[c.id] }))
      .filter(({ m }) => m.buyVol + m.sellVol > 10_000)
      .sort((a, b) => Math.abs(b.m.delta) - Math.abs(a.m.delta))[0];
    if (strongest) {
      const { c, m } = strongest;
      const pct = (m.imbalance * 100).toFixed(0);
      reasons.push(`${c.emoji} ${c.label}: ${m.imbalance > 0 ? 'alıcı' : 'satıcı'} baskın (${pct}%, hacim payı %${(m.sharePct * 100).toFixed(0)})`);
    }

    if (megaCount > 0) reasons.push(`🐳 ${megaCount} adet MEGA (>${fmtC(th.MEGA)}) işlem gerçekleşti!`);
    else if (whaleCount > 3) reasons.push(`🐋 ${whaleCount} adet balina (>${fmtC(th.WHALE)}) işlemi`);

    if (recentImb > 0.3) reasons.push(`⚡ Son 5sn: alım baskısı artıyor`);
    else if (recentImb < -0.3) reasons.push(`⚡ Son 5sn: satım baskısı artıyor`);

    // Uyum bildirimi
    if (th.sampleSize < 30) {
      reasons.push(`📊 Adaptif eşikler toplanıyor (${th.sampleSize}/30)...`);
    }

    let signal: FlowSnapshot['signal'] = 'WAIT';
    let confidence = 20;
    let score = 0;
    score += smartImb * 50;
    score += recentImb * 25;
    if (regime === 'ACCUMULATION') score += 30;
    if (regime === 'DISTRIBUTION') score -= 30;
    if (regime === 'SMART_FOLLOWS_PRICE') score += priceUp ? 15 : -15;
    if (regime === 'RETAIL_DRIVEN') score *= 0.4;
    if (totalVol < 500_000) score *= 0.5;

    score = Math.max(-100, Math.min(100, score));
    confidence = Math.round(Math.abs(score));

    if (score >= 50) signal = 'STRONG_BUY';
    else if (score >= 20) signal = 'BUY';
    else if (score <= -50) signal = 'STRONG_SELL';
    else if (score <= -20) signal = 'SELL';
    else signal = 'WAIT';

    if (signal === 'WAIT' && reasons.length === 1) {
      reasons.unshift('⏸️ Tarafsız bölge — sinyal için balina hareketi bekleniyor');
    }

    return {
      timestamp: ts,
      price,
      priceChange1mPct: priceChangePct,
      tiers: metrics,
      smartMoneyDelta: smartDelta,
      retailDelta,
      signal,
      confidence,
      regime,
      reasons,
      stats: {
        totalVolume: totalVol,
        tradeCount: count,
        whaleTradeCount: whaleCount,
        megaTradeCount: megaCount,
      },
      smartImbalance: smartImb,
      thresholds: {
        LARGE: th.LARGE,
        WHALE: th.WHALE,
        MEGA: th.MEGA,
        sampleSize: th.sampleSize,
      },
    };
  }
}

function fmtC(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}
