/**
 * EngineKernel — saf TS performans motoru.
 *
 * PRENSİPLER:
 * 1. React'i tanımaz, React'i import etmez, setState çağırmaz.
 * 2. WS'den gelen HER event (aggTrade, depth) geldiği an işlenir,
 *    ana thread'de sadece O(1) sayı/ring-buffer güncellemesi yapılır.
 * 3. React ya da herhangi bir tüketici 60 fps (yaklaşık 16 ms)'de bir
 *    snapshot() çağırır → o anki önbelleklenmiş (memoized) durumu alır.
 * 4. snapshot() her zaman yeni obje DÖNMEZ. Değişen şeyler varsa yeni
 *    referans verir, yoksa bir önceki snapshot'ı döndürür. Bu sayede
 *    React.memo ve Zustand shallow compare gereksiz re-render yapmaz.
 * 5. Ring buffer'lar sabit boyutlu, hiç allocation yapmaz sıcak yolda
 *    (sadece ilk bağlantıda ve nadiren yeniden boyutlanır).
 *
 * Piramit görselleştirmesi canvas'ta yapılacağı için, katmanların
 * doğrudan pozisyon/renk/verisini hesaplanmış olarak dışarı verir.
 */

import { AdaptiveTierTracker } from './adaptive-tiers';
import type { TierId } from './tiers';
import {
  spawnRealPyramid,
  updateRealPyramid,
  pyramidVWAP,
  pyramidPnLPct,
  type RealPyramid,
  type RealPyramidEvent,
  type Fill,
} from './pyramid/real-flow-engine';

// Ring buffer sabit boyutları
const TRADE_BUFFER_SIZE = 8192;       // ~8K son trade (yaklaşık 1-2 dk BTC için yeter)
const DEPTH_LEVELS = 20;              // 20x20 order book
const WINDOW_MS = 60_000;             // ana akış penceresi
const RECENT_MS = 5_000;              // kısa vadeli momentum
const ALPHA_EMA = 0.02;
const PYRAMID_TRIGGER_SCORE = 0.7;    // piramit tetikleyici skor (0..1)

// WebSocket durumları
export type KernelStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface KernelTrade {
  ts: number;
  price: number;
  qty: number;
  side: 'BUY' | 'SELL';
  notional: number;
  tier: TierId;
}

export interface KernelDepth {
  ts: number;
  bids: [number, number][]; // [price, qty]
  asks: [number, number][];
  maxQty: number;           // bar normalize için
}

export interface TierStat {
  buyVol: number;
  sellVol: number;
  delta: number;
  imbalance: number;
  ema: number;
  sharePct: number;
}

export interface KernelPyramidLayerView {
  level: number;
  tier: TierId;
  anchorPrice: number;
  vwap: number;
  notional: number;
  invalidatePrice: number;
  widthPct: number;     // 0..100
  color: string;
  breached: boolean;
}

export interface KernelPyramidView {
  id: string;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  entryTs: number;
  vwap: number;
  pnlPct: number;
  totalNotional: number;
  peakNotional: number;
  status: 'GROWING' | 'PEAKED' | 'COLLAPSING' | 'WRECKED';
  layers: KernelPyramidLayerView[];
  nextLayerPrice: number;
  nLayers: number;
  peakLayers: number;
}

export interface KernelSnapshot {
  status: KernelStatus;
  symbol: string;
  price: number;
  priceDir: 'up' | 'down' | 'same';
  priceChange1mPct: number;
  lastTradeTs: number;
  signal: 'STRONG_BUY' | 'BUY' | 'WAIT' | 'SELL' | 'STRONG_SELL';
  confidence: number;
  smartImbalance: number;
  regime: 'ACCUMULATION' | 'DISTRIBUTION' | 'SMART_FOLLOWS_PRICE' | 'RETAIL_DRIVEN' | 'QUIET';
  reasons: string[];
  tiers: Record<TierId, TierStat>;
  stats: {
    totalVolume: number;
    tradeCount: number;
    whaleTradeCount: number;
    megaTradeCount: number;
    tradeRate: number;   // işlem/sn
  };
  thresholds: { LARGE: number; WHALE: number; MEGA: number; sampleSize: number };
  depth: KernelDepth | null;
  pyramids: KernelPyramidView[];
  wreckedCount: number;
  lastWreckReason: 'REVERSAL' | 'TIMEOUT' | 'VWAP_BREACH' | null;
  lastWreckAt: number;
}

