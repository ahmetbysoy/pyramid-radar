/**
 * Adaptif (Percentile Tabanlı) Tier Sistemi
 *
 * Sabit 100$/1K/10K/... eşikleri yerine son 15 dakikadaki işlem büyüklüklerinin
 * dağılımını kullanarak tier eşiklerini otomatik belirler.
 * BTC'de mega = 1M+$ iken PEPE'de 1K+$ olabilir, sistem her coin'e kendi uyum sağlar.
 *
 * ÖNEMLİ: Percentile kendi kendini köreltmesin diye taban/tavan eklendi:
 *  - Percentile çok küçük bir coin'de anlamsız küçük kalmaması için MUTLAK MINIMUM:
 *      SMALL ≥ 50$, LARGE ≥ 1000$, WHALE ≥ 10_000$, MEGA ≥ 50_000$
 *  - Çok uç/balinalı dönemlerde WHALE/MEGA aşırı şişmesin diye MUTLAK TAVAN:
 *      WHALE ≤ 2M$, MEGA ≤ 20M$
 *  - EMA yumuşatması ile eşikler zıplamasın
 *
 * Percentile dilimleri (kümülatif):
 *   MICRO  : P0–P20   (en küçük %20)
 *   SMALL  : P20–P45
 *   MEDIUM : P45–P70
 *   LARGE  : P70–P90  — akıllı para
 *   WHALE  : P90–P99  — balina
 *   MEGA   : P99+     — mega balina
 */

import type { TierId } from './tiers';

export interface TierThresholds {
  MICRO: number;  // her zaman 0
  SMALL: number;
  MEDIUM: number;
  LARGE: number;
  WHALE: number;
  MEGA: number;
  /** hesaplandığı zaman */
  updatedAt: number;
  /** dağılımdaki toplam işlem sayısı */
  sampleSize: number;
}

interface TierConfig {
  id: TierId;
  label: string;
  emoji: string;
  /** alt percentile */
  pLow: number;
  color: string;
}

export const TIER_CONFIGS: TierConfig[] = [
  { id: 'MICRO',  label: 'Micro',   emoji: '🐟', pLow: 0,   color: '#6B7B99' },
  { id: 'SMALL',  label: 'Küçük',   emoji: '🐠', pLow: 20,  color: '#8B9BBB' },
  { id: 'MEDIUM', label: 'Orta',    emoji: '🐡', pLow: 45,  color: '#A78BFA' },
  { id: 'LARGE',  label: 'Büyük',   emoji: '🦈', pLow: 70,  color: '#22D3EE' },
  { id: 'WHALE',  label: 'Balina',  emoji: '🐋', pLow: 90,  color: '#34D399' },
  { id: 'MEGA',   label: 'Mega',    emoji: '🐳', pLow: 99,  color: '#FBBF24' },
];

const PERCENTILES: Record<TierId, number> = {
  MICRO: 0,
  SMALL: 20,
  MEDIUM: 45,
  LARGE: 70,
  WHALE: 90,
  MEGA: 99,
};

const MAX_SAMPLES = 3000;
const RECALC_MS = 2000;
const MIN_SAMPLES = 30;
const EMA_ALPHA = 0.15;    // eşik yumuşatması — ani kaymaları önler

// Mutlak tabanlar (kendi kendini köreltmeyi engeller)
const FLOOR = {
  SMALL: 50,
  MEDIUM: 500,
  LARGE: 1_000,
  WHALE: 10_000,
  MEGA: 50_000,
};
// Mutlak tavanlar (mega balina dönemlerinde aşırı şişmeyi engeller)
const CEIL = {
  SMALL: 10_000,
  MEDIUM: 100_000,
  LARGE: 500_000,
  WHALE: 2_000_000,
  MEGA: 20_000_000,
};

const FALLBACK_THRESHOLDS: TierThresholds = {
  MICRO: 0,
  SMALL: 100,
  MEDIUM: 1_000,
  LARGE: 10_000,
  WHALE: 100_000,
  MEGA: 1_000_000,
  updatedAt: 0,
  sampleSize: 0,
};

export class AdaptiveTierTracker {
  private samples: number[] = [];
  private idx = 0;
  private filled = false;
  private thresholds: TierThresholds = { ...FALLBACK_THRESHOLDS };
  private lastRecalc = 0;

  /** Yeni bir işlem notional'ı ekle */
  push(notional: number): void {
    if (!Number.isFinite(notional) || notional <= 0) return;
    if (this.samples.length < MAX_SAMPLES) {
      this.samples.push(notional);
    } else {
      this.samples[this.idx] = notional;
      this.idx = (this.idx + 1) % MAX_SAMPLES;
      this.filled = true;
    }
  }

