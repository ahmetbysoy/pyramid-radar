/**
 * EngineKernel — saf TS performans motoru (v4).
 *
 * PRENSIPLER:
 *  1. React'i tanimaz, import etmez, setState cagirmaz.
 *  2. Her WS event'i geldigi an O(1) olarak isler, ring-buffer'a yazar.
 *  3. Ust katman (React) 60fps'te snapshot() cagirir → sadece referans degismisse yeni obje doner.
 *  4. Hesaplamalar 1Hz'de (internal tick) yapilir, her raf'te sadece obje referansi okunur.
 *
 * CIFT PENCERE MIMARISI:
 *  - Saniyelik kovalar (bucket) tutulur: 3600 sn (1 saat) ring-buffer.
 *  - Kullanici 1/5/15/60 dk secer → o pencerenin aggregate'i (imbalance, VWAP, delta) hesaplanir.
 *  - "Session" (uygulama acildigindan beri) ayri tutulur, hicbir zaman dusmez.
 *  - Iki pencerenin imbalansi karsilastirilir:
 *      * Kisa vade SATIYOR, uzun vade ALIYOR → "Balina cikisa gecti — DONUS BASLADI"
 *      * Kisa vade ALIYOR, uzun vade SATIYOR → "Dususun dibinde akumulasyon"
 *      * Ayn yon → trend teyitli
 *      * Ayr yon → divergence (ana urun)
 *  - Piramit katmanlari uzun vade VWAP'a gore olgunlasir (catlamaz),
 *    kisa vade akisa gore buyur.
 *
 * NOT: Tier esikleri adaptiftir (percentile), tickSize ile fiyat formatlanir.
 */

import { AdaptiveTierTracker } from './adaptive-tiers';
import { BucketStore, WINDOWS } from './buckets';
import type { WindowMs, Aggregate } from './buckets';
export type { WindowMs } from './buckets';
import type { TierId } from './tiers';
import {
  spawnRealPyramid, updateRealPyramid, pyramidVWAP, pyramidPnLPct,
  type RealPyramid, type RealPyramidEvent, type Fill,
} from './pyramid/real-flow-engine';

export type KernelStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface PyramidLayerView {
  level: number;
  tier: TierId;
  anchorPrice: number;
  vwap: number;
  notional: number;
  invalidatePrice: number;
  widthPct: number;
  color: string;
  breached: boolean;
}

export interface PyramidView {
  id: string;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  entryTs: number;
  vwap: number;
  pnlPct: number;
  totalNotional: number;
  peakNotional: number;
  status: 'GROWING' | 'PEAKED' | 'COLLAPSING' | 'WRECKED';
  layers: PyramidLayerView[];
  nLayers: number;
  peakLayers: number;
}

export interface DivergenceSignal {
  /** 'SMART_DUMPING', 'ACCUMULATING', 'CONFIRMING_UP', 'CONFIRMING_DOWN', 'RETAIL_CHOP' */
  type: 'SMART_DUMPING' | 'ACCUMULATING' | 'CONFIRMING_UP' | 'CONFIRMING_DOWN' | 'RETAIL_CHOP' | 'QUIET';
  label: string;
  color: string;
  emoji: string;
  /** bu sinyalin yon gucunu 0..100 ver */
  strength: number;
}

export interface KernelSnapshot {
  status: KernelStatus;
  symbol: string;
  price: number;
  priceDir: 'up' | 'down' | 'same';
  priceChangePct: number;
  lastTradeTs: number;
  signal: 'STRONG_BUY' | 'BUY' | 'WAIT' | 'SELL' | 'STRONG_SELL';
  confidence: number;
  regime: 'ACCUMULATION' | 'DISTRIBUTION' | 'SMART_FOLLOWS_PRICE' | 'RETAIL_DRIVEN' | 'QUIET';
  reasons: string[];
  shortAgg: Aggregate;   // secili kisa pencere
  longAgg: Aggregate;    // 1sa veya session
  session: {
    startTs: number;
    startPrice: number;
    totalVol: number;
    tradeCount: number;
    vwap: number;
    smartVwap: number;
    retailVwap: number;
    smartImb: number;
    retailImb: number;
    whaleCount: number;
    megaCount: number;
  };
  thresholds: { LARGE: number; WHALE: number; MEGA: number; sampleSize: number };
  depth: { ts: number; bids: [number, number][]; asks: [number, number][]; maxQty: number } | null;
  pyramids: PyramidView[];
  wreckedCount: number;
  lastWreckReason: 'REVERSAL' | 'TIMEOUT' | 'VWAP_BREACH' | null;
  lastWreckAt: number;
  divergence: DivergenceSignal;
  /** secili kisa pencere */
  activeWindowMs: WindowMs;
}

