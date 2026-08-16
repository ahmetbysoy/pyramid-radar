import type { SymbolMeta } from '../types';

/**
 * TickSize veya stepSize string'inden decimal basamak sayısını hesapla.
 * "0.1"    → 1 (BTC)
 * "0.01"   → 2 (ETH, SOL)
 * "0.0001" → 4 (DOGE)
 * "0.0000001" → 7 (PEPE)
 * "1"      → 0
 * "10"     → 0
 */
export function decimalsFromStep(step: string): number {
  const f = parseFloat(step);
  if (!isFinite(f) || f <= 0) return 0;
  if (f >= 1) return 0;
  // String olarak decimal kısmını say (kayan nokta hatasından kaçınmak için)
  const parts = step.split('.');
  if (parts.length < 2) return 0;
  return parts[1].replace(/0+$/, '').length || parts[1].length;
}

/**
 * Fiyatı symbol'ün tickSize'ına göre formatla.
 * Binlik ayraç olarak TR/US konvansiyonu kullanır.
 */
export function formatPrice(price: number, meta?: Pick<SymbolMeta, 'priceDecimals'>): string {
  if (!isFinite(price)) return '—';
  const dec = meta?.priceDecimals ?? 2;
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  }).format(price);
}

/**
 * Miktarı stepSize'a göre formatla.
 */
export function formatQty(qty: number, meta?: Pick<SymbolMeta, 'qtyDecimals'>): string {
  if (!isFinite(qty)) return '—';
  const dec = meta?.qtyDecimals ?? 2;
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: dec,
  }).format(qty);
}

/** Yüzde formatla */
export function formatPct(pct: number, sign = true): string {
  const v = pct * 100;
  const s = sign && v > 0 ? '+' : '';
  return `${s}${v.toFixed(2)}%`;
}

/** Büyük sayıları kısalt: 1234 → 1.23K, 1.2M vs. */
export function formatCompact(n: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(n);
}
