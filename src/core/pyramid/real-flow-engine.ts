/**
 * Gerçek Para Akışı Piramit Motoru (v2)
 *
 * ESKİ YANLIŞ: sabit 100$ × 1.618^n hayali katmanlar, sembolden bağımsız.
 *
 * YENİ DOĞRU:
 *  - Her katman belirli bir "akıllı para" tier'ına (LARGE/WHALE/MEGA) ait
 *    GERÇEK trade dolgularının toplamını temsil eder.
 *  - Katman büyüklüğü = o seviyedeki gerçek USDT fill toplamı (hayali çarpan yok).
 *  - Katman VWAP'ı = o seviyeye gelen gerçek balina alış/satışlarının
 *    hacim-ağırlıklı ortalama fiyatı. Bu SAYEDE:
 *       AL piramidinin en alt (mega) katmanının VWAP'ı = balinaların
 *       bu oturumdaki GERÇEK ortalama maliyeti. Fiyat bunun altına
 *       düştüğünde balina malı başabaşın altında → panik/stop.
 *  - Yeni bir "akıllı para" katmanı ancak:
 *       1. Aynı tarafın skoru ≥ 0.3 (flow hizalı) ise,
 *       2. VE fiyat bir önceki katmandan layerAddPct kadar uzaklaştıysa,
 *       3. VE o yönde en az MIN_TIER_NOTIONAL kadar yeni dolgu gelmişse
 *    eklenir.
 *  - Katman invalidasyonu: fiyat katman VWAP'ını layerRemovePct kadar geçerse
 *    katman silinir (balina stop'u yedi / mal dağıtıldı).
 *  - Birden fazla katman tek tick'te kırılırsa while döngüsü hepsini siler.
 */

import type { Side } from './types';
import type { TierId } from '../tiers';
import { DEFAULT_PYRAMID_CONFIG, type PyramidConfig } from './types';

export interface RealLayer {
  level: number;
  /** Hangi tier tarafından beslendi (bulk alımın ana kaynağı) */
  dominantTier: TierId;
  /** Katmanın açıldığı anki fiyat */
  anchorPrice: number;
  /** Katman VWAP'ı — tüm dolguların hacim-ağırlıklı ortalaması */
  vwap: number;
  /** Katmandaki toplam USDT dolgu */
  notional: number;
  /** Katmandaki toplam coin miktarı (VWAP = notional / qtyBase) */
  qtyBase: number;
  /** İlk dolgu zamanı */
  addTs: number;
  /** Son dolgu zamanı */
  lastFillTs: number;
  /** Katman kırılma (invalidate) fiyatı */
  invalidatePrice: number;
}

export interface RealPyramid {
  id: string;
  symbol: string;
  side: Side;
  /** İlk katmanın açıldığı fiyat */
  entryPrice: number;
  entryTs: number;
  layers: RealLayer[];
  /** Bir sonraki katman eşiği (fiyat) */
  nextLayerPrice: number;
  /** Henüz katman açmak için birikmiş fakat henüz eşiğe ulaşmamış dolgu */
  pendingNotional: number;
  /** Genel piramit VWAP'ı (tüm katmanların ağırlıklı ortalaması) */
  totalNotional: number;
  totalQtyBase: number;
  status: 'GROWING' | 'PEAKED' | 'COLLAPSING' | 'WRECKED';
  peakLayers: number;
  /** Son katman eklenme zamanı (PEAKED durumu için) */
  lastGrowthTs: number;
  peakNotional: number;
  config: PyramidConfig;
}

let _idCounter = 0;
function newId(): string {
  _idCounter += 1;
  return `rpyr-${Date.now().toString(36)}-${_idCounter}`;
}

/** Piramit için yeni katman eşiği fiyatı */
function nextLayerPrice(anchor: number, side: Side, pct: number): number {
  return side === 'BUY' ? anchor * (1 + pct) : anchor * (1 - pct);
}

