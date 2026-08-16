import { useEffect, useRef } from 'react';
import { useStore, DEFAULT_SYMBOLS } from '../store';
import { fetchExchangeInfo } from '../utils/exchangeInfo';
import { formatPrice, formatPct, formatCompact } from '../utils/format';
import { BinanceFuturesAdapter } from '../core/ws/BinanceFuturesAdapter';
import { pushTrade, pushDepth, computeScore, resetSymbol } from '../core/indicators/simple';
import { spawnPyramid, updatePyramid, pyramidNotional, avgEntry, currentPnLPct } from '../core/pyramid/engine';
import { DEFAULT_PYRAMID_CONFIG } from '../core/pyramid/types';
import type { Trade, Depth, MarkPrice, WsStatus } from '../types';
import type { PyramidEvent } from '../core/pyramid/engine';

export function App() {
  const status = useStore((s) => s.status);
  const markets = useStore((s) => s.markets);
  const symbols = useStore((s) => s.selectedSymbols);
  const setStatus = useStore((s) => s.setStatus);
  const initSymbol = useStore((s) => s.initSymbol);
  const setPrice = useStore((s) => s.setPrice);
  const setMeta = useStore((s) => s.setMeta);
  const addPyramid = useStore((s) => s.addPyramid);
  const updatePyramidState = useStore((s) => s.updatePyramid);
  const wreckPyramid = useStore((s) => s.wreckPyramid);
  const setScore = useStore((s) => s.setScore);
  const adapterRef = useRef<BinanceFuturesAdapter | null>(null);

  // Exchange info yükle
  useEffect(() => {
    let mounted = true;
    fetchExchangeInfo()
      .then((meta) => {
        if (!mounted) return;
        for (const sym of DEFAULT_SYMBOLS) {
          if (meta.has(sym)) {
            setMeta(sym, meta.get(sym)!);
            initSymbol(sym, meta.get(sym));
          } else {
            initSymbol(sym);
          }
        }
      })
      .catch(() => {
        if (!mounted) return;
        for (const sym of DEFAULT_SYMBOLS) initSymbol(sym);
      });
    return () => { mounted = false; };
  }, [initSymbol, setMeta]);

  // WS bağlantısı
  useEffect(() => {
    const adapter = new BinanceFuturesAdapter(DEFAULT_SYMBOLS, {
      onTrade: (t: Trade) => {
        pushTrade(t.symbol, t.ts, t.qty, t.side);
        setPrice(t.symbol, t.price);
      },
      onDepth: (d: Depth) => {
        pushDepth(d.symbol, d.bids, d.asks);
      },
      onMark: (m: MarkPrice) => {
        setPrice(m.symbol, m.price);
      },
      onStatus: (s: WsStatus) => setStatus(s),
    });
    adapterRef.current = adapter;
    adapter.connect();

    // Tick döngüsü: 100ms (10 Hz) skor ve piramit değerlendirmesi
    const tick = setInterval(() => {
      const now = Date.now();
      const state = useStore.getState();
      for (const sym of DEFAULT_SYMBOLS) {
        const m = state.markets[sym];
        if (!m || m.price <= 0) continue;

        const score = computeScore(sym, now);
        setScore(sym, score);

        // Aktif piramitleri güncelle
        const toWreck: Array<{ p: typeof m.activePyramids[number]; reason: 'REVERSAL' | 'TIMEOUT' }> = [];
        for (const p of m.activePyramids) {
          const events = updatePyramid(p, m.price, score, now, DEFAULT_PYRAMID_CONFIG);
          for (const ev of events as PyramidEvent[]) {
            if (ev.type === 'LAYER_ADDED' || ev.type === 'LAYER_REMOVED') {
              updatePyramidState(sym, p);
            } else if (ev.type === 'WRECKED') {
              toWreck.push({ p, reason: ev.reason });
            }
          }
        }
        for (const w of toWreck) {
          wreckPyramid(sym, w.p, w.reason);
        }

        // Tetikleyici: Yeni piramit doğur (aktif piramit yoksa ve skor eşiği geçerse)
        if (
          m.activePyramids.length === 0 &&
          Math.abs(score) >= DEFAULT_PYRAMID_CONFIG.triggerThreshold
        ) {
          const side = score > 0 ? 'BUY' : 'SELL';
          const pyr = spawnPyramid(sym, side, m.price, DEFAULT_PYRAMID_CONFIG, now);
          addPyramid(sym, pyr);
        }
      }
    }, 100);

    return () => {
      clearInterval(tick);
      adapter.disconnect();
      for (const sym of DEFAULT_SYMBOLS) resetSymbol(sym);
    };
  }, [setStatus, setPrice, setScore, addPyramid, updatePyramidState, wreckPyramid]);

  return (
    <div className="app">
      <header className="header">
        <h1>🏔️ PİRAMİT RADAR</h1>
        <div>
          <span className={`status-dot ${status}`} />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.7rem', color: 'var(--muted)' }}>
            {status.toUpperCase()}
          </span>
        </div>
      </header>

      <div className="main">
        {symbols.map((sym) => {
          const m = markets[sym];
          if (!m) return null;
          const meta = m.meta;
          const metaExists = !!meta;
          const buyPyramids = m.activePyramids.filter((p) => p.side === 'BUY');
          const sellPyramids = m.activePyramids.filter((p) => p.side === 'SELL');
          const pnl = m.activePyramids.length > 0
            ? currentPnLPct(m.activePyramids[0], m.price)
            : 0;

          return (
            <div key={sym} className="symbol-card">
              <div className="sym-header">
                <span className="sym-name">
                  {meta?.baseAsset ?? sym.replace('USDT', '')}
                  <span style={{ color: 'var(--muted)', fontSize: '0.7rem', marginLeft: 4 }}>/USDT</span>
                </span>
                <span className={`sym-price ${m.priceDir}`}>
                  {metaExists ? formatPrice(m.price, meta) : m.price.toFixed(2)}
                </span>
              </div>

              <div className="pyramid-row">
                <div className="pyramid-col">
                  <h3>ALIM PİRAMİTİ {buyPyramids.length > 0 ? `(${buyPyramids.reduce((s, p) => s + p.layers.length, 0)}K)` : ''}</h3>
                  <div className="pyramid-stack">
                    {buyPyramids.flatMap((p) =>
                      [...p.layers].reverse().map((l) => {
                        const width = 20 + l.level * 22;
                        return (
                          <div
                            key={`${p.id}-${l.level}`}
                            className="pyr-layer buy"
                            style={{ width: `${Math.min(width, 95)}%` }}
                          >
                            {formatCompact(l.notional)}
                          </div>
                        );
                      }),
                    )}
                  </div>
                </div>
                <div className="pyramid-col">
                  <h3>SATIM PİRAMİTİ {sellPyramids.length > 0 ? `(${sellPyramids.reduce((s, p) => s + p.layers.length, 0)}K)` : ''}</h3>
                  <div className="pyramid-stack">
                    {sellPyramids.flatMap((p) =>
                      [...p.layers].reverse().map((l) => {
                        const width = 20 + l.level * 22;
                        return (
                          <div
                            key={`${p.id}-${l.level}`}
                            className="pyr-layer sell"
                            style={{ width: `${Math.min(width, 95)}%` }}
                          >
                            {formatCompact(l.notional)}
                          </div>
                        );
                      }),
                    )}
                  </div>
                </div>
              </div>

              <div className="sym-stats">
                <span>Skor: <b className="v" style={{ color: m.score > 0 ? 'var(--green)' : m.score < 0 ? 'var(--red)' : 'var(--muted)' }}>{m.score.toFixed(2)}</b></span>
                {m.activePyramids.length > 0 && (
                  <>
                    <span>Avg: <b className="v">{metaExists ? formatPrice(avgEntry(m.activePyramids[0]), meta) : avgEntry(m.activePyramids[0]).toFixed(2)}</b></span>
                    <span>PnL: <b className="v" style={{ color: pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>{formatPct(pnl)}</b></span>
                    <span>Toplam: <b className="v">{formatCompact(m.activePyramids.reduce((s, p) => s + pyramidNotional(p), 0))}</b></span>
                  </>
                )}
                <span>Yıkılan: <b className="v">{m.wreckedPyramids.length}</b></span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="disclaimer">
        ⚠️ TÜM VERİ GERÇEK BİNANCE FUTURES — HAYALİ PİRAMİTLERDİR · YATIRIM TAVSİYESİ DEĞİLDİR
      </div>
    </div>
  );
}
