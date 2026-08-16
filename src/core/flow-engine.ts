/**
 * Para Akış Motoru (Order Flow Engine)
 *
 * Fikir: Fiyatın ne yaptığına değil, PARANIN nerede biriktiğine bak.
 * Her trade'in büyüklüğüne göre tier'a ayır, son 60 saniye için
 * tier-bazlı alış/satış hacmini ve CVD'sini hesapla.
 *
 * Çıktı:
 *  - Her tier için delta, imbalance
 *  - Büyük-küçük oyuncu ayrımı: Whale+Mega ("smart money") vs Micro+Small ("retail")
 *  - Divergence tespiti:
 *       Fiyat ↑, whale satıyor, retail alıyor → DISTRIBUTION (ayyuka çıkış)
 *       Fiyat ↓, whale alıyor, retail satıyor → ACCUMULATION  (dip toplama)
 *  - Güven skoru + metinsel açıklama (neden BUY/SELL/WAIT)
 */

import { TIER_IDS, TIERS, tierFromNotional, emptyTierMetrics, type TierId, type TierMetrics } from './tiers';

const WINDOW_MS = 60_000;     // 60 saniyelik ana pencere
const RECENT_MS = 5_000;     // "son 5 saniye" diverjansı
const ALPHA_EMA = 0.02;      // yumuşatma

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
  smartMoneyDelta: number;      // whale+mega toplam delta
  retailDelta: number;          // micro+small toplam delta
  signal: 'STRONG_BUY' | 'BUY' | 'WAIT' | 'SELL' | 'STRONG_SELL';
  confidence: number;           // 0–100
  regime: 'ACCUMULATION' | 'DISTRIBUTION' | 'SMART_FOLLOWS_PRICE' | 'RETAIL_DRIVEN' | 'QUIET';
  reasons: string[];            // kullanıcıya gösterilecek sebep cümleleri
  stats: {
    totalVolume: number;
    tradeCount: number;
    whaleTradeCount: number;
    megaTradeCount: number;
  };
}

export class FlowEngine {
  private trades: Trade[] = [];
  private priceRef: { price: number; ts: number } | null = null;

  pushTrade(ts: number, price: number, qty: number, side: 'BUY' | 'SELL'): void {
    const notional = price * qty;
    const tier = tierFromNotional(notional);
    this.trades.push({ ts, price, qty, side, notional, tier });
    if (!this.priceRef || price > 0) this.priceRef = { price, ts };
    // Pencere dışı eski trade'leri at
    const cutoff = ts - WINDOW_MS * 1.5;
    while (this.trades.length && this.trades[0].ts < cutoff) this.trades.shift();
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

    // 1 dakika öncesinin fiyatı ve son fiyat
    for (const t of this.trades) {
      if (t.ts >= windowStart) {
        if (firstPrice === 0) firstPrice = t.price;
        lastPrice = t.price;
      }
    }
    const price = this.priceRef?.price ?? lastPrice ?? 0;
    const priceChangePct = firstPrice > 0 ? ((lastPrice - firstPrice) / firstPrice) : 0;

    // Her tier için hacimleri topla
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

    // Her tier için delta/imbalance/ema/share
    for (const id of TIER_IDS) {
      const m = metrics[id];
      m.delta = m.buyVol - m.sellVol;
      const total = m.buyVol + m.sellVol;
      m.imbalance = total > 0 ? m.delta / total : 0;
      // EMA yumuşatması
      m.ema = (1 - ALPHA_EMA) * m.ema + ALPHA_EMA * m.imbalance;
      m.sharePct = totalVol > 0 ? total / totalVol : 0;
    }

    // Smart money (whale + mega) vs Retail (micro + small)
    const smartDelta = metrics.WHALE.delta + metrics.MEGA.delta;
    const smartVol = metrics.WHALE.buyVol + metrics.WHALE.sellVol + metrics.MEGA.buyVol + metrics.MEGA.sellVol;
    const retailDelta = metrics.MICRO.delta + metrics.SMALL.delta;
    const retailVol = metrics.MICRO.buyVol + metrics.MICRO.sellVol + metrics.SMALL.buyVol + metrics.SMALL.sellVol;
    const smartImb = smartVol > 0 ? smartDelta / smartVol : 0;
    const retailImb = retailVol > 0 ? retailDelta / retailVol : 0;

    // Son 5 saniye yön
    let recentBuy = 0, recentSell = 0;
    for (const t of this.trades) {
      if (t.ts < recentStart) continue;
      if (t.side === 'BUY') recentBuy += t.notional;
      else recentSell += t.notional;
    }
    const recentImb = recentBuy + recentSell > 0 ? (recentBuy - recentSell) / (recentBuy + recentSell) : 0;

    // ─── Rejim tespiti ────────────────────────────────────
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

    // Tier-bazlı öne çıkanlar
    const strongestTier = TIER_IDS
      .filter((id) => metrics[id].buyVol + metrics[id].sellVol > 10_000)
      .sort((a, b) => Math.abs(metrics[b].delta) - Math.abs(metrics[a].delta))[0];
    if (strongestTier) {
      const t = TIERS.find((x) => x.id === strongestTier)!;
      const m = metrics[strongestTier];
      const pct = (m.imbalance * 100).toFixed(0);
      reasons.push(`${t.emoji} ${t.label}: ${m.imbalance > 0 ? 'alıcı' : 'satıcı'} baskın (${pct}%, hacim payı %${(m.sharePct * 100).toFixed(0)})`);
    }

    // Mega balina var mı?
    if (megaCount > 0) {
      reasons.push(`🐳 ${megaCount} adet MEGA (>1M$) işlem gerçekleşti!`);
    } else if (whaleCount > 3) {
      reasons.push(`🐋 ${whaleCount} adet balina (>100K$) işlemi`);
    }

    // Son 5sn momentum
    if (recentImb > 0.3) reasons.push(`⚡ Son 5sn: alım baskısı artıyor`);
    else if (recentImb < -0.3) reasons.push(`⚡ Son 5sn: satım baskısı artıyor`);

    // ─── Sinyal ve güven ───────────────────────────────────
    let signal: FlowSnapshot['signal'] = 'WAIT';
    let confidence = 20;

    // Skoru hesapla (-100 ile +100 arası)
    let score = 0;
    score += smartImb * 50;                     // akıllı para ağırlığı
    score += recentImb * 25;                    // son 5sn momentum
    if (regime === 'ACCUMULATION') score += 30;
    if (regime === 'DISTRIBUTION') score -= 30;
    if (regime === 'SMART_FOLLOWS_PRICE') score += priceUp ? 15 : -15;
    if (regime === 'RETAIL_DRIVEN') score *= 0.4; // retail sinyalini kır
    if (totalVol < 500_000) score *= 0.5;       // düşük hacimde güven düşük

    score = Math.max(-100, Math.min(100, score));
    confidence = Math.round(Math.abs(score));

    if (score >= 50) signal = 'STRONG_BUY';
    else if (score >= 20) signal = 'BUY';
    else if (score <= -50) signal = 'STRONG_SELL';
    else if (score <= -20) signal = 'SELL';
    else signal = 'WAIT';

    // Sinyal gerekçesi
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
    };
  }
}