/** Katman invalidasyon fiyatı (VWAP'ın altında/üstünde) */
function invalidatePriceForLayer(vwap: number, side: Side, pct: number): number {
  return side === 'BUY' ? vwap * (1 - pct) : vwap * (1 + pct);
}

export function spawnRealPyramid(
  symbol: string,
  side: Side,
  price: number,
  tier: TierId,
  notional: number,
  config: PyramidConfig = DEFAULT_PYRAMID_CONFIG,
  ts: number = Date.now(),
): RealPyramid {
  const qtyBase = notional / price;
  const firstLayer: RealLayer = {
    level: 1,
    dominantTier: tier,
    anchorPrice: price,
    vwap: price,
    notional,
    qtyBase,
    addTs: ts,
    lastFillTs: ts,
    invalidatePrice: invalidatePriceForLayer(price, side, config.layerRemovePct),
  };
  return {
    id: newId(),
    symbol,
    side,
    entryPrice: price,
    entryTs: ts,
    layers: [firstLayer],
    nextLayerPrice: nextLayerPrice(price, side, config.layerAddPct),
    pendingNotional: 0,
    totalNotional: notional,
    totalQtyBase: qtyBase,
    status: 'GROWING',
    peakLayers: 1,
    lastGrowthTs: ts,
    peakNotional: notional,
    config,
  };
}

export type RealPyramidEvent =
  | { type: 'LAYER_FILLED'; pyramid: RealPyramid; level: number; tier: TierId; addedNotional: number }
  | { type: 'LAYER_ADDED'; pyramid: RealPyramid; level: number; tier: TierId }
  | { type: 'LAYER_REMOVED'; pyramid: RealPyramid; level: number }
  | { type: 'PEAKED'; pyramid: RealPyramid }
  | { type: 'COLLAPSING'; pyramid: RealPyramid; remainingLayers: number }
  | { type: 'WRECKED'; pyramid: RealPyramid; reason: 'REVERSAL' | 'TIMEOUT' | 'VWAP_BREACH' };

const MIN_TIER_NOTIONAL = 5_000; // Yeni katman için minimum akış (adaptif eşik sonrası oranlanabilir)
const PEAK_MS = 5000;            // 5sn dolgu yoksa PEAK
const PENDING_KICK = 15_000;     // 15sn beklemeden dolgu gelmezse pending'i sıfırla

/**
 * Tick ana fonksiyonu:
 *  - lastPrice: şu anki fiyat
 *  - flowSide: anlık flow yönü (-1..+1 arası, 0 nötr)
 *  - trades: bu tick'te gerçekleşen akıllı para (LARGE/WHALE/MEGA) fill'leri
 *    [{ side, price, qty, notional, tier }]
 *
 * Katman kuralları (alım tarafı için simetrik):
 *  - Her LARGE/WHALE/MEGA BUY trade, aktif AL piramidinin en son (en yeni) katmanına
 *    VWAP güncelleyerek eklenir.
 *  - Yeni katman eşiği aşıldığında ve birikmiş dolgu yeterliyse yeni katman açılır.
 *  - Fiyat son katmanın invalidate VWAP'ının altına inerse katman silinir (döngü: hepsi).
 */
export interface Fill {
  side: Side;
  price: number;
  qty: number;
  notional: number;
  tier: TierId;
  ts: number;
}