  /** Mevcut eşikleri döndür (gerekirse yeniden hesapla) */
  getThresholds(): TierThresholds {
    const now = Date.now();
    if (now - this.lastRecalc > RECALC_MS) {
      this.recalc();
      this.lastRecalc = now;
    }
    return this.thresholds;
  }

  /** Notional değerine göre tier döndür */
  tierFromNotional(notional: number): TierId {
    const t = this.getThresholds();
    if (notional >= t.MEGA) return 'MEGA';
    if (notional >= t.WHALE) return 'WHALE';
    if (notional >= t.LARGE) return 'LARGE';
    if (notional >= t.MEDIUM) return 'MEDIUM';
    if (notional >= t.SMALL) return 'SMALL';
    return 'MICRO';
  }

  /** Hangi tier'lar "smart money" (akıllı para) olarak kabul edilir? */
  isSmartMoney(tier: TierId): boolean {
    return tier === 'WHALE' || tier === 'MEGA' || tier === 'LARGE';
  }

  /** Hangi tier'lar "retail" olarak kabul edilir? */
  isRetail(tier: TierId): boolean {
    return tier === 'MICRO' || tier === 'SMALL' || tier === 'MEDIUM';
  }

  private recalc(): void {
    const now = Date.now();
    if (this.samples.length < MIN_SAMPLES) {
      this.thresholds = { ...FALLBACK_THRESHOLDS, sampleSize: this.samples.length, updatedAt: now };
      return;
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    const n = sorted.length;

    const rawPct = (p: number): number => {
      if (n === 0) return 0;
      const rank = (p / 100) * (n - 1);
      const lo = Math.floor(rank);
      const hi = Math.min(n - 1, lo + 1);
      const frac = rank - lo;
      return sorted[lo] * (1 - frac) + sorted[hi] * frac;
    };

    // Ham percentile değerleri
    const raw = {
      SMALL: rawPct(PERCENTILES.SMALL),
      MEDIUM: rawPct(PERCENTILES.MEDIUM),
      LARGE: rawPct(PERCENTILES.LARGE),
      WHALE: rawPct(PERCENTILES.WHALE),
      MEGA: rawPct(PERCENTILES.MEGA),
    };
    // Tabana/tavana kelepçele
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const clamped = {
      SMALL:  clamp(raw.SMALL,  FLOOR.SMALL,  CEIL.SMALL),
      MEDIUM: clamp(raw.MEDIUM, FLOOR.MEDIUM, CEIL.MEDIUM),
      LARGE:  clamp(raw.LARGE,  FLOOR.LARGE,  CEIL.LARGE),
      WHALE:  clamp(raw.WHALE,  FLOOR.WHALE,  CEIL.WHALE),
      MEGA:   clamp(raw.MEGA,   FLOOR.MEGA,   CEIL.MEGA),
    };
    // Monotonluk garantisi: her tier bir öncekinden ≥%20 büyük olsun
    if (clamped.MEDIUM < clamped.SMALL * 1.2)  clamped.MEDIUM = clamped.SMALL * 1.2;
    if (clamped.LARGE  < clamped.MEDIUM * 1.2) clamped.LARGE  = clamped.MEDIUM * 1.2;
    if (clamped.WHALE  < clamped.LARGE * 1.2)  clamped.WHALE  = clamped.LARGE * 1.2;
    if (clamped.MEGA   < clamped.WHALE * 1.5)  clamped.MEGA   = clamped.WHALE * 1.5;
    // Tavanı tekrar uygula (monotonluk sonrası aşmış olabilir)
    clamped.MEDIUM = Math.min(clamped.MEDIUM, CEIL.MEDIUM);
    clamped.LARGE  = Math.min(clamped.LARGE,  CEIL.LARGE);
    clamped.WHALE  = Math.min(clamped.WHALE,  CEIL.WHALE);
    clamped.MEGA   = Math.min(clamped.MEGA,   CEIL.MEGA);

    // EMA yumuşatması (eşikler her 2sn'de bir α kadar yeni değere yaklaşsın)
    const ema = (prev: number, next: number) =>
      prev > 0 ? prev * (1 - EMA_ALPHA) + next * EMA_ALPHA : next;

    this.thresholds = {
      MICRO: 0,
      SMALL:  ema(this.thresholds.SMALL,  clamped.SMALL),
      MEDIUM: ema(this.thresholds.MEDIUM, clamped.MEDIUM),
      LARGE:  ema(this.thresholds.LARGE,  clamped.LARGE),
      WHALE:  ema(this.thresholds.WHALE,  clamped.WHALE),
      MEGA:   ema(this.thresholds.MEGA,   clamped.MEGA),
      updatedAt: now,
      sampleSize: this.filled ? MAX_SAMPLES : n,
    };
  }

  reset(): void {
    this.samples = [];
    this.idx = 0;
    this.filled = false;
    this.thresholds = { ...FALLBACK_THRESHOLDS };
    this.lastRecalc = 0;
  }
}
