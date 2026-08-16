/**
 * Emir büyüklük katmanları (TIER).
 *
 * Her aggTrade USDT notional değerine göre bir kategoriye atılır.
 * Fiyat × miktar = notional (USDT).
 *
 * Farklı büyüklükteki oyuncuları ayırmak için kullanılır:
 *   - MICRO:  < $100           perakende sıfır hisseden
 *   - SMALL:  $100 – $1K       ufak trader
 *   - MEDIUM: $1K – $10K       düzgün perakende
 *   - LARGE:  $10K – $100K     akıllı para, ufak balina
 *   - WHALE:  $100K – $1M      balina
 *   - MEGA:   > $1M            mega balina (OTC, kurumsal)
 */

export interface Tier {
  id: TierId;
  label: string;
  emoji: string;
  /** minimum notional (dahil) */
  minNotional: number;
  /** renk tonu */
  color: string;
}

export type TierId = 'MICRO' | 'SMALL' | 'MEDIUM' | 'LARGE' | 'WHALE' | 'MEGA';

export const TIERS: Tier[] = [
  { id: 'MICRO',  label: 'Micro',    emoji: '🐟', minNotional: 0,        color: '#6B7B99' },
  { id: 'SMALL',  label: 'Small',    emoji: '🐠', minNotional: 100,      color: '#8B9BBB' },
  { id: 'MEDIUM', label: 'Medium',   emoji: '🐡', minNotional: 1_000,    color: '#A78BFA' },
  { id: 'LARGE',  label: 'Large',    emoji: '🦈', minNotional: 10_000,   color: '#22D3EE' },
  { id: 'WHALE',  label: 'Whale',    emoji: '🐋', minNotional: 100_000,  color: '#34D399' },
  { id: 'MEGA',   label: 'Mega',     emoji: '🐳', minNotional: 1_000_000,color: '#FBBF24' },
];

/**
 * Bir trade'in notional'ına göre tier'ını belirle.
 */
export function tierFromNotional(notional: number): TierId {
  let t: TierId = 'MICRO';
  for (const tier of TIERS) {
    if (notional >= tier.minNotional) t = tier.id;
  }
  return t;
}

export const TIER_IDS: TierId[] = TIERS.map((t) => t.id);

/** Tier metriklerini tutmak için tip */
export type TierMetrics = Record<TierId, {
  buyVol: number;   // son pencere alış hacmi (USDT)
  sellVol: number;  // son pencere satış hacmi (USDT)
  delta: number;    // buy - sell
  imbalance: number;// (buy - sell) / (buy + sell) ∈ [-1, +1]
  /** son 100 tickteki ortalama delta yönü (düzeltmeli) */
  ema: number;
  /** bu katmanın genel hacme oranı */
  sharePct: number;
}>;

export function emptyTierMetrics(): TierMetrics {
  const out = {} as TierMetrics;
  for (const t of TIER_IDS) {
    out[t] = { buyVol: 0, sellVol: 0, delta: 0, imbalance: 0, ema: 0, sharePct: 0 };
  }
  return out;
}
