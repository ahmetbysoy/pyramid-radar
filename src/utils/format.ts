import type { SymbolMeta } from '../types';

/**
 * TickSize veya stepSize string'inden decimal basamak sayısını hesapla.
 * "0.1"        → 1
 * "0.01"       → 2
 * "0.0100"     → 4 (tickSize 0.0100 demek 4 ondalık haneli fiyat demektir, sondaki sıfırlar korunur)
 * "0.0001"     → 4
 * "0.0000001"  → 7
 * "1"          → 0
 * "10"         → 0
 *
 * ÖNEMLİ: sondaki sıfırlar silinmez — tickSize "0.0100" ise 2 değil 4 hane gösterilir,
 * çünkü borsa "0.0100" tickSize ile 4 ondalık hassasiyette fiyat veriyor demektir.
 * (Binance bazı coin'lerde tickSize'ı "0.01000000" gibi verir, orada priceDecimals = 8 olmalı.)
 */
export function decimalsFromStep(step: string): number {
  if (!step) return 0;
  // Float olarak 1'den büyükse (örn "1", "10") tamsayıdır
  const f = parseFloat(step);
  if (!isFinite(f) || f <= 0) return 0;
  if (f >= 1) return 0;
  const parts = step.split('.');
  if (parts.length < 2) return 0;
  // Sondaki sıfırları SİLME — tickSize'ın tam basamağı kullan
  return parts[1].length;
}

/**
 * Fiyatı symbol'ün tickSize'ına göre formatla.
 * Sondaki sıfırlar KORUNUR (örneğin BTC 5 haneli ise "103,420.50000" olarak görünür).
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