const TIER_COLORS: Record<TierId, string> = {
  MICRO:  '#6B7B99', SMALL: '#8B9BBB', MEDIUM: '#A78BFA',
  LARGE:  '#22D3EE', WHALE: '#34D399', MEGA:  '#FBBF24',
};

const PYRAMID_TRIGGER_SCORE = 0.7; // 0.7 smartImb ustunde yeni piramit

export class EngineKernel {
  readonly symbol: string;
  private buckets = new BucketStore();
  private tierTracker = new AdaptiveTierTracker();

  private price = 0;
  private prevPrice = 0;
  private priceDir: 'up' | 'down' | 'same' = 'same';
  private lastTradeTs = 0;

  private status: KernelStatus = 'idle';
  private activeWindowMs: WindowMs = 300_000; // default 5dk
  private longWindowMs: WindowMs = 3_600_000; // 1sa

  private pyramids: RealPyramid[] = [];
  private wreckedCount = 0;
  private lastWreckReason: 'REVERSAL' | 'TIMEOUT' | 'VWAP_BREACH' | null = null;
  private lastWreckAt = 0;
  private pendingSmartFills: Fill[] = [];

  private lastSnapshot: KernelSnapshot | null = null;
  private lastSnapshotTs = 0;
  private lastComputeResult: KernelSnapshot | null = null;

  private onPyramidEvent?: (ev: RealPyramidEvent) => void;

  private publicWs: WebSocket | null = null;
  private marketWs: WebSocket | null = null;
  private destroyed = false;
  private tickTimer: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  backoffMs = 1000;
  private publicReady = false;
  private marketReady = false;

  private lastDepth: { ts: number; bids: [number, number][]; asks: [number, number][]; maxQty: number } | null = null;

  constructor(symbol = 'BTCUSDT') {
    this.symbol = symbol.toUpperCase();
  }

  // ===== DIŞ API =====

  setActiveWindow(ms: WindowMs) { this.activeWindowMs = ms; }
  getActiveWindow() { return this.activeWindowMs; }

  connect() {
    this.destroyed = false;
    this.buckets.reset();
    this.pyramids = [];
    this.wreckedCount = 0;
    this.connectPublic();
    this.connectMarket();
    // Ic hesap tick'i 1Hz — asagida snapshot 60fps, ama hesaplar saniyede bir yeter
    this.tickTimer = window.setInterval(() => this.internalTick(Date.now()), 1000);
  }