// Tier konfigürasyonu (sadece renk/isim — eşikler adaptif)
const TIER_COLORS: Record<TierId, string> = {
  MICRO:  '#6B7B99',
  SMALL:  '#8B9BBB',
  MEDIUM: '#A78BFA',
  LARGE:  '#22D3EE',
  WHALE:  '#34D399',
  MEGA:   '#FBBF24',
};
const TIER_IDS: TierId[] = ['MICRO', 'SMALL', 'MEDIUM', 'LARGE', 'WHALE', 'MEGA'];

function emptyTierStats(): Record<TierId, TierStat> {
  const out = {} as Record<TierId, TierStat>;
  for (const id of TIER_IDS) {
    out[id] = { buyVol: 0, sellVol: 0, delta: 0, imbalance: 0, ema: 0, sharePct: 0 };
  }
  return out;
}

export class EngineKernel {
  // === Ayarlar ===
  symbol: string;

  // === Ring buffer: son işlemler ===
  private trades: KernelTrade[] = new Array(TRADE_BUFFER_SIZE);
  private tradeHead = 0;   // sonraki yazılacak index
  private tradeLen = 0;    // kayıtlı işlem sayısı

  // === Adaptif tier takipçisi ===
  private tierTracker = new AdaptiveTierTracker();

  // === Emir defteri (en son snapshot) ===
  private depth: KernelDepth | null = null;

  // === Durum ===
  private status: KernelStatus = 'idle';
  private price = 0;
  private priceDir: 'up' | 'down' | 'same' = 'same';
  private lastTradeTs = 0;

  // === Piramitler ===
  private pyramids: RealPyramid[] = [];
  private wreckedCount = 0;
  private lastWreckReason: 'REVERSAL' | 'TIMEOUT' | 'VWAP_BREACH' | null = null;
  private lastWreckAt = 0;
  private pendingSmartFills: Fill[] = []; // bu tick'te toplanan smart-money dolguları

  // === Snapshot caching ===
  private lastSnapshot: KernelSnapshot | null = null;
  private lastSnapshotTs = 0;

  // === Event callbacks ===
  private onPyramidEvent?: (ev: RealPyramidEvent) => void;
  private publicWs: WebSocket | null = null;
  private marketWs: WebSocket | null = null;
  backoffMs = 1000;
  private publicReady = false;
  private marketReady = false;
  private destroyed = false;
  private tickTimer: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(symbol = 'BTCUSDT') {
    this.symbol = symbol.toUpperCase();
  }

  // ============================================
  // DIŞ API
  // ============================================

  connect() {
    this.destroyed = false;
    this.connectPublic();
    this.connectMarket();
    // İç hesaplama tick'i: 60 fps yerine 30 fps (33 ms) — zaten rAF 60'ta
    // snapshot alacağız ama iç hesaplar 30 Hz yeterli (tier ve piramit)
    this.tickTimer = window.setInterval(() => this.internalTick(performance.now()), 33);
  }

  disconnect() {
    this.destroyed = true;
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    this.closeWs(this.publicWs); this.publicWs = null;
    this.closeWs(this.marketWs); this.marketWs = null;
    this.publicReady = false; this.marketReady = false;
    this.status = 'idle';
  }

  onEvent(cb: (ev: RealPyramidEvent) => void) {
    this.onPyramidEvent = cb;
  }

  /**
   * snapshot() — React burayı 60 fps'te çağırır.
   * Her 16 ms'de bir çağrılsa bile, eğer veri değişmemişse
   * aynı referansı döndürür (shallow compare ile re-render olmaz).
   */
  snapshot(): KernelSnapshot | null {
    const now = performance.now();
    if (this.lastSnapshot && now - this.lastSnapshotTs < 16) {
      return this.lastSnapshot;
    }
    this.lastSnapshot = this.computeSnapshot();
    this.lastSnapshotTs = now;
    return this.lastSnapshot;
  }