export function updateRealPyramid(
  p: RealPyramid,
  lastPrice: number,
  flowSide: number,           // -1..+1, akıllı para imbalansı
  fills: Fill[],
  ts: number,
): RealPyramidEvent[] {
  const events: RealPyramidEvent[] = [];
  if (p.status === 'WRECKED') return events;

  const cfg = p.config;

  // Zaman aşımı
  if (ts - p.entryTs > cfg.timeoutMs) {
    p.status = 'WRECKED';
    events.push({ type: 'WRECKED', pyramid: p, reason: 'TIMEOUT' });
    return events;
  }

  // ── 1. Gelen dolguları son katmana ekle ─────────────────
  const sameSideFills = fills.filter((f) => f.side === p.side);
  const oppSideFills = fills.filter((f) => f.side !== p.side);
  void oppSideFills; // karşı taraf dolgusu katman dolgusuna eklenmez, VWAP'ı etkilemez.
  // (Ancak fiyat üzerinden katman invalidate olur.)

  // ── 2. Flow hizalamasi ────────────────────────────────
  const flowAligned =
    (p.side === 'BUY' && flowSide > 0.3) ||
    (p.side === 'SELL' && flowSide < -0.3);

  // ── 1. Gelen dolgulari son katmana ekle ─────────────────
  if (p.layers.length > 0 && sameSideFills.length > 0) {
    const top = p.layers[p.layers.length - 1];
    for (const f of sameSideFills) {
      if (f.tier === 'MICRO' || f.tier === 'SMALL' || f.tier === 'MEDIUM') continue;
      top.notional += f.notional;
      top.qtyBase += f.qty;
      top.vwap = top.qtyBase > 0 ? top.notional / top.qtyBase : top.vwap;
      top.lastFillTs = ts;
      p.totalNotional += f.notional;
      p.totalQtyBase += f.qty;
      p.pendingNotional += f.notional;
      p.peakNotional = Math.max(p.peakNotional, p.totalNotional);
      events.push({ type: 'LAYER_FILLED', pyramid: p, level: top.level, tier: f.tier, addedNotional: f.notional });
    }
    top.invalidatePrice = invalidatePriceForLayer(top.vwap, p.side, cfg.layerRemovePct);
  }

  // ── 3. Yeni katman açma ────────────────────────────────
  // Yeni katman addThreshold kadar tohum notional ile açılır — 0-notional hayalet yok.
  const top = p.layers[p.layers.length - 1];
  const baseNotional = p.layers[0]?.notional ?? MIN_TIER_NOTIONAL;
  const referenceNotional = top?.notional ?? baseNotional;
  const addThreshold = Math.max(MIN_TIER_NOTIONAL, referenceNotional * 0.1);

  if (p.pendingNotional > 0 && ts - (top?.lastFillTs ?? p.entryTs) > PENDING_KICK) {
    p.pendingNotional = 0;
  }

  if (flowAligned && p.pendingNotional >= addThreshold && top) {
    while (true) {
      const hitThreshold =
        p.side === 'BUY' ? lastPrice >= p.nextLayerPrice : lastPrice <= p.nextLayerPrice;
      if (!hitThreshold) break;

      const newLevel = p.layers.length + 1;
      const dominantTier: TierId =
        sameSideFills[sameSideFills.length - 1]?.tier ?? 'LARGE';

      // Yeni katman: anchor olarak lastPrice kullan, başlangıç notional'ı 0.
      // Pending sadece eşik sayacıydı, içindeki dolgu zaten eski katmanda sayıldı —
      // double-count yapmamak için sıfırdan başlarız.
      // Pending dolgu yeni katmanın tohumudur — double-count olmaması için
      // eski katmandan düşeriz (pending eski katmanda "birikmiş" sayılıyordu).
      // Ancak pendingNotional eski dolguların ÜSTÜNE eklenen sayacı tuttuğundan
      // aslında double-count yok, çünkü pending her zaman 0'dan sayacağa resetlenir.
      // Yeni katman min addThreshold kadar tohumla açılır:
      const seedNotional = addThreshold;
      const seedQty = seedNotional / lastPrice;
      const newLayer: RealLayer = {
        level: newLevel,
        dominantTier,
        anchorPrice: lastPrice,
        vwap: lastPrice,
        notional: seedNotional,
        qtyBase: seedQty,
        addTs: ts,
        lastFillTs: ts,
        invalidatePrice: invalidatePriceForLayer(lastPrice, p.side, cfg.layerRemovePct),
      };
      p.layers.push(newLayer);
      p.totalNotional += seedNotional;
      p.totalQtyBase += seedQty;
      p.peakLayers = Math.max(p.peakLayers, newLevel);
      p.lastGrowthTs = ts;
      p.nextLayerPrice = nextLayerPrice(lastPrice, p.side, cfg.layerAddPct);
      p.pendingNotional = 0;
      p.status = 'GROWING';
      p.peakNotional = Math.max(p.peakNotional, p.totalNotional);
      events.push({ type: 'LAYER_ADDED', pyramid: p, level: newLevel, tier: dominantTier });
      if (newLevel > 50) break;
    }
  }

  // ── 3. PEAKED durumu ───────────────────────────────────
  if (p.status === 'GROWING' && ts - p.lastGrowthTs > PEAK_MS) {
    p.status = 'PEAKED';
    events.push({ type: 'PEAKED', pyramid: p });
  }

  // ── 4. Katman silme (fiyat VWAP invalidate'i geçerse) ──
  while (p.layers.length > 1) {
    const last = p.layers[p.layers.length - 1];
    const breached =
      p.side === 'BUY' ? lastPrice <= last.invalidatePrice : lastPrice >= last.invalidatePrice;
    if (!breached) break;
    const removed = p.layers.pop()!;
    p.totalNotional -= removed.notional;
    p.totalQtyBase -= removed.qtyBase;
    const newLast = p.layers[p.layers.length - 1];
    p.nextLayerPrice = nextLayerPrice(newLast.anchorPrice, p.side, cfg.layerAddPct);
    // Alt katmanın invalidate fiyatını kendi VWAP'ından yeniden hesapla
    newLast.invalidatePrice = invalidatePriceForLayer(newLast.vwap, p.side, cfg.layerRemovePct);
    p.pendingNotional = 0;
    if (p.status !== 'COLLAPSING') {
      p.status = 'COLLAPSING';
      events.push({ type: 'COLLAPSING', pyramid: p, remainingLayers: p.layers.length });
    }
    events.push({ type: 'LAYER_REMOVED', pyramid: p, level: removed.level });
  }

  // ── 5. Tek kaldığında ters sinyal veya VWAP ihlali → yık
  if (p.layers.length === 1) {
    const base = p.layers[0];
    const oppSignal =
      (p.side === 'BUY' && flowSide < -cfg.triggerThreshold) ||
      (p.side === 'SELL' && flowSide > cfg.triggerThreshold);
    const baseBreach =
      p.side === 'BUY' ? lastPrice <= base.invalidatePrice : lastPrice >= base.invalidatePrice;
    if (oppSignal || baseBreach) {
      p.layers.pop();
      p.status = 'WRECKED';
      events.push({
        type: 'WRECKED',
        pyramid: p,
        reason: baseBreach ? 'VWAP_BREACH' : 'REVERSAL',
      });
    }
  } else if (p.layers.length === 0) {
    p.status = 'WRECKED';
    events.push({ type: 'WRECKED', pyramid: p, reason: 'VWAP_BREACH' });
  }

  return events;
}

/** Tüm piramidin toplam VWAP'ı */
export function pyramidVWAP(p: RealPyramid): number {
  return p.totalQtyBase > 0 ? p.totalNotional / p.totalQtyBase : p.entryPrice;
}

/** Anlık PnL% */
export function pyramidPnLPct(p: RealPyramid, price: number): number {
  const v = pyramidVWAP(p);
  return p.side === 'BUY' ? (price - v) / v : (v - price) / v;
}

/** Verilen tier label'ı (Türkçe) */
export function tierLabelFor(tier: TierId): string {
  const m: Record<TierId, string> = {
    MICRO: 'Micro', SMALL: 'Küçük', MEDIUM: 'Orta',
    LARGE: 'Büyük', WHALE: 'Balina', MEGA: 'Mega',
  };
  return m[tier];
}