  disconnect() {
    this.destroyed = true;
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    this.closeWs(this.publicWs); this.publicWs = null;
    this.closeWs(this.marketWs); this.marketWs = null;
    this.publicReady = false; this.marketReady = false;
    this.status = 'idle';
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  onEvent(cb: (ev: RealPyramidEvent) => void) { this.onPyramidEvent = cb; }

  /** React 60 fps'te bunu cagirir */
  snapshot(): KernelSnapshot | null {
    const now = performance.now();
    if (this.lastSnapshot && now - this.lastSnapshotTs < 16 && this.lastComputeResult) {
      return this.lastSnapshot;
    }
    this.lastSnapshot = this.lastComputeResult ?? this.buildEmptySnapshot();
    this.lastSnapshotTs = now;
    return this.lastSnapshot;
  }

  // ===== İŞLEME (1Hz) =====

  private internalTick(ts: number) {
    if (this.price <= 0) return;
    // Hesaplamalar
    this.lastComputeResult = this.computeSnapshot(ts);
    

    // Piramitleri güncelle
    const fills = this.pendingSmartFills;
    this.pendingSmartFills = [];
    const shortAgg = this.lastComputeResult.shortAgg;
    const flowScore = shortAgg.smartImb; // -1..+1

    for (const p of this.pyramids) {
      if (p.status === 'WRECKED') continue;
      const events = updateRealPyramid(p, this.price, flowScore, fills, ts);
      for (const ev of events) {
        if (ev.type === 'WRECKED') {
          this.wreckedCount++;
          this.lastWreckReason = ev.reason;
          this.lastWreckAt = ts;
        }
        this.onPyramidEvent?.(ev);
      }
    }
    this.pyramids = this.pyramids.filter(p => p.status !== 'WRECKED' || ts - p.lastGrowthTs < 2000);

    // Yeni piramit tetikleme: divergence'a gore daha akilli
    const hasBuy = this.pyramids.some(p => p.side === 'BUY' && p.status !== 'WRECKED');
    const hasSell = this.pyramids.some(p => p.side === 'SELL' && p.status !== 'WRECKED');

    // Yeni piramit: kisa vade akilli para skoru TRIGGER ustundeyse + ters piramit yoksa
    if (!hasBuy && !hasSell && fills.length > 0) {
      const seed = fills
        .filter(f => f.side === 'BUY' && (f.tier === 'LARGE' || f.tier === 'WHALE' || f.tier === 'MEGA'))
        .sort((a, b) => b.notional - a.notional)[0];
      const seedSell = fills
        .filter(f => f.side === 'SELL' && (f.tier === 'LARGE' || f.tier === 'WHALE' || f.tier === 'MEGA'))
        .sort((a, b) => b.notional - a.notional)[0];
      // Akıllı para sinyaline göre yon ver
      if (flowScore >= PYRAMID_TRIGGER_SCORE && seed && seed.notional > 5000) {
        const p = spawnRealPyramid(this.symbol, 'BUY', seed.price, seed.tier, seed.notional, undefined, ts);
        this.pyramids.push(p);
        this.onPyramidEvent?.({ type: 'LAYER_ADDED', pyramid: p, level: 1, tier: seed.tier });
      } else if (flowScore <= -PYRAMID_TRIGGER_SCORE && seedSell && seedSell.notional > 5000) {
        const p = spawnRealPyramid(this.symbol, 'SELL', seedSell.price, seedSell.tier, seedSell.notional, undefined, ts);
        this.pyramids.push(p);
        this.onPyramidEvent?.({ type: 'LAYER_ADDED', pyramid: p, level: 1, tier: seedSell.tier });
      }
    }
  }

  // ===== HESAPLAMA =====

  private buildEmptySnapshot(): KernelSnapshot {
    const empty = this.buckets.aggregate(60_000, '1dk', Date.now());
    return {
      status: this.status,
      symbol: this.symbol,
      price: 0, priceDir: 'same', priceChangePct: 0, lastTradeTs: 0,
      signal: 'WAIT', confidence: 0, regime: 'QUIET',
      reasons: ['Bağlantı bekleniyor...'],
      shortAgg: empty, longAgg: empty,
      session: {
        startTs: 0, startPrice: 0, totalVol: 0, tradeCount: 0,
        vwap: 0, smartVwap: 0, retailVwap: 0, smartImb: 0, retailImb: 0,
        whaleCount: 0, megaCount: 0,
      },
      thresholds: { LARGE: 10_000, WHALE: 100_000, MEGA: 1_000_000, sampleSize: 0 },
      depth: null, pyramids: [], wreckedCount: 0, lastWreckReason: null, lastWreckAt: 0,
      divergence: { type: 'QUIET', label: 'Beklemede', color: '#7C8DB0', emoji: '🔇', strength: 0 },
      activeWindowMs: this.activeWindowMs,
    };
  }

  private computeSnapshot(ts: number): KernelSnapshot {
    if (this.price <= 0) return this.lastComputeResult ?? this.buildEmptySnapshot();

    const th = this.tierTracker.getThresholds();
    const shortAgg = this.buckets.aggregate(this.activeWindowMs,
      WINDOWS.find(w => w.ms === this.activeWindowMs)!.label, ts);
    const longAgg = this.buckets.aggregate(this.longWindowMs,
      WINDOWS.find(w => w.ms === this.longWindowMs)!.label, ts);
    const s = this.buckets.session;

    const sessionVwap = s.qty > 0 ? s.pq / s.qty : this.price;
    const sessionSmartVwap = s.smartQty > 0 ? s.smartPq / s.smartQty : sessionVwap;
    const sessionRetailVwap = s.retailQty > 0 ? s.retailPq / s.retailQty : sessionVwap;
    const sVol = (() => {
      let b = 0, ss = 0;
      for (const tid of ['MICRO','SMALL','MEDIUM'] as TierId[]) {
        b += s.tiers[tid].buyVol; ss += s.tiers[tid].sellVol;
      }
      return { buy: b, sell: ss };
    })();
    const sVol2 = (() => {
      let b = 0, ss = 0;
      for (const tid of ['LARGE','WHALE','MEGA'] as TierId[]) {
        b += s.tiers[tid].buyVol; ss += s.tiers[tid].sellVol;
      }
      return { buy: b, sell: ss };
    })();
    const sessionSmartVol = sVol2.buy + sVol2.sell;
    const sessionRetailVol = sVol.buy + sVol.sell;
    const sessionSmartImb = sessionSmartVol > 0 ? (sVol2.buy - sVol2.sell) / sessionSmartVol : 0;
    const sessionRetailImb = sessionRetailVol > 0 ? (sVol.buy - sVol.sell) / sessionRetailVol : 0;

    // Rejim & divergence tespiti — İKİ PENCERENİN ÇAKIŞMASI
    const short = shortAgg;
    const long = longAgg;
    let regime: KernelSnapshot['regime'] = 'QUIET';
    let divergence: DivergenceSignal = {
      type: 'QUIET', label: 'Sessiz', color: '#7C8DB0', emoji: '🔇', strength: 0,
    };
    const reasons: string[] = [];

    const shortSmart = short.smartImb;
    const longSmart = long.smartImb;
    const priceUp = short.priceChangePct > 0.001;
    const priceDn = short.priceChangePct < -0.001;
    const hasEnoughVol = short.totalVol > 500_000;

    // Divergence matrisi
    if (hasEnoughVol) {
      const shortBuying = shortSmart > 0.2;
      const shortSelling = shortSmart < -0.2;
      const longBuying = longSmart > 0.15;
      const longSelling = longSmart < -0.15;

      if (priceUp && longSelling && shortBuying && long.totalVol > short.totalVol * 2) {
        // Fiyat yukari ama uzun vadeli akilli para satis tarafında, kisa vade perakende/short covering aliyor
        regime = 'DISTRIBUTION';
        divergence = {
          type: 'SMART_DUMPING',
          label: 'BALİNA ÇIKIŞTA — DİSTRİBÜSYON',
          color: '#F87171', emoji: '📤', strength: Math.round(Math.abs(longSmart) * 100),
        };
        reasons.push(`📤 DİSTRİBÜSYON: Fiyat yükseliyor ama son 1saattir balinalar satıyor (uzun vade imbalans ${(longSmart*100).toFixed(0)}%). Kısa vade alımı perakende. Tepe dağıtımı olabilir.`);
      } else if (priceDn && longBuying && shortSelling && long.totalVol > short.totalVol * 2) {
        regime = 'ACCUMULATION';
        divergence = {
          type: 'ACCUMULATING',
          label: 'DİP TOPLAMA — AKÜMÜLASYON',
          color: '#34D399', emoji: '📥', strength: Math.round(longSmart * 100),
        };
        reasons.push(`📥 AKÜMÜLASYON: Fiyat düşüyor ama son 1saattir balinalar alımda (uzun vade ${(longSmart*100).toFixed(0)}% alıcı). Kısa vade perakende panik satışı. Dip toplama.`);
      } else if (shortBuying && longBuying) {
        regime = 'SMART_FOLLOWS_PRICE';
        divergence = {
          type: 'CONFIRMING_UP',
          label: 'AKILLI PARA ALIYOR — TEYİTLİ YÜKSELİŞ',
          color: '#22D3EE', emoji: '🎯', strength: Math.round((Math.abs(shortSmart) + Math.abs(longSmart)) * 50),
        };
        reasons.push(`🎯 Teyitli yükseliş: hem kısa (${(shortSmart*100).toFixed(0)}%) hem uzun vade (${(longSmart*100).toFixed(0)}%) balina alımda.`);
      } else if (shortSelling && longSelling) {
        regime = 'SMART_FOLLOWS_PRICE';
        divergence = {
          type: 'CONFIRMING_DOWN',
          label: 'AKILLI PARA SATIYOR — TEYİTLİ DÜŞÜŞ',
          color: '#FBBF24', emoji: '🎯', strength: Math.round((Math.abs(shortSmart) + Math.abs(longSmart)) * 50),
        };
        reasons.push(`🎯 Teyitli düşüş: hem kısa (${(shortSmart*100).toFixed(0)}%) hem uzun vade (${(longSmart*100).toFixed(0)}%) balina satımda.`);
      } else if (short.recentImb > 0.3 && longSmart < -0.1) {
        regime = 'RETAIL_DRIVEN';
        divergence = {
          type: 'SMART_DUMPING',
          label: 'KISA VADE PERAKENDE ALIYOR, BALİNA SATIYOR',
          color: '#A78BFA', emoji: '⚠️', strength: Math.round(Math.abs(longSmart) * 100),
        };
        reasons.push(`⚠️ Son 5sn alım baskısı ama uzun vade balina satışı. Dikkatli ol.`);
      } else if (Math.abs(shortSmart) < 0.15 && Math.abs(longSmart) < 0.1) {
        divergence = { type: 'RETAIL_CHOP', label: 'Piyasa chop, balina yok', color: '#A78BFA', emoji: '🐟', strength: 10 };
        reasons.push('🐟 Chop bölgesi — balina yok, perakende sürüklüyor. Wait.');
      } else {
        divergence = { type: 'QUIET', label: 'Tarafsız bölge', color: '#7C8DB0', emoji: '⏸', strength: 10 };
        reasons.push('⏸ Tarafsız bölge — net sinyal yok.');
      }
    } else {
      divergence = { type: 'QUIET', label: 'Hacim düşük', color: '#7C8DB0', emoji: '🔇', strength: 0 };
      reasons.push('🔇 Düşük hacim — beklemede.');
    }

    // Mega/balina işlem sayısı bilgisi
    if (short.megaCount > 0) {
      reasons.push(`🐳 Son ${short.windowLabel} penceresinde ${short.megaCount} adet MEGA (>${formatCompactShort(th.MEGA)}) işlem!`);
    } else if (short.whaleCount > 5) {
      reasons.push(`🐋 Son ${short.windowLabel} içinde ${short.whaleCount} adet balina (>${formatCompactShort(th.WHALE)}) işlemi.`);
    }

    // Tier öne çıkan
    const strongest = (['MEGA','WHALE','LARGE'] as TierId[])
      .map(id => ({ id, m: short.tiers[id] }))
      .filter(x => x.m.buyVol + x.m.sellVol > th.LARGE)
      .sort((a, b) => Math.abs(b.m.delta) - Math.abs(a.m.delta))[0];
    if (strongest) {
      const emojis: Record<TierId, string> = { MICRO: '🐟', SMALL: '🐠', MEDIUM: '🐡', LARGE: '🦈', WHALE: '🐋', MEGA: '🐳' };
      reasons.push(`${emojis[strongest.id]} ${strongest.id}: ${strongest.m.imbalance > 0 ? 'alıcı' : 'satıcı'} baskın (${(strongest.m.imbalance*100).toFixed(0)}%).`);
    }

    if (short.recentImb > 0.4) reasons.push('⚡ Son 5sn: alım baskısı artıyor.');
    else if (short.recentImb < -0.4) reasons.push('⚡ Son 5sn: satım baskısı artıyor.');

    if (th.sampleSize < 100) {
      reasons.push(`📊 Adaptif eşik toplanıyor (${th.sampleSize}/100)...`);
    }

    // Skor hesapla — short ve long birlikte
    let score = short.smartImb * 50 + long.smartImb * 30 + short.recentImb * 20;
    if (regime === 'ACCUMULATION') score += 25;
    if (regime === 'DISTRIBUTION') score -= 25;
    if (false || divergence.type === 'RETAIL_CHOP') score *= 0.4;
    if (short.totalVol < 500_000) score *= 0.5;
    score = Math.max(-100, Math.min(100, score));

    let signal: KernelSnapshot['signal'] = 'WAIT';
    const confidence = Math.round(Math.abs(score));
    if (score >= 50) signal = 'STRONG_BUY';
    else if (score >= 20) signal = 'BUY';
    else if (score <= -50) signal = 'STRONG_SELL';
    else if (score <= -20) signal = 'SELL';

    // Piramit görünümleri
    const pyramidViews: PyramidView[] = this.pyramids.map(p => {
      const vwap = pyramidVWAP(p);
      const pnl = pyramidPnLPct(p, this.price);
      const total = p.totalNotional;
      const layers: PyramidLayerView[] = p.layers.map(layer => {
        const share = total > 0 ? layer.notional / total : 1 / p.layers.length;
        const posFromBase = layer.level / Math.max(p.peakLayers, p.layers.length);
        const baseWidth = 30 + posFromBase * 50;
        const widthPct = Math.min(95, Math.max(15, baseWidth + share * 30));
        const breached = p.side === 'BUY'
          ? this.price <= layer.invalidatePrice
          : this.price >= layer.invalidatePrice;
        return {
          level: layer.level,
          tier: layer.dominantTier,
          anchorPrice: layer.anchorPrice,
          vwap: layer.vwap,
          notional: layer.notional,
          invalidatePrice: layer.invalidatePrice,
          widthPct,
          color: TIER_COLORS[layer.dominantTier],
          breached,
        };
      });
      return {
        id: p.id,
        side: p.side,
        entryPrice: p.entryPrice,
        entryTs: p.entryTs,
        vwap,
        pnlPct: pnl,
        totalNotional: total,
        peakNotional: p.peakNotional,
        status: p.status,
        layers,
        nLayers: p.layers.length,
        peakLayers: p.peakLayers,
      };
    });

    return {
      status: this.status,
      symbol: this.symbol,
      price: this.price,
      priceDir: this.priceDir,
      priceChangePct: short.priceChangePct,
      lastTradeTs: this.lastTradeTs,
      signal,
      confidence,
      regime,
      reasons,
      shortAgg,
      longAgg,
      session: {
        startTs: s.startTs,
        startPrice: s.startPrice,
        totalVol: s.totalVol,
        tradeCount: s.tradeCount,
        vwap: sessionVwap,
        smartVwap: sessionSmartVwap,
        retailVwap: sessionRetailVwap,
        smartImb: sessionSmartImb,
        retailImb: sessionRetailImb,
        whaleCount: s.whaleCount,
        megaCount: s.megaCount,
      },
      thresholds: { LARGE: th.LARGE, WHALE: th.WHALE, MEGA: th.MEGA, sampleSize: th.sampleSize },
      depth: this.lastDepth,
      pyramids: pyramidViews,
      wreckedCount: this.wreckedCount,
      lastWreckReason: this.lastWreckReason,
      lastWreckAt: this.lastWreckAt,
      divergence,
      activeWindowMs: this.activeWindowMs,
    };
  }

  // ===== TRADE/DEPTH GİRİŞİ =====

  private onTrade(ts: number, price: number, qty: number, side: 'BUY' | 'SELL') {
    const notional = price * qty;
    this.tierTracker.push(notional);
    const tier = this.tierTracker.tierFromNotional(notional);

    this.prevPrice = this.price || price;
    this.price = price;
    this.priceDir = price > this.prevPrice ? 'up' : price < this.prevPrice ? 'down' : this.priceDir;
    this.lastTradeTs = ts;

    this.buckets.addTrade(ts, price, qty, side, tier);

    // Smart money fills → piramit besleme
    if (tier === 'LARGE' || tier === 'WHALE' || tier === 'MEGA') {
      this.pendingSmartFills.push({ side, price, qty, notional, tier, ts });
      // Kuyruk çok uzamasın
      if (this.pendingSmartFills.length > 500) this.pendingSmartFills.shift();
    }
  }

  private onDepth(ts: number, bids: [number, number][], asks: [number, number][]) {
    const allQ: number[] = [];
    for (const [, q] of bids) allQ.push(q);
    for (const [, q] of asks) allQ.push(q);
    let maxQty = 0.0001;
    for (const q of allQ) if (q > maxQty) maxQty = q;
    this.lastDepth = {
      ts,
      bids: bids.slice(0, 20),
      asks: asks.slice(0, 20),
      maxQty,
    };
  }

  // ===== WEBSOCKET =====

  private connectPublic() {
    if (this.destroyed) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    const url = `wss://fstream.binance.com/public/ws/${this.symbol.toLowerCase()}@depth20@100ms`;
    try {
      const ws = new WebSocket(url);
      this.publicWs = ws;
      if (this.status !== 'reconnecting' && this.status !== 'live') this.status = 'connecting';
      ws.onopen = () => {
        if (this.destroyed) { ws.close(); return; }
        this.publicReady = true;
        this.maybeLive();
      };
      ws.onmessage = (ev) => this.handlePublic(ev.data);
      ws.onerror = () => this.scheduleReconnect('public');
      ws.onclose = () => { if (!this.destroyed) this.scheduleReconnect('public'); };
    } catch { this.scheduleReconnect('public'); }
  }

  private connectMarket() {
    if (this.destroyed) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    const sym = this.symbol.toLowerCase();
    const url = `wss://fstream.binance.com/market/ws/${sym}@aggTrade/${sym}@markPrice@1s`;
    try {
      const ws = new WebSocket(url);
      this.marketWs = ws;
      ws.onopen = () => {
        if (this.destroyed) { ws.close(); return; }
        this.marketReady = true;
        this.maybeLive();
      };
      ws.onmessage = (ev) => this.handleMarket(ev.data);
      ws.onerror = () => this.scheduleReconnect('market');
      ws.onclose = () => { if (!this.destroyed) this.scheduleReconnect('market'); };
    } catch { this.scheduleReconnect('market'); }
  }

  private maybeLive() {
    if (this.publicReady && this.marketReady) {
      this.status = 'live';
      this.backoffMs = 1000;
    }
  }

  private scheduleReconnect(which: 'public' | 'market') {
    if (this.destroyed) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    this.status = 'reconnecting';
    const delay = Math.min(this.backoffMs, 30_000);
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (which === 'public') { this.closeWs(this.publicWs); this.publicWs = null; this.publicReady = false; this.connectPublic(); }
      else { this.closeWs(this.marketWs); this.marketWs = null; this.marketReady = false; this.connectMarket(); }
    }, delay);
  }

  private closeWs(ws: WebSocket | null) {
    if (!ws) return;
    ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null;
    try { ws.close(); } catch { /* ignore */ }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private unwrap(raw: string, defaultHint?: string): { stream: string; data: any; sym: string; ts: number } | null {
    if (typeof raw !== 'string') return null;
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return null; }
    if (msg && typeof msg === 'object' && 'stream' in msg && 'data' in msg && typeof msg.stream === 'string') {
      const stream = msg.stream as string;
      const data = msg.data;
      const sym = (data?.s ?? stream.split('@')[0]).toUpperCase();
      const ts = Number(data?.T ?? data?.E ?? Date.now());
      return { stream, data, sym, ts };
    }
    if (msg && typeof msg === 'object' && 'e' in msg && 's' in msg) {
      const data = msg;
      const event = String(data.e ?? '');
      let st = defaultHint ?? event;
      if (event === 'depthUpdate') st = 'depth';
      else if (event === 'aggTrade') st = 'aggTrade';
      else if (event === 'markPriceUpdate') st = 'markPrice';
      return {
        stream: `${String(data.s).toLowerCase()}@${st}`,
        data,
        sym: String(data.s).toUpperCase(),
        ts: Number(data.T ?? data.E ?? Date.now()),
      };
    }
    return null;
  }

  private handlePublic(raw: string) {
    const env = this.unwrap(raw, 'depth');
    if (!env) return;
    if (env.stream.includes('depth') && env.data.b && env.data.a) {
      const bids: [number, number][] = (env.data.b as string[][]).map(([p, q]) => [parseFloat(p), parseFloat(q)]);
      const asks: [number, number][] = (env.data.a as string[][]).map(([p, q]) => [parseFloat(p), parseFloat(q)]);
      this.onDepth(env.ts, bids, asks);
    }
  }

  private handleMarket(raw: string) {
    const env = this.unwrap(raw);
    if (!env) return;
    if (env.stream.includes('aggTrade')) {
      const price = parseFloat(env.data.p);
      const qty = parseFloat(env.data.q);
      const side: 'BUY' | 'SELL' = env.data.m ? 'SELL' : 'BUY';
      this.onTrade(env.ts, price, qty, side);
    }
  }
}

function formatCompactShort(n: number): string {
  if (n >= 1_000_000) return `$${(n/1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n/1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}
