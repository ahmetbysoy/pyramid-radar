import { describe, it, expect } from 'vitest';
import { decimalsFromStep, formatPrice, formatPct, formatCompact } from './format';

describe('format utils', () => {
  it('decimalsFromStep doğru hesaplar', () => {
    expect(decimalsFromStep('0.1')).toBe(1);       // BTC
    expect(decimalsFromStep('0.01')).toBe(2);      // ETH
    expect(decimalsFromStep('0.0001')).toBe(4);    // DOGE
    expect(decimalsFromStep('0.0000001')).toBe(7); // PEPE
    expect(decimalsFromStep('1')).toBe(0);
    expect(decimalsFromStep('10')).toBe(0);
  });

  it('formatPrice decimals ile', () => {
    expect(formatPrice(98450.3, { priceDecimals: 1 })).toMatch(/98,?450\.3/);
    expect(formatPrice(0.00001234, { priceDecimals: 8 })).toContain('0.00001234');
    expect(formatPrice(1.234, { priceDecimals: 2 })).toBe('1.23');
  });

  it('formatPct işaretli', () => {
    expect(formatPct(0.0042)).toBe('+0.42%');
    expect(formatPct(-0.012)).toBe('-1.20%');
  });

  it('formatCompact kısaltma', () => {
    expect(formatCompact(1234)).toMatch(/1\.23K|1,23K/);
    expect(formatCompact(1500000)).toMatch(/1\.5M|1,5M/);
  });
});