  /** Test/manuel kullanım için: direkt trade ekle */
  pushTrade(ts: number, price: number, qty: number, side: 'BUY' | 'SELL') {
    const notional = price * qty;
    this.tierTracker.push(notional);
    const tier = this.tierTracker.tierFromNotional(notional);
    const trade: KernelTrade = { ts, price, qty, side, notional, tier };

    // Ring buffer'a yaz
    this.trades[this.tradeHead] = trade;
    this.tradeHead = (this.tradeHead + 1) % TRADE_BUFFER_SIZE;
    if (this.tradeLen < TRADE_BUFFER_SIZE) this.tradeLen++;

    // Fiyat güncelle
    if (price !== this.price) {
      this.priceDir = price > this.price ? 'up' : price < this.price ? 'down' : this.priceDir;
      this.price = price;
      
    }
    this.lastTradeTs = ts;

    // Akıllı para dolgusunu piramit için kuyruğa al
    if (this.tierTracker.isSmartMoney(tier)) {
      this.pendingSmartFills.push({
        side, price, qty, notional, tier, ts,
      });
    }
  }

  pushDepth(ts: number, bids: [number, number][], asks: [number, number][]) {
    const allQtys: number[] = [];
    for (let i = 0; i < Math.min(DEPTH_LEVELS, bids.length); i++) allQtys.push(bids[i][1]);
    for (let i = 0; i < Math.min(DEPTH_LEVELS, asks.length); i++) allQtys.push(asks[i][1]);
    let maxQty = 0;
    for (const q of allQtys) if (q > maxQty) maxQty = q;
    this.depth = {
      ts,
      bids: bids.slice(0, DEPTH_LEVELS).map(b => [b[0], b[1]] as [number, number]),
      asks: asks.slice(0, DEPTH_LEVELS).map(a => [a[0], a[1]] as [number, number]),
      maxQty: Math.max(maxQty, 0.0001),
    };
  }

  // ============================================
  // İŞLEME (30 Hz internal tick)
  // ============================================

  private internalTick(_now: number) {
    if (this.price <= 0) return;
    const ts = Date.now();
    

    // Tier/pyramid hesaplamalarını 30 Hz'de yap
    const snap = this.computeFlow(ts);

    // Piramitleri güncelle
    const fills = this.pendingSmartFills;
    this.pendingSmartFills = [];

    // 1) Mevcut piramitleri güncelle
    for (const p of this.pyramids) {
      if (p.status === 'WRECKED') continue;
      const events = updateRealPyramid(p, this.price, snap.smartImb, fills, ts);
      for (const ev of events) {
        if (ev.type === 'WRECKED') {
          this.wreckedCount++;
          this.lastWreckReason = ev.reason;
          this.lastWreckAt = ts;
        }
        this.onPyramidEvent?.(ev);
      }
    }
    // WRECKED olanları temizle (200 ms sonra, görsel için animate şansı)
    this.pyramids = this.pyramids.filter(p => p.status !== 'WRECKED' || ts - p.lastGrowthTs < 200);

    // 2) Yeni piramit tetikleyici
    const hasBuy = this.pyramids.some(p => p.side === 'BUY' && p.status !== 'WRECKED');
    const hasSell = this.pyramids.some(p => p.side === 'SELL' && p.status !== 'WRECKED');
    const sideAlign =
      (snap.signal === 'STRONG_BUY' || snap.signal === 'BUY') && snap.smartImb > 0.3;
    const sideAlignSell =
      (snap.signal === 'STRONG_SELL' || snap.signal === 'SELL') && snap.smartImb < -0.3;

    if (snap.smartImb >= PYRAMID_TRIGGER_SCORE && sideAlign && !hasBuy) {
      const seed = fills.filter(f => f.side === 'BUY').sort((a, b) => b.notional - a.notional)[0];
      if (seed && seed.notional > 1000) {
        const p = spawnRealPyramid(this.symbol, 'BUY', seed.price, seed.tier, seed.notional, undefined, ts);
        this.pyramids.push(p);
        this.onPyramidEvent?.({ type: 'LAYER_ADDED', pyramid: p, level: 1, tier: seed.tier });
      }
    } else if (snap.smartImb <= -PYRAMID_TRIGGER_SCORE && sideAlignSell && !hasSell) {
      const seed = fills.filter(f => f.side === 'SELL').sort((a, b) => b.notional - a.notional)[0];
      if (seed && seed.notional > 1000) {
        const p = spawnRealPyramid(this.symbol, 'SELL', seed.price, seed.tier, seed.notional, undefined, ts);
        this.pyramids.push(p);
        this.onPyramidEvent?.({ type: 'LAYER_ADDED', pyramid: p, level: 1, tier: seed.tier });
      }
    }
  }

