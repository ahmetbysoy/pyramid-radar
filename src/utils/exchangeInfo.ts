import type { SymbolMeta } from '../types';
import { decimalsFromStep } from './format';

const FAPI_EXCHANGE_INFO = 'https://fapi.binance.com/fapi/v1/exchangeInfo';

interface RawFilter {
  filterType: string;
  tickSize?: string;
  stepSize?: string;
  minPrice?: string;
  minQty?: string;
  minNotional?: string;
  notional?: string;
}

interface RawSymbol {
  symbol: string;
  status: string;
  contractType: string;
  baseAsset: string;
  quoteAsset: string;
  filters: RawFilter[];
}

interface RawExchangeInfo {
  symbols: RawSymbol[];
}

const CACHE_KEY = 'pyramid-exchange-info';
const CACHE_TTL = 1000 * 60 * 60 * 6; // 6 saat

/**
 * Binance USDT-M Futures için exchangeInfo çek ve önbellekle.
 * Sadece TRADING durumunda ve USDT perpetual'ları döndürür.
 */
export async function fetchExchangeInfo(force = false): Promise<Map<string, SymbolMeta>> {
  // Önbellekten oku
  if (!force) {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        const { ts, data } = JSON.parse(cached) as { ts: number; data: Array<[string, SymbolMeta]> };
        if (Date.now() - ts < CACHE_TTL) {
          return new Map(data);
        }
      }
    } catch {
      // bozulmuşsa tekrar çek
    }
  }

  const res = await fetch(FAPI_EXCHANGE_INFO);
  if (!res.ok) throw new Error(`exchangeInfo HTTP ${res.status}`);
  const info = (await res.json()) as RawExchangeInfo;

  const out = new Map<string, SymbolMeta>();

  for (const s of info.symbols) {
    if (s.status !== 'TRADING') continue;
    if (s.contractType !== 'PERPETUAL') continue;
    if (s.quoteAsset !== 'USDT') continue;

    const pf = s.filters.find((f) => f.filterType === 'PRICE_FILTER');
    const lf = s.filters.find((f) => f.filterType === 'LOT_SIZE');
    const mf = s.filters.find((f) => f.filterType === 'MIN_NOTIONAL');

    if (!pf || !lf) continue;

    const tickSize = pf.tickSize ?? '0.01';
    const stepSize = lf.stepSize ?? '0.001';

    out.set(s.symbol, {
      symbol: s.symbol,
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
      priceDecimals: decimalsFromStep(tickSize),
      qtyDecimals: decimalsFromStep(stepSize),
      filters: {
        tickSize,
        stepSize,
        minPrice: pf.minPrice ?? '0',
        minQty: lf.minQty ?? '0',
        minNotional: mf?.notional ?? mf?.minNotional ?? '5',
      },
    });
  }

  // Önbelleğe al
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ ts: Date.now(), data: Array.from(out.entries()) }),
    );
  } catch {
    // localStorage doluysa sorun değil
  }

  return out;
}

/**
 * Elindeki metadata map'inden tek sembolü al; yoksa default (0.01/0.001) döndür.
 */
export function getMeta(meta: Map<string, SymbolMeta> | null, symbol: string): SymbolMeta {
  return (
    meta?.get(symbol) ?? {
      symbol,
      baseAsset: symbol.replace('USDT', ''),
      quoteAsset: 'USDT',
      priceDecimals: 2,
      qtyDecimals: 3,
      filters: {
        tickSize: '0.01',
        stepSize: '0.001',
        minPrice: '0',
        minQty: '0',
        minNotional: '5',
      },
    }
  );
}
