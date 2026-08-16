/**
 * Adaptif (Percentile Tabanlı) Tier Sistemi
 *
 * Sabit 100$/1K/10K/... eşikleri yerine son 15 dakikadaki işlem büyüklüklerinin
 * dağılımını kullanarak tier eşiklerini otomatik belirler.
 * BTC'de mega = 1M+$ iken PEPE'de 1K+$ olabilir, sistem her coin'e kendi uyum sağlar.
 *
 * Percentile dilimleri (kümülatif):
 *   MICRO  : P0–P20   (en küçük %20 işlem) — sıfır hisseden perakende
 *   SMALL  : P20–P45  (sonraki %25)        — ufak trader
 *   MEDIUM : P45–P70  (sonraki %25)        — düzgün perakende
 *   LARGE  : P70–P90  (sonraki %20)        — akıllı para / ufak balina
 *   WHALE  : P90–P99  (son %9)             — balina
 *   MEGA   : P99+     (en tepedeki %1)     — mega balina / kurumsal
 *
 * Hesaplama yaklaşımı: son MAX_SAMPLES adet trade'in notional değerini ring buffer'da tut,
 * 2 saniyede bir sıralayarak yaklaşık percentille'i çıkar. Hafıza/CPU dostu.
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

const MAX_SAMPLES = 3000;      // son ~3000 işlem (15dk'da BTC için rahat yeter)
const RECALC_MS = 2000;       // 2 saniyede bir percentille'i yeniden hesapla
const MIN_SAMPLES = 30;       // en az bu kadar işlem birikmeden adaptife geçme

/** Başlangıç için mantıklı varsayılan eşikler (BTC benzeri) */
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
    if (this.samples.length < MIN_SAMPLES) {
      this.thresholds = { ...FALLBACK_THRESHOLDS, sampleSize: this.samples.length, updatedAt: Date.now() };
      return;
    }
    // Kopyasını alıp sırala
    const sorted = [...this.samples].sort((a, b) => a - b);
    const n = sorted.length;

    const pct = (p: number): number => {
      if (n === 0) return 0;
      const rank = (p / 100) * (n - 1);
      const lo = Math.floor(rank);
      const hi = Math.min(n - 1, lo + 1);
      const frac = rank - lo;
      return sorted[lo] * (1 - frac) + sorted[hi] * frac;
    };

    this.thresholds = {
      MICRO: 0,
      SMALL: pct(PERCENTILES.SMALL),
      MEDIUM: pct(PERCENTILES.MEDIUM),
      LARGE: pct(PERCENTILES.LARGE),
      WHALE: pct(PERCENTILES.WHALE),
      MEGA: pct(PERCENTILES.MEGA),
      updatedAt: Date.now(),
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