  // ============================================
  // FLOW HESAPLAMA (saf hesap, allocation minimize)
  // ============================================

  private iterTradesInWindow(ts: number, windowMs: number, cb: (t: KernelTrade) => void) {
    const cutoff = ts - windowMs;
    for (let i = 0; i < this.tradeLen; i++) {
      const idx = (this.tradeHead - 1 - i + TRADE_BUFFER_SIZE) % TRADE_BUFFER_SIZE;
      const t = this.trades[idx];
      if (!t || t.ts < cutoff) break;
      cb(t);
    }
  }

  private computeFlow(ts: number) {
    const metrics = emptyTierStats();
    let totalVol = 0;
    let count = 0;
    let whaleCount = 0;
    let megaCount = 0;
    let firstPrice = 0;
    let lastP = 0;
    let firstTs = Infinity;

    // 60 saniyelik pencere
    this.iterTradesInWindow(ts, WINDOW_MS, (t) => {
      count++;
      totalVol += t.notional;
      if (t.ts < firstTs) { firstTs = t.ts; firstPrice = t.price; }
      lastP = t.price;
      const m = metrics[t.tier];
      if (t.side === 'BUY') m.buyVol += t.notional;
      else m.sellVol += t.notional;
      if (t.tier === 'WHALE') whaleCount++;
      if (t.tier === 'MEGA') megaCount++;
    });

    for (const id of TIER_IDS) {
      const m = metrics[id];
      m.delta = m.buyVol - m.sellVol;
      const t = m.buyVol + m.sellVol;
      m.imbalance = t > 0 ? m.delta / t : 0;
      m.ema = (1 - ALPHA_EMA) * m.ema + ALPHA_EMA * m.imbalance;
      m.sharePct = totalVol > 0 ? t / totalVol : 0;
    }

    // Smart money = LARGE + WHALE + MEGA
    const smart = metrics.LARGE, w = metrics.WHALE, mg = metrics.MEGA;
    const smartDelta = smart.delta + w.delta + mg.delta;
    const smartVol =
      smart.buyVol + smart.sellVol + w.buyVol + w.sellVol + mg.buyVol + mg.sellVol;
    const retail = metrics.MICRO, sm = metrics.SMALL, md = metrics.MEDIUM;
    const retailDelta = retail.delta + sm.delta + md.delta;
    const retailVol =
      retail.buyVol + retail.sellVol + sm.buyVol + sm.sellVol + md.buyVol + md.sellVol;
    const smartImb = smartVol > 0 ? smartDelta / smartVol : 0;
    const retailImb = retailVol > 0 ? retailDelta / retailVol : 0;

    // Son 5 saniye momentum
    let recentBuy = 0, recentSell = 0, recentCount = 0;
    this.iterTradesInWindow(ts, RECENT_MS, (t) => {
      recentCount++;
      if (t.side === 'BUY') recentBuy += t.notional;
      else recentSell += t.notional;
    });
    const recentImb = recentBuy + recentSell > 0
      ? (recentBuy - recentSell) / (recentBuy + recentSell) : 0;

    const priceChangePct = firstPrice > 0 && lastP > 0 ? (lastP - firstPrice) / firstPrice : 0;
    const th = this.tierTracker.getThresholds();

    // Rejim
    let regime: KernelSnapshot['regime'] = 'QUIET';
    const reasons: string[] = [];
    const priceUp = priceChangePct > 0.001;
    const priceDn = priceChangePct < -0.001;
    const smartBuying = smartImb > 0.25;
    const smartSelling = smartImb < -0.25;
    const retailBuying = retailImb > 0.25;
    const retailSelling = retailImb < -0.25;

    if (priceUp && smartSelling && retailBuying && Math.abs(smartImb) > 0.15) {
      regime = 'DISTRIBUTION';
      reasons.push('DISTRIBUSYON: fiyat yukseliyor ama balinalar satiyor, retail alyor');
    } else if (priceDn && smartBuying && retailSelling && Math.abs(smartImb) > 0.15) {
      regime = 'ACCUMULATION';
      reasons.push('AKUMULASYON: fiyat dusuyor ama balinalar alyor, retail satiyor');
    } else if ((priceUp && smartBuying) || (priceDn && smartSelling)) {
      regime = 'SMART_FOLLOWS_PRICE';
      reasons.push(`Akll para fyaty destekliyor (balina imbalans %${(smartImb * 100).toFixed(0)})`);
    } else if (retailBuying || retailSelling) {
      regime = 'RETAIL_DRIVEN';
      reasons.push(`Hareket perakende kaynakly (balina yok)`);
    } else if (totalVol < 100_000) {
      reasons.push('Dusuk hacim - beklemede');
    }

    // Öne çıkan tier
    const strongest = TIER_IDS
      .map(id => ({ id, m: metrics[id] }))
      .filter(x => x.m.buyVol + x.m.sellVol > 10_000)
      .sort((a, b) => Math.abs(b.m.delta) - Math.abs(a.m.delta))[0];
    if (strongest) {
      const emojis: Record<TierId, string> = {
        MICRO: '[M]', SMALL: '[S]', MEDIUM: '[MED]', LARGE: '[L]', WHALE: '[W]', MEGA: '[MEGA]',
      };
      reasons.push(`${emojis[strongest.id]} ${strongest.id}: ${strongest.m.imbalance > 0 ? 'alcy' : 'satycy'} baskyn`);
    }
    if (megaCount > 0) reasons.push(`[MEGA] ${megaCount} adet MEGA islem!`);
    else if (whaleCount > 3) reasons.push(`[W] ${whaleCount} adet balina islemi`);
    if (recentImb > 0.3) reasons.push('Son 5 sn: alym baskysy artyyor');
    else if (recentImb < -0.3) reasons.push('Son 5 sn: satym baskysy artyyor');
    if (th.sampleSize < 30) reasons.push(`Adaptif esik toplanıyor (${th.sampleSize}/30)...`);

    // Skor & sinyal
    let score = 0;
    score += smartImb * 50;
    score += recentImb * 25;
    if (regime === 'ACCUMULATION') score += 30;
    if (regime === 'DISTRIBUTION') score -= 30;
    if (regime === 'SMART_FOLLOWS_PRICE') score += priceUp ? 15 : -15;
    if (regime === 'RETAIL_DRIVEN') score *= 0.4;
    if (totalVol < 500_000) score *= 0.5;
    score = Math.max(-100, Math.min(100, score));

    let signal: KernelSnapshot['signal'] = 'WAIT';
    const confidence = Math.round(Math.abs(score));
    if (score >= 50) signal = 'STRONG_BUY';
    else if (score >= 20) signal = 'BUY';
    else if (score <= -50) signal = 'STRONG_SELL';
    else if (score <= -20) signal = 'SELL';

    if (signal === 'WAIT' && reasons.length === 1) {
      reasons.unshift('Tarafsyz blge - balina hareketi bekleniyor');
    }

    // Trade rate (işlem/sn)
    const oneSecAgo = ts - 1000;
    let recentTrades = 0;
    for (let i = 0; i < this.tradeLen; i++) {
      const idx = (this.tradeHead - 1 - i + TRADE_BUFFER_SIZE) % TRADE_BUFFER_SIZE;
      const t = this.trades[idx];
      if (!t || t.ts < oneSecAgo) break;
      recentTrades++;
    }

    return {
      signal,
      confidence,
      smartImb,
      regime,
      reasons,
      tiers: metrics,
      stats: {
        totalVolume: totalVol,
        tradeCount: count,
        whaleTradeCount: whaleCount,
        megaTradeCount: megaCount,
        tradeRate: recentTrades,
      },
      thresholds: { LARGE: th.LARGE, WHALE: th.WHALE, MEGA: th.MEGA, sampleSize: th.sampleSize },
      priceChangePct,
    };
  }

