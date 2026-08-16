/**
 * Piramit motoru için iç tipler — dışarıya types/index.ts'den export edilmeyenler.
 */

export type Side = 'BUY' | 'SELL';

export interface Layer {
  level: number;
  addPrice: number;
  addTs: number;
  notional: number;
}

/** Piramit katmanları eklerken/silerken değişen durum */
export interface PyramidState {
  id: string;
  symbol: string;
  side: Side;
  entryPrice: number;
  entryTs: number;
  layers: Layer[];
  baseSize: number;
  /** Bir sonraki katmanı eklemek için fiyatın ne kadar uzağa gitmesi gerekiğu */
  nextLayerThreshold: number;
  /** Son katmanın silineceği fiyat */
  lastLayerInvalidatePrice: number;
  status: 'GROWING' | 'PEAKED' | 'COLLAPSING' | 'WRECKED';
  peakLayers: number;
}

/** Piramit motoru ayarları */
export interface PyramidConfig {
  /** Tetikleyici skoru (0-1) */
  triggerThreshold: number;
  /** Baz katman hayali USDT büyüklüğü */
  baseNotional: number;
  /** Katman büyümesi çarpanı (varsayılan 1.618 altın oran) */
  growthMultiplier: number;
  /** Yeni katman için gereken % uzaklık */
  layerAddPct: number;
  /** Son katmanı silmek için geri çekilme % */
  layerRemovePct: number;
  /** Piramidin zaman aşımı (ms) — hareketsiz kalırsa yık */
  timeoutMs: number;
}

export const DEFAULT_PYRAMID_CONFIG: PyramidConfig = {
  triggerThreshold: 0.7,
  baseNotional: 100,
  growthMultiplier: 1.618,
  layerAddPct: 0.002,   // %0.2
  layerRemovePct: 0.0015, // %0.15
  timeoutMs: 15 * 60 * 1000, // 15 dk
};