  private computeSnapshot(): KernelSnapshot {
    if (this.price <= 0) {
      return this.lastSnapshot ?? {
        status: this.status,
        symbol: this.symbol,
        price: 0, priceDir: 'same', priceChange1mPct: 0, lastTradeTs: 0,
        signal: 'WAIT', confidence: 0, smartImbalance: 0, regime: 'QUIET',
        reasons: ['Baglant bekleniyor...'],
        tiers: emptyTierStats(),
        stats: { totalVolume: 0, tradeCount: 0, whaleTradeCount: 0, megaTradeCount: 0, tradeRate: 0 },
        thresholds: { LARGE: 10_000, WHALE: 100_000, MEGA: 1_000_000, sampleSize: 0 },
        depth: null,
        pyramids: [],
        wreckedCount: 0, lastWreckReason: null, lastWreckAt: 0,
      };
    }

    const flow = this.computeFlow(Date.now());

    // Piramit görünümlerini hazırla (canvas için)
    const pyramidViews: KernelPyramidView[] = this.pyramids.map(p => {
      const vwap = pyramidVWAP(p);
      const pnl = pyramidPnLPct(p, this.price);
      const total = p.totalNotional;
      const layers: KernelPyramidLayerView[] = p.layers.map(layer => {
        // Görsel genişlik: toplam piramit notional'ına orantılı, minimum %20
        const share = total > 0 ? layer.notional / total : 1 / p.layers.length;
        // En üst katman (en yeni) dar, taban (en eski) geniş olmalı
        const posFromBase = layer.level / Math.max(p.peakLayers, p.layers.length);
        const baseWidth = 30 + posFromBase * 50; // taban %80, tepe %30
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
        nextLayerPrice: p.nextLayerPrice,
        nLayers: p.layers.length,
        peakLayers: p.peakLayers,
      };
    });

    return {
      status: this.status,
      symbol: this.symbol,
      price: this.price,
      priceDir: this.priceDir,
      priceChange1mPct: flow.priceChangePct,
      lastTradeTs: this.lastTradeTs,
      signal: flow.signal,
      confidence: flow.confidence,
      smartImbalance: flow.smartImb,
      regime: flow.regime,
      reasons: flow.reasons,
      tiers: flow.tiers,
      stats: flow.stats,
      thresholds: flow.thresholds,
      depth: this.depth,
      pyramids: pyramidViews,
      wreckedCount: this.wreckedCount,
      lastWreckReason: this.lastWreckReason,
      lastWreckAt: this.lastWreckAt,
    };
  }

  // ============================================
  // WEBSOCKET (Binance Futures v2)
  // ============================================

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
    } catch {
      this.scheduleReconnect('public');
    }
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
    } catch {
      this.scheduleReconnect('market');
    }
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

  private unwrapMessage(raw: string, defaultHint?: string): { stream: string; data: any; sym: string; ts: number } | null {
    if (typeof raw !== 'string') return null;
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return null; }
    if (msg && typeof msg === 'object' && 'stream' in msg && 'data' in msg && typeof msg.stream === 'string') {
      const stream: string = msg.stream;
      const data = msg.data;
      const sym = (data?.s ?? stream.split('@')[0]).toUpperCase();
      const ts = Number(data?.T ?? data?.E ?? data?.E ?? Date.now());
      return { stream, data, sym, ts };
    }
    if (msg && typeof msg === 'object' && 'e' in msg && 's' in msg) {
      const data = msg;
      const ev = String(data.e ?? '');
      let streamType = defaultHint ?? ev;
      if (ev === 'depthUpdate') streamType = 'depth';
      else if (ev === 'aggTrade') streamType = 'aggTrade';
      else if (ev === 'markPriceUpdate') streamType = 'markPrice';
      const symRaw = String(data.s ?? '').toLowerCase();
      return { stream: `${symRaw}@${streamType}`, data, sym: String(data.s).toUpperCase(), ts: Number(data.T ?? data.E ?? Date.now()) };
    }
    return null;
  }

  private handlePublic(raw: string) {
    const env = this.unwrapMessage(raw, 'depth');
    if (!env) return;
    if (env.stream.includes('depth') && env.data.b && env.data.a) {
      const bids: [number, number][] = (env.data.b as string[][]).map(([p, q]) => [parseFloat(p), parseFloat(q)]);
      const asks: [number, number][] = (env.data.a as string[][]).map(([p, q]) => [parseFloat(p), parseFloat(q)]);
      this.pushDepth(env.ts, bids, asks);
    }
  }

  private handleMarket(raw: string) {
    const env = this.unwrapMessage(raw);
    if (!env) return;
    if (env.stream.includes('aggTrade')) {
      const price = parseFloat(env.data.p);
      const qty = parseFloat(env.data.q);
      // m=true → buyer is maker → aggressive side = SELL
      const side: 'BUY' | 'SELL' = env.data.m ? 'SELL' : 'BUY';
      this.pushTrade(env.ts, price, qty, side);
    }
    // markPrice şimdilik kullanılmıyor
  }
}
